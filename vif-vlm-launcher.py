#!/usr/bin/env python3
"""
Entrypoint for the VLM engine containers (the `vif-model-*` services in
docker-compose.yaml).
Runs unchanged on any supported GPU and model: defaults adapt to the hardware
at startup, and everything else comes from the engine's spec or from VLM_*
variables -- you should not need to edit this file.

Stdlib plus pynvml only, running on the engine image's Python 3.12.

TWO SOURCES OF FLAGS, in priority order:

  1. An ENGINE SPEC written by VIS to the shared state volume
     (VIF_ENGINE_SPEC_FILE, or <VIF_STATE_DIR>/engines/<engine key>.json).
     VIS resolves the whole command from its model catalog and this script
     runs it verbatim -- it is a dumb executor, by design. The one addition
     is the deployment's own middleware (VIF_ENGINE_MIDDLEWARE, below).
  2. The LEGACY env-driven path: VLM_* variables in the engine's environment.
     Bit-compatible with the bash entrypoint this file replaces, with one
     documented exception: --served-model-name is always passed (see below).

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
GPU). All of these are read from the engine's environment, except VLM_GPU_IDS
which is deployment placement and lives in .env:
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
are read by vLLM/HuggingFace directly. On the managed path a token set in the
Manager reaches vLLM too: when the container's own HF_TOKEN is empty, the
launcher reads <VIF_STATE_DIR>/secrets/hf-token before every access check and
every load and hands it to vLLM as HF_TOKEN. A token set in .env always wins,
so a deployment can pin it there. The token is never logged.

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
                               timeout a crash note is written, the engine is
                               stopped (SIGTERM, then SIGKILL 30s later), the
                               lock is released and the container exits
                               75; the restarted launcher rests parked on the
                               note until the spec changes -- one wedged
                               engine must not block the pool, nor take the
                               lock again and again.
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
                               running, and a slot's verdict while it waits for
                               one (default 2).
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
  VIF_ENGINE_HOST              The address the launcher's own health stub binds
                               (default 0.0.0.0, right for a container on a
                               private network). A launcher that shares its host
                               with other services sets 127.0.0.1. vLLM's own
                               bind address is `--host` in the engine's flags.
  VIF_STARTING_FILE            Present while an engine brought back from parked
                               is starting (default /tmp/vif-engine-starting):
                               the stub has given up the port and vLLM has not
                               opened it yet, so the container healthcheck
                               accepts this file in place of /health.

BOTH PATHS:
  VIF_ENGINE_MIDDLEWARE        ASGI middleware the deployment mounts into the
                               engine, as import paths separated by spaces or
                               commas (e.g. vif_auth.VifAuthMiddleware). Each
                               becomes a `--middleware` flag. It belongs to the
                               deployment rather than to the spec because the
                               deployment is what bind-mounts the module; one
                               the command already names is not added twice.

  VIF_LAUNCHER_DRY_RUN=1       Print the fully resolved command and env as
                               JSON and exit without starting anything.

SLOTS (the generic `vif-model-slot-N` services):
  VIF_SLOT                     This container is a slot: the name it registers
                               under (its compose service name). VLM_MODEL is
                               the model its deployment assigned it, "" to let
                               VIS choose one (it wins when set).

A SLOT serves whichever custom model the catalog overlay adds: the one its
deployment pins to it, else the next one VIS assigns to a slot left free.
Either way VIS cannot know from the catalog where that model's engine is.
Before anything else the launcher registers on the state volume --
<state dir>/slots/<slot>.json: the slot, its model, this container's hostname
and a nonce new on every start -- and then:

  * with no model assigned, it rests on the health stub (`/vif/parked` says
    `"unassigned": true`), so an enabled slot nobody has used yet keeps the
    stack healthy, and keeps reading VIS's verdict: one that `assigned` it a
    model (the next custom model the overlay adds, in the overlay's order) is
    taken like the deployment's own, and goes on to that model's spec;
  * otherwise it waits for VIS's verdict on that registration,
    <state dir>/slots/<slot>.assignment.json carrying the same nonce, serving
    the stub meanwhile. `assigned` goes on to the model's spec like any other
    engine, still watching the verdict: one that takes the model away parks
    the engine until a verdict assigns it again; `misconfigured` (a model the
    catalog does not have, one with a service of its own, one another slot
    already serves) logs VIS's reason and rests on the stub (`"misconfigured":
    true` and the reason), still watching for a verdict that changes. No verdict within
    VIF_SPEC_TIMEOUT_SECONDS exits 78, as a spec that never arrives does.

THE DESIRED STATE, AND THE WATCH LOOP. A spec names one of three states, and
this script keeps following the spec for as long as it runs (re-read every
couple of seconds; a spec whose content has not changed costs one read):

  awake    the engine serves.
  asleep   the engine's weights are in host RAM (vLLM sleep level 1). The
           process, its CUDA context and its compiled graphs stay; it is back
           in a second or two.
  parked   no engine process at all -- the weights are on disk and this script
           answers /health itself, so the container stays healthy. Back in a
           cold start (a minute or two), during which nothing answers /health
           and VIF_STARTING_FILE keeps the container healthy instead. This is
           the cold tier, and the only state available to an engine that
           cannot be woken from sleep.

VIS moves an engine between those three by rewriting its spec; nothing else
is needed on this side. A sleep or a wake that fails is not retried until the
spec changes: VIS decides what happens to an engine that would not move.

A DISABLED ENGINE is one the catalog overlay takes out of the deployment. Its
spec says `disabled: true` (and `parked`): the launcher serves the health stub
for good, adds `"disabled": true` to what `/vif/parked` answers, and never
loads the model, takes the load lock, reads the card or asks the hub about it
-- `/vif/access` is not answered. A later spec without the flag is followed
like any other change of desired state.

THE POOL DUTIES, when several engines share one card:

  * the LOAD LOCK serializes cold loads, so five engines starting at once do
    not thrash the disk and the GPU.
  * BOOT ORDER: an engine whose spec says `awake` (a member of the active
    set) loads LAST. Each engine's memory reservation is sized on the
    assumption that every other engine is asleep while it loads, and one that
    loads awake stays awake, so it cannot load first. Before it asks for the
    lock it waits until every other engine whose
    spec says `asleep` has published its readiness marker (loaded, and asleep)
    or rests parked (spec `parked`, or `asleep` without sleep mode). Engines
    whose spec says `parked`, and engines held parked by a crash note about
    their current spec, are never waited for. The wait is bounded by
    VIF_POOL_LOAD_TIMEOUT_SECONDS, then it loads anyway with a WARNING naming
    who it gave up on. It ends early, parked, if the spec stops saying
    `awake`, and so does the wait for the load lock: an engine never loads on
    an ask VIS has since withdrawn.
  * the LOAD GUARD: an engine whose spec says `asleep` and that is not loaded
    does not start loading while another engine holds its card: its `awake/`
    marker exists, or it is loaded (`ready/`) and its spec says `awake`. VIS
    writes that spec before it wakes the engine over HTTP, and the awake
    marker only follows at that engine's launcher's next poll. Only engines
    whose spec pins the same `gpu_ids` count: a card of its own is a card of
    its own. A spec that says `gpu_shared` is one VIS sized to load beside
    the engines serving on its card, and the guard does not hold it. Without
    either there is no room beside a serving engine, so this one serves the
    parked health stub instead and loads once no engine holds the card, or
    when its spec turns to `awake`. This is what keeps an engine restarted
    beside a serving one from crash-looping.
  * the LOG TEE copies the engine's output to <state dir>/logs/<key>.log as
    well as to this container's stdout, which is how the Manager shows engine
    logs without VIS ever holding a Docker socket.

THE STATE VOLUME, shared with VIS and every other engine:

  <state dir>/engines/<key>.json  this engine's spec          (written by VIS)
  <state dir>/active-model        legacy (VLM_STATE_FILE) only: an older VIS's
                                  serving id, which VIS moves into its
                                  overlay and deletes
  <state dir>/ready/<key>         loaded, awake or asleep     (written here)
  <state dir>/awake/<key>         awake and serving           (written here)
  <state dir>/loading/<key>       a load is under way         (written here)
  <state dir>/crashed/<key>       the last load died, or was  (written here)
                                  refused before it started
  <state dir>/phase/<key>         where a load in progress is (written here)
  <state dir>/sized/<key>         how the last load was sized (written here)
  <state dir>/logs/<key>.log      this engine's output        (written here)

The awake marker is created after a load that is not followed by a sleep and
after a successful wake, and removed when the engine goes to sleep, is parked
or stops. A stop clears both markers the moment it arrives, before the engine
has exited, so a restart of the whole pool never finds a neighbour's marker
from before it; and each launcher clears both of its own markers when it
starts, so one left by a launcher that was killed outright never misleads the
pool.

A load that dies leaves `crashed/<key>`: JSON with the digest of the spec the
load started from (`spec_digest`, the SHA-256 of the spec file's bytes), the
digest of what that spec asks for (`decision_digest`: the same spec without
`generated_by` and `generated_at`), vLLM's exit code or the signal that killed
it, and a reason. VIS reads it to fail a cold start without waiting out its
budget. A restarted launcher whose spec still asks for the same thing does not
load again -- it serves the parked health stub, the way a failed sleep or wake
is not retried, until the spec asks for something else; a rewrite that only
restamps it does not count -- so an engine that crashes while loading does
not crash-loop under Docker's restart policy. A load
that succeeds removes the marker; VIS removes it before a new cold start.
A load that would only run into a license is refused the same way, before
anything is started: a spec that says `gated` needs the weights on disk or an
HF_TOKEN whose account has accepted the model's license, and when it has
neither the crash note carries `access_problem` (token_missing, token_rejected
or license_not_accepted) instead of an exit code. The parked stub answers
`GET /vif/access` with the same verdict, checked right then, and says where
the token came from (`token_source`: environment, manager, or empty), so VIS
can refuse an activate before it moves any engine. The note
carries a fingerprint of the token it was decided with (a truncated SHA-256,
never the token); once the token in force is another one -- set or removed in
the Manager, or a restart with a new .env -- the note is dropped and the next
load is checked again. It is also dropped when the launcher starts.

`phase/<key>` is JSON with the spec digest, `phase` (waiting for the pool or
the load lock, downloading, loading, compiling) and, while downloading,
`downloaded_bytes`. It exists only while a load is under way and only moves
forward. Downloading is read from the hub cache on disk (weights not yet
linked, or a `.incomplete` file); compiling starts at vLLM's own "Loading
weights took" line, and an engine whose log is never teed simply stays in
`loading`.

`loading/<key>` is what tells a launcher that died mid-load (SIGKILL, the
container's OOM kill) from one that never loaded: a restart that finds it for
the spec in force and no `ready/<key>` writes the crash marker itself. A clean
stop, or a load that succeeds, removes it. These two markers apply to engines
run from a spec.

EVERY LOAD IS SIZED FROM THE CARD, when the spec carries `load_sizing`. Under
the load lock, just before vLLM starts, this script reads the card through
NVML and replaces the spec's --gpu-memory-utilization with

  floor2( (free - headroom_mib - extra_mib) / total ), at most max_utilization

where free and total are what CUDA reports: NVML's free, and NVML's total less
the driver's reserve (the least of each across the engine's GPUs). The spec's
utilization was decided when VIS wrote it; at boot every spec lands at once
and the engines load one after another, each beside the residuals of the ones
before it, so only this moment sees the card the load will find. VIS decides
every input and the formula; this is its copy, pinned by VIS's tests. When
what is left for the pool is less than weights_mib, vLLM is not started: the
refusal is a crash note carrying the arithmetic and `sizing_refused: true`, so
that it reads as a refusal for memory rather than a load that died, and the
engine rests parked until its spec asks for something else. A card that cannot be read leaves the
spec's own utilization. Each load's sizing is logged ("load sized from the
card: ...") and written to `sized/<key>` as JSON: the digests of the spec it
sized, `measured`, `approved`, the `utilization` vLLM was started with, the
card's numbers and the `reason`.

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
import math
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

from dataclasses import asdict, dataclass, field, replace
from enum import StrEnum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import FrameType
from typing import IO, Any, Callable, TextIO

# Bump on every edit to this file.
LAUNCHER_REVISION: str = "2026-10-07.1"

EXIT_HEALTH_TIMEOUT: int = 75
EXIT_CONFIG: int = 78
# Grace between SIGTERM and SIGKILL when this script stops an engine (a park,
# a reload, a wedged load). A clean exit of the largest model takes ~11 s with
# its CUDA teardown, and only a clean exit frees the card before the next load
# sizes itself against it; a kill also orphans vLLM's engine-core workers.
STOP_GRACE_SECONDS: int = 30

ENGINE_SPEC_VERSION: int = 1
ENGINE_SPEC_DIRNAME: str = "engines"
ENGINE_LOG_DIRNAME: str = "logs"
ENGINE_READY_DIRNAME: str = "ready"
ENGINE_AWAKE_DIRNAME: str = "awake"
ENGINE_LOADING_DIRNAME: str = "loading"
ENGINE_CRASHED_DIRNAME: str = "crashed"
ENGINE_PHASE_DIRNAME: str = "phase"
ENGINE_SIZED_DIRNAME: str = "sized"
ENGINE_SLOTS_DIRNAME: str = "slots"
SLOT_ASSIGNMENT_SUFFIX: str = ".assignment.json"
ACTIVE_MODEL_FILENAME: str = "active-model"
# Written by VIS, mode 0600: the HuggingFace token set in the Manager.
HF_TOKEN_FILE: str = "secrets/hf-token"
DEFAULT_STATE_DIR: str = "/vif-state"
# Inside the container, not on the state volume: the healthcheck reads it.
DEFAULT_STARTING_FILE: str = "/tmp/vif-engine-starting"
# Every interface: the engine sits on a private container network, and its
# neighbours reach it by service name.
DEFAULT_ENGINE_HOST: str = "0.0.0.0"
DEFAULT_SPEC_TIMEOUT_SECONDS: int = 300
# How often the desired state is re-read. Fast enough that a move between
# states is not noticeably slower for it, slow enough to be free.
DEFAULT_WATCH_POLL_SECONDS: float = 2.0
# How long the engine that should be serving waits for the rest of the hot
# pool to load first: the shipped catalog has five models, so at most four
# others, each holding the load lock for at most its health deadline (1800 s)
# plus its step into sleep (the 120 s /sleep call). 4 x 1920 = 7680, rounded up.
DEFAULT_POOL_LOAD_TIMEOUT_SECONDS: int = 7800
READY_POLL_SECONDS: float = 2.0
LOCK_POLL_SECONDS: float = 0.2

FP8_KV_CACHE_MIN_COMPUTE_CAPABILITY: float = 8.9

DEFAULT_HF_ENDPOINT: str = "https://huggingface.co"
ACCESS_PROBE_TIMEOUT_SECONDS: float = 10.0
WEIGHT_SUFFIXES: tuple[str, ...] = (".safetensors", ".bin", ".pt", ".pth", ".gguf")
# vLLM's own line once the weights are on the GPU; what follows is compiling,
# profiling and graph capture.
WEIGHTS_LOADED: re.Pattern[bytes] = re.compile(
    rb"Loading weights took|Model loading took"
)

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


class LoadPhase(StrEnum):
    """
    Where a load is, in the order a first load goes through them. A phase that
    does not apply (weights already on disk, a warm compile cache) is skipped.
    """

    WAITING = "waiting"
    DOWNLOADING = "downloading"
    LOADING = "loading"
    COMPILING = "compiling"


LOAD_PHASE_ORDER: tuple[LoadPhase, ...] = tuple(LoadPhase)


class AccessProblem(StrEnum):
    """Why a gated model's weights cannot be fetched with this deployment's token."""

    TOKEN_MISSING = "token_missing"
    TOKEN_REJECTED = "token_rejected"
    LICENSE_NOT_ACCEPTED = "license_not_accepted"


ACCESS_CAUSES: dict[AccessProblem, str] = {
    AccessProblem.TOKEN_MISSING: "no HuggingFace token is set",
    AccessProblem.TOKEN_REJECTED: "HuggingFace does not accept the token",
    AccessProblem.LICENSE_NOT_ACCEPTED: (
        "the account behind the token has not accepted its license"
    ),
}


class TokenSource(StrEnum):
    """Where the token a check or a load uses comes from."""

    NONE = ""
    ENVIRONMENT = "environment"
    MANAGER = "manager"


# Dry runs print JSON on stdout, so their logging moves out of the way.
_LOG_STREAM: TextIO = sys.stdout


def log(message: str) -> None:
    print(f"[vlm-launcher] {message}", file=_LOG_STREAM, flush=True)


def warn(message: str) -> None:
    print(f"[vlm-launcher] {message}", file=sys.stderr, flush=True)


@dataclass(frozen=True)
class LoadSizing:
    """The spec's `load_sizing`: VIS's inputs for sizing a load from the card."""

    max_utilization: float
    headroom_mib: int
    extra_mib: int
    weights_mib: int


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
    # Where a load in progress and a load that died are recorded. Spec path
    # only: the digest they carry is the spec's.
    loading_dir: str = ""
    crashed_dir: str = ""
    # Where the phase of a load in progress is published. Spec path only.
    phase_dir: str = ""
    # Whether the weights sit behind a HuggingFace license: the spec says so.
    gated: bool = False
    # The token set in the Manager, used when the environment has none. Spec
    # path only.
    hf_token_file: str = ""
    # Where each load's sizing is recorded, and what it is sized with; None
    # runs `args` as they are. Spec path only.
    sized_dir: str = ""
    load_sizing: LoadSizing | None = None
    # Taken out of the deployment by the catalog overlay: parked for good.
    disabled: bool = False
    # Sized by VIS to load beside the engines serving on its card: the load
    # guard does not apply.
    gpu_shared: bool = False
    gpu_ids: str = ""
    tensor_parallel_size: int = 1
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
    def loading_file(self) -> str:
        """This engine's load-in-progress marker, or "" when there is nowhere."""
        if not self.loading_dir:
            return ""
        return str(Path(self.loading_dir) / engine_key(self.model))

    @property
    def crashed_file(self) -> str:
        """This engine's crash marker, or "" when there is nowhere."""
        if not self.crashed_dir:
            return ""
        return str(Path(self.crashed_dir) / engine_key(self.model))

    @property
    def phase_file(self) -> str:
        """This engine's load-phase marker, or "" when there is nowhere."""
        if not self.phase_dir:
            return ""
        return str(Path(self.phase_dir) / engine_key(self.model))

    @property
    def sized_file(self) -> str:
        """This engine's load-sizing record, or "" when there is nowhere."""
        if not self.sized_dir:
            return ""
        return str(Path(self.sized_dir) / engine_key(self.model))

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


