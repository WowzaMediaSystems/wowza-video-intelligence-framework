# Model Manager spike — gated checks

Runnable checks for the parts of the VIF Model Manager (see
[`docs/vif-model-manager-proposal.md`](../../docs/vif-model-manager-proposal.md))
that cannot be proved on CI: they need a real GPU, real weights and a real vLLM
engine. They exercise the opt-in pool duties in
[`vif-vlm-launcher.py`](../../vif-vlm-launcher.py) and the Bearer guard in
[`vlm-patches/vif_auth.py`](../../vlm-patches/vif_auth.py).

**These have not been run.** They are written to be run on rented datacenter-GPU
hardware, as part of the phase-0 spike. Nothing here runs in CI, and nothing
here is part of a customer deployment — the duties they exercise are off by
default and the shipped stack never sets the variables that turn them on.

`test_vif_auth.py` is the exception: it is a plain unit test of the middleware
against a dummy ASGI app and needs no GPU. Run it anywhere.

## Prerequisites

- A host with an NVIDIA GPU, current drivers and the NVIDIA Container Toolkit.
- Docker, `curl` and `python3` on the host.
- Enough VRAM for the model under test, plus room for a second engine in the
  lock check. A 40–48 GB datacenter card covers the whole catalog.
- `HF_TOKEN` exported if the model under test is license-gated.

## Configuration

Everything is env, with defaults that work on a single-GPU box:

| Variable | Default | What it selects |
| --- | --- | --- |
| `VIF_SPIKE_IMAGE` | `vllm/vllm-openai:v0.26.0` | the pinned engine image |
| `VIF_SPIKE_MODEL_A` | `Qwen/Qwen3-VL-4B-Instruct-FP8` | the model most checks load |
| `VIF_SPIKE_MODEL_B` | same as A | the second engine in the lock check |
| `VIF_SPIKE_GPUS` | `all` | passed to `docker run --gpus` |
| `VIF_SPIKE_STATE_DIR` | `/tmp/vif-spike-state` | host dir standing in for the shared state volume |
| `VIF_SPIKE_HF_CACHE` | `~/.cache/huggingface` | weights cache, so runs after the first are warm |
| `VIF_SPIKE_UTILIZATION` | `0.80` | `--gpu-memory-utilization` for each engine; the pool checks need two resident at once |
| `VIF_SPIKE_PORT_A` / `_B` | `18001` / `18002` | published ports |
| `VIF_SPIKE_READY_TIMEOUT` | `900` | seconds to wait for an engine to come up |
| `VIF_SPIKE_HEALTH_TIMEOUT` | `90` | the launcher's health deadline in the wedge check |
| `VIF_SPIKE_API_KEY` | `spike-key` | the key the middleware check uses |

Run one check, or all of them:

```bash
cd spike/vif-model-manager
bash 03-self-sleep-matrix.sh
bash run-all.sh              # all five, one at a time; they share the state dir
```

Each check cleans up its own containers on exit and prints `PASS` / `FAIL` per
assertion; the exit code is non-zero if any assertion failed.

## The checks

### `01-supervisor-exit-code.sh`

`docker stop` on a running engine must reach the `vllm serve` child through the
launcher. Asserts a supervised child exists (not the `exec` path), that the
container's exit code is `0`, and that it stopped before the daemon's 10 s
SIGKILL — a forwarded SIGTERM, not a killed container.

### `02-load-lock-serialization.sh`

Two engines started at once on one GPU must load one after the other. Both
engines run with the same `VLM_LOAD_LOCK_FILE`; the assertion is on `docker logs
-t` timestamps — the second engine logs that it waited, takes the lock only
after the first releases it, and starts `Loading weights` after the first was
ready.

### `03-self-sleep-matrix.sh`

The state file decides who stays awake. Three cases, each a fresh engine:

| State file | Expected |
| --- | --- |
| absent | `is_sleeping == true` — the safe default; several awake engines is how one card OOMs |
| names another model | `is_sleeping == true` |
| names this model | `is_sleeping == false` |

`/health` must answer `200` in all three, including while asleep — otherwise the
compose healthcheck would kill parked engines.

### `04-lock-timeout-recovery.sh`

A wedged engine must not hold the pool's lock forever. The check SIGSTOPs the
supervised child so it never answers `/health`, then asserts the launcher
releases the lock, the container exits `75`, and the restart policy brings it
back to a *healthy* engine. The retry is the promise, not the exit code.

### `05-auth-middleware-matrix.sh`

The `vif_auth` middleware, mounted through `--middleware`, against a live
engine. With `VLLM_API_KEY` set: `/health`, `/ping`, `/metrics` and `/version`
answer `200` with no key; `/is_sleeping` answers `401` without and `200` with;
`/v1` behaves exactly as vLLM's own auth makes it behave, with no second
challenge. `POST /collective_rpc` and `POST /sleep` without the key must be
`401` **and have no effect** — the check reads `is_sleeping` before and after
and requires it unchanged. Then the same engine with no key configured, where
every path is open: the documented keyless posture, unchanged from today.

### `test_vif_auth.py`

The middleware's own decisions, no GPU and no vLLM — which paths it guards,
which stay open, that `/v1`/`/v2`/`/inference` are never double-guarded, that an
unset or empty key makes it inert, and that `root_path` is stripped before
matching. Needs `pytest`, `starlette` and `httpx`; the pinned engine image
already has all three, which is the cheapest way to test against the exact
Starlette the middleware will run under:

```bash
docker run --rm -v "$PWD:/repo" -w /repo --entrypoint python3 \
  vllm/vllm-openai:v0.26.0 -m pytest spike/vif-model-manager/test_vif_auth.py -q
```

## What the spike still owes beyond these checks

The measurements — wake latency per sleep level, host RAM per sleeper, residual
VRAM, whether the whole catalog fits resident — are the spike's actual output
and its GO/NO-GO input. These scripts only prove the mechanism behaves; they say
nothing about whether it is fast or small enough.

## WSL2 caveat (2026-09-21)

Sleep mode requires vLLM's cumem allocator, which requires CUDA UVA — unavailable under WSL2.
An engine started with `--enable-sleep-mode` on WSL2 crashes at boot (`RuntimeError: UVA is not
available`). These checks therefore need a native-Linux GPU host; a WSL2 box (e.g. the local 5060)
can only exercise the lock/supervisor/flag paths with sleep mode OFF. How managed deployments
should behave on no-UVA platforms is an OPEN design item (starting without sleep mode conflicts
with multiple resident models — all engines would be awake at full reservation).
