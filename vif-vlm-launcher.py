#!/usr/bin/env python3
"""
Entrypoint for the VLM engine containers (the `vlm` service in
docker-compose.yaml, and the VIF model services from the phase-1 release).
Runs unchanged on any supported GPU and model: defaults adapt to the hardware
at startup, and everything else comes from the engine's spec or from VLM_*
variables -- you should not need to edit this file.

Stdlib plus pynvml only, running on the engine image's Python 3.12.

TWO SOURCES OF FLAGS, in priority order:

  1. An ENGINE SPEC written by VIS to the shared state volume
     (VIF_ENGINE_SPEC_FILE, or <VIF_STATE_DIR>/engines/<engine key>.json).
     VIS resolves the whole command from its model catalog and this script
     runs it verbatim -- it is a dumb executor, by design.
  2. The LEGACY env-driven path: VLM_* variables from the model's env file
     (vlm-env/<name>.env, picked by VLM_CONF in .env). Bit-compatible with
     the bash entrypoint this file replaces, with one documented exception:
     --served-model-name is always passed (see below).

--served-model-name IS ALWAYS PASSED. Under HF_HUB_OFFLINE=1 vLLM otherwise
serves an offline model under its snapshot PATH instead of its HuggingFace id,
which breaks model routing and the Manager's Verify probe on air-gapped hosts.
Online deployments see no change. Air-gapped deployments whose streams named
the snapshot path must rename them to the HuggingFace id.

FIXED flags (not overridable) are tuned to the VIS workload -- unique,
non-repeating video frames with short structured responses:
  --no-enable-prefix-caching   frames never repeat, so prefix caching
                               only adds overhead
  --mm-processor-cache-gb 0    same reason, for the multimodal
                               preprocessor cache

AUTO-DETECTED at startup (legacy path only; the spec carries it resolved):
  kv-cache dtype               fp8 when every GPU the server uses has compute
                               capability >= 8.9 (Ada/Hopper or newer), else
                               "auto" -- fp8 KV cache is not supported on
                               older GPUs such as A10G/A100. Set
                               VLM_KV_CACHE_DTYPE to override.

TUNABLE (defaults fit Qwen3-VL-4B-Instruct-FP8 on a DEDICATED 24 GB-class
GPU). All of these live in the model's env file, except VLM_GPU_IDS which is
deployment placement and lives in .env:
  VLM_GPU_IDS                  (.env) Pin the engine to specific GPU(s), e.g.
                               "1" or "2,3". Indices match `nvidia-smi` order.
                               Unset = first visible GPU (GPU 0), which WSE and
                               VIS also use -- pin this on multi-GPU hosts so
                               they don't contend.
  VLM_TENSOR_PARALLEL_SIZE     Shard the model across N GPUs (default 1).
  VLM_GPU_MEMORY_UTILIZATION   Fraction of the GPU vLLM reserves (default
                               0.90). Best practice: give the VLM a dedicated
                               GPU via VLM_GPU_IDS and keep other workloads on
                               other cards.
  VLM_PORT                     Served port (default 8000). The compose
                               healthcheck follows it; point your streams'
                               `endpoint_url` at the same port.
plus VLM_MODEL, VLM_MAX_MODEL_LEN, VLM_MAX_NUM_SEQS, VLM_KV_CACHE_DTYPE,
VLM_MAX_NUM_BATCHED_TOKENS, VLM_MAX_PIXELS / VLM_MIN_PIXELS (Qwen-style
processor kwargs; no default -- some processors reject them),
VLM_MAX_IMAGES_PER_PROMPT, and VLM_EXTRA_ARGS (raw passthrough, appended
last; flag values containing spaces cannot be passed here).

HF_TOKEN (higher rate limits on the first-boot weight download) and
HF_HUB_OFFLINE=1 (skip Hub probes on air-gapped hosts with pre-seeded weights)
are read by vLLM/HuggingFace directly, not by this script.

SIZING CONCURRENCY: there is no universal "right" --max-num-seqs; vLLM
computes the real ceiling for your GPU at startup and prints it. Watch the
boot log for:

  Maximum concurrency for <max_model_len> tokens per request: <Y>x

By default (VLM_MAX_NUM_SEQS=auto) the flag is omitted and vLLM sizes the
ceiling to your GPU's KV-cache capacity. To pin it instead, set
VLM_MAX_NUM_SEQS to floor(<Y>) -- useful on a constrained GPU if preemptions
climb (`vllm:num_preemptions_total`). Use the same <Y> to size the
`max_concurrent_requests` cap in the VIS WebSocket VLM config.

POOL DUTIES (opt-in on the legacy path, OFF by default; carried by the spec
on the managed path). These exist for a pool of resident engines sharing one
GPU, where a manager decides which one serves. With none of them set this
script execs `vllm serve` directly, exactly as the bash entrypoint did.
  VLM_SLEEP_MODE               "1"/"true" adds --enable-sleep-mode and exports
                               VLLM_SERVER_DEV_MODE=1, which is what mounts
                               /sleep, /wake_up and /is_sleeping. Default off.
  VLM_LOAD_LOCK_FILE           Path to a lock file on a volume shared by every
                               engine on the GPU. Held from before the engine
                               launches until it is ready (and, for an engine
                               that must park, until it is asleep), so cold
                               loads serialize instead of claiming the card at
                               once. Unset = no locking.
  VLM_HEALTH_TIMEOUT_SECONDS   How long to wait for this engine's own /health
                               while holding the lock (default 1800). On
                               timeout the lock is released, the engine is
                               stopped (SIGTERM, then SIGKILL 10s later) and
                               the container exits 75 so the restart policy
                               retries -- one wedged engine must not block the
                               pool.
  VLM_HEALTH_POLL_SECONDS      Interval between /health polls (default 2).
  VLM_STATE_FILE               Path on the shared volume naming the model that
                               should be serving (first non-empty line = a
                               model id). Once healthy, this engine sleeps
                               unless the file names it -- an absent or
                               unreadable file means sleep, because several
                               awake engines on one card is how you OOM it.
                               This script only ever sleeps itself; waking is
                               the manager's job.
  VLM_SLEEP_LEVEL              Sleep level for that self-sleep (default 1:
                               weights to host RAM; 2 discards them).

MANAGED PATH:
  VIF_ENGINE_SPEC_FILE         Path to this engine's spec on the state volume.
  VIF_STATE_DIR                Where specs live when the path is not given
                               (<dir>/engines/<engine key>.json).
  VIF_SPEC_TIMEOUT_SECONDS     How long to wait for VIS to write the spec
                               before exiting 78 (default 300).

  VIF_LAUNCHER_DRY_RUN=1       Print the fully resolved command and env as
                               JSON and exit without starting anything.

EXIT CODES: 75 health-check timeout, 78 bad configuration (including a spec
that never arrives); anything else is vLLM's own.
"""