def middleware_args(environ: dict[str, str], args: list[str]) -> list[str]:
    """The `--middleware` flags VIF_ENGINE_MIDDLEWARE asks for, minus any in `args`."""
    named: set[str] = {
        args[index + 1] for index, arg in enumerate(args[:-1]) if arg == "--middleware"
    } | {arg.split("=", 1)[1] for arg in args if arg.startswith("--middleware=")}
    flags: list[str] = []
    for path in env_value(environ, "VIF_ENGINE_MIDDLEWARE").replace(",", " ").split():
        if path in named:
            continue
        named.add(path)
        flags.extend(["--middleware", path])
    return flags


def make_shared_dir(directory: Path) -> None:
    """
    Create a marker directory owned like the directory it sits in.

    The engines run as root and VIS as the state volume's owner; VIS removes
    what the launcher writes (a crash note before a new cold start), which
    needs write access to the directory it sits in. The compose's init step
    chowns the volume only when the stack starts, so a directory created
    after that would otherwise stay root's.
    """
    if directory.is_dir():
        return
    make_shared_dir(directory.parent)
    directory.mkdir(exist_ok=True)
    owner: os.stat_result = directory.parent.stat()
    try:
        os.chown(directory, owner.st_uid, owner.st_gid)
    except PermissionError:
        # Not root: whatever this process creates is its own already.
        pass


