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
                               that must sleep, until it is asleep), so cold
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
  VIF_STATE_DIR                The state volume: where specs live when the path
                               is not given (<dir>/engines/<engine key>.json),
                               and where the log tee (<dir>/logs/) and the
                               readiness markers (<dir>/ready/) go.
  VIF_SPEC_TIMEOUT_SECONDS     How long to wait for VIS to write the spec
                               before exiting 78 (default 300).
  VIF_WATCH_POLL_SECONDS       How often the spec is re-read once the engine is
                               running (default 2).
  VIF_ACTIVE_READY_TIMEOUT_SECONDS
                               How long a non-active engine waits for the active
                               one to publish its readiness marker before taking
                               the load lock anyway (default 1800). The bound
                               exists so an engine that never arrives cannot
                               wedge the pool.
  VIF_ENGINE_LOG_FILE          Override for where the child's output is teed.

  VIF_LAUNCHER_DRY_RUN=1       Print the fully resolved command and env as
                               JSON and exit without starting anything.

THE DESIRED STATE, AND THE WATCH LOOP. A spec names one of three states, and
this script keeps following the spec for as long as it runs (re-read every
couple of seconds; a spec whose content has not changed costs one read):

  awake    the engine serves.
  asleep   the engine's weights are in host RAM (vLLM sleep level 1). The
           process, its CUDA context and its compiled graphs stay; it is back
           in a second or two.
  parked   no engine process at all -- the weights are on disk and this script
           answers /health itself, so the container stays healthy. Back in a
           cold start (a minute or two). This is the cold tier, and the only
           state available to an engine that cannot be woken from sleep.

VIS moves an engine between those three by rewriting its spec; nothing else
is needed on this side.

THE POOL DUTIES, when several engines share one card:

  * the LOAD LOCK serializes cold loads, so five engines starting at once do
    not thrash the disk and the GPU. The engine that should be serving takes
    it first: every other engine waits until that one publishes its readiness
    marker before it even asks for the lock, because flock is not fair.
  * the LOG TEE copies the engine's output to <state dir>/logs/<key>.log as
    well as to this container's stdout, which is how the Manager shows engine
    logs without VIS ever holding a Docker socket.

EXIT CODES: 75 health-check timeout, 78 bad configuration (including a spec
that never arrives); anything else is vLLM's own.
"""

import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from dataclasses import dataclass, field
from enum import StrEnum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import FrameType
from typing import IO, Any, TextIO

# Bump on every edit to this file.
LAUNCHER_REVISION: str = "2026-09-22"

EXIT_HEALTH_TIMEOUT: int = 75
EXIT_CONFIG: int = 78
# Grace between SIGTERM and SIGKILL when this script stops a wedged engine.
STOP_GRACE_SECONDS: int = 10

ENGINE_SPEC_VERSION: int = 1
ENGINE_SPEC_DIRNAME: str = "engines"
ENGINE_LOG_DIRNAME: str = "logs"
ENGINE_READY_DIRNAME: str = "ready"
ACTIVE_MODEL_FILENAME: str = "active-model"
DEFAULT_STATE_DIR: str = "/vif-state"
DEFAULT_SPEC_TIMEOUT_SECONDS: int = 300
# How often the desired state is re-read. Fast enough that a switch is not
# noticeably slower for it, slow enough to be free.
DEFAULT_WATCH_POLL_SECONDS: float = 2.0
# How long a non-active engine waits for the active one to be ready before it
# gives up on the priority and loads anyway. Never wedge the pool on one
# engine that is not coming.
DEFAULT_ACTIVE_READY_TIMEOUT_SECONDS: int = 1800
READY_POLL_SECONDS: float = 2.0

FP8_KV_CACHE_MIN_COMPUTE_CAPABILITY: float = 8.9

_TRUE: frozenset[str] = frozenset({"1", "true", "yes"})
_FALSE: frozenset[str] = frozenset({"", "0", "false", "no"})
_NON_SLUG: re.Pattern[str] = re.compile(r"[^a-z0-9]+")


class ConfigError(Exception):
    """Something is wrong with the configuration; the engine never starts."""


class DesiredState(StrEnum):
    """What the spec says this engine should be right now."""

    AWAKE = "awake"
    ASLEEP = "asleep"
    PARKED = "parked"


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
    # The spec's desired state. On the legacy path it is the starting point
    # and the state file decides from then on.
    desired_state: DesiredState = DesiredState.AWAKE
    spec_file: str = ""
    # The file naming the model that should be serving: the spec path derives
    # it from the state volume, the legacy path takes VLM_STATE_FILE.
    state_file: str = ""
    # Where this engine publishes "I am loaded", and where it looks for the
    # active engine's own marker before asking for the load lock.
    ready_dir: str = ""
    log_file: str = ""
    load_lock_file: str = ""
    health_timeout_seconds: int = 1800
    health_poll_seconds: float = 2.0
    watch_poll_seconds: float = DEFAULT_WATCH_POLL_SECONDS
    active_ready_timeout_seconds: int = DEFAULT_ACTIVE_READY_TIMEOUT_SECONDS

    @property
    def argv(self) -> list[str]:
        return ["vllm", "serve", self.model, *self.args]

    @property
    def ready_file(self) -> str:
        """This engine's own readiness marker, or "" when there is nowhere."""
        if not self.ready_dir:
            return ""
        return str(Path(self.ready_dir) / engine_key(self.model))

    @property
    def watches(self) -> bool:
        """Whether a desired state can change under this engine while it runs."""
        return bool(self.spec_file) or bool(self.state_file)

    @property
    def needs_supervision(self) -> bool:
        """
        False only for the bare legacy case: no pool, no manager, no log tee.

        There the container is handed straight to vLLM, exactly as the bash
        entrypoint did, and the engine is PID 1.
        """
        return bool(self.load_lock_file) or self.watches or bool(self.log_file)