import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

from dataclasses import dataclass, field
from pathlib import Path
from types import FrameType
from typing import Any, TextIO

# Bump on every edit to this file.
LAUNCHER_REVISION: str = "2026-09-21"

EXIT_HEALTH_TIMEOUT: int = 75
EXIT_CONFIG: int = 78
# Grace between SIGTERM and SIGKILL when this script stops a wedged engine.
STOP_GRACE_SECONDS: int = 10

ENGINE_SPEC_VERSION: int = 1
ENGINE_SPEC_DIRNAME: str = "engines"
DEFAULT_STATE_DIR: str = "/vif-state"
DEFAULT_SPEC_TIMEOUT_SECONDS: int = 300

FP8_KV_CACHE_MIN_COMPUTE_CAPABILITY: float = 8.9

_TRUE: frozenset[str] = frozenset({"1", "true", "yes"})
_FALSE: frozenset[str] = frozenset({"", "0", "false", "no"})
_NON_SLUG: re.Pattern[str] = re.compile(r"[^a-z0-9]+")


class ConfigError(Exception):
    """Something is wrong with the configuration; the engine never starts."""


# Dry runs print JSON on stdout, so their logging moves out of the way.
_LOG_STREAM: TextIO = sys.stdout


def log(message: str) -> None:
    print(f"[vlm-launcher] {message}", file=_LOG_STREAM, flush=True)