# ── weights on disk, and access to gated ones ──────────────────────────────


def hf_cache_dir(environ: dict[str, str]) -> Path:
    """Where the HuggingFace hub cache is, by the variables huggingface_hub reads."""
    explicit: str = env_value(environ, "HF_HUB_CACHE")
    if explicit:
        return Path(explicit)
    home: str = env_value(environ, "HF_HOME")
    if home:
        return Path(home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def weights_cache_state(environ: dict[str, str], model: str) -> tuple[bool, int]:
    """
    Whether this model's weights are completely in the hub cache, and how many
    bytes of it are on disk.

    huggingface_hub downloads each file to `blobs/<hash>.incomplete` and renames
    it when done, and only then links it into `snapshots/`: a download is under
    way while any `.incomplete` file exists, and finished once a weight file is
    linked and none does. A model that is a local path, or a host set offline,
    never downloads.
    """
    if Path(model).exists() or env_bool(environ, "HF_HUB_OFFLINE"):
        return True, 0
    root: Path = hf_cache_dir(environ) / f"models--{model.replace('/', '--')}"
    downloaded: int = 0
    incomplete: bool = False
    try:
        for entry in os.scandir(root / "blobs"):
            downloaded += entry.stat().st_size
            incomplete = incomplete or entry.name.endswith(".incomplete")
    except OSError:
        pass
    linked: bool = False
    try:
        for snapshot in os.scandir(root / "snapshots"):
            linked = linked or any(
                name.endswith(WEIGHT_SUFFIXES) for name in os.listdir(snapshot.path)
            )
    except OSError:
        pass
    return linked and not incomplete, downloaded


def hf_token(environ: dict[str, str]) -> str:
    return env_value(environ, "HF_TOKEN") or env_value(
        environ, "HUGGING_FACE_HUB_TOKEN"
    )


# The token file is read on every poll; an unreadable one is said once.
_UNREADABLE_TOKEN_FILES: set[str] = set()


def stored_hf_token(path: str) -> str:
    """The token VIS stored for the Manager, or "" when there is none."""
    if not path:
        return ""
    try:
        token: str = Path(path).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except OSError as exc:
        if path not in _UNREADABLE_TOKEN_FILES:
            _UNREADABLE_TOKEN_FILES.add(path)
            warn(f"the HuggingFace token file {path} cannot be read ({exc.strerror}).")
        return ""
    _UNREADABLE_TOKEN_FILES.discard(path)
    return token


def token_source(environ: dict[str, str], token_file: str) -> TokenSource:
    """The environment's token wins; the Manager's stands in when it has none."""
    if hf_token(environ):
        return TokenSource.ENVIRONMENT
    if stored_hf_token(token_file):
        return TokenSource.MANAGER
    return TokenSource.NONE


def with_stored_token(environ: dict[str, str], token_file: str) -> dict[str, str]:
    """`environ` as vLLM and the access check see it: the Manager's token filled in."""
    if hf_token(environ):
        return environ
    stored: str = stored_hf_token(token_file)
    if not stored:
        return environ
    return {**environ, "HF_TOKEN": stored}


def token_fingerprint(token: str) -> str:
    """Tells two tokens apart without holding either; "" for no token."""
    if not token:
        return ""
    return hashlib.sha256(f"vif-hf-token:{token}".encode("utf-8")).hexdigest()[:16]


def hf_endpoint(environ: dict[str, str]) -> str:
    return env_value(environ, "HF_ENDPOINT", DEFAULT_HF_ENDPOINT).rstrip("/")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def gated_access_problem(environ: dict[str, str], model: str) -> AccessProblem | None:
    """
    Why a gated model cannot be downloaded here, or None when it can, is not
    needed (already on disk, offline) or cannot be told.

    Without a token there is nothing to ask the hub. With one, a HEAD on the
    model's config answers 401 for a token the hub does not accept and 403 for
    an account that has not accepted the license; anything else, a network
    failure included, is left for vLLM to run into rather than blocking a load
    this check has no evidence against.
    """
    if weights_cache_state(environ, model)[0]:
        return None
    token: str = hf_token(environ)
    if not token:
        return AccessProblem.TOKEN_MISSING
    request: urllib.request.Request = urllib.request.Request(
        f"{hf_endpoint(environ)}/{model}/resolve/main/config.json",
        method="HEAD",
        headers={"Authorization": f"Bearer {token}"},
    )
    opener: urllib.request.OpenerDirector = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=ACCESS_PROBE_TIMEOUT_SECONDS):
            return None
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            return AccessProblem.TOKEN_REJECTED
        if exc.code == 403:
            return AccessProblem.LICENSE_NOT_ACCEPTED
        return None
    except (urllib.error.URLError, OSError):
        return None


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


# ── load sizing: the spec's inputs, against the card as it is now ─────────

UTILIZATION_FLAG: str = "--gpu-memory-utilization="
BYTES_PER_MIB: int = 1024 * 1024
_UTILIZATION_DECIMALS: int = 2


@dataclass(frozen=True)
class CardMemory:
    """The card as CUDA sees it: NVML's free, and its total less the reserve."""

    free_mib: int
    total_mib: int


@dataclass(frozen=True)
class SizedLoad:
    """One load sized from the card, in the same terms VIS's `size_load` uses."""

    approved: bool
    utilization: float
    usable_mib: int
    predicted_peak_mib: int
    reason: str


def load_sizing_from_spec(document: dict[str, Any]) -> LoadSizing | None:
    """The spec's `load_sizing`, or None when it has none (null or absent)."""
    raw: Any = document.get("load_sizing")
    if raw is None:
        return None
    try:
        sizing: LoadSizing = LoadSizing(
            max_utilization=float(raw["max_utilization"]),
            headroom_mib=int(raw["headroom_mib"]),
            extra_mib=int(raw["extra_mib"]),
            weights_mib=int(raw["weights_mib"]),
        )
    except (TypeError, KeyError, ValueError):
        raise ConfigError(f"engine spec load_sizing={raw!r} is not usable.") from None
    if not 0.0 < sizing.max_utilization <= 1.0:
        raise ConfigError(
            f"engine spec load_sizing max_utilization={sizing.max_utilization} "
            "is not in (0, 1]."
        )
    return sizing