# ── shared helpers ─────────────────────────────────────────────────────────


def engine_key(model_id: str) -> str:
    """Filesystem-safe key for a model id. Mirrors VIS's app/vlm/engine_spec.py."""
    return _NON_SLUG.sub("-", model_id.lower()).strip("-")


def engine_log_file(environ: dict[str, str], state_dir: str, model: str) -> str:
    """
    Where this engine's output is teed, on top of the container's own stdout.

    VIS reads this file to show engine logs in the Manager, which is how that
    works without VIS ever holding a Docker socket.
    """
    explicit: str = environ.get("VIF_ENGINE_LOG_FILE", "").strip()
    if explicit:
        return explicit
    if not state_dir:
        return ""
    return str(Path(state_dir) / ENGINE_LOG_DIRNAME / f"{engine_key(model)}.log")


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


def state_dir_from_env(environ: dict[str, str], spec_file: str) -> str:
    """
    The state volume, which is what the log tee and the readiness markers use.

    Normally VIF_STATE_DIR; when only an explicit spec path was given, the
    volume is that file's grandparent (<dir>/engines/<key>.json).
    """
    state_dir: str = environ.get("VIF_STATE_DIR", "").strip()
    if state_dir:
        return state_dir
    if spec_file:
        return str(Path(spec_file).resolve().parent.parent)
    return ""