def warn(message: str) -> None:
    print(f"[vlm-launcher] {message}", file=sys.stderr, flush=True)


@dataclass(frozen=True)
class LaunchPlan:
    """Everything needed to run one engine and do its pool duties."""

    source: str
    model: str
    args: list[str]
    env: dict[str, str] = field(default_factory=dict)
    port: int = 8000
    sleep_mode: bool = False
    sleep_level: int = 1
    # True/False decide directly (spec path); None means "ask the state file".
    active: bool | None = None
    state_file: str = ""
    load_lock_file: str = ""
    health_timeout_seconds: int = 1800
    health_poll_seconds: float = 2.0

    @property
    def argv(self) -> list[str]:
        return ["vllm", "serve", self.model, *self.args]

    @property
    def has_sleep_duty(self) -> bool:
        """Whether this engine may have to park itself once it is healthy."""
        if self.active is None:
            return bool(self.state_file)
        return self.sleep_mode and not self.active

    @property
    def needs_supervision(self) -> bool:
        return bool(self.load_lock_file) or self.has_sleep_duty


# ── shared helpers ─────────────────────────────────────────────────────────


def engine_key(model_id: str) -> str:
    """Filesystem-safe key for a model id. Mirrors VIS's app/vlm/engine_spec.py."""
    return _NON_SLUG.sub("-", model_id.lower()).strip("-")


def parse_bool(name: str, raw: str) -> bool:
    lowered: str = raw.strip().lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    raise ConfigError(f"{name}='{raw}' is not a boolean.")


def pin_gpus(gpu_ids: str) -> dict[str, str]:
    """CUDA_VISIBLE_DEVICES pinning, by `nvidia-smi` index."""
    if not gpu_ids:
        return {}
    log(f"VLM_GPU_IDS={gpu_ids} -> pinned via CUDA_VISIBLE_DEVICES.")
    return {"CUDA_DEVICE_ORDER": "PCI_BUS_ID", "CUDA_VISIBLE_DEVICES": gpu_ids}


def _gpu_indices(gpu_ids: str, count: int) -> list[int]:
    if not gpu_ids:
        return list(range(count))
    return [int(part) for part in gpu_ids.split(",") if part.strip() != ""]


def probe_gpus(gpu_ids: str) -> float | None:
    """
    Log the GPUs this engine will use and return their lowest compute
    capability, or None when the probe is unavailable (no pynvml, no driver).
    """
    try:
        import pynvml
    except ImportError:
        warn("pynvml not available; skipping the GPU probe.")
        return None

    try:
        pynvml.nvmlInit()
    except Exception as exc:  # nvmlInit raises NVMLError, which needs the import
        warn(f"NVML init failed ({exc}); skipping the GPU probe.")
        return None

    try:
        total: int = pynvml.nvmlDeviceGetCount()
        indices: list[int] = _gpu_indices(gpu_ids, total)
        log("Detected GPU(s):")
        lowest: float | None = None
        for index in indices:
            handle: Any = pynvml.nvmlDeviceGetHandleByIndex(index)
            name: str = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode()
            memory_mib: int = pynvml.nvmlDeviceGetMemoryInfo(handle).total // (
                1024 * 1024
            )
            major, minor = pynvml.nvmlDeviceGetCudaComputeCapability(handle)
            capability: float = float(f"{major}.{minor}")
            log(f"  {index}, {name}, {memory_mib} MiB, {major}.{minor}")
            lowest = capability if lowest is None else min(lowest, capability)
        return lowest
    except Exception as exc:
        warn(f"GPU probe failed ({exc}).")
        return None
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass


def warn_if_sleep_mode_cannot_work() -> None:
    """
    Sleep mode needs vLLM's cumem allocator, which needs CUDA UVA. UVA is
    unavailable under WSL2, where the engine dies at boot with an unexplained
    "RuntimeError: UVA is not available" -- say why before vLLM says what.
    """
    try:
        release: str = Path("/proc/version").read_text(encoding="utf-8")
    except OSError:
        return
    if "microsoft" not in release.lower():
        return
    warn(
        "sleep mode is enabled on a WSL2 kernel: vLLM's cumem allocator needs "
        "CUDA UVA, which WSL2 does not provide, so the engine will fail at "
        "boot with 'RuntimeError: UVA is not available'. Run managed engines "
        "on a native Linux host."
    )