def size_load(model: str, sizing: LoadSizing, card: CardMemory) -> SizedLoad:
    """
    `(free - headroom - extra) / total`, floored to two decimals and capped.

    A copy of the Video Intelligence Service's own, reason string included:
    VIS decides the formula, and its tests pin this one to it.
    """
    usable: int = card.free_mib - sizing.headroom_mib - sizing.extra_mib
    factor: int = 10**_UTILIZATION_DECIMALS
    utilization: float = min(
        math.floor(max(usable, 0) / card.total_mib * factor) / factor,
        sizing.max_utilization,
    )
    # vLLM's own rounding of its request.
    pool: int = math.ceil(utilization * card.total_mib)
    predicted: int = pool + sizing.extra_mib + sizing.headroom_mib
    arithmetic: str = (
        f"{card.free_mib} MiB free as CUDA reports it - "
        f"{sizing.headroom_mib} MiB cold-load headroom - {sizing.extra_mib} MiB "
        f"the engine holds outside its pool = {usable} MiB for its pool"
    )
    approved: bool = usable >= sizing.weights_mib
    reason: str
    if not approved:
        reason = (
            f"{model} cannot be loaded on the card as it is now: "
            f"{arithmetic}, less than the {sizing.weights_mib} MiB its pool needs."
        )
    else:
        cap: str = (
            f", capped at {sizing.max_utilization:g}"
            if utilization >= sizing.max_utilization
            else ""
        )
        reason = (
            f"{model} loads at utilization {utilization:g} of "
            f"{card.total_mib} MiB ({arithmetic}{cap}); predicted peak "
            f"{predicted} MiB."
        )
    return SizedLoad(
        approved=approved,
        utilization=utilization,
        usable_mib=usable,
        predicted_peak_mib=predicted,
        reason=reason,
    )


def read_card_memory(gpu_ids: str, shards: int) -> tuple[CardMemory | None, str]:
    """
    The engine's card(s) right now, or None and why not.

    NVML's v2 memory info gives what vLLM's CUDA sees without a CUDA context
    of our own: its free matches CUDA's, and CUDA's total is NVML's less the
    driver's reserve. Across several GPUs, the least of each.
    """
    try:
        import pynvml
    except ImportError:
        return None, "pynvml is not available"
    try:
        pynvml.nvmlInit()
    except Exception as exc:  # nvmlInit raises NVMLError, which needs the import
        return None, f"NVML init failed ({exc})"
    try:
        cards: list[CardMemory] = []
        for index in _gpu_indices(gpu_ids, shards):
            handle: Any = pynvml.nvmlDeviceGetHandleByIndex(index)
            memory: Any = pynvml.nvmlDeviceGetMemoryInfo(
                handle, version=pynvml.nvmlMemory_v2
            )
            cards.append(
                CardMemory(
                    free_mib=int(memory.free) // BYTES_PER_MIB,
                    total_mib=(int(memory.total) - int(memory.reserved))
                    // BYTES_PER_MIB,
                )
            )
    except Exception as exc:
        return None, f"NVML could not read the card's memory ({exc})"
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass
    if not cards:
        return None, "no GPU to read"
    return (
        CardMemory(
            free_mib=min(card.free_mib for card in cards),
            total_mib=min(card.total_mib for card in cards),
        ),
        "",
    )


def utilization_in(args: list[str]) -> float | None:
    """The --gpu-memory-utilization the spec's args carry, if any."""
    for arg in args:
        if arg.startswith(UTILIZATION_FLAG):
            try:
                return float(arg.removeprefix(UTILIZATION_FLAG))
            except ValueError:
                return None
    return None