def read_desired_state(document: dict[str, Any]) -> DesiredState:
    """
    The spec's desired state, falling back to what `active` used to mean.

    `desired_state` is optional so the frozen spec_version 1 stays readable
    both ways: a spec written before the cold tier existed says only `active`,
    and awake/asleep is exactly what it meant.
    """
    raw: Any = document.get("desired_state")
    if raw is None:
        return DesiredState.AWAKE if bool(document["active"]) else DesiredState.ASLEEP
    try:
        return DesiredState(str(raw))
    except ValueError:
        raise ConfigError(
            f"engine spec desired_state {raw!r} is not one of "
            f"{', '.join(state.value for state in DesiredState)}"
        ) from None


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
    model: str = str(document["model"])
    desired: DesiredState = read_desired_state(document)
    if desired is DesiredState.ASLEEP and not sleep_mode:
        # Capability beats configuration, on this side too: an engine with no
        # /sleep endpoint cannot put itself to sleep, so it parks -- the only
        # way it has of standing down -- rather than staying awake and holding
        # a card it was not given. VIS writes "parked" for such engines
        # already; this is the backstop.
        warn(
            f"the engine spec asks {model} to be asleep but sleep mode is off; "
            "parking it instead (no engine process, health stub only)."
        )
        desired = DesiredState.PARKED

    spec_file: str = spec_path_from_env(environ)
    state_dir: str = state_dir_from_env(environ, spec_file)
    return LaunchPlan(
        source="spec",
        model=model,
        args=[str(arg) for arg in document["args"]],
        env=env,
        port=int(document["port"]),
        sleep_mode=sleep_mode,
        sleep_level=int(document.get("sleep_level", 1)),
        desired_state=desired,
        spec_file=spec_file,
        state_file=str(Path(state_dir) / ACTIVE_MODEL_FILENAME) if state_dir else "",
        ready_dir=str(Path(state_dir) / ENGINE_READY_DIRNAME) if state_dir else "",
        log_file=engine_log_file(environ, state_dir, model),
        load_lock_file=str(document.get("load_lock_file") or ""),
        health_timeout_seconds=int(document.get("health_timeout_seconds", 1800)),
        health_poll_seconds=float(environ.get("VLM_HEALTH_POLL_SECONDS", "2")),
        watch_poll_seconds=float(
            environ.get("VIF_WATCH_POLL_SECONDS", str(DEFAULT_WATCH_POLL_SECONDS))
        ),
        active_ready_timeout_seconds=int(
            environ.get(
                "VIF_ACTIVE_READY_TIMEOUT_SECONDS",
                str(DEFAULT_ACTIVE_READY_TIMEOUT_SECONDS),
            )
        ),
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

    # Sleep mode is what lets an engine stand down without dying: the process,
    # its compiled graphs and its warm state survive, but the GPU memory does
    # not.
    if sleep_mode:
        env["VLLM_SERVER_DEV_MODE"] = "1"
        args.append("--enable-sleep-mode")
        log("VLM_SLEEP_MODE -> --enable-sleep-mode, VLLM_SERVER_DEV_MODE=1.")

    # Escape hatch for vLLM flags not exposed above (e.g. --quantization).
    args.extend(environ.get("VLM_EXTRA_ARGS", "").split())

    state_dir: str = environ.get("VIF_STATE_DIR", "").strip()
    return LaunchPlan(
        source="env",
        model=model,
        args=args,
        env=env,
        port=int(port),
        sleep_mode=sleep_mode,
        sleep_level=int(sleep_level),
        # The state file decides from here on; awake is only where it starts.
        desired_state=DesiredState.AWAKE,
        state_file=state_file,
        ready_dir=str(Path(state_dir) / ENGINE_READY_DIRNAME) if state_dir else "",
        log_file=engine_log_file(environ, state_dir, model),
        load_lock_file=load_lock_file,
        health_timeout_seconds=int(health_timeout),
        health_poll_seconds=float(health_poll),
        watch_poll_seconds=float(
            environ.get("VIF_WATCH_POLL_SECONDS", str(DEFAULT_WATCH_POLL_SECONDS))
        ),
        active_ready_timeout_seconds=int(
            environ.get(
                "VIF_ACTIVE_READY_TIMEOUT_SECONDS",
                str(DEFAULT_ACTIVE_READY_TIMEOUT_SECONDS),
            )
        ),
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


def _digest_of(path: str) -> str:
    """A file's content hash, or "" when there is nothing to hash."""
    if not path:
        return ""
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return ""


class ParkedStub:
    """
    The HTTP server a parked engine leaves in place of its vLLM process.

    Parking stops the child, which would otherwise leave the container's port
    dead and its compose healthcheck failing on an engine that is doing
    exactly what it was told. This answers `/health` so the container stays
    healthy, and `/vif/parked` so anything asking can tell "parked on purpose"
    from "started without dev mode". Everything else 404s, `/is_sleeping`
    included: a parked engine genuinely does not have one.
    """

    def __init__(self) -> None:
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self._server is not None

    def start(self, port: int, model: str) -> None:
        if self._server is not None:
            return
        body: bytes = json.dumps(
            {
                "parked": True,
                "model": model,
                "launcher_revision": LAUNCHER_REVISION,
            }
        ).encode("utf-8")

        class Handler(BaseHTTPRequestHandler):
            protocol_version: str = "HTTP/1.1"

            def log_message(self, fmt: str, *args: Any) -> None:
                return

            def _send(self, status: int, payload: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:
                path: str = self.path.split("?", 1)[0]
                if path in ("/health", "/vif/parked"):
                    self._send(200, body)
                    return
                self._send(404, b"{}")

            def do_POST(self) -> None:
                self._send(404, b"{}")

        self._server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True, name="parked-stub"
        )
        self._thread.start()
        log(f"parked: no engine process; serving the health stub on :{port}.")

    def stop(self) -> None:
        if self._server is None:
            return
        self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=10)
        self._server = None
        self._thread = None
        log("parked stub stopped.")


class Engine:
    """The vLLM child process, its pool duties, and the state it is told to be in."""

    def __init__(self, plan: LaunchPlan, environ: dict[str, str]) -> None:
        self.plan: LaunchPlan = plan
        self.environ: dict[str, str] = environ
        self.child: subprocess.Popen[bytes] | None = None
        self.terminating: bool = False
        # Nothing has been entered yet: no process, no stub.
        self.state: DesiredState = DesiredState.PARKED
        self._stub: ParkedStub = ParkedStub()
        self._lock_file: TextIO | None = None
        self._tee: threading.Thread | None = None
        self._spec_digest: str = _digest_of(plan.spec_file)
        self._log_warned: bool = False
        self._announced_awake: bool | None = None

    # -- signals ------------------------------------------------------------

    def forward_signal(self, signum: int, _frame: FrameType | None) -> None:
        self.terminating = True
        if self.child is not None and self.child.poll() is None:
            self.child.send_signal(signum)

    # -- load lock ----------------------------------------------------------

    def take_load_lock(self) -> None:
        if not self.plan.load_lock_file or self._lock_file is not None:
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

    def wait_for_active_engine(self, target: DesiredState) -> None:
        """
        Lock priority: whoever should be serving loads first.

        `flock` has no fairness, so a neighbour that asks at the wrong moment
        takes the lock ahead of the engine every stream is waiting for and
        makes it load last. A non-active engine therefore does not even ask
        until the active one has published its readiness marker. The wait is
        bounded: an active engine that never arrives must not wedge the pool.
        """
        if target is DesiredState.AWAKE or not self.plan.ready_dir:
            return
        active: str = self.read_active_model()
        if not active or active == self.plan.model:
            return
        marker: Path = Path(self.plan.ready_dir) / engine_key(active)
        deadline: float = time.monotonic() + self.plan.active_ready_timeout_seconds
        announced: bool = False
        while not marker.exists():
            if self.terminating:
                return
            if time.monotonic() >= deadline:
                warn(
                    f"the active engine ({active}) was not ready within "
                    f"{self.plan.active_ready_timeout_seconds}s; taking the load "
                    "lock anyway."
                )
                return
            if not announced:
                log(
                    f"waiting for the active engine ({active}) to be ready "
                    "before asking for the load lock..."
                )
                announced = True
            time.sleep(READY_POLL_SECONDS)
        log(f"the active engine ({active}) is ready.")

    def mark_ready(self) -> None:
        """Publish "this engine is loaded", for the neighbours waiting on it."""
        path: str = self.plan.ready_file
        if not path:
            return
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(f"{self.plan.model}\n", encoding="utf-8")
        except OSError as exc:
            warn(f"the readiness marker {path} could not be written ({exc}).")

    def clear_ready(self) -> None:
        path: str = self.plan.ready_file
        if not path:
            return
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass

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

    # -- the desired state --------------------------------------------------

    def read_active_model(self) -> str:
        try:
            for line in (
                Path(self.plan.state_file).read_text(encoding="utf-8").splitlines()
            ):
                if line.strip():
                    return line.strip()
        except OSError:
            return ""
        return ""

    def poll_desired(self) -> DesiredState:
        """What the spec (or the state file) says this engine should be now."""
        if self.plan.spec_file:
            return self._desired_from_spec()
        if self.plan.state_file:
            return self._desired_from_state_file()
        return self.plan.desired_state

    def _desired_from_spec(self) -> DesiredState:
        """
        Re-read the spec, and adopt it if it changed.

        A spec that will not parse is a snapshot of a write in flight, not a
        decision: VIS renames its writes into place, so the only way to see
        half a file is to have read it mid-rename on a filesystem that allows
        it. Either way the answer is to keep the spec already in hand.
        """
        try:
            raw: str = Path(self.plan.spec_file).read_text(encoding="utf-8")
        except OSError:
            return self.plan.desired_state
        digest: str = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        if digest == self._spec_digest:
            return self.plan.desired_state
        try:
            fresh: LaunchPlan = plan_from_spec(json.loads(raw), self.environ)
        except (json.JSONDecodeError, ConfigError) as exc:
            warn(
                f"the engine spec changed but is unusable ({exc}); "
                "keeping the last one."
            )
            return self.plan.desired_state
        self._spec_digest = digest
        if fresh.argv != self.plan.argv or fresh.env != self.plan.env:
            warn(
                "the engine spec's command changed; it takes effect the next "
                "time this engine starts."
            )
        self.plan = fresh
        return fresh.desired_state

    def _desired_from_state_file(self) -> DesiredState:
        """The legacy path's desired state: awake only if the file names us."""
        active: str = self.read_active_model()
        awake: bool = bool(active) and active == self.plan.model
        if awake != self._announced_awake:
            if awake:
                log(f"state file names {self.plan.model} -> staying awake.")
            else:
                log(f"active model is '{active or '<none>'}', not {self.plan.model}.")
            self._announced_awake = awake
        return DesiredState.AWAKE if awake else DesiredState.ASLEEP

    # -- sleep and wake -----------------------------------------------------

    def _control(self, path: str, what: str) -> bool:
        request: urllib.request.Request = urllib.request.Request(
            f"http://127.0.0.1:{self.plan.port}{path}", method="POST"
        )
        api_key: str = self.environ.get("VLLM_API_KEY", "")
        if api_key:
            request.add_header("Authorization", f"Bearer {api_key}")
        try:
            with urllib.request.urlopen(request, timeout=120):
                return True
        except (urllib.error.URLError, OSError) as exc:
            warn(f"{what} failed ({exc}).")
            return False

    def sleep_now(self) -> None:
        """Sleep in host RAM. A failure leaves the engine awake, and says so."""
        if not self.plan.sleep_mode:
            warn(
                "this engine has no /sleep endpoint, so it cannot sleep; "
                "it stays awake and keeps its GPU memory."
            )
            return
        log(f"sleeping at level {self.plan.sleep_level}.")
        if self._control(f"/sleep?level={self.plan.sleep_level}", "/sleep"):
            self.state = DesiredState.ASLEEP
            self.clear_ready()
            log("asleep.")
        else:
            warn("this engine stays awake and keeps its GPU memory.")

    def wake_now(self) -> None:
        """Come back from host RAM. A failure leaves it asleep, and says so."""
        log("waking.")
        if self._control("/wake_up", "/wake_up"):
            self.state = DesiredState.AWAKE
            self.mark_ready()
            log("awake.")
        else:
            warn("this engine stays asleep; VIS decides what happens next.")

    # -- process lifecycle --------------------------------------------------

    def _open_log(self) -> IO[bytes] | None:
        if not self.plan.log_file:
            return None
        try:
            Path(self.plan.log_file).parent.mkdir(parents=True, exist_ok=True)
            return open(self.plan.log_file, "ab", buffering=0)
        except OSError as exc:
            if not self._log_warned:
                warn(
                    f"engine logs are not being teed to {self.plan.log_file} "
                    f"({exc}); the Manager's log view will be empty."
                )
                self._log_warned = True
            return None

    def _tee_output(self, stream: IO[bytes]) -> None:
        """
        Copy the child's output to the container's stdout AND to the volume.

        Line by line and unbuffered on both sides: a log tail is only useful
        while the engine is still running.
        """
        handle: IO[bytes] | None = self._open_log()
        try:
            for line in stream:
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
                if handle is None:
                    continue
                try:
                    handle.write(line)
                except OSError as exc:
                    if not self._log_warned:
                        warn(f"engine logs stopped being teed ({exc}).")
                        self._log_warned = True
                    handle.close()
                    handle = None
        finally:
            if handle is not None:
                handle.close()

    def start(self) -> None:
        if not self.plan.log_file:
            self.child = subprocess.Popen(self.plan.argv)
            return
        self.child = subprocess.Popen(
            self.plan.argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        assert self.child.stdout is not None
        self._tee = threading.Thread(
            target=self._tee_output,
            args=(self.child.stdout,),
            daemon=True,
            name="log-tee",
        )
        self._tee.start()

    def await_child(self) -> int:
        assert self.child is not None
        status: int = self.child.wait()
        self._join_tee()
        # A signalled child comes back as -N here and as 128+N from bash's
        # `wait`; keep the container's exit code what the shell produced.
        return 128 + abs(status) if status < 0 else status

    def stop_child(self) -> None:
        """
        A wedged engine may be unable to act on SIGTERM at all, so fall back to
        SIGKILL rather than hang here.
        """
        if self.child is None:
            return
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=STOP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                warn(
                    f"the engine ignored SIGTERM for {STOP_GRACE_SECONDS}s; killing it."
                )
                self.child.kill()
                self.child.wait()
        self._join_tee()
        self.child = None
        self.clear_ready()
        # The lock is never held across a park: whoever loads next must not
        # wait on an engine that no longer exists.
        self.release_load_lock()

    def _join_tee(self) -> None:
        if self._tee is None:
            return
        self._tee.join(timeout=10)
        self._tee = None

    # -- the state machine --------------------------------------------------

    def start_engine(self, target: DesiredState) -> int | None:
        """
        Bring the engine up and leave it in `target`.

        Returns an exit code only when the container itself should stop.
        """
        self.wait_for_active_engine(target)
        self.take_load_lock()
        self.start()
        health: int = self.wait_for_health()
        if health == 1:
            warn(
                f"no /health in {self.plan.health_timeout_seconds}s; "
                "releasing the lock and stopping."
            )
            self.release_load_lock()
            self.stop_child()
            return EXIT_HEALTH_TIMEOUT
        if health == 2:
            self.release_load_lock()
            return self.await_child()

        self.state = DesiredState.AWAKE
        self.mark_ready()
        if target is DesiredState.ASLEEP:
            self.sleep_now()
        self.release_load_lock()
        return None

    def enter(self, target: DesiredState) -> int | None:
        """One desired-state transition. An exit code means the container stops."""
        if target is self.state:
            return None
        log(f"desired state: {self.state} -> {target}.")
        if target is DesiredState.PARKED:
            self.stop_child()
            self.state = DesiredState.PARKED
            self._stub.start(self.plan.port, self.plan.model)
            return None
        if self.state is DesiredState.PARKED:
            self._stub.stop()
            return self.start_engine(target)
        if target is DesiredState.ASLEEP:
            self.sleep_now()
        else:
            self.wake_now()
        return None

    def run(self) -> int:
        """
        Follow the desired state until the engine exits or we are stopped.

        The loop is the whole cold tier: VIS moves an engine between awake,
        asleep and parked by rewriting its spec, and this is what acts on it.
        """
        target: DesiredState = self.poll_desired()
        if target is DesiredState.PARKED:
            self._stub.start(self.plan.port, self.plan.model)
        else:
            code: int | None = self.start_engine(target)
            if code is not None:
                return code

        while not self.terminating:
            if self.child is not None and self.child.poll() is not None:
                return self.await_child()
            if self.plan.watches:
                code = self.enter(self.poll_desired())
                if code is not None:
                    return code
            time.sleep(self.plan.watch_poll_seconds)

        if self.child is not None:
            return self.await_child()
        return 0

    def close(self) -> None:
        self.clear_ready()
        self.release_load_lock()
        self._stub.stop()


def supervise(plan: LaunchPlan, environ: dict[str, str]) -> int:
    engine: Engine = Engine(plan, environ)
    signal.signal(signal.SIGTERM, engine.forward_signal)
    signal.signal(signal.SIGINT, engine.forward_signal)
    try:
        return engine.run()
    finally:
        engine.close()


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
            "desired_state": plan.desired_state.value,
            "spec_file": plan.spec_file,
            "state_file": plan.state_file,
            "ready_file": plan.ready_file,
            "log_file": plan.log_file,
            "load_lock_file": plan.load_lock_file,
            "health_timeout_seconds": plan.health_timeout_seconds,
            "watches": plan.watches,
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

    os.environ.update(plan.env)

    if plan.desired_state is DesiredState.PARKED:
        log(f"{plan.model} starts parked: no engine process until VIS asks for one.")
        return supervise(plan, dict(os.environ))

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

    # Nothing to do once the engine is up: hand the container straight to vLLM.
    if not plan.needs_supervision:
        os.execvp(plan.argv[0], plan.argv)

    return supervise(plan, dict(os.environ))


if __name__ == "__main__":
    sys.exit(main())