# ── source 1: the engine spec VIS writes ───────────────────────────────────


def spec_path_from_env(environ: dict[str, str]) -> str:
    explicit: str = environ.get("VIF_ENGINE_SPEC_FILE", "").strip()
    if explicit:
        return explicit
    state_dir: str = environ.get("VIF_STATE_DIR", "").strip()
    model: str = environ.get("VLM_MODEL", "").strip()
    if state_dir and model:
        return str(Path(state_dir) / ENGINE_SPEC_DIRNAME / f"{engine_key(model)}.json")
    return ""


def wait_for_spec(path: str, timeout_seconds: int) -> dict[str, Any]:
    """
    Read the spec, waiting for VIS to write it.

    Engines can start before VIS does, so a missing spec is not yet an error;
    a spec that never arrives is, with a defined exit rather than a crash loop
    inside vLLM.
    """
    deadline: float = time.monotonic() + timeout_seconds
    announced: bool = False
    while True:
        reason: str = ""
        try:
            document: dict[str, Any] = json.loads(
                Path(path).read_text(encoding="utf-8")
            )
            return document
        except FileNotFoundError:
            reason = "not written yet"
        except (OSError, json.JSONDecodeError) as exc:
            # A half-written spec reads as invalid JSON; treat it as not there
            # yet and let the deadline decide.
            reason = str(exc)
        if time.monotonic() >= deadline:
            raise ConfigError(
                f"no usable engine spec at {path} after {timeout_seconds}s "
                f"({reason}) -- is VIS running, and is the state volume shared?"
            )
        if not announced:
            log(f"waiting up to {timeout_seconds}s for VIS to write {path}...")
            announced = True
        time.sleep(2.0)


def plan_from_spec(document: dict[str, Any], environ: dict[str, str]) -> LaunchPlan:
    version: Any = document.get("spec_version")
    if version != ENGINE_SPEC_VERSION:
        raise ConfigError(
            f"engine spec version {version!r} is not supported "
            f"(this launcher reads version {ENGINE_SPEC_VERSION})"
        )
    for required in ("model", "args", "port", "active", "sleep_mode"):
        if required not in document:
            raise ConfigError(f"engine spec is missing '{required}'")

    env: dict[str, str] = {
        str(k): str(v) for k, v in (document.get("env") or {}).items()
    }
    gpu_ids: str = str(
        document.get("gpu_ids") or environ.get("VLM_GPU_IDS", "")
    ).strip()
    env.update(pin_gpus(gpu_ids))

    sleep_mode: bool = bool(document["sleep_mode"])
    active: bool = bool(document["active"])
    if not active and not sleep_mode:
        raise ConfigError(
            "engine spec says this engine is not active but has sleep mode off; "
            "it cannot park itself."
        )

    return LaunchPlan(
        source="spec",
        model=str(document["model"]),
        args=[str(arg) for arg in document["args"]],
        env=env,
        port=int(document["port"]),
        sleep_mode=sleep_mode,
        sleep_level=int(document.get("sleep_level", 1)),
        active=active,
        load_lock_file=str(document.get("load_lock_file") or ""),
        health_timeout_seconds=int(document.get("health_timeout_seconds", 1800)),
        health_poll_seconds=float(environ.get("VLM_HEALTH_POLL_SECONDS", "2")),
    )


# ── source 2: the legacy VLM_* environment ─────────────────────────────────


