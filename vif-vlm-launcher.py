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
                               When the file names this engine again, it wakes
                               itself.
  VLM_SLEEP_LEVEL              Sleep level for that self-sleep (default 1:
                               weights to host RAM; 2 discards them).

MANAGED PATH:
  VIF_ENGINE_SPEC_FILE         Path to this engine's spec on the state volume.
  VIF_STATE_DIR                The state volume: where specs live when the path
                               is not given (<dir>/engines/<engine key>.json),
                               and where the log tee (<dir>/logs/) and the
                               markers (<dir>/ready/, <dir>/awake/) go.
  VIF_SPEC_TIMEOUT_SECONDS     How long to wait for VIS to write the spec
                               before exiting 78 (default 300).
  VIF_WATCH_POLL_SECONDS       How often the spec is re-read once the engine is
                               running (default 2).
  VIF_POOL_LOAD_TIMEOUT_SECONDS
                               How long the engine that should be serving waits
                               for the rest of the hot pool to load before it
                               takes the load lock anyway (default 7800: four
                               other engines, each holding the lock for at most
                               its 1800 s health deadline plus a 120 s step into
                               sleep, rounded up). The bound exists so an engine
                               that never arrives cannot keep the pool from
                               serving.
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
is needed on this side. A sleep or a wake that fails is not retried until the
spec changes: VIS decides what happens to an engine that would not move.

THE POOL DUTIES, when several engines share one card:

  * the LOAD LOCK serializes cold loads, so five engines starting at once do
    not thrash the disk and the GPU.
  * BOOT ORDER: the engine that should be serving loads LAST. Each engine's
    memory reservation is sized on the assumption that every other engine is
    asleep while it loads, so the active one, which stays awake, cannot load
    first. Before it asks for the lock it waits until every other engine whose
    spec says `asleep` has published its readiness marker (loaded, and asleep)
    or rests parked (spec `parked`, or `asleep` without sleep mode). Engines
    whose spec says `parked` are never waited for. The wait is bounded by
    VIF_POOL_LOAD_TIMEOUT_SECONDS, then it loads anyway with a WARNING naming
    who it gave up on.
  * the LOAD GUARD: an engine whose spec says `asleep` and that is not loaded
    does not start loading while another engine's `awake/` marker exists --
    there is no room for it beside a serving engine. It serves the parked
    health stub instead and loads once no awake marker remains, or when its
    spec turns to `awake` (the manager puts the previous engine to sleep
    before it asks). This is what keeps an engine restarted beside a serving
    one from crash-looping.
  * the LOG TEE copies the engine's output to <state dir>/logs/<key>.log as
    well as to this container's stdout, which is how the Manager shows engine
    logs without VIS ever holding a Docker socket.

THE STATE VOLUME, shared with VIS and every other engine:

  <state dir>/engines/<key>.json  this engine's spec          (written by VIS)
  <state dir>/active-model        the id that should serve    (written by VIS)
  <state dir>/ready/<key>         loaded, awake or asleep     (written here)
  <state dir>/awake/<key>         awake and serving           (written here)
  <state dir>/logs/<key>.log      this engine's output        (written here)

The awake marker is created after a load that is not followed by a sleep and
after a successful wake, and removed when the engine goes to sleep, is parked
or stops. Each launcher clears both of its own markers when it starts, so one
left by a launcher that was killed outright never misleads the pool.

AN EMPTY VALUE COUNTS AS UNSET, for every variable above, as it did for the
bash entrypoint's ${VAR:-default}. A value that does not parse (VLM_PORT=abc)
is a configuration error, exit 78, naming the variable.