def with_utilization(args: list[str], utilization: float) -> list[str]:
    """`args` with its --gpu-memory-utilization replaced, or added."""
    flag: str = f"{UTILIZATION_FLAG}{utilization}"
    if not any(arg.startswith(UTILIZATION_FLAG) for arg in args):
        return [*args, flag]
    return [flag if arg.startswith(UTILIZATION_FLAG) else arg for arg in args]


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
    disabled: bool = document.get("disabled") is True
    if disabled and desired is not DesiredState.PARKED:
        warn(
            f"the engine spec disables {model} but asks for {desired}; a "
            "disabled engine is parked."
        )
        desired = DesiredState.PARKED
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
    args: list[str] = [str(arg) for arg in document["args"]]
    args.extend(middleware_args(environ, args))
    return LaunchPlan(
        source="spec",
        model=model,
        args=args,
        env=env,
        port=spec_int(document, "port"),
        sleep_mode=sleep_mode,
        sleep_level=spec_int(document, "sleep_level", 1),
        desired_state=desired,
        spec_file=spec_file,
        state_file=str(Path(state_dir) / ACTIVE_MODEL_FILENAME) if state_dir else "",
        ready_dir=str(Path(state_dir) / ENGINE_READY_DIRNAME) if state_dir else "",
        awake_dir=str(Path(state_dir) / ENGINE_AWAKE_DIRNAME) if state_dir else "",
        loading_dir=str(Path(state_dir) / ENGINE_LOADING_DIRNAME) if state_dir else "",
        crashed_dir=str(Path(state_dir) / ENGINE_CRASHED_DIRNAME) if state_dir else "",
        phase_dir=str(Path(state_dir) / ENGINE_PHASE_DIRNAME) if state_dir else "",
        gated=bool(document.get("gated", False)),
        hf_token_file=str(Path(state_dir) / HF_TOKEN_FILE) if state_dir else "",
        sized_dir=str(Path(state_dir) / ENGINE_SIZED_DIRNAME) if state_dir else "",
        load_sizing=load_sizing_from_spec(document),
        disabled=disabled,
        gpu_shared=document.get("gpu_shared") is True,
        gpu_ids=gpu_ids,
        tensor_parallel_size=spec_int(document, "tensor_parallel_size", 1),
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

    # Processor kwargs only when the engine's environment sets pixel caps.
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
    extra_args: list[str] = env_value(environ, "VLM_EXTRA_ARGS").split()
    args.extend(middleware_args(environ, extra_args))
    args.extend(extra_args)

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


# Who wrote a spec and when: part of the file, never part of what it decides.
SPEC_PROVENANCE_FIELDS: frozenset[str] = frozenset({"generated_by", "generated_at"})


def decision_digest(document: dict[str, Any]) -> str:
    """
    The digest of what a spec asks for, leaving out who wrote it and when.

    VIS stamps every write, so a rewrite that asks for nothing new still
    changes the file's own digest. A crash note is matched on this one, so that
    such a rewrite does not load again a model whose load just died.
    """
    decision: dict[str, Any] = {
        key: value
        for key, value in document.items()
        if key not in SPEC_PROVENANCE_FIELDS
    }
    return hashlib.sha256(
        json.dumps(decision, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _decision_of(path: str) -> str:
    """The decision digest of the spec at `path`; "" when it cannot be read."""
    if not path:
        return ""
    try:
        document: Any = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    return decision_digest(document) if isinstance(document, dict) else ""


def last_load_words(model: str, note: dict[str, Any]) -> str:
    """What a crash note says the last load did: died, or was refused."""
    reason: str = str(note.get("reason") or "no reason recorded")
    if note.get("sizing_refused"):
        return (
            f"the last load of {model} was refused for lack of free memory on "
            f"the card, and nothing was started ({reason})"
        )
    if note.get("access_problem"):
        return f"the last load of {model} was refused ({reason})"
    return f"the last load of {model} died ({reason})"


def crash_matches(note: dict[str, Any], spec_digest: str, decision: str) -> bool:
    """
    Whether a crash note is about the spec now in force.

    A note carries the decision digest from this revision on; an older one only
    the file's, which is then what it is compared on.
    """
    noted: Any = note.get("decision_digest")
    if noted:
        return bool(decision) and noted == decision
    return bool(spec_digest) and note.get("spec_digest") == spec_digest


@dataclass(frozen=True)
class Peer:
    """Another engine on the state volume, as its spec and markers show it."""

    model: str
    # None stands for a spec that cannot be read right now.
    desired: DesiredState | None
    spec_digest: str = ""
    decision: str = ""
    # The card its spec pins; unset is the first visible GPU.
    gpu_ids: str = ""


def same_card(mine: str, theirs: str) -> bool:
    """Whether two `gpu_ids` pins name the same card; unset means GPU 0."""
    return (mine.strip() or "0") == (theirs.strip() or "0")


class LockWait(StrEnum):
    TAKEN = "taken"
    STOPPED = "stopped"
    # The spec stopped asking for the state the lock was wanted for.
    SUPERSEDED = "superseded"


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

    def __init__(self, host: str = DEFAULT_ENGINE_HOST) -> None:
        self._host: str = host
        self._server: _StubServer | None = None
        self._thread: threading.Thread | None = None
        # Whether the stub now serving says the engine is disabled.
        self.disabled: bool = False

    @property
    def running(self) -> bool:
        return self._server is not None

    def start(
        self,
        port: int,
        model: str,
        access: Callable[[], dict[str, Any]] | None = None,
        disabled: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> None:
        if self._server is not None:
            return
        self.disabled = disabled
        answer: dict[str, Any] = {
            "parked": True,
            "model": model,
            "launcher_revision": LAUNCHER_REVISION,
        }
        if disabled:
            answer["disabled"] = True
        answer.update(extra or {})
        body: bytes = json.dumps(answer).encode("utf-8")

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
                if path == "/vif/access" and access is not None:
                    self._send(200, json.dumps(access()).encode("utf-8"))
                    return
                self._send(404, b"{}")

            def do_POST(self) -> None:
                self._send(404, b"{}")

        self._server = _StubServer((self._host, port), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True, name="parked-stub"
        )
        self._thread.start()
        log(
            f"parked: no engine process; serving the health stub on {self._host}:{port}."
        )

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

    def __init__(
        self,
        plan: LaunchPlan,
        environ: dict[str, str],
        lease: "SlotLease | None" = None,
    ) -> None:
        self.plan: LaunchPlan = plan
        self.environ: dict[str, str] = environ
        self.lease: "SlotLease | None" = lease
        self.child: subprocess.Popen[bytes] | None = None
        # Whether a stop signal has already been passed on to the child.
        self._forwarded: bool = False
        # Nothing has been entered yet: no process, no stub.
        self.state: DesiredState = DesiredState.PARKED
        self._stub: ParkedStub = ParkedStub(
            env_value(environ, "VIF_ENGINE_HOST", DEFAULT_ENGINE_HOST)
        )
        self._lock_file: TextIO | None = None
        self._tee: threading.Thread | None = None
        self._spec_digest: str = _digest_of(plan.spec_file)
        self._decision: str = _decision_of(plan.spec_file)
        self._log_warned: bool = False
        self._announced_awake: bool | None = None
        self._guard_announced: bool = False
        # The hot move (sleep or wake) that last failed, and the digest of the
        # decision it failed under. It is not tried again until that changes.
        self._failed_move: tuple[DesiredState, str] | None = None
        # The digests of the spec the load in progress started from, and the
        # crash digest already announced as the reason for staying parked.
        self._load_digest: str = ""
        self._load_decision: str = ""
        self._crash_announced: str = ""
        # The spec digest the published phase belongs to, and the last phase
        # (and byte count) written, so a poll that saw nothing new writes nothing.
        self._phase_digest: str = ""
        self._phase: LoadPhase | None = None
        self._phase_bytes: int = -1
        # Set by the log tee once vLLM says the weights are on the GPU.
        self._weights_loaded: bool = False
        self._gate_announced: str = ""
        self._starting_file: str = env_value(
            environ, "VIF_STARTING_FILE", DEFAULT_STARTING_FILE
        )

    # -- signals ------------------------------------------------------------

    @property
    def terminating(self) -> bool:
        return _STOP.is_set()

    def forward_signal(self, signum: int, _frame: FrameType | None) -> None:
        _STOP.set()
        # A stopping engine is loaded for no one. Cleared now, not once the
        # child has exited: a stop that outlasts the container's grace period
        # ends in a SIGKILL, which would leave the markers behind for a
        # neighbour starting beside it -- the serving engine would take them
        # as the rest of the pool loaded, and load first.
        self.clear_awake()
        self.clear_ready()
        self.clear_loading()
        self.clear_phase()
        if self.child is not None and self.child.poll() is None:
            self.child.send_signal(signum)
            self._forwarded = True

    # -- load lock ----------------------------------------------------------

    def take_load_lock(self, target: DesiredState) -> LockWait:
        """
        Wait for the load lock, for as long as the spec still asks for `target`.

        Polled rather than blocking, so that neither a stop nor a new spec
        waits for a neighbour to finish loading.
        """
        if not self.plan.load_lock_file or self._lock_file is not None:
            return LockWait.TAKEN
        self._lock_file = open(self.plan.load_lock_file, "a", encoding="utf-8")
        log(f"waiting for the load lock ({self.plan.load_lock_file})...")
        next_look: float = time.monotonic() + self.plan.watch_poll_seconds
        while True:
            try:
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                outcome: LockWait | None = None
                if pause(LOCK_POLL_SECONDS):
                    log("stopped while waiting for the load lock.")
                    outcome = LockWait.STOPPED
                elif time.monotonic() >= next_look:
                    next_look = time.monotonic() + self.plan.watch_poll_seconds
                    if self.poll_desired() is not target:
                        log("the spec changed while waiting for the load lock.")
                        outcome = LockWait.SUPERSEDED
                if outcome is not None:
                    self._lock_file.close()
                    self._lock_file = None
                    return outcome
        log("load lock acquired.")
        return LockWait.TAKEN

    def release_load_lock(self) -> None:
        # flock also drops when the process dies; releasing explicitly is what
        # lets the next engine start while this one keeps serving.
        if self._lock_file is None:
            return
        fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
        self._lock_file.close()
        self._lock_file = None
        log("load lock released.")

    def _peer_specs(self) -> list[Peer]:
        """
        Every OTHER engine's spec.

        An unreadable spec is most likely a write in flight. An `asleep` spec
        without sleep mode counts as parked, which is what that engine's own
        launcher makes of it, and so does a disabled one.
        """
        if not self.plan.engines_dir:
            return []
        own: str = engine_key(self.plan.model)
        peers: list[Peer] = []
        for path in sorted(Path(self.plan.engines_dir).glob("*.json")):
            if path.stem == own:
                continue
            try:
                raw: str = path.read_text(encoding="utf-8")
                document: dict[str, Any] = json.loads(raw)
                model: str = str(document.get("model") or path.stem)
                desired: DesiredState = read_desired_state(document)
                if document.get("disabled") is True or (
                    desired is DesiredState.ASLEEP and not document.get("sleep_mode")
                ):
                    desired = DesiredState.PARKED
            except (OSError, json.JSONDecodeError, KeyError, ConfigError):
                peers.append(Peer(model=path.stem, desired=None))
                continue
            peers.append(
                Peer(
                    model=model,
                    desired=desired,
                    spec_digest=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
                    decision=decision_digest(document),
                    gpu_ids=str(document.get("gpu_ids") or ""),
                )
            )
        return peers

    def _peer_loaded(self, peer: Peer) -> bool:
        return (Path(self.plan.ready_dir) / engine_key(peer.model)).exists()

    def _peer_crash_parked(self, peer: Peer) -> bool:
        """Whether the peer's launcher holds it parked on a note about its spec."""
        if not self.plan.crashed_dir:
            return False
        note: dict[str, Any] | None = self._read_marker(
            str(Path(self.plan.crashed_dir) / engine_key(peer.model))
        )
        return note is not None and crash_matches(note, peer.spec_digest, peer.decision)

    def pool_still_loading(self) -> list[str]:
        """
        The other engines that should be asleep and are not loaded yet.

        One whose last load of this very spec died is not coming: its launcher
        stays parked until the spec asks for something else.
        """
        pending: list[str] = []
        for peer in self._peer_specs():
            if (
                peer.desired is DesiredState.PARKED
                or peer.desired is DesiredState.AWAKE
            ):
                continue
            if peer.desired is None:
                pending.append(peer.model)
            elif not self._peer_loaded(peer) and not self._peer_crash_parked(peer):
                pending.append(peer.model)
        return pending

    def wait_for_pool(self, target: DesiredState) -> bool:
        """
        Boot order: an engine that should be serving loads last.

        Every engine's memory reservation assumes the others are asleep while
        it loads, and an engine that loads awake stays awake. So before it
        asks for the load lock, an engine that should be serving waits for
        every other engine whose spec says `asleep` to be loaded (its
        readiness marker) or to rest parked. Bounded: an engine that never
        arrives must not keep the pool from serving.

        False when the spec stopped asking for `target` meanwhile.
        """
        if target is not DesiredState.AWAKE or not self.plan.ready_dir:
            return True
        deadline: float = time.monotonic() + self.plan.pool_load_timeout_seconds
        announced: list[str] = []
        while True:
            if self.poll_desired() is not target:
                log("the spec changed while waiting for the rest of the pool.")
                return False
            pending: list[str] = self.pool_still_loading()
            if not pending:
                if announced:
                    log("the rest of the pool is loaded.")
                return True
            if self.terminating:
                return True
            if time.monotonic() >= deadline:
                warn(
                    "WARNING: the rest of the pool did not load within "
                    f"{self.plan.pool_load_timeout_seconds}s; giving up on "
                    f"{', '.join(pending)} and taking the load lock anyway."
                )
                return True
            if pending != announced:
                log(
                    "the serving engine loads last; waiting for "
                    f"{', '.join(pending)} to load first..."
                )
                announced = pending
            pause(READY_POLL_SECONDS)

    def serving_elsewhere(self) -> list[str]:
        """
        The other engines holding this engine's card: an awake marker, or a
        loaded engine whose spec says `awake`, among the engines whose spec
        pins the same card (an awake marker of an engine whose spec cannot
        be read counts, to be safe).

        The second is a wake in progress. VIS writes the `awake` spec before
        its own `/wake_up`, and rewrites the rest of the pool the moment that
        call returns, while the woken engine's launcher writes its awake
        marker only at its next poll. An `awake` spec that is not loaded yet
        is the boot order's serving engine, waiting for this one to load first.
        """
        own: str = engine_key(self.plan.model)
        peers: list[Peer] = self._peer_specs()
        elsewhere: set[str] = {
            engine_key(peer.model)
            for peer in peers
            if peer.desired is not None
            and not same_card(self.plan.gpu_ids, peer.gpu_ids)
        }
        names: set[str] = set()
        if self.plan.awake_dir:
            try:
                names.update(
                    path.name
                    for path in Path(self.plan.awake_dir).iterdir()
                    if path.name != own and path.name not in elsewhere
                )
            except OSError:
                pass
        if self.plan.ready_dir:
            names.update(
                engine_key(peer.model)
                for peer in peers
                if peer.desired is DesiredState.AWAKE
                and self._peer_loaded(peer)
                and same_card(self.plan.gpu_ids, peer.gpu_ids)
            )
        return sorted(names)

    def load_guarded(self, target: DesiredState) -> bool:
        """
        The load guard: an engine that should be asleep does not load beside a
        serving one, because the card has no room for it. An `awake` spec is
        never guarded -- VIS sized it within its card's plan for the active set --
        and neither is one VIS sized to share its card (`gpu_shared`).
        """
        if target is not DesiredState.ASLEEP or self.plan.gpu_shared:
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
        if not path or self.terminating:
            return
        try:
            make_shared_dir(Path(path).parent)
            Path(path).write_text(f"{self.plan.model}\n", encoding="utf-8")
        except OSError as exc:
            warn(f"the {what} marker {path} could not be written ({exc}).")
        # A stop that landed during the write has already cleared the markers.
        if self.terminating:
            self._remove_marker(path)

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

    def mark_starting(self) -> None:
        """Publish "starting from parked", which the container healthcheck reads."""
        self._write_marker(self._starting_file, "starting")

    def clear_starting(self) -> None:
        self._remove_marker(self._starting_file)

    # -- the load that died -------------------------------------------------

    @staticmethod
    def _read_marker(path: str) -> dict[str, Any] | None:
        """A JSON marker, or None when it is absent or unreadable."""
        if not path:
            return None
        try:
            document: Any = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return document if isinstance(document, dict) else None

    def _write_json_marker(
        self, path: str, document: dict[str, Any], what: str
    ) -> None:
        """Through a rename: VIS polls this file and must never read half of it."""
        if not path:
            return
        try:
            write_json_atomically(Path(path), document)
        except OSError as exc:
            warn(f"the {what} marker {path} could not be written ({exc}).")

    def mark_loading(self) -> None:
        """Note the load about to start, and the spec it starts from."""
        self._load_digest = self._spec_file_digest()
        self._load_decision = self._decision
        self._write_json_marker(
            self.plan.loading_file,
            {
                "spec_digest": self._load_digest,
                "decision_digest": self._load_decision,
                "at": time.time(),
            },
            "loading",
        )

    def clear_loading(self) -> None:
        self._remove_marker(self.plan.loading_file)

    def clear_crashed(self) -> None:
        self._remove_marker(self.plan.crashed_file)

    def record_crash(
        self,
        digest: str,
        decision: str,
        exit_code: int | None,
        signal_number: int | None,
        reason: str,
        access_problem: AccessProblem | None = None,
        sizing_refused: bool = False,
        fingerprint: str = "",
    ) -> None:
        document: dict[str, Any] = {
            "spec_digest": digest,
            "decision_digest": decision,
            "exit_code": exit_code,
            "signal": signal_number,
            "at": time.time(),
            "reason": reason,
        }
        if access_problem is not None:
            document["access_problem"] = access_problem.value
            document["token_fingerprint"] = fingerprint
        if sizing_refused:
            document["sizing_refused"] = True
        self._write_json_marker(self.plan.crashed_file, document, "crashed")

    # -- the phase of a load ------------------------------------------------

    def publish_phase(self, phase: LoadPhase, downloaded_bytes: int = 0) -> None:
        """Publish where the load is. Only ever forward, and only when it changed."""
        if self._phase is not None and LOAD_PHASE_ORDER.index(
            phase
        ) < LOAD_PHASE_ORDER.index(self._phase):
            return
        if phase is self._phase and downloaded_bytes == self._phase_bytes:
            return
        self._phase = phase
        self._phase_bytes = downloaded_bytes
        document: dict[str, Any] = {
            "spec_digest": self._phase_digest,
            "phase": phase.value,
            "at": time.time(),
        }
        if phase is LoadPhase.DOWNLOADING:
            document["downloaded_bytes"] = downloaded_bytes
        self._write_json_marker(self.plan.phase_file, document, "phase")

    def clear_phase(self) -> None:
        self._phase = None
        self._phase_bytes = -1
        self._remove_marker(self.plan.phase_file)

    def observe_phase(self) -> None:
        """Work out the phase of the load under way, from disk and from vLLM's own line."""
        if self._weights_loaded:
            self.publish_phase(LoadPhase.COMPILING)
            return
        complete: bool
        downloaded: int
        complete, downloaded = weights_cache_state(self.environ, self.plan.model)
        if complete:
            self.publish_phase(LoadPhase.LOADING)
        else:
            self.publish_phase(LoadPhase.DOWNLOADING, downloaded)

    # -- gated models -------------------------------------------------------

    @property
    def token_environ(self) -> dict[str, str]:
        """The container's environment with the Manager's token, read right now."""
        return with_stored_token(self.environ, self.plan.hf_token_file)

    def gated_out(self) -> bool:
        """
        Whether a load would only run into a license or a token that will not do.

        Said once per spec and token, as a crash note carrying the problem: VIS
        reads it the way it reads a load that died, and the engine stays
        parked, the same posture, until the spec is rewritten or the token
        changes.
        """
        if not self.plan.gated:
            return False
        environ: dict[str, str] = self.token_environ
        problem: AccessProblem | None = gated_access_problem(environ, self.plan.model)
        if problem is None:
            return False
        decision: str = self._decision
        if self._gate_announced != decision:
            reason: str = (
                f"{self.plan.model} is a gated HuggingFace model and cannot be "
                f"downloaded: {ACCESS_CAUSES[problem]}"
            )
            self.record_crash(
                self._spec_file_digest(),
                decision,
                None,
                None,
                reason,
                access_problem=problem,
                fingerprint=token_fingerprint(hf_token(environ)),
            )
            warn(f"{reason}; staying parked until the desired state is rewritten.")
            self._gate_announced = decision
        return True

    def access_report(self) -> dict[str, Any]:
        """What the parked stub answers on /vif/access: can this engine load now."""
        problem: AccessProblem | None = (
            gated_access_problem(self.token_environ, self.plan.model)
            if self.plan.gated
            else None
        )
        return {
            "model": self.plan.model,
            "gated": self.plan.gated,
            "ok": problem is None,
            "access_problem": problem.value if problem is not None else "",
            "token_source": token_source(self.environ, self.plan.hf_token_file).value,
        }

    def forget_stale_gate(self) -> None:
        """
        Drop a gate note left by an earlier run of this launcher.

        The network and the environment's token are the container's, which a
        restart is what changes; the digest alone would keep the engine parked
        on a problem that may since have been fixed.
        """
        note: dict[str, Any] | None = self._read_marker(self.plan.crashed_file)
        if note is not None and note.get("access_problem"):
            self.clear_crashed()

    def forget_gate_of_another_token(self) -> None:
        """
        Drop a gate note decided with a token that is no longer the one in force.

        The Manager's token changes with no restart, so the note says which
        token it was about; with another one the next load is checked afresh.
        """
        if not self.plan.gated:
            return
        note: dict[str, Any] | None = self._read_marker(self.plan.crashed_file)
        if note is None or not note.get("access_problem"):
            return
        current: str = token_fingerprint(hf_token(self.token_environ))
        if note.get("token_fingerprint", "") == current:
            return
        self.clear_crashed()
        self._gate_announced = ""
        log(
            f"the HuggingFace token changed since {self.plan.model} was refused; "
            "the next load checks it again."
        )

    def record_child_crash(self) -> None:
        """The engine exited before it was ready: say how, for VIS and for us."""
        assert self.child is not None
        status: int = self.child.wait()
        if status < 0:
            reason: str = f"vLLM was killed by signal {-status} during its load"
            self.record_crash(
                self._load_digest, self._load_decision, None, -status, reason
            )
        else:
            reason = f"vLLM exited with code {status} during its load"
            self.record_crash(
                self._load_digest, self._load_decision, status, None, reason
            )
        warn(f"{reason}; not loading again until its spec asks for something else.")

    def reconcile_dead_load(self, was_loaded: bool) -> None:
        """
        Turn a load marker left by a launcher that died into a crash marker.

        A `loading/` marker for the spec in force and no readiness marker
        means the previous launcher died mid-load (SIGKILL, the container's
        OOM kill), so nobody wrote a crash marker. A marker for another spec
        is just stale.
        """
        marker: dict[str, Any] | None = self._read_marker(self.plan.loading_file)
        if marker is None:
            return
        self.clear_loading()
        digest: str = self._spec_file_digest()
        if was_loaded or not crash_matches(marker, digest, self._decision):
            return
        known: dict[str, Any] | None = self._read_marker(self.plan.crashed_file)
        if known is not None and crash_matches(known, digest, self._decision):
            return
        self.record_crash(
            digest,
            self._decision,
            None,
            None,
            "the previous launcher died while this engine was loading "
            "(the container was killed or ran out of memory)",
        )

    def crash_parked(self) -> bool:
        """
        Whether the last load of this very spec died, so it is not tried again.

        The same posture as a failed sleep or wake: a spec that asks for
        something new is a new decision, and gets a new attempt. A rewrite
        that only restamps the same spec is not.
        """
        marker: dict[str, Any] | None = self._read_marker(self.plan.crashed_file)
        if marker is None:
            return False
        digest: str = self._spec_file_digest()
        if not crash_matches(marker, digest, self._decision):
            return False
        if self._crash_announced != digest:
            warn(
                f"{last_load_words(self.plan.model, marker)}; staying parked "
                "until its spec asks for something else."
            )
            self._crash_announced = digest
        return True

    # -- load sizing --------------------------------------------------------

    def size_load(self) -> list[str] | None:
        """
        The command this load runs, sized from the card as it is now.

        Called under the load lock, so no other engine's load is in flight and
        what is free is what vLLM will find. None when the card cannot hold
        the weights: nothing is started, and the refusal is a crash note, so
        the engine rests parked until its spec asks for something else.
        """
        sizing: LoadSizing | None = self.plan.load_sizing
        if sizing is None:
            self._remove_marker(self.plan.sized_file)
            return self.plan.argv
        record: dict[str, Any] = {
            "spec_digest": self._spec_file_digest(),
            "decision_digest": self._decision,
            "max_utilization": sizing.max_utilization,
            "headroom_mib": sizing.headroom_mib,
            "extra_mib": sizing.extra_mib,
            "weights_mib": sizing.weights_mib,
        }
        card, why = read_card_memory(self.plan.gpu_ids, self.plan.tensor_parallel_size)
        if card is None:
            standing: float | None = utilization_in(self.plan.args)
            reason: str = (
                f"the card could not be read ({why}); the spec's utilization "
                f"{standing:g} stands"
                if standing is not None
                else f"the card could not be read ({why}); vLLM's default stands"
            )
            warn(f"{reason}.")
            self._write_json_marker(
                self.plan.sized_file,
                {
                    **record,
                    "measured": False,
                    "approved": True,
                    "utilization": standing,
                    "reason": reason,
                    "at": time.time(),
                },
                "load sizing",
            )
            return self.plan.argv
        sized: SizedLoad = size_load(self.plan.model, sizing, card)
        self._write_json_marker(
            self.plan.sized_file,
            {
                **record,
                "measured": True,
                "approved": sized.approved,
                "utilization": sized.utilization if sized.approved else None,
                "free_mib": card.free_mib,
                "total_mib": card.total_mib,
                "usable_mib": sized.usable_mib,
                "predicted_peak_mib": (
                    sized.predicted_peak_mib if sized.approved else None
                ),
                "reason": sized.reason,
                "at": time.time(),
            },
            "load sizing",
        )
        if not sized.approved:
            self.record_crash(
                self._spec_file_digest(),
                self._decision,
                None,
                None,
                sized.reason,
                sizing_refused=True,
            )
            warn(
                f"not loading: {sized.reason} Nothing was started, so nothing "
                "crashed: the card has too little free memory for the weights. "
                "Staying parked until its spec asks for something else; "
                "activating the model again sizes it anew."
            )
            return None
        log(f"load sized from the card: {sized.reason}")
        return replace(
            self.plan, args=with_utilization(self.plan.args, sized.utilization)
        ).argv

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
            self.observe_phase()
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
        desired: DesiredState = self.plan.desired_state
        if self.plan.spec_file:
            desired = self._desired_from_spec()
        elif self.plan.state_file:
            desired = self._desired_from_state_file()
        if self.lease is not None and not self.lease.held():
            return DesiredState.PARKED
        return desired

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
            document: dict[str, Any] = json.loads(raw)
            fresh: LaunchPlan = plan_from_spec(document, self.environ)
        except (json.JSONDecodeError, ConfigError) as exc:
            warn(
                f"the engine spec changed but is unusable ({exc}); "
                "keeping the last one."
            )
            return self.plan.desired_state
        self._spec_digest = digest
        self._decision = decision_digest(document)
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

    def _spec_file_digest(self) -> str:
        """
        The digest of the bytes the desired state is read from right now,
        stamps included: a rewrite that asks for nothing new changes it. What
        a spec asks for, stamps left out, is `self._decision`.
        """
        if self.plan.spec_file:
            return self._spec_digest
        return _digest_of(self.plan.state_file)

    def _already_failed(self, target: DesiredState) -> bool:
        return self._failed_move == (target, self._spec_file_digest())

    def move_hot(self, target: DesiredState) -> None:
        """
        Sleep or wake, at most once per decision.

        A failed move is not retried on the next poll: an engine that would
        not wake is one VIS has already given up on, and waking it again every
        couple of seconds, forever, helps nobody. A new spec (or state file)
        is a new decision, and gets a new attempt.
        """
        digest: str = self._spec_file_digest()
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
            make_shared_dir(Path(self.plan.log_file).parent)
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
                if not self._weights_loaded and WEIGHTS_LOADED.search(line):
                    self._weights_loaded = True
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
        no /sleep, a new GPU pin must reach the new process, and so must a
        token set in the Manager since.
        """
        return {**self.token_environ, **self.plan.env}

    def start(self, argv: list[str]) -> None:
        if not self.plan.log_file:
            self.child = subprocess.Popen(argv, env=self.child_env)
            return
        self.child = subprocess.Popen(
            argv,
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
        self.clear_phase()
        self._weights_loaded = False
        self._phase_digest = self._spec_file_digest()
        self.publish_phase(LoadPhase.WAITING)
        try:
            return self._load_engine(target)
        finally:
            self.clear_phase()

    def _load_engine(self, target: DesiredState) -> int | None:
        # A wait that outlives the ask ends parked; the watch loop follows
        # whatever the spec says now.
        if not self.wait_for_pool(target):
            self.hold_parked()
            return None
        if self.terminating:
            return 0
        lock: LockWait = self.take_load_lock(target)
        if lock is LockWait.STOPPED:
            return 0
        if lock is LockWait.SUPERSEDED:
            self.hold_parked()
            return None
        if self.terminating:
            self.release_load_lock()
            return 0
        # Another engine may have started serving while this one waited for
        # the lock; loading beside it is what the guard exists to prevent.
        if self.load_guarded(target):
            self.release_load_lock()
            self.hold_parked()
            return None
        argv: list[str] | None = self.size_load()
        if argv is None:
            self.release_load_lock()
            self.hold_parked()
            return None
        self.mark_loading()
        self.start(argv)
        # A stop that landed while the child was being spawned found no child
        # to forward to; hand it over now.
        if self.terminating and not self._forwarded and self.child is not None:
            self.child.terminate()
            self._forwarded = True
        health: int = self.wait_for_health()
        if health == 1:
            # The same posture as a load that dies: without a crash note the
            # restarted launcher would load the same spec again and hold the
            # load lock for another full budget, for as long as it stays wedged.
            reason: str = (
                f"vLLM gave no /health in {self.plan.health_timeout_seconds}s "
                "during its load"
            )
            self.record_crash(
                self._load_digest, self._load_decision, None, None, reason
            )
            warn(
                f"no /health in {self.plan.health_timeout_seconds}s; "
                "stopping it and releasing the lock. Not loading again until "
                "its spec asks for something else."
            )
            # stop_child releases the lock once the card is free: the next
            # load sizes itself against the card as it finds it.
            self.stop_child()
            return EXIT_HEALTH_TIMEOUT
        if health == 2:
            self.release_load_lock()
            code: int = self.await_child()
            if not self.terminating:
                self.record_child_crash()
            return code

        self.state = DesiredState.AWAKE
        self.mark_ready()
        self.clear_crashed()
        self.clear_loading()
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
        if self.plan.disabled:
            # Nothing is ever loaded, so there is nothing to ask the hub.
            self._stub.start(self.plan.port, self.plan.model, disabled=True)
            return
        self._stub.start(self.plan.port, self.plan.model, self.access_report)

    def enter(self, target: DesiredState) -> int | None:
        """One desired-state transition. An exit code means the container stops."""
        if (
            self.state is DesiredState.PARKED
            and self._stub.disabled != self.plan.disabled
        ):
            # The flag changed while parked: restart the stub so /vif/parked
            # answers for the spec now in force.
            self._stub.stop()
            self.hold_parked()
        if target is self.state:
            return None
        hot: bool = DesiredState.PARKED not in (target, self.state)
        if hot and self._already_failed(target):
            return None
        if self.state is DesiredState.PARKED and (
            self.load_guarded(target) or self.crash_parked() or self.gated_out()
        ):
            return None
        log(f"desired state: {self.state} -> {target}.")
        if target is DesiredState.PARKED:
            self.stop_child()
            self.hold_parked()
            return None
        if self.state is DesiredState.PARKED:
            # From here until vLLM answers /health, nothing answers it.
            self.mark_starting()
            self._stub.stop()
            try:
                return self.start_engine(target)
            finally:
                self.clear_starting()
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
        was_loaded: bool = (
            bool(self.plan.ready_file) and Path(self.plan.ready_file).exists()
        )
        self.clear_ready()
        self.clear_awake()
        self.clear_starting()
        self.clear_phase()
        self.forget_stale_gate()
        target: DesiredState = self.poll_desired()
        self.reconcile_dead_load(was_loaded)
        if (
            target is DesiredState.PARKED
            or self.load_guarded(target)
            or self.crash_parked()
            or self.gated_out()
        ):
            self.hold_parked()
        else:
            code: int | None = self.start_engine(target)
            if code is not None:
                return code

        while not self.terminating:
            if self.child is not None and self.child.poll() is not None:
                return self.await_child()
            if self.plan.watches:
                if self.state is DesiredState.PARKED:
                    self.forget_gate_of_another_token()
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
        self.clear_starting()
        self.clear_loading()
        self.clear_phase()
        self.release_load_lock()
        self._stub.stop()


# ── slots ──────────────────────────────────────────────────────────────────


class SlotStatus(StrEnum):
    ASSIGNED = "assigned"
    UNASSIGNED = "unassigned"
    MISCONFIGURED = "misconfigured"


def write_json_atomically(path: Path, document: dict[str, Any]) -> None:
    make_shared_dir(path.parent)
    temporary: Path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def register_slot(state_dir: Path, slot: str, model: str) -> str:
    """Say on the volume what this slot was given to serve; returns the nonce."""
    nonce: str = os.urandom(8).hex()
    write_json_atomically(
        state_dir / ENGINE_SLOTS_DIRNAME / f"{engine_key(slot)}.json",
        {
            "slot": slot,
            "model": model,
            "hostname": socket.gethostname(),
            "nonce": nonce,
            "launcher_revision": LAUNCHER_REVISION,
        },
    )
    return nonce


def read_slot_verdict(state_dir: Path, slot: str, nonce: str) -> dict[str, Any] | None:
    """VIS's verdict on this start's registration, or None while there is none."""
    path: Path = (
        state_dir / ENGINE_SLOTS_DIRNAME / f"{engine_key(slot)}{SLOT_ASSIGNMENT_SUFFIX}"
    )
    try:
        verdict: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(verdict, dict) or verdict.get("nonce") != nonce:
        return None
    return verdict


@dataclass
class SlotLease:
    """
    An assigned slot's hold on its model, which VIS can take back.

    A restarted VIS may hand the model to another slot; this one then parks
    until a verdict assigns it again.
    """

    state_dir: Path
    slot: str
    nonce: str
    model: str
    lost: bool = False

    def held(self) -> bool:
        """Re-read VIS's verdict; an unreadable one changes nothing."""
        verdict: dict[str, Any] | None = read_slot_verdict(
            self.state_dir, self.slot, self.nonce
        )
        if verdict is None:
            return not self.lost
        now: str = str(verdict.get("model") or self.model)
        lost: bool = verdict.get("status") != SlotStatus.ASSIGNED or now != self.model
        if lost and not self.lost:
            reason: str = str(verdict.get("reason") or verdict.get("status"))
            if now != self.model:
                reason = f"VIS now assigns this slot {now}; recreate its container"
            warn(f"slot {self.slot} lost {self.model}: {reason}. Parking.")
        elif self.lost and not lost:
            log(f"slot {self.slot} assigned {self.model} by VIS again.")
        self.lost = lost
        return not lost


def run_slot(environ: dict[str, str], slot: str) -> SlotLease:
    """Register this slot and wait until VIS assigns it its model."""
    state_dir_text: str = env_value(environ, "VIF_STATE_DIR")
    if not state_dir_text:
        raise ConfigError(f"slot {slot} needs VIF_STATE_DIR to register on")
    state_dir: Path = Path(state_dir_text)
    model: str = env_value(environ, "VLM_MODEL")
    port: int = env_int(environ, "VLM_PORT", 8000)
    timeout: int = env_int(
        environ, "VIF_SPEC_TIMEOUT_SECONDS", DEFAULT_SPEC_TIMEOUT_SECONDS
    )
    poll: float = env_float(
        environ, "VIF_WATCH_POLL_SECONDS", DEFAULT_WATCH_POLL_SECONDS
    )
    try:
        nonce: str = register_slot(state_dir, slot, model)
    except OSError as exc:
        raise ConfigError(
            f"slot {slot} cannot register on {state_dir} ({exc}) -- is the state "
            "volume mounted and writable?"
        ) from None
    stub: ParkedStub = ParkedStub(
        env_value(environ, "VIF_ENGINE_HOST", DEFAULT_ENGINE_HOST)
    )
    if not model:
        log(
            f"slot {slot} has no model of its own: resting on the health stub "
            "until VIS assigns it a custom model from the catalog overlay."
        )
        stub.start(port, "", extra={"slot": slot, "unassigned": True})
        while True:
            proposal: dict[str, Any] | None = read_slot_verdict(state_dir, slot, nonce)
            picked: str = "" if proposal is None else str(proposal.get("model") or "")
            if (
                proposal is not None
                and picked
                and proposal.get("status") == SlotStatus.ASSIGNED
            ):
                stub.stop()
                log(f"slot {slot} assigned {picked} by VIS.")
                return SlotLease(state_dir, slot, nonce, picked)
            if pause(poll):
                stub.stop()
                raise Stopped(f"slot {slot} stopped")

    log(f"slot {slot} registered for {model}; waiting for VIS to assign it...")
    stub.start(port, model, extra={"slot": slot})
    deadline: float = time.monotonic() + timeout
    announced: str = ""
    answered: bool = False
    while True:
        verdict: dict[str, Any] | None = read_slot_verdict(state_dir, slot, nonce)
        if verdict is not None:
            answered = True
            if verdict.get("status") == SlotStatus.ASSIGNED:
                stub.stop()
                log(f"slot {slot} assigned {model} by VIS.")
                return SlotLease(state_dir, slot, nonce, model)
            reason: str = str(verdict.get("reason") or verdict.get("status"))
            if reason != announced:
                warn(
                    f"slot {slot} is misconfigured: {reason}. Resting on the "
                    "health stub."
                )
                announced = reason
                stub.stop()
                stub.start(
                    port,
                    model,
                    extra={"slot": slot, "misconfigured": True, "reason": reason},
                )
        elif not answered and time.monotonic() >= deadline:
            stub.stop()
            raise ConfigError(
                f"VIS never answered slot {slot}'s registration within {timeout}s "
                "-- is VIS running, and is the state volume shared?"
            )
        if pause(poll):
            stub.stop()
            raise Stopped(f"slot {slot} stopped")


def supervise(
    plan: LaunchPlan, environ: dict[str, str], lease: SlotLease | None = None
) -> int:
    engine: Engine = Engine(plan, environ, lease)
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
            "load_sizing": (
                None if plan.load_sizing is None else asdict(plan.load_sizing)
            ),
            "disabled": plan.disabled,
            "gpu_shared": plan.gpu_shared,
            "sized_file": plan.sized_file,
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
        slot: str = env_value(dict(os.environ), "VIF_SLOT")
        lease: SlotLease | None = None
        environ: dict[str, str] = dict(os.environ)
        if slot and not dry_run:
            lease = run_slot(environ, slot)
            environ["VLM_MODEL"] = lease.model
        plan: LaunchPlan = build_plan(environ)
    except ConfigError as exc:
        warn(str(exc))
        return EXIT_CONFIG
    except Stopped as exc:
        log(f"{exc}; exiting.")
        return 0

    if dry_run:
        print(json.dumps(describe(plan), indent=2))
        return 0

    if plan.disabled:
        log(
            f"{plan.model} is disabled by the catalog overlay: it rests parked, "
            "with no engine process, no weights and no load lock, until VIS "
            "writes a spec without the flag."
        )
        return supervise(plan, environ, lease)
    if plan.desired_state is DesiredState.PARKED:
        log(f"{plan.model} starts parked: no engine process until VIS asks for one.")
        return supervise(plan, environ, lease)

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

    return supervise(plan, environ, lease)


if __name__ == "__main__":
    sys.exit(main())