def plan_from_env(environ: dict[str, str]) -> LaunchPlan:
    model: str = environ.get("VLM_MODEL", "Qwen/Qwen3-VL-4B-Instruct-FP8")
    max_model_len: str = environ.get("VLM_MAX_MODEL_LEN", "16384")
    gpu_memory_utilization: str = environ.get("VLM_GPU_MEMORY_UTILIZATION", "0.90")
    max_num_batched_tokens: str = environ.get("VLM_MAX_NUM_BATCHED_TOKENS", "8192")
    max_num_seqs: str = environ.get("VLM_MAX_NUM_SEQS", "auto")
    tensor_parallel_size: str = environ.get("VLM_TENSOR_PARALLEL_SIZE", "1")
    # Per-image pixel caps are Qwen-style PROCESSOR kwargs -- other processors
    # (e.g. Nemotron's) reject them, so there is no default here.
    min_pixels: str = environ.get("VLM_MIN_PIXELS", "")
    max_pixels: str = environ.get("VLM_MAX_PIXELS", "")
    max_images: str = environ.get("VLM_MAX_IMAGES_PER_PROMPT", "8")
    port: str = environ.get("VLM_PORT", "8000")

    load_lock_file: str = environ.get("VLM_LOAD_LOCK_FILE", "")
    state_file: str = environ.get("VLM_STATE_FILE", "")
    health_timeout: str = environ.get("VLM_HEALTH_TIMEOUT_SECONDS", "1800")
    health_poll: str = environ.get("VLM_HEALTH_POLL_SECONDS", "2")
    sleep_level: str = environ.get("VLM_SLEEP_LEVEL", "1")
    sleep_mode: bool = parse_bool("VLM_SLEEP_MODE", environ.get("VLM_SLEEP_MODE", ""))

    # Self-sleep goes through /sleep, which only exists in dev mode. Refuse the
    # combination up front rather than leaving an engine awake that the pool is
    # sized for asleep.
    if state_file and not sleep_mode:
        raise ConfigError(
            "VLM_STATE_FILE needs VLM_SLEEP_MODE=1 (the /sleep endpoint)."
        )

    env: dict[str, str] = pin_gpus(environ.get("VLM_GPU_IDS", ""))

    # fp8 KV cache halves KV memory (more concurrency per GB) but is not
    # supported on pre-Ada GPUs. Unless VLM_KV_CACHE_DTYPE is set, pick fp8
    # only when the hardware supports it.
    kv_cache_dtype: str = environ.get("VLM_KV_CACHE_DTYPE", "")
    capability: float | None = probe_gpus(environ.get("VLM_GPU_IDS", ""))
    if not kv_cache_dtype:
        if capability is not None and capability >= FP8_KV_CACHE_MIN_COMPUTE_CAPABILITY:
            kv_cache_dtype = "fp8"
            log(f"compute capability {capability} >= 8.9 -> --kv-cache-dtype fp8.")
        else:
            shown: str = "unknown" if capability is None else str(capability)
            kv_cache_dtype = "auto"
            log(
                f"compute capability '{shown}' (< 8.9 or probe failed) "
                "-> --kv-cache-dtype auto."
            )

    args: list[str] = [
        f"--port={port}",
        f"--served-model-name={model}",
        f"--max-model-len={max_model_len}",
        f"--gpu-memory-utilization={gpu_memory_utilization}",
        f"--max-num-batched-tokens={max_num_batched_tokens}",
        f"--tensor-parallel-size={tensor_parallel_size}",
        f"--kv-cache-dtype={kv_cache_dtype}",
        "--no-enable-prefix-caching",
        "--mm-processor-cache-gb=0",
        f'--limit-mm-per-prompt={{"image": {max_images}, "video": 0}}',
    ]

    # Processor kwargs only when the model's env file sets pixel caps.
    if min_pixels or max_pixels:
        pairs: list[str] = []
        if min_pixels:
            pairs.append(f'"min_pixels": {min_pixels}')
        if max_pixels:
            pairs.append(f'"max_pixels": {max_pixels}')
        args.append(f"--mm-processor-kwargs={{{', '.join(pairs)}}}")

    # --max-num-seqs: pin to the value, or omit when "auto" so vLLM sizes it
    # to this GPU's KV capacity.
    if max_num_seqs == "auto":
        log(
            "VLM_MAX_NUM_SEQS=auto -> letting vLLM derive --max-num-seqs from KV capacity."
        )
    else:
        args.append(f"--max-num-seqs={max_num_seqs}")

    # Sleep mode is what makes an engine parkable: the process, its compiled
    # graphs and its warm state survive, but the GPU memory does not.
    if sleep_mode:
        env["VLLM_SERVER_DEV_MODE"] = "1"
        args.append("--enable-sleep-mode")
        log("VLM_SLEEP_MODE -> --enable-sleep-mode, VLLM_SERVER_DEV_MODE=1.")

    # Escape hatch for vLLM flags not exposed above (e.g. --quantization).
    args.extend(environ.get("VLM_EXTRA_ARGS", "").split())

    return LaunchPlan(
        source="env",
        model=model,
        args=args,
        env=env,
        port=int(port),
        sleep_mode=sleep_mode,
        sleep_level=int(sleep_level),
        active=None,
        state_file=state_file,
        load_lock_file=load_lock_file,
        health_timeout_seconds=int(health_timeout),
        health_poll_seconds=float(health_poll),
    )