EXIT CODES: 75 health-check timeout, 78 bad configuration (including a spec
that never arrives), 0 for a SIGTERM that arrives before there is an engine to
pass it to (waiting for the spec, the rest of the pool or the load lock); anything
else is vLLM's own.
"""

import fcntl
import hashlib
import json
import os
import re
import signal
import socket
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
LAUNCHER_REVISION: str = "2026-09-28.4"

EXIT_HEALTH_TIMEOUT: int = 75
EXIT_CONFIG: int = 78
# Grace between SIGTERM and SIGKILL when this script stops a wedged engine.
STOP_GRACE_SECONDS: int = 10

ENGINE_SPEC_VERSION: int = 1
ENGINE_SPEC_DIRNAME: str = "engines"
ENGINE_LOG_DIRNAME: str = "logs"
ENGINE_READY_DIRNAME: str = "ready"
ENGINE_AWAKE_DIRNAME: str = "awake"
ACTIVE_MODEL_FILENAME: str = "active-model"
DEFAULT_STATE_DIR: str = "/vif-state"
DEFAULT_SPEC_TIMEOUT_SECONDS: int = 300
# How often the desired state is re-read. Fast enough that a switch is not
# noticeably slower for it, slow enough to be free.
DEFAULT_WATCH_POLL_SECONDS: float = 2.0
# How long the engine that should be serving waits for the rest of the hot
# pool to load first: the shipped catalog has five models, so at most four
# others, each holding the load lock for at most its health deadline (1800 s)
# plus its step into sleep (the 120 s /sleep call). 4 x 1920 = 7680, rounded up.
DEFAULT_POOL_LOAD_TIMEOUT_SECONDS: int = 7800
READY_POLL_SECONDS: float = 2.0
LOCK_POLL_SECONDS: float = 0.2

FP8_KV_CACHE_MIN_COMPUTE_CAPABILITY: float = 8.9

_TRUE: frozenset[str] = frozenset({"1", "true", "yes"})
_FALSE: frozenset[str] = frozenset({"", "0", "false", "no"})
_NON_SLUG: re.Pattern[str] = re.compile(r"[^a-z0-9]+")


class ConfigError(Exception):
    """Something is wrong with the configuration; the engine never starts."""


class Stopped(Exception):
    """A stop signal arrived before there was an engine to hand it to."""


# Set by SIGTERM/SIGINT from the moment main() starts. Every wait in this file
# polls it: the launcher is PID 1, which ignores a signal it has no handler for.
_STOP: threading.Event = threading.Event()
STOP_POLL_SECONDS: float = 0.1


def request_stop(_signum: int, _frame: FrameType | None) -> None:
    _STOP.set()


def pause(seconds: float) -> bool:
    """Sleep up to `seconds`, cut short by a stop. True when one was requested."""
    deadline: float = time.monotonic() + seconds
    while not _STOP.is_set():
        remaining: float = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(STOP_POLL_SECONDS, remaining))
    return _STOP.is_set()


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
    # Where this engine publishes "I am loaded" and "I am serving", and where
    # it reads the other engines' markers.
    ready_dir: str = ""
    awake_dir: str = ""
    # The other engines' specs, which the boot order reads. Spec path only.
    engines_dir: str = ""
    log_file: str = ""
    load_lock_file: str = ""
    health_timeout_seconds: int = 1800
    health_poll_seconds: float = 2.0
    watch_poll_seconds: float = DEFAULT_WATCH_POLL_SECONDS
    pool_load_timeout_seconds: int = DEFAULT_POOL_LOAD_TIMEOUT_SECONDS

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
    def awake_file(self) -> str:
        """This engine's own awake marker, or "" when there is nowhere."""
        if not self.awake_dir:
            return ""
        return str(Path(self.awake_dir) / engine_key(self.model))

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
    """
    Filesystem-safe key for a model id: the same rule as the engine-spec format
    the Video Intelligence Service writes.
    """
    return _NON_SLUG.sub("-", model_id.lower()).strip("-")


