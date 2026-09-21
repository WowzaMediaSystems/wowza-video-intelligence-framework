# VIF Model Manager

Putting model choice under VIF's own control — a customer picks a model by name, the switch takes seconds, and vLLM is orchestrated out of sight rather than rebuilt.

> **Proposal · 28 August 2026 · Video Intelligence Framework**
>
> Nothing implemented · no tickets filed
> Est. 7–9 weeks, phased
> Repo copy: `docs/vif-model-manager-proposal.md`

## Contents

- [Summary](#summary)
- [Where things stand](#where-things-stand)
- [What we already have](#what-we-already-have)
- [The switching physics](#the-switching-physics)
- [A VIF Model Manager](#a-vif-model-manager)
- [The orchestrator](#the-orchestrator)
- [The managed endpoint](#the-managed-endpoint)
- [Why the other shapes lose](#why-the-other-shapes-lose)
- [Phasing](#phasing)
- [Risks and open questions](#risks-and-open-questions)
- [Evidence index](#evidence-index)

---

## Summary

*Context*

VIF has three moving parts. The engine (WSE plus the Video Intelligence Controller) taps a live stream and pushes frame batches to VIS, the inference service. For the detectors that need a vision-language model — the standalone `detector_type=vlm` analyzer, and the `vlm_verification` overlay on scene and object detection — VIS calls out to a VLM endpoint over OpenAI-compatible HTTP. In the shipped stack that endpoint is a sidecar container running the third-party `vllm/vllm-openai` image, started by an opt-in compose profile.

### The problem

vLLM is in the customer's face, and it should not be.

- Choosing a model means setting `VLM_CONF` in `.env`, which selects a file from `vlm-env/`, which is a list of raw vLLM command-line flags. The vocabulary a customer learns is vLLM's, not VIF's.
- Changing model is a shell operation, not a product operation. The documented flow is edit `.env`, then `docker compose --profile default --profile vlm up -d` to recreate the sidecar in place — and the guide has to warn that a bare `down` misses the profile-gated container entirely. There is no in-product way to switch.
- The sidecar's tuning ships as prose the customer is expected to read and act on. `qwen.env` instructs them to delete a flag by hand on a 40 GB+ card; `cosmos-nano.env` explains in a comment which flag to drop on an 80 GB card. Nobody will do this.

The goal is that an average customer thinks "VIF serves VLMs, cool" and never learns the word vLLM.

### The finding

The gap is much narrower than the current UX suggests — and narrower than a process-lifecycle problem. Everything downstream of "an engine serving model X is running" already works live with no restart, and vLLM's sleep mode removes the restart from switching itself: several engines sit resident on one GPU with all but one asleep, a sleeping engine releases ~90%+ of its GPU memory, and waking one takes seconds. Switching is an orchestration problem — sleep one engine, wake another — not an engine build problem.

### The proposal

A Model Manager inside VIS: a model catalog (friendly names plus machine-readable sizing, tuning and residency metadata, replacing the `vlm-env` flag files), an engine-pool orchestrator with two backends — stock sidecar containers driven purely over HTTP in Docker; supervised child processes from a second venv in Linux standalone — and a small control API the Manager UI drives. vLLM disappears from the documented customer path; `endpoint_url` demotes to an advanced "bring your own endpoint" option. Windows standalone stays endpoint-only, permanently.

About 7–9 weeks, phased so each phase ships something. The Docker UX win lands in phase 1, because no image merge precedes it. Tidying the launch script is worth doing but solves neither goal on its own — it is phase 0. Merging vLLM into the VIS image and embedding it as a Python library are both examined and not taken for Docker; the first survives only as the standalone-Linux mechanism, where nothing else works.

---

## Where things stand

*Baseline*

The entire vLLM-specific surface in the framework repo is small — which is the good news, and also why the current arrangement has never been worth defending on complexity grounds.

### The sidecar, in full

| Piece | What it is |
| --- | --- |
| `vlm-entrypoint.sh` | 182 lines (~50 of real logic after a 71-line doc banner): GPU compute-capability probe → fp8 KV-cache dtype, engine-arg assembly, `--limit-mm-per-prompt`, auto `--max-num-seqs`, pixel processor kwargs, `VLM_EXTRA_ARGS` passthrough. GPU pinning happens here via `CUDA_VISIBLE_DEVICES` — the compose reservation itself is `count: all` |
| `vlm-env/*.env` | 6 model profiles, ~1 KB each: HF model id plus hand-tuned flags. Five customer-facing; the sixth is an internal smoke test that runtime-attaches a LoRA fine-tune to Cosmos3-Nano |
| `vlm` compose service | image pinned `vllm/vllm-openai:v0.26.0`, `env_file` selected by `VLM_CONF`, weights + compile-cache volumes, `ipc: host`, healthcheck, restart policy, opt-in `--profile vlm` |
| `vlm-patches/cosmos3_edge.py` | one vLLM model file (verbatim from a newer vLLM release), bind-mounted read-only over the image's dist-packages |
| `docker-compose.vlm-multi.yaml` | override adding a second engine; its header documents copy-the-block for a third, and co-locating two models on one card by keeping the sum of their `VLM_GPU_MEMORY_UTILIZATION` under 1 |

Two flags are pinned in the entrypoint as workload correctness for a stream of never-repeating frames: `--no-enable-prefix-caching` and `--mm-processor-cache-gb=0`. (Not exposed — though `VLM_EXTRA_ARGS` is appended last and vLLM's parsing is last-wins, so the escape hatch can in practice override them.)

#### What a customer touches today

- `VLM_CONF`
- `VLM_GPU_IDS`
- `VLM_2_CONF` / `VLM_2_GPU_IDS`
- `VLLM_API_KEY`
- `HF_TOKEN` / `HF_HUB_OFFLINE`
- `vlm-env/*.env` flag files
- `--profile vlm` incantations
- `endpoint_url` + `model_name`

#### What they would touch after

- a model name, from a dropdown
- an HF token, once, for gated models
- — and, if they insist, `endpoint_url` (advanced)

### Three other facts worth recording

**The launch script has forked — and one copy is dead.** The framework's `vlm-entrypoint.sh` (182 lines, revision marker 2026-07-24) is the live one. The VIS repo carries its own copy (166 lines, 2026-06-10) that nothing references — no compose file, Dockerfile, CI workflow or doc in the VIS repo mentions it. Live drift plus dead weight, today.

**The test and doc surface is real, and modest.** 10 e2e test files declare (by docstring convention — there is no marker machinery) a dependency on the vLLM sidecar, over 10 dedicated VLM config fixtures; two more VLM tests deliberately run without it to exercise the unreachable-endpoint path. One UI spec is dedicated to the endpoint field, four more assert on `endpoint_url`/`api_key` round-trips. The customer-facing `VLM_GUIDE.md` is 268 lines; its four topologies vary where the engine sits relative to VIS.

**One coverage gap.** The e2e test for VLM reconfigure of a running stream has been removed (only stale bytecode remains) — the live-reconfigure path this proposal leans on has no end-to-end coverage right now.

---

## What we already have

*Finding*

Three things are already built and reusable. Together they are why this is an orchestration problem rather than a rewrite.

**Friendly naming is half-built.** `VLM_MODEL_OPTIONS` already holds five curated entries with human labels — "Qwen3-VL-4B (Qwen)", "Nemotron Nano 12B VL (NVIDIA)" — plus an `__other__` sentinel revealing a free-text input. It is simply hardcoded, synced by hand in three places.

> `vif-stream-config.js:41` · `Default.json:122` · `VlmConfigMessage.java:23`

**Model switching is already live.** The client pool is keyed on `(endpoint_url, api_key)` only, and the model is a per-request field. Live reconfigure of a running stream is supported — the old session closes and immediately reopens.

> `client.py:445, :210` · `session.py:282` · `registry.py:128`

**Two engines at once is documented.** With the `vlm-multi` override both engines run warm, and moving a stream between them is a stream-config edit — no container is touched. What's missing is everything around that: bringing engines up, knowing what fits, doing it from the product.

> `docker-compose.vlm-multi.yaml` · `VLM_GUIDE.md:160-173`

### What that adds up to

The perceived problem — "changing model means shell commands and an engine reload" — is the cost of engine orchestration, nothing else. The plumbing underneath a switch already exists end to end.

---

## The switching physics

*Constraint*

**No base-model hot swap in a process.** vLLM's runtime reconfiguration within one server process covers LoRA adapters only: `POST /v1/load_lora_adapter` and `/v1/unload_lora_adapter`, gated behind `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True`. One process serves one base model for its lifetime.

**Awake engines claim memory eagerly.** The shipped profiles set `VLM_GPU_MEMORY_UTILIZATION=0.80` (`qwen.env`) and `0.87` (`cosmos-nano.env`); the entrypoint default is `0.90`. Two engines cannot both be awake on one card at those values (they can co-exist at reduced values, at the cost of KV-cache headroom for both).

**Sleep mode is the way out.** A vLLM server started with `--enable-sleep-mode` can be put to sleep and woken over HTTP. Level 1 offloads weights to CPU RAM and discards the KV cache — waking is a copy back from RAM, upstream-measured at ~0.3 s for a small model to ~3–6 s for a 235B model. Level 2 discards weights too (a few MB of RAM per sleeping engine) — waking re-reads them from page cache or disk, ~0.8–2.6 s on upstream's test models. A sleeping engine keeps its process, compiled graphs and warm state, so woken engines skip the cold-start penalty entirely. Multimodal models and FP8 quantization — both of which our catalog uses — are demonstrated upstream. Discarding the KV cache costs us nothing: prefix caching is already pinned off for never-repeating frames.

### The four paths, and what each costs

| Path | Sequence | Cost |
| --- | --- | --- |
| **Resident models — sleep / wake** (the normal switch) | drain → sleep old → wake new → ready | Seconds, not minutes: ≈ 1–6 s upstream · the phase-0 spike measures ours |
| **First activation** — once per model per host | start → download + load weights → compile → ready | 40 s – 2 min warm · minutes cold |
| **Spare GPU — warm cutover** | old engine keeps serving; new engine wakes on card 2 → cut over → sleep old | No interruption |
| **LoRA adapter — same base model** | runtime adapter load, no restart | Instant |

First activation keeps the old cost profile — the compile cache exists to keep the ~40 s recompile off later paths. Every switch after that is a sleep/wake among resident engines. An internal smoke-test profile already runtime-attaches a LoRA fine-tune to Cosmos3-Nano, so the adapter fast path has an in-house consumer.

### Two caveats to carry honestly

The sleep/wake endpoints sit behind `VLLM_SERVER_DEV_MODE=1` and upstream frames them as development endpoints for trusted networks — fine inside the compose network or on loopback, but an API surface upstream does not yet call stable; the pinned image insulates us and a capability probe must guard it. And upstream's wake timings are upstream's models on upstream's hardware: a phase-0 spike measures sleep/wake for our five catalog models under the pinned image, patched Cosmos3-Edge included, before phase 1 commits to the numbers.

**What to promise.** One click. Switching among resident models: a progress state that resolves in seconds. First activation of a new model: an honest staged readout — downloading, compiling, ready — because that path is minutes, and a customer who cannot see which stage they are in will assume it hung.

---

## A VIF Model Manager

*Proposal*

### Customer-facing surface

- **Models have VIF names.** "Qwen3-VL 4B", "Nemotron Nano 12B VL", "Cosmos3 Edge". The HuggingFace id, the engine flags and the serving port are internal detail.
- **Switching is a dropdown plus a progress state in Manager**, not a shell command. Streams keep running; VLM analysis pauses with a visible reason for the seconds a same-GPU sleep/wake takes, or not at all when a second card allows a warm cutover.
- **vLLM leaves the documented path.** `VLM_CONF`, `vlm-env/`, the `VLM_*` block and the profile incantations disappear from what a normal customer reads; compose services get VIF names.
- **`endpoint_url` demotes to advanced.** It must not be removed — see below — but the default becomes "VIF-managed", and bring-your-own becomes the exception a customer opts into.

### The model catalog

The `vlm-env` profiles become named model definitions shipped inside VIS. The important change is not the format, it is that today's prose becomes data. `cosmos-nano.env` currently says, in a comment:

> `--enforce-eager` is here because ~32 GB of weights leave little room for CUDA graphs on a 40-48 GB card. On an 80 GB card (or 2x 24 GB with `VLM_TENSOR_PARALLEL_SIZE=2`) drop it.

That is a tuning decision keyed on detected hardware, written as a sentence and delegated to the customer. A catalog entry carries it as fields — minimum VRAM, tuning tier per GPU class, tensor-parallel eligibility, per-request image cap, pixel-kwarg support, sleep-residency defaults (level 1 vs 2 by host RAM), and whether the model is license-gated on HuggingFace — so the manager picks correctly without anyone reading a comment. `qwen.env` has the same shape of instruction.

Adding a model becomes adding a catalog entry, which is also what makes the UI dropdown stop being a list synced by hand across three files — the UI reads the catalog over the control API. Customers who copied a profile to a local file (the documented `vlm-env/local.env` convention, promised to survive upgrades) get a catalog-overlay equivalent and a migration note.

Two naming decisions up front: VIS already has a `model_catalog` — it enumerates detection checkpoints and serves them over HTTP — so the VLM catalog needs its own name and API surface rather than a quiet extension of a documented response shape. And the ids streams use stay the served model ids (the HF ids); friendly labels are presentation.

---

## The orchestrator

*Mechanism*

The heart of the work is one state machine, with two backends. Per engine:

```
absent → starting → loading → ready(awake) ⇄ asleep
                                  ↘ failed (→ rollback to the previously working engine)
                        draining → sleeping/stopping
```

Pool-level rules: pre-flight VRAM/RAM checks that refuse before touching a working engine, at-most-N-awake per GPU (N=1 at shipped utilization values), staged progress (downloading / compiling / waking / ready), and rollback — the worst outcome of a one-click switch is ending up with nothing serving.

```
   engine                 VIS                          engine pool
 WSE + VIC          Model Manager                Qwen3-VL 4B     awake · serving
                    catalog · orchestrator       Nemotron Nano 12B   asleep
                    managed endpoint /v1         Cosmos3 Edge        asleep

   ── WebSocket ──▶                ── HTTP · routes by model ──▶
                                   ── sleep · wake · health ──▶

        stock containers in Docker · child processes standalone
```

**One pool, two backends.** Streams point at one stable managed endpoint; the request's `model` field picks the engine. The orchestrator's only levers over the pool are HTTP calls it already has in both shapes.

#### Docker — orchestrate stock sidecars over HTTP

- Engines stay unmodified `vllm/vllm-openai` containers with VIF service names, one per resident catalog model, profile-gated. The resident set is a one-time compose choice; everything per-switch is UI.
- Each engine starts with `--enable-sleep-mode`. The phase-0 Python launcher gains two duties: serialize initial loads on a shared GPU (a lock on a shared volume — N engines loading at once would OOM the card) and self-sleep after first health unless it is the active model.
- VIS never gains the Docker socket (root-equivalent on the host). It discovers the pool via `health`/`is_sleeping` probes and switches with `/sleep` + `/wake_up`. Adding a never-resident model stays a compose-level change the UI shows honestly as "available, not resident".
- In exchange: upstream upgrades stay an image tag bump, CVE ownership stays upstream's, the model-patch bind-mount survives unchanged.

#### Linux standalone — supervise child processes

- No containers exist, so VIS owns the processes: spawn `vllm serve` per resident model from a second venv (vLLM pins `torch==2.11.0`; VIS pins `2.9.1+cu128`, ABI-linked — one venv cannot hold both), relay logs, poll healthy, restart with backoff, shut down in order. Same state machine, same sleep/wake HTTP, against `127.0.0.1`.
- Installer work: the payload is literally the image's venv and the relocation machinery assumes exactly one — generalise it; a second torch/CUDA stack roughly doubles the payload, arguing for a separate `-vlm` installer variant.
- systemd stays one unit — engines are children of the VIS service. The unit's hardening was written for a single Python process; the engines' weights cache and shared-memory appetite get measured against it, not guessed.

#### Windows standalone — endpoint-only, ever

A separate native build path (Windows venv, Nuitka-compiled `.pyd`, venv shipped as `runtime.7z` behind an NSSM service), and vLLM publishes no Windows wheel. Windows VIS reports no engine capability; the UI shows the bring-your-own flow only. Note `installers/` contains zero VLM mentions today on either OS — any standalone work is net-new capability, not a migration.

### Control API

```
GET  /vlm/models                  catalog · loadable on this hardware · resident · awake · state
POST /vlm/models/{id}/activate    pre-flight · wake or first-load · drain · progress
GET  /vlm/status                  engine health · GPU/RAM placement · capacity
```

Authentication is part of the design, not an afterthought: activate changes what the whole deployment serves, so the API rides VIS's existing HTTP auth posture and the design doc must say so for deployments where VIS is reachable beyond the compose network.

---

## The managed endpoint

*Contract*

The wire protocol makes `endpoint_url` a required, non-empty field on both VLM message types, per-stream endpoints are an advertised capability (hosted endpoints included), and a UI regression test exists specifically to guard per-stream endpoints against being collapsed into a global one. So "VIF-managed" must not mean deleting or globalizing the field. The clean shape:

- VIS exposes one stable OpenAI-compatible URL — the managed endpoint — that routes each request by its `model` field to the right engine in the pool. Managed streams all point at this one URL and differ only by model name; the pool key never churns across switches; per-stream model choice is preserved exactly as the protocol already allows.
- VIC's compiled-in default `endpoint_url` becomes the managed endpoint. In compose, the managed endpoint can inherit the network alias streams already point at, making existing stream configs migrate with zero edits — a deliberate decision to make, not an accident.
- The Engine-side Verify probe (`GET <endpoint>/models`, run from the Engine because the operator's browser cannot resolve compose-internal hostnames) keeps working against the managed endpoint unchanged — VIS answers `/models` with what is awake. Whether a request naming a sleeping model fails fast with a clear reason or triggers an auto-wake is an explicit policy decision; default to fail-fast, revisit with data.
- Bring-your-own endpoints bypass all of this untouched.

### The supervisor–breaker race

VIS's VLM client assumes engine downtime is external: a circuit breaker trips on connect failures and waits out the outage, and the per-pool learned image cap is forgotten only on connect failure — the code's own comment says a sidecar restart is exactly when operators change settings. A VIS-owned switch inverts that: the managed URL never goes down, nothing trips, and a swap would leave a stale learned cap from the previous model. The orchestrator must tell the client layer about managed swaps explicitly — suspend the breaker for the drain window, reset the learned cap on activate, and surface "paused: switching model" as a distinct, visible reason (the degraded path and its e2e test already exist for the unreachable case).

### What must stay

`endpoint_url` and the OpenAI-compatible HTTP client are permanent: Windows standalone cannot host a local engine; bring-your-own and hosted endpoints are a documented, tested capability; and the Verify probe stays, targeting whatever endpoint the stream names. The abstraction is "VIF-managed by default, bring-your-own if you want", never "VIF only".

---

## Why the other shapes lose

*Alternatives considered*

### Tidy the launch script into VIS

**5–8 days · Do it — as phase 0, not as the fix**

Move the entrypoint and `vlm-env/` into VIS as the single source of truth, rewritten as an OS-agnostic Python launcher (VIS already depends on `nvidia-ml-py`, so the compute-capability probe needs no `nvidia-smi` shell-out). It kills the fork — including deleting the VIS repo's orphaned, never-referenced copy — and it is the foundation the catalog and the launcher's new sleep-mode duties sit on. But by itself the customer still edits flag files and runs compose commands.

### Merge vLLM into the VIS image

**3–4 weeks before any UX lands · Not for Docker — survives only as the standalone mechanism**

Workable (an isolated venv with its own torch sidesteps the dependency wall), and exactly what Linux standalone requires, where there is no container boundary to lean on. For Docker it buys one thing the sidecar shape lacks — vLLM invisible at install time — and pays three avoidable costs: the ~24 GB-class engine image becomes our build, our CVE surface and our `THIRD_PARTY_NOTICES` growth where today an upgrade is a tag bump; the model-patch bind-mount needs a replacement inside our build; and the VIS image roughly quadruples for every customer, including the majority not using VLM features. Sleep-mode orchestration over stock sidecars delivers the same customer-visible product without owning any of that; install-time invisibility is approximated with VIF-named services and rewritten docs.

### Embed vLLM as a Python library, in-process

**2–3 months · Not recommended**

A hard dependency wall: vLLM 0.26.0 pins `torch==2.11.0`, `torchvision==0.26.0`, `transformers>=5.5.3`; VIS pins `torch==2.9.1+cu128`, `torchvision==0.24.1+cu128`, `transformers==5.3.0`. vLLM links libtorch, so a resolver override cannot paper over it — embedding means migrating VIS's entire torch stack, dragging the custom arm64 sm_75 wheel (rebuilt, republished), mmcv/tensorrt/ONNX/rf-detr/wowza_clip/timm/peft revalidation, Windows excluded outright, and an unknown — vLLM's V1 engine spawns its core as a separate process, untested under the Nuitka-compiled, source-stripped entrypoint. It would not even allow deleting the HTTP client, since bring-your-own is a supported capability. Real odds of a wall, for a benefit (skipping a JPEG-encode and base64 hop per frame) that is noise next to inference time.

### N always-awake engines

**A GPU per model · Superseded by sleep mode**

Running every model warm simultaneously buys instant switching at a GPU per model, or at reduced KV-cache headroom when co-located. Sleep mode gets the same instant switching on one card for the price of host RAM, using the same containers. The only remaining case — a multi-GPU host wanting two models serving concurrently — is capacity inside the orchestrator's placement rules, not a separate mode.

---

## Phasing

*Cost*

Phases are a genuine sequence — each depends on the last, and each ships something usable on its own. The Docker UX win lands in phase 1 precisely because no image merge precedes it.

| Phase | Scope | Estimate |
| --- | --- | --- |
| **0** | Single source of truth and de-risking: launcher as an OS-agnostic Python console script (NVML, not `nvidia-smi`) with the two new duties (load serialization, self-sleep after health); profiles as package data; thin shim so compose keeps working; delete the orphaned VIS copy; spike: measure sleep/wake for all five catalog models on the pinned image; freeze the managed-endpoint shape and the catalog naming | 5–8 d |
| **1** | The Docker UX win: catalog with sizing/tuning/residency data; engine-pool state machine + sleep/wake orchestration over stock sidecars; managed endpoint with model routing; breaker/learned-cap coordination; control API; Manager UI dropdown-plus-progress; VIC default endpoint + UI fallbacks; compose engine set with VIF names; e2e for switching (and restore the missing reconfigure test) | 3 wk |
| **2** | Hard paths and polish: first-activation UX (staged download/compile progress, HF token + license flow for gated models); multi-GPU warm cutover and multi-awake placement; LoRA fast path; rollback hardening; migrate the 10 sidecar e2e tests, fixtures and UI specs; rewrite `VLM_GUIDE.md` and compose docs | 1.5–2.5 wk |
| **3** | Linux standalone: engine venv in the image build; generalise the one-venv relocation machinery; `-vlm` installer variant + CI; systemd/shm/hardening measurement and fixes; process-supervisor backend reusing the phase-1 state machine | 2–3 wk |
| | **Total** | **7–9 wk** |

Phase 0 stands alone and is worth doing regardless; its spike and two frozen decisions are what make the phase-1 estimate trustworthy. Phase 3 is net-new capability for standalone customers and can trail without holding the rest hostage.

Most of the cost is not vLLM logic — porting the entrypoint's ~50 lines of real logic is about a day. It is orchestration-state correctness, config surface, installer plumbing, the e2e/UI test migration, and a 268-line customer guide.

---

## Risks and open questions

*Risk*

#### Support opacity — the main risk

Today a customer who OOMs on a small card sees vLLM's own error and can go read `VLM_GUIDE.md`. Under a managed catalog they see "VIF couldn't load Cosmos3 Nano". Pre-flight VRAM/RAM checks that refuse before draining a working engine, a visible reason on failure, and reachable engine logs are not polish — they are what makes hiding vLLM safe. Design the failure path first.

#### The sleep API is upstream's dev surface

`/sleep` and `/wake_up` sit behind `VLLM_SERVER_DEV_MODE=1` and upstream reserves the right to change them. The pinned image makes each upgrade a deliberate re-validation; the orchestrator's capability probe turns an incompatible image into a degraded-but-honest mode instead of a broken one. Still a dependency to own knowingly.

#### Memory accounting, both kinds

Level-1 residency parks each sleeping model's weights in host RAM — the manager needs a RAM budget and a per-model level-1/level-2 decision. On the GPU, sleeping engines still hold small per-process CUDA contexts, the awake engine wants its full 0.80–0.90 reservation, and the detection models allocate lazily as streams start — the eager/lazy asymmetry the guide already warns about. Pre-flight works from measured inventory; whether shipped utilization values need headroom shaved for resident pools is a spike output, not a guess.

#### Gated models keep a token in the flow

At least one catalog model is license-gated on HuggingFace; first activation of a gated model cannot be one click. The catalog flags gated entries and the UI collects the token and links the license — `HF_TOKEN` leaves the `.env` surface but not the world.

#### Cold-start honesty

First activation of a never-used model downloads weights. The progress API has to distinguish "downloading 5 GB" from "compiling" from "waking", or customers will think it hung.

#### Open questions

- Default resident set: all five catalog models asleep (slowest bring-up — loads serialize — best switching) or a chosen subset?
- A request naming a sleeping model: fail fast (default) or wake-on-demand with thrash protection?
- Two models serving concurrently on one GPU: allowed at reduced utilization, or multi-GPU only? Pre-flight enforces the answer, so it lands in phase 1.
- Compose alias handover for zero-edit migration of existing stream configs: do it, or require the one-time endpoint edit?

---

## Evidence index

*Appendix*

Versions and facts this proposal rests on, so they can be rechecked rather than re-derived.

| Claim | Source |
| --- | --- |
| vLLM 0.26.0 pins `torch==2.11.0`, `torchvision==0.26.0`, `transformers>=5.5.3`; wheels manylinux x86_64 + aarch64 + sdist only | PyPI `requires_dist` for vllm 0.26.0 |
| Sleep mode: levels 1/2, `--enable-sleep-mode`, endpoints behind `VLLM_SERVER_DEV_MODE=1`; wake ~0.3 s–6 s level 1, ~0.8–2.6 s level 2; ~90%+ GPU memory released; multimodal + FP8 demonstrated | vLLM sleep-mode docs; vLLM blog "Zero-Reload Model Switching" (2025-10-26) |
| No base-model hot swap in-process; LoRA load/unload only, via `VLLM_ALLOW_RUNTIME_LORA_UPDATING` | vLLM LoRA docs |
| VIS pins `torch==2.9.1+cu128`, `torchvision==0.24.1+cu128`, `transformers==5.3.0` | `requirements.lock:319,327,331,342` |
| Custom arm64 sm_75 torch wheel from private CodeArtifact; Nuitka obfuscation; Windows `.pyd` + `runtime.7z` + NSSM | `Dockerfile:174-194,244-326`, `installers/windows/` |
| Client pool keyed `(endpoint_url, api_key)`; model per-request; learned image cap cleared only on connect failure; breaker treats downtime as external | `app/vlm/client.py:445,467,210,152,324-346` |
| Live stream reconfigure supported; its e2e test removed (stale bytecode only) | `app/streams/session.py:282`, `app/streams/registry.py:128`; `qa_automation/tests/__pycache__/` |
| `endpoint_url` required (`min_length=1`) on both VLM message types; hosted per-stream endpoints documented; UI test guards per-stream values | `app/protocol/messages/vlm.py:83,210`; `docs/WEBSOCKET_PROTOCOL.md:275,287-291`; `refreeze.cjs:101-113` |
| A detection-checkpoint `model_catalog` already exists in VIS | `app/runtime/model_catalog.py`, `app/protocol/router.py:188-210` |
| UI dropdown; three-way hand sync of the model list | `vif-stream-config.js:41-50`, `Default.json:122`, `VlmConfigMessage.java:23-24` |
| Verify probes `<endpoint>/models` Engine-side because browsers cannot resolve compose hostnames | `rest/VlmTestConfig.java:33-39,141` |
| Entrypoint fork: framework 182 lines rev 2026-07-24 (live) vs VIS 166 lines rev 2026-06-10 (zero inbound references in its own repo) | framework `vlm-entrypoint.sh:75`; VIS `video-intelligence-service/vlm-entrypoint.sh:70` + repo-wide grep |
| Eager reservation 0.80 / 0.87 / default 0.90; tuning as prose; pinned flags; `VLM_EXTRA_ARGS` appended last | `vlm-env/qwen.env`, `vlm-env/cosmos-nano.env`, `vlm-entrypoint.sh:80,143-144,169-175` |
| Compose `vlm` service: image `vllm/vllm-openai:v0.26.0`, profile-gated, `count: all` reservation with entrypoint-side pinning; Cosmos3-Edge patch bind-mounted | `docker-compose.yaml:191-255,199-201` |
| Two-engine override; one-card co-location documented | `docker-compose.vlm-multi.yaml:1-37` |
| Documented model change is an in-place `up -d` recreate; bare `down` misses the profile-gated container; local-copy profile convention promised to survive upgrades | `docs/VLM_GUIDE.md:28,128-133,147,158,178` |
| Compile cache exists to keep the ~40 s compile off recreation; lazy/eager memory asymmetry | `docs/VLM_GUIDE.md:117,122`, `docker-compose.yaml:212-216` |
| Linux installer is the relocated image venv; relocation assumes exactly one venv; systemd hardening; zero VLM mentions in `installers/` (18 files) | `installers/linux/make-installer.sh:118`, `install.sh:243-283`, `templates/wowza-vis.service:31,38-41`; `grep -rni 'vlm\|vllm' installers/` → empty |
| 10 e2e files require the sidecar (docstring convention); 10 dedicated fixtures; 1 dedicated + 4 asserting UI specs | `qa_automation/tests/`, `qa_automation/configs/`, `qa_automation/ui/specs/stream-config/` |
| Customer guide is 268 lines; four topologies vary the engine↔VIS split | framework `docs/VLM_GUIDE.md:58,70,86,99` |
| VIS depends on `nvidia-ml-py` directly; internal LoRA smoke-test profile runtime-attaches a fine-tune to Cosmos3-Nano | `pyproject.toml:100`; `vlm-env/cosmos-nano-anode.env:1` |

---

Snapshot of a design discussion, 28 August 2026. Written against VIC `24a97b7d` and framework/VIS checkouts of the same date.