def build_plan(environ: dict[str, str]) -> LaunchPlan:
    spec_file: str = spec_path_from_env(environ)
    if spec_file:
        timeout: int = int(
            environ.get("VIF_SPEC_TIMEOUT_SECONDS", str(DEFAULT_SPEC_TIMEOUT_SECONDS))
        )
        log(f"engine spec: {spec_file}")
        return plan_from_spec(wait_for_spec(spec_file, timeout), environ)
    return plan_from_env(environ)


# ── the supervisor and its duties ──────────────────────────────────────────


class Engine:
    """The vLLM child process, its load lock, and its self-sleep."""

    def __init__(self, plan: LaunchPlan) -> None:
        self.plan: LaunchPlan = plan
        self.child: subprocess.Popen[bytes] | None = None
        self.terminating: bool = False
        self._lock_file: TextIO | None = None

    # -- signals ------------------------------------------------------------

    def forward_signal(self, signum: int, _frame: FrameType | None) -> None:
        self.terminating = True
        if self.child is not None and self.child.poll() is None:
            self.child.send_signal(signum)

    # -- load lock ----------------------------------------------------------

    def take_load_lock(self) -> None:
        if not self.plan.load_lock_file:
            return
        self._lock_file = open(self.plan.load_lock_file, "a", encoding="utf-8")
        log(f"waiting for the load lock ({self.plan.load_lock_file})...")
        fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX)
        log("load lock acquired.")

    def release_load_lock(self) -> None:
        # flock also drops when the process dies; releasing explicitly is what
        # lets the next engine start while this one keeps serving.
        if self._lock_file is None:
            return
        fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
        self._lock_file.close()
        self._lock_file = None
        log("load lock released.")

    # -- health -------------------------------------------------------------

    def wait_for_health(self) -> int:
        """0 ready, 1 timed out, 2 the engine exited or we are shutting down."""
        deadline: float = time.monotonic() + self.plan.health_timeout_seconds
        url: str = f"http://127.0.0.1:{self.plan.port}/health"
        while time.monotonic() < deadline:
            if self.terminating:
                return 2
            if self.child is None or self.child.poll() is not None:
                return 2
            # Every probe is time-boxed: a wedged engine still accepts
            # connections, so an untimed request would wait out the very
            # deadline it is being polled against. A failed probe is the
            # normal case while the model loads -- stay quiet about it.
            try:
                with urllib.request.urlopen(url, timeout=5) as response:
                    if 200 <= response.status < 300:
                        return 0
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(self.plan.health_poll_seconds)
        return 1

    # -- self-sleep ---------------------------------------------------------

    def _read_active_model(self) -> str:
        try:
            for line in (
                Path(self.plan.state_file).read_text(encoding="utf-8").splitlines()
            ):
                if line.strip():
                    return line.strip()
        except OSError:
            return ""
        return ""

    def should_stay_awake(self) -> bool:
        if self.plan.active is not None:
            return self.plan.active
        active: str = self._read_active_model()
        if active and active == self.plan.model:
            log(f"state file names {self.plan.model} -> staying awake.")
            return True
        log(f"active model is '{active or '<none>'}', not {self.plan.model}.")
        return False

    def maybe_self_sleep(self) -> None:
        """
        Park unless this engine is the one that should be serving. An absent,
        unreadable or foreign state file all mean the same thing: this engine
        is not the one that should be holding the card.
        """
        if not self.plan.has_sleep_duty or self.should_stay_awake():
            return
        log(f"sleeping at level {self.plan.sleep_level}.")
        request: urllib.request.Request = urllib.request.Request(
            f"http://127.0.0.1:{self.plan.port}/sleep?level={self.plan.sleep_level}",
            method="POST",
        )
        api_key: str = os.environ.get("VLLM_API_KEY", "")
        if api_key:
            request.add_header("Authorization", f"Bearer {api_key}")
        try:
            with urllib.request.urlopen(request, timeout=30):
                log("asleep.")
        except (urllib.error.URLError, OSError) as exc:
            warn(
                f"/sleep failed ({exc}); this engine stays awake and keeps its GPU memory."
            )

    # -- process lifecycle --------------------------------------------------

    def start(self) -> None:
        self.child = subprocess.Popen(self.plan.argv)

    def await_child(self) -> int:
        assert self.child is not None
        status: int = self.child.wait()
        # A signalled child comes back as -N here and as 128+N from bash's
        # `wait`; keep the container's exit code what the shell produced.
        return 128 + abs(status) if status < 0 else status

    def stop_child(self) -> None:
        """
        A wedged engine may be unable to act on SIGTERM at all, so fall back to
        SIGKILL rather than hang here.
        """
        assert self.child is not None
        self.child.terminate()
        try:
            self.child.wait(timeout=STOP_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()


def supervise(plan: LaunchPlan) -> int:
    engine: Engine = Engine(plan)
    signal.signal(signal.SIGTERM, engine.forward_signal)
    signal.signal(signal.SIGINT, engine.forward_signal)

    engine.take_load_lock()
    engine.start()

    health: int = engine.wait_for_health()
    if health == 0:
        engine.maybe_self_sleep()
        engine.release_load_lock()
    elif health == 1:
        warn(
            f"no /health in {plan.health_timeout_seconds}s; "
            "releasing the lock and stopping."
        )
        engine.release_load_lock()
        engine.stop_child()
        return EXIT_HEALTH_TIMEOUT
    else:
        engine.release_load_lock()

    return engine.await_child()


# ── entry point ────────────────────────────────────────────────────────────


def describe(plan: LaunchPlan) -> dict[str, Any]:
    return {
        "launcher_revision": LAUNCHER_REVISION,
        "source": plan.source,
        "argv": plan.argv,
        "env": plan.env,
        "duties": {
            "port": plan.port,
            "sleep_mode": plan.sleep_mode,
            "sleep_level": plan.sleep_level,
            "active": plan.active,
            "state_file": plan.state_file,
            "load_lock_file": plan.load_lock_file,
            "health_timeout_seconds": plan.health_timeout_seconds,
            "supervised": plan.needs_supervision,
        },
    }


def main() -> int:
    global _LOG_STREAM
    try:
        dry_run: bool = parse_bool(
            "VIF_LAUNCHER_DRY_RUN", os.environ.get("VIF_LAUNCHER_DRY_RUN", "")
        )
        if dry_run:
            _LOG_STREAM = sys.stderr
        log(f"revision {LAUNCHER_REVISION}")
        plan: LaunchPlan = build_plan(dict(os.environ))
    except ConfigError as exc:
        warn(str(exc))
        return EXIT_CONFIG

    if dry_run:
        print(json.dumps(describe(plan), indent=2))
        return 0

    log("Launching vLLM with:")
    for part in [plan.model, *plan.args]:
        log(f"  {part}")
    max_model_len: str = next(
        (
            arg.split("=", 1)[1]
            for arg in plan.args
            if arg.startswith("--max-model-len=")
        ),
        "<max_model_len>",
    )
    log(
        f"On startup, find: 'Maximum concurrency for {max_model_len} tokens "
        "per request: <Y>x'"
    )
    log("-> set VLM_MAX_NUM_SEQS to floor(<Y>) to match THIS GPU's KV capacity.")

    if plan.sleep_mode:
        warn_if_sleep_mode_cannot_work()

    os.environ.update(plan.env)

    # Nothing to do once the engine is up: hand the container straight to vLLM.
    if not plan.needs_supervision:
        os.execvp(plan.argv[0], plan.argv)

    return supervise(plan)


if __name__ == "__main__":
    sys.exit(main())