def engine_log_file(environ: dict[str, str], state_dir: str, model: str) -> str:
    """
    Where this engine's output is teed, on top of the container's own stdout.

    VIS reads this file to show engine logs in the Manager, which is how that
    works without VIS ever holding a Docker socket.
    """
    explicit: str = env_value(environ, "VIF_ENGINE_LOG_FILE")
    if explicit:
        return explicit
    if not state_dir:
        return ""
    return str(Path(state_dir) / ENGINE_LOG_DIRNAME / f"{engine_key(model)}.log")


def env_value(environ: dict[str, str], name: str, default: str = "") -> str:
    """
    A knob's value, stripped, or `default` when it is unset OR blank.

    Compose passes a variable listed in the service but empty in .env as "",
    and the bash launcher this replaces read every knob as ${VAR:-default}:
    an empty value counts as unset, for every knob.
    """
    value: str = environ.get(name, "").strip()
    return value if value else default


def env_int(environ: dict[str, str], name: str, default: int) -> int:
    raw: str = env_value(environ, name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ConfigError(f"{name}='{raw}' is not an integer.") from None


def env_float(environ: dict[str, str], name: str, default: float) -> float:
    raw: str = env_value(environ, name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        raise ConfigError(f"{name}='{raw}' is not a number.") from None


def env_bool(environ: dict[str, str], name: str) -> bool:
    return parse_bool(name, env_value(environ, name))


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
    explicit: str = env_value(environ, "VIF_ENGINE_SPEC_FILE")
    if explicit:
        return explicit
    state_dir: str = env_value(environ, "VIF_STATE_DIR")
    model: str = env_value(environ, "VLM_MODEL")
    if state_dir and model:
        return str(Path(state_dir) / ENGINE_SPEC_DIRNAME / f"{engine_key(model)}.json")
    return ""


def state_dir_from_env(environ: dict[str, str], spec_file: str) -> str:
    """
    The state volume, which is what the log tee and the readiness markers use.

    Normally VIF_STATE_DIR; when only an explicit spec path was given, the
    volume is that file's grandparent (<dir>/engines/<key>.json).
    """
    state_dir: str = env_value(environ, "VIF_STATE_DIR")
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
        if _STOP.is_set():
            raise Stopped(f"stopped while waiting for {path}")
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
        pause(2.0)


def spec_int(document: dict[str, Any], name: str, default: int | None = None) -> int:
    """An integer field of the spec; one that is not an integer is a config error."""
    raw: Any = document.get(name, default)
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ConfigError(f"engine spec {name}={raw!r} is not an integer.") from None


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
        document.get("gpu_ids") or env_value(environ, "VLM_GPU_IDS")
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
        port=spec_int(document, "port"),
        sleep_mode=sleep_mode,
        sleep_level=spec_int(document, "sleep_level", 1),
        desired_state=desired,
        spec_file=spec_file,
        state_file=str(Path(state_dir) / ACTIVE_MODEL_FILENAME) if state_dir else "",
        ready_dir=str(Path(state_dir) / ENGINE_READY_DIRNAME) if state_dir else "",
        awake_dir=str(Path(state_dir) / ENGINE_AWAKE_DIRNAME) if state_dir else "",
        engines_dir=str(Path(spec_file).parent) if spec_file else "",
        log_file=engine_log_file(environ, state_dir, model),
        load_lock_file=str(document.get("load_lock_file") or ""),
        health_timeout_seconds=spec_int(document, "health_timeout_seconds", 1800),
        health_poll_seconds=env_float(environ, "VLM_HEALTH_POLL_SECONDS", 2.0),
        watch_poll_seconds=env_float(
            environ, "VIF_WATCH_POLL_SECONDS", DEFAULT_WATCH_POLL_SECONDS
        ),
        pool_load_timeout_seconds=env_int(
            environ,
            "VIF_POOL_LOAD_TIMEOUT_SECONDS",
            DEFAULT_POOL_LOAD_TIMEOUT_SECONDS,
        ),
    )


# ── source 2: the legacy VLM_* environment ─────────────────────────────────


def plan_from_env(environ: dict[str, str]) -> LaunchPlan:
    model: str = env_value(environ, "VLM_MODEL", "Qwen/Qwen3-VL-4B-Instruct-FP8")
    max_model_len: str = env_value(environ, "VLM_MAX_MODEL_LEN", "16384")
    gpu_memory_utilization: str = env_value(
        environ, "VLM_GPU_MEMORY_UTILIZATION", "0.90"
    )
    max_num_batched_tokens: str = env_value(
        environ, "VLM_MAX_NUM_BATCHED_TOKENS", "8192"
    )
    max_num_seqs: str = env_value(environ, "VLM_MAX_NUM_SEQS", "auto")
    tensor_parallel_size: str = env_value(environ, "VLM_TENSOR_PARALLEL_SIZE", "1")
    # Per-image pixel caps are Qwen-style PROCESSOR kwargs -- other processors
    # (e.g. Nemotron's) reject them, so there is no default here.
    min_pixels: str = env_value(environ, "VLM_MIN_PIXELS")
    max_pixels: str = env_value(environ, "VLM_MAX_PIXELS")
    max_images: str = env_value(environ, "VLM_MAX_IMAGES_PER_PROMPT", "8")
    port: int = env_int(environ, "VLM_PORT", 8000)

    load_lock_file: str = env_value(environ, "VLM_LOAD_LOCK_FILE")
    state_file: str = env_value(environ, "VLM_STATE_FILE")
    health_timeout: int = env_int(environ, "VLM_HEALTH_TIMEOUT_SECONDS", 1800)
    health_poll: float = env_float(environ, "VLM_HEALTH_POLL_SECONDS", 2.0)
    sleep_level: int = env_int(environ, "VLM_SLEEP_LEVEL", 1)
    sleep_mode: bool = env_bool(environ, "VLM_SLEEP_MODE")
    gpu_ids: str = env_value(environ, "VLM_GPU_IDS")

    # Self-sleep goes through /sleep, which only exists in dev mode. Refuse the
    # combination up front rather than leaving an engine awake that the pool is
    # sized for asleep.
    if state_file and not sleep_mode:
        raise ConfigError(
            "VLM_STATE_FILE needs VLM_SLEEP_MODE=1 (the /sleep endpoint)."
        )

    env: dict[str, str] = pin_gpus(gpu_ids)

    # fp8 KV cache halves KV memory (more concurrency per GB) but is not
    # supported on pre-Ada GPUs. Unless VLM_KV_CACHE_DTYPE is set, pick fp8
    # only when the hardware supports it.
    kv_cache_dtype: str = env_value(environ, "VLM_KV_CACHE_DTYPE")
    capability: float | None = probe_gpus(gpu_ids)
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
    args.extend(env_value(environ, "VLM_EXTRA_ARGS").split())

    state_dir: str = env_value(environ, "VIF_STATE_DIR")
    return LaunchPlan(
        source="env",
        model=model,
        args=args,
        env=env,
        port=port,
        sleep_mode=sleep_mode,
        sleep_level=sleep_level,
        # The state file decides from here on; awake is only where it starts.
        desired_state=DesiredState.AWAKE,
        state_file=state_file,
        ready_dir=str(Path(state_dir) / ENGINE_READY_DIRNAME) if state_dir else "",
        awake_dir=str(Path(state_dir) / ENGINE_AWAKE_DIRNAME) if state_dir else "",
        log_file=engine_log_file(environ, state_dir, model),
        load_lock_file=load_lock_file,
        health_timeout_seconds=health_timeout,
        health_poll_seconds=health_poll,
        watch_poll_seconds=env_float(
            environ, "VIF_WATCH_POLL_SECONDS", DEFAULT_WATCH_POLL_SECONDS
        ),
        pool_load_timeout_seconds=env_int(
            environ,
            "VIF_POOL_LOAD_TIMEOUT_SECONDS",
            DEFAULT_POOL_LOAD_TIMEOUT_SECONDS,
        ),
    )


def build_plan(environ: dict[str, str]) -> LaunchPlan:
    spec_file: str = spec_path_from_env(environ)
    if spec_file:
        timeout: int = env_int(
            environ, "VIF_SPEC_TIMEOUT_SECONDS", DEFAULT_SPEC_TIMEOUT_SECONDS
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


class _StubServer(ThreadingHTTPServer):
    """
    A ThreadingHTTPServer that can close the connections it is still serving.

    `shutdown()` only stops accepting: a handler thread already holding a
    connection keeps answering on it. A pooled client would then keep talking
    to a stub that no longer exists while the engine serves new connections on
    the same port.
    """

    def __init__(self, address: tuple[str, int], handler: type[Any]) -> None:
        self._live: set[socket.socket] = set()
        self._live_lock: threading.Lock = threading.Lock()
        super().__init__(address, handler)

    def process_request(self, request: Any, client_address: Any) -> None:
        with self._live_lock:
            self._live.add(request)
        super().process_request(request, client_address)

    def shutdown_request(self, request: Any) -> None:
        with self._live_lock:
            self._live.discard(request)
        super().shutdown_request(request)

    def handle_error(self, request: Any, client_address: Any) -> None:
        # A connection closed under its handler by close_live_connections is
        # the expected way for it to end, not something to print a trace for.
        return

    def close_live_connections(self) -> None:
        with self._live_lock:
            live: list[socket.socket] = list(self._live)
            self._live.clear()
        for connection in live:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()


class ParkedStub:
    """
    The HTTP server a parked engine leaves in place of its vLLM process.

    Parking stops the child, which would otherwise leave the container's port
    dead and its compose healthcheck failing on an engine that is doing
    exactly what it was told. This answers `/health` so the container stays
    healthy, and `/vif/parked` so anything asking can tell "parked on purpose"
    from "started without dev mode". Everything else 404s, `/is_sleeping`
    included: a parked engine genuinely does not have one.

    No connection outlives an answer, or the stub: every response closes its
    connection, and `stop()` closes any still open. A client that reuses a
    connection must reconnect -- and reach the engine -- once the stub is gone.
    """

    def __init__(self) -> None:
        self._server: _StubServer | None = None
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
                # Also sets close_connection: one request per connection.
                self.send_header("Connection", "close")
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

        self._server = _StubServer(("0.0.0.0", port), Handler)
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
        self._server.close_live_connections()
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
        # Whether a stop signal has already been passed on to the child.
        self._forwarded: bool = False
        # Nothing has been entered yet: no process, no stub.
        self.state: DesiredState = DesiredState.PARKED
        self._stub: ParkedStub = ParkedStub()
        self._lock_file: TextIO | None = None
        self._tee: threading.Thread | None = None
        self._spec_digest: str = _digest_of(plan.spec_file)
        self._log_warned: bool = False
        self._announced_awake: bool | None = None
        self._guard_announced: bool = False
        # The hot move (sleep or wake) that last failed, and the digest of the
        # decision it failed under. It is not tried again until that changes.
        self._failed_move: tuple[DesiredState, str] | None = None

    # -- signals ------------------------------------------------------------

    @property
    def terminating(self) -> bool:
        return _STOP.is_set()

    def forward_signal(self, signum: int, _frame: FrameType | None) -> None:
        _STOP.set()
        if self.child is not None and self.child.poll() is None:
            self.child.send_signal(signum)
            self._forwarded = True

    # -- load lock ----------------------------------------------------------

    def take_load_lock(self) -> bool:
        """
        Wait for the load lock. False means a stop came first.

        Polled rather than blocking, so that a stop never waits for a
        neighbour to finish loading.
        """
        if not self.plan.load_lock_file or self._lock_file is not None:
            return True
        self._lock_file = open(self.plan.load_lock_file, "a", encoding="utf-8")
        log(f"waiting for the load lock ({self.plan.load_lock_file})...")
        while True:
            try:
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if pause(LOCK_POLL_SECONDS):
                    self._lock_file.close()
                    self._lock_file = None
                    log("stopped while waiting for the load lock.")
                    return False
        log("load lock acquired.")
        return True

    def release_load_lock(self) -> None:
        # flock also drops when the process dies; releasing explicitly is what
        # lets the next engine start while this one keeps serving.
        if self._lock_file is None:
            return
        fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
        self._lock_file.close()
        self._lock_file = None
        log("load lock released.")

    def _peer_specs(self) -> list[tuple[str, DesiredState | None]]:
        """
        Every OTHER engine's model id and effective desired state.

        None stands for a spec that cannot be read right now -- most likely a
        write in flight. An `asleep` spec without sleep mode counts as parked,
        which is what that engine's own launcher makes of it.
        """
        if not self.plan.engines_dir:
            return []
        own: str = engine_key(self.plan.model)
        peers: list[tuple[str, DesiredState | None]] = []
        for path in sorted(Path(self.plan.engines_dir).glob("*.json")):
            if path.stem == own:
                continue
            try:
                document: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
                model: str = str(document.get("model") or path.stem)
                desired: DesiredState = read_desired_state(document)
                if desired is DesiredState.ASLEEP and not document.get("sleep_mode"):
                    desired = DesiredState.PARKED
            except (OSError, json.JSONDecodeError, KeyError, ConfigError):
                peers.append((path.stem, None))
                continue
            peers.append((model, desired))
        return peers

    def pool_still_loading(self) -> list[str]:
        """The other engines that should be asleep and are not loaded yet."""
        pending: list[str] = []
        for model, desired in self._peer_specs():
            if desired is DesiredState.PARKED or desired is DesiredState.AWAKE:
                continue
            if (
                desired is None
                or not (Path(self.plan.ready_dir) / engine_key(model)).exists()
            ):
                pending.append(model)
        return pending

    def wait_for_pool(self, target: DesiredState) -> None:
        """
        Boot order: the engine that should be serving loads last.

        Every engine's memory reservation assumes the others are asleep while
        it loads, and an engine that loads awake stays awake. So before it
        asks for the load lock, the engine that should be serving waits for
        every other engine whose spec says `asleep` to be loaded (its
        readiness marker) or to rest parked. Bounded: an engine that never
        arrives must not keep the pool from serving.
        """
        if target is not DesiredState.AWAKE or not self.plan.ready_dir:
            return
        deadline: float = time.monotonic() + self.plan.pool_load_timeout_seconds
        announced: list[str] = []
        while True:
            pending: list[str] = self.pool_still_loading()
            if not pending:
                if announced:
                    log("the rest of the pool is loaded.")
                return
            if self.terminating:
                return
            if time.monotonic() >= deadline:
                warn(
                    "WARNING: the rest of the pool did not load within "
                    f"{self.plan.pool_load_timeout_seconds}s; giving up on "
                    f"{', '.join(pending)} and taking the load lock anyway."
                )
                return
            if pending != announced:
                log(
                    "the serving engine loads last; waiting for "
                    f"{', '.join(pending)} to load first..."
                )
                announced = pending
            pause(READY_POLL_SECONDS)

    def serving_elsewhere(self) -> list[str]:
        """The other engines whose awake marker exists."""
        if not self.plan.awake_dir:
            return []
        own: str = engine_key(self.plan.model)
        try:
            names: list[str] = sorted(
                path.name
                for path in Path(self.plan.awake_dir).iterdir()
                if path.name != own
            )
        except OSError:
            return []
        return names

    def load_guarded(self, target: DesiredState) -> bool:
        """
        The load guard: an engine that should be asleep does not load beside a
        serving one, because the card has no room for it. An `awake` spec is
        never guarded -- the manager puts the previous engine to sleep before
        it asks.
        """
        if target is not DesiredState.ASLEEP:
            return False
        serving: list[str] = self.serving_elsewhere()
        if not serving:
            self._guard_announced = False
            return False
        if not self._guard_announced:
            log(
                f"{', '.join(serving)} is awake; staying parked until nothing "
                "else is serving or this engine is asked to serve."
            )
            self._guard_announced = True
        return True

    def _write_marker(self, path: str, what: str) -> None:
        if not path:
            return
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(f"{self.plan.model}\n", encoding="utf-8")
        except OSError as exc:
            warn(f"the {what} marker {path} could not be written ({exc}).")

    @staticmethod
    def _remove_marker(path: str) -> None:
        if not path:
            return
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass

    def mark_ready(self) -> None:
        """Publish "this engine is loaded", for the neighbours waiting on it."""
        self._write_marker(self.plan.ready_file, "readiness")

    def clear_ready(self) -> None:
        self._remove_marker(self.plan.ready_file)

    def mark_awake(self) -> None:
        """Publish "this engine is serving", which the load guard reads."""
        self._write_marker(self.plan.awake_file, "awake")

    def clear_awake(self) -> None:
        self._remove_marker(self.plan.awake_file)

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
            pause(self.plan.health_poll_seconds)
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
        api_key: str = env_value(self.child_env, "VLLM_API_KEY")
        if api_key:
            request.add_header("Authorization", f"Bearer {api_key}")
        try:
            with urllib.request.urlopen(request, timeout=120):
                return True
        except (urllib.error.URLError, OSError) as exc:
            warn(f"{what} failed ({exc}).")
            return False

    def sleep_now(self) -> bool:
        """Sleep in host RAM. A failure leaves the engine awake, and says so."""
        if not self.plan.sleep_mode:
            warn(
                "this engine has no /sleep endpoint, so it cannot sleep; "
                "it stays awake and keeps its GPU memory."
            )
            return False
        log(f"sleeping at level {self.plan.sleep_level}.")
        if self._control(f"/sleep?level={self.plan.sleep_level}", "/sleep"):
            self.state = DesiredState.ASLEEP
            # Still loaded, so the readiness marker stays; it is no longer
            # serving, so a neighbour may load beside it.
            self.clear_awake()
            log("asleep.")
            return True
        warn("this engine stays awake and keeps its GPU memory.")
        return False

    def wake_now(self) -> bool:
        """Come back from host RAM. A failure leaves it asleep, and says so."""
        log("waking.")
        if self._control("/wake_up", "/wake_up"):
            self.state = DesiredState.AWAKE
            self.mark_ready()
            self.mark_awake()
            log("awake.")
            return True
        warn("this engine stays asleep; VIS decides what happens next.")
        return False

    def _decision_digest(self) -> str:
        """The digest of what the desired state is read from right now."""
        if self.plan.spec_file:
            return self._spec_digest
        return _digest_of(self.plan.state_file)

    def _already_failed(self, target: DesiredState) -> bool:
        return self._failed_move == (target, self._decision_digest())

    def move_hot(self, target: DesiredState) -> None:
        """
        Sleep or wake, at most once per decision.

        A failed move is not retried on the next poll: an engine that would
        not wake is one VIS has already given up on, and waking it again every
        couple of seconds, forever, helps nobody. A new spec (or state file)
        is a new decision, and gets a new attempt.
        """
        digest: str = self._decision_digest()
        moved: bool = (
            self.sleep_now() if target is DesiredState.ASLEEP else self.wake_now()
        )
        if moved:
            self._failed_move = None
            return
        self._failed_move = (target, digest)
        warn("not trying again until the desired state is rewritten.")

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

    @property
    def child_env(self) -> dict[str, str]:
        """
        The environment of the spec being executed, on top of the container's.

        Built on every start, never once at boot: an engine that booted parked
        and is restarted hot needs that spec's VLLM_SERVER_DEV_MODE, or it has
        no /sleep, and a new GPU pin must reach the new process.
        """
        return {**self.environ, **self.plan.env}

    def start(self) -> None:
        if not self.plan.log_file:
            self.child = subprocess.Popen(self.plan.argv, env=self.child_env)
            return
        self.child = subprocess.Popen(
            self.plan.argv,
            env=self.child_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
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
        self.clear_awake()
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
        self.wait_for_pool(target)
        if self.terminating or not self.take_load_lock():
            return 0
        if self.terminating:
            self.release_load_lock()
            return 0
        # Another engine may have started serving while this one waited for
        # the lock; loading beside it is what the guard exists to prevent.
        if self.load_guarded(target):
            self.release_load_lock()
            self.hold_parked()
            return None
        self.start()
        # A stop that landed while the child was being spawned found no child
        # to forward to; hand it over now.
        if self.terminating and not self._forwarded and self.child is not None:
            self.child.terminate()
            self._forwarded = True
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
            self.move_hot(target)
        if self.state is DesiredState.AWAKE:
            # Loaded awake, or a self-sleep that failed: either way it holds
            # the card, and the load guard must know.
            self.mark_awake()
        self.release_load_lock()
        return None

    def hold_parked(self) -> None:
        """Rest parked, with the health stub up, until the guard lifts."""
        self.state = DesiredState.PARKED
        self._stub.start(self.plan.port, self.plan.model)

    def enter(self, target: DesiredState) -> int | None:
        """One desired-state transition. An exit code means the container stops."""
        if target is self.state:
            return None
        hot: bool = DesiredState.PARKED not in (target, self.state)
        if hot and self._already_failed(target):
            return None
        if self.state is DesiredState.PARKED and self.load_guarded(target):
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
        self.move_hot(target)
        return None

    def run(self) -> int:
        """
        Follow the desired state until the engine exits or we are stopped.

        The loop is the whole cold tier: VIS moves an engine between awake,
        asleep and parked by rewriting its spec, and this is what acts on it.
        """
        # Markers left by a launcher that died without cleaning up (SIGKILL,
        # OOM, a host crash) would tell the neighbours this engine is loaded,
        # or serving.
        self.clear_ready()
        self.clear_awake()
        target: DesiredState = self.poll_desired()
        if target is DesiredState.PARKED or self.load_guarded(target):
            self.hold_parked()
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
            pause(self.plan.watch_poll_seconds)

        if self.child is not None:
            return self.await_child()
        return 0

    def close(self) -> None:
        self.clear_awake()
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
            "awake_file": plan.awake_file,
            "log_file": plan.log_file,
            "load_lock_file": plan.load_lock_file,
            "health_timeout_seconds": plan.health_timeout_seconds,
            "watches": plan.watches,
            "supervised": plan.needs_supervision,
        },
    }


def main() -> int:
    global _LOG_STREAM
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        dry_run: bool = env_bool(dict(os.environ), "VIF_LAUNCHER_DRY_RUN")
        if dry_run:
            _LOG_STREAM = sys.stderr
        log(f"revision {LAUNCHER_REVISION}")
        plan: LaunchPlan = build_plan(dict(os.environ))
    except ConfigError as exc:
        warn(str(exc))
        return EXIT_CONFIG
    except Stopped as exc:
        log(f"{exc}; exiting.")
        return 0

    if dry_run:
        print(json.dumps(describe(plan), indent=2))
        return 0

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

    if _STOP.is_set():
        log("stopped before the engine started; exiting.")
        return 0

    # Nothing to do once the engine is up: hand the container straight to vLLM.
    if not plan.needs_supervision:
        os.execvpe(plan.argv[0], plan.argv, {**os.environ, **plan.env})

    return supervise(plan, dict(os.environ))


if __name__ == "__main__":
    sys.exit(main())
