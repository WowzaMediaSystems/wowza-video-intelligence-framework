# VLM Analysis Guide

The Video Intelligence framework can run a **vision-language model (VLM)** over your live streams. Unlike the scene and object detectors, which score a fixed set of trained classes, a VLM understands free-text vocabulary — "person wearing a hard hat", "forklift near pedestrians", "smoke without visible flames" — and explains its reasoning with every result.

With `detector_type: "vlm"` the VLM watches the stream directly. Give it a list of classes (any short phrase works) for a per-class verdict with reasoning, ask it for a free-text description, or drive it with your own prompts and output schema.

The framework **manages the VLM engines for you**. The Video Intelligence Service (VIS) runs one [vLLM](https://docs.vllm.ai) engine per supported model on your GPU, decides which model serves, switches between them on request, and sizes every engine from the memory your card actually has free. Streams reach the serving model through VIS's own OpenAI-compatible endpoint, and you choose the model from a dropdown in the Engine Manager. You can also point a stream at an endpoint you run yourself instead; see [Appendix: bring your own endpoint](#appendix-bring-your-own-endpoint). The default model is **Qwen/Qwen3-VL-4B-Instruct-FP8** (commercial-use friendly).

**In this guide**

- [Quick start](#quick-start)
- [How it fits together](#how-it-fits-together)
- [Deployment topologies](#deployment-topologies)
- [Choosing and activating a model](#choosing-and-activating-a-model)
- [Tiers: hot and cold](#tiers-hot-and-cold)
- [Gated models and the HuggingFace token](#gated-models-and-the-huggingface-token)
- [Customizing the deployment: the catalog overlay](#customizing-the-deployment-the-catalog-overlay)
  - [Configure models from the Manager](#configure-models-from-the-manager)
- [Sizing and pre-flight](#sizing-and-pre-flight)
- [Engine logs and troubleshooting](#engine-logs-and-troubleshooting)
- [Upgrading from the single sidecar, and going back](#upgrading-from-the-single-sidecar-and-going-back)
- [Linux installer: the `-vlm` package](#linux-installer-the--vlm-package)
- [Air-gapped hosts](#air-gapped-hosts)
- [Configuration reference](#configuration-reference)
- [Appendix: bring your own endpoint](#appendix-bring-your-own-endpoint)

---

## Quick start

Prerequisites: a working framework checkout with `.env` populated (licenses, admin credentials — see the [README](../README.md)), an NVIDIA GPU with current drivers, and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). The smallest catalog model needs an 8 GB card; the default needs 24 GB ([model table](#the-models)).

**1. Start the full stack with the managed VLM engines:**

```bash
docker compose --profile default --profile vlm up -d
```

Each engine downloads its model's weights into `./vis/vlm-models` the first time it loads, and reuses them on every later boot. The engines load one at a time, the active model last. Watch progress:

```bash
docker compose logs -f vif-model-qwen-qwen3-vl-4b-instruct-fp8   # the default model's download + load
docker compose ps                                                 # every vif-model-* flips to (healthy)
```

> The `vlm` profile is additive and opt-in: a bare `docker compose up` starts everything **except** the engines, and `docker compose --profile vlm up` starts VIS + the engines only. A bare `docker compose down` leaves the profile-gated engines running — include `--profile vlm` on the `down` as well to stop them.

**2. Publish a stream whose name starts with `vlm`** — the default configuration ships a ready-made VLM stream entry matching `vlm.*` on the `live` application:

```bash
ffmpeg -re -stream_loop -1 -i your-clip.mp4 -c copy -f flv rtmp://localhost:1935/live/vlm-demo
```

**3. Watch the results.** The default entry detects `fire`, `smoke`, `person`, and `vehicle`, and surfaces results through the standard event listeners:

```bash
tail -f wse/logs/wowzastreamingengine_vi.log
```

You'll see one entry per analysis window with each detected class and the model's reasoning. The same results are embedded as ID3 tags in the stream, and an overlay rendition named `vlm-demo-vi` shows detected classes burned into the video (play it from the Engine Manager test player at `http://localhost:8088`, or directly at `http://localhost/live/vlm-demo-vi/playlist.m3u8`).

**4. Make it yours.** Change `class_names` to anything you want to find (it's open vocabulary) — either from the Video Intelligence configuration in Engine Manager (`http://localhost:8088`), or by editing the stream's file under `wse/conf.modules/vif/` (for the shipped entry, `live_vlmDotStar.json`) and restarting the stream to apply — either by toggling its active state or by restarting the encoder. To try another model, see [Choosing and activating a model](#choosing-and-activating-a-model).

---

## How it fits together

```
stream ─▶ Engine (WSE + plugin) ──WebSocket──▶ VIS ──▶ managed endpoint (/v1) ──▶ the serving engine
                                                              │                      (one vLLM container per model,
                                                              └─ switches, sizes,     all resident, one serving)
                                                                 watches the pool
```

- **One engine per model.** The compose file has a `vif-model-<model>` service for every supported model (plus generic [slots](#adding-your-own-model-an-overlay-entry-and-a-slot) for models you add). They all run the stock `vllm/vllm-openai` image through a small launcher (`vif-vlm-launcher.py`) that runs the command VIS wrote for it. Nothing about a model is configured in `.env`: VIS resolves each engine's whole command from its catalog and from the card it runs on.
- **One serves at a time.** The others rest, either **asleep** (hot tier) or **parked** (cold tier); see [Tiers](#tiers-hot-and-cold). Switching models is a call to VIS (the Manager's **Activate** button). No container is recreated.
- **One endpoint.** Streams use `http://video-intelligence-service.docker:5001/v1`, VIS's own port. VIS routes each request by the `model_name` it carries. The address the old single sidecar answered on, `http://vlm.docker:8000/v1`, is served the same way, so older configs keep working. The engines sit on an internal network that only VIS joins, and no engine port is ever published.
- **A stream either follows or pins.** An empty `model_name` (shown as **Default** in the Manager) follows whichever model is active: activate another model and the stream moves with it. A named `model_name` pins the stream to that model, and a pinned stream **degrades** (empty results, `degraded: true`, reported as `engine_asleep`) while another model is active.
- **The active model persists.** It is stored in `./vis/vlm-state/active-model`. On the first start, when that file does not exist, VIS seeds it with the first catalog model (Qwen3-VL 4B).

Everything the engines share lives in four bind mounts under `./vis/`:

| Path | Holds |
|---|---|
| `./vis/vlm-models` | Model weights (HuggingFace cache), downloaded once per model; also where your [LoRA adapters](#your-own-lora-adapters) go |
| `./vis/vlm-adapters` | LoRA adapters uploaded through VIS (see [Your own LoRA adapters](#your-own-lora-adapters)). VIS writes it, every engine mounts it read-only |
| `./vis/vlm-cache` | vLLM's compile cache, so a recreated container does not recompile. Safe to delete |
| `./vis/vlm-state` | The active model, each engine's command, markers, engine logs, the saved HuggingFace token. Shared only by VIS and the engines |

The service VIS runs as owns these directories; the `vis-init` helper hands them over on every start.

---

## Deployment topologies

The three moving parts are the **engine** (WSE + the Video Intelligence Controller), **VIS** (the inference service), and the **VLM endpoint**:

```
engine ──WebSocket──▶ VIS ──HTTP──▶ VLM endpoint
```

Any permutation works — everything on one machine, the engine split from VIS, one engine fanning out to many VIS instances, or many engines sharing one VIS. The managed engines always run on the same machine as the VIS that manages them: they share its state volume, and only it can reach them.

### 1. Everything on one machine (default)

```
┌─────────────────────────────────────┐
│  engine ──▶ VIS ──▶ VLM engines     │
│              GPU(s)                 │
└─────────────────────────────────────┘
docker compose --profile default --profile vlm up -d
```

Works out of the box — see the [Quick start](#quick-start).

### 2. Engine on one machine, VIS + VLM on another

Put inference on the GPU box and keep the engine wherever your streaming runs:

```
┌── box A ───────────┐      ┌── box B (GPU) ──────────┐
│  engine + manager  │─────▶│  VIS ──▶ VLM engines    │
└────────────────────┘ :5001└─────────────────────────┘

box B:  docker compose --profile vi-service --profile vlm up -d   # VIS + VLM only
box A:  docker compose --profile wse up -d                        # engine + manager only
        # .env on box A: VIS_PROTOCOL=ws  VIS_HOST=<box B address>  VIS_PORT=5001
```

The default VLM `endpoint_url` works unchanged. Set `VIS_API_KEY` (same value in both `.env` files) to authenticate the engine→VIS connection across the network, and use `VIS_PROTOCOL=wss` with SSL configured on VIS for untrusted networks.

### 3. One engine, many VIS

Spread streams or applications across several GPU boxes. `vi_service_url` is overridable per stream entry:

```jsonc
"streams": [
  { "stream_name": "lobby.*",  "vi_service_url": "ws://gpu-box-1:5001/ws/stream/", ... },
  { "stream_name": "garage.*", "vi_service_url": "ws://gpu-box-2:5001/ws/stream/", ... }
]
```

Run each GPU box with `docker compose --profile vi-service --profile vlm up -d` — with the default configuration, each VIS serves its streams from its own local engines.

### 4. Many engines, one VIS

Multiple engines can share one VIS deployment — point each engine's `VIS_HOST` at the same box. VIS pools models across streams. Streams on a bring-your-own endpoint share one HTTP client pool per endpoint, whose `request_timeout_seconds` and `max_concurrent_requests` are set by the **first** stream to use it; later streams with different values keep the first ones (a WARNING is logged).

> **Using the managed endpoint from another machine**: the engines' own ports are never published — they sit on an internal network only VIS joins. The managed endpoint is VIS's `/v1`, on VIS's port: uncomment the `ports:` block on the VIS service to publish it, and set `VLLM_API_KEY` in `.env` (`/v1` does not use `VIS_API_KEY`, so without it the endpoint is unauthenticated), then point `endpoint_url` at `http://<VIS box>:5001/v1` with the same key as `api_key`. To run a VLM on a different machine from VIS, serve it there with any OpenAI-compatible server and point the stream's `endpoint_url` at it.


---

## Choosing and activating a model

### The models

| Model | Notes | Needs a card of | Weights on disk |
|---|---|---|---|
| `Qwen/Qwen3-VL-4B-Instruct-FP8` | Default. Commercial-use friendly | 24 GB | 6 GB |
| `nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8` | NVIDIA reasoning VLM. Cannot sleep, so it always rests parked | 24 GB | 15.4 GB |
| `google/gemma-3-4b-it` | Gated on HuggingFace: [accept the license and give the engines a token](#gated-models-and-the-huggingface-token) | 24 GB | 8.6 GB |
| `nvidia/Cosmos3-Edge` | NVIDIA Cosmos reasoning VLM (3.86B); fp8-quantized at load. Uses the bundled patch mount, already wired in `docker-compose.yaml` | 8 GB | 7.7 GB |
| `nvidia/Cosmos3-Nano` | Larger Cosmos reasoning VLM (15.75B) | 40 GB | 31.5 GB |

"Needs a card of" is the catalog's `min_vram_gb`: [pre-flight](#sizing-and-pre-flight) refuses a model whose floor is above your card's memory. The weights of all five come to about 70 GB of disk under `./vis/vlm-models`. `GET /vlm/models` (below) lists the catalog as your deployment resolved it, including anything you added or disabled in the [overlay](#customizing-the-deployment-the-catalog-overlay).

### Activating a model from the Manager

Open the VIF configuration page in the Engine Manager (`http://localhost:8088`), choose a VLM stream's configuration (or the **Stream Config Defaults**) and go to its **VLM Analysis** section:

1. Under **VLM Server**, keep **Managed by this deployment**. The **Model Name** dropdown then lists the deployment's models, each with its state and tier, for example `Gemma 3 4B Instruct (status: asleep · hot tier)`. The **?** beside it explains every status.
2. The first choice, **Default**, follows the active model and names it: `Default (follows the active model: Qwen3-VL 4B Instruct (FP8))`. Picking any model by name pins the stream to it.
3. Pick a model that is not serving. The line under the dropdown says what that means for this model, and an **Activate** button appears. **Activate** makes it the model the whole deployment serves: the streams that follow the active model pause briefly and continue on the new one, and streams pinned to the model being replaced degrade until it is activated again.
4. The line under the dropdown follows the switch to its end — `queued`, `draining the serving engine`, `waking` or `starting the engine`, `downloading the weights` with how much has arrived, `loading the weights onto the GPU`, `compiling and warming up the engine`, `verifying with a test request` — then `✓ <model> is serving`. Stages that do not apply are skipped, so a model that is already on disk and compiled starts in seconds. Every switch ends with one real test request: a model is not reported as serving until it has answered one.

The same dropdown appears in the VOD analysis editor. Activating is a deployment-wide act, so it is offered wherever the dropdown is, and it does not save the stream's config: **Save** still does that.

**If a switch fails**, the previous model is put back and keeps serving; the line under the dropdown says why (a refusal before anything was touched, or the load's own last error line). Only when that rollback fails too is nothing serving, and the failure is reported at CRITICAL in the VIS log and in the status; see [troubleshooting](#engine-logs-and-troubleshooting).

**First activation.** A model whose weights are not on disk yet is downloaded when first loaded, then loaded and compiled, which takes minutes. Because the hot-tier models load at boot (see [Startup order](#startup-order)), most of the catalog downloads during the first boot and a later activation is a wake.

**Verify.** The **Verify** button beside the server address lists the models the endpoint serves. On the managed endpoint that is the awake model only; the result is reported against your selection and never changes it. (On your own endpoint, a single served model that differs from your selection is adopted.)

### Activating a model from the API

The same operations are plain HTTP on VIS (`X-API-Key` as for the rest of VIS); they are what the Manager calls:

```bash
curl -H "X-API-Key: $VIS_API_KEY" http://<VIS host>:5001/vlm/models                  # catalog, residency, state, tier
curl -X POST -H "X-API-Key: $VIS_API_KEY" \
  http://<VIS host>:5001/vlm/models/nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8/activate
curl -H "X-API-Key: $VIS_API_KEY" http://<VIS host>:5001/vlm/status                  # progress, engines, log tails
```

VIS's port is not published by default; uncomment the `ports:` block on the VIS service to reach these from the host, and keep `VIS_API_KEY` set. A request that cannot work is refused at once, before the serving engine is touched, with `409` and a message that ends with what to do about it. The wire details (every field and refusal code) are in the Video Intelligence Service's WebSocket protocol reference.

### What streams see during a switch

| Situation | What the stream does |
|---|---|
| A switch is running | Every managed stream waits: the managed endpoint answers `switching` (`paused: switching model`), and the window counts as unanswered (degraded). Loading a LoRA adapter into the model that is already serving pauses nothing |
| A pinned stream's model is resting (asleep or parked) | `engine_asleep`: the stream degrades until that model is activated. Nothing wakes a resting model but an explicit activate |
| The serving engine crashed or no model is active | `engine_failed`: degraded until it is back |
| `model_name` is not a model this deployment manages | Not degraded: the endpoint answers `404 model_not_found` with the models it does manage, and the stream reports an error, because a typo should be fixed rather than hidden |

A degraded window carries an empty `vlm_analysis` with `degraded: true`, the overlay shows the **AI offline** badge, and the stream keeps running. See [What you receive](#what-you-receive).

---

## Tiers: hot and cold

Every model has its own engine, all of them resident, but only one holds the GPU at a time. A resident model that is not serving rests at one of two depths — its **tier**:

| | Hot (**asleep**) | Cold (**parked**) |
|---|---|---|
| What it is | vLLM sleep mode, level 1: the process stays up and its weights move to host RAM | The engine process is stopped; only the launcher's health stub runs |
| Weights while resting | Host RAM (roughly 8 to 27 GiB per model, as measured on the shipped models) | Disk only |
| Switching to it | About 1 to 2 seconds | A cold start: about 1 to 2 minutes with a warm compile cache |
| GPU memory it keeps | 0.6 to 2.2 GiB per sleeping engine | None |
| Status in the Manager | `asleep` · `hot tier` | `parked` · `cold tier` |

Hot returns in seconds but costs host RAM; cold costs nothing while resting and returns with a cold start. A switch away from a model puts it to rest at its own tier, and VIS proves the model it switches to with a real request before it reports it serving.

### Who decides a model's tier

Three layers, strongest first:

1. **Capability.** A model that cannot sleep is always cold (Nemotron). On a host where sleep mode cannot run, `VLM_FORCE_ALL_COLD=true` makes every model cold (see below).
2. **The overlay's tier.** An explicit `"tier": "hot"` or `"cold"` on a model's [overlay entry](#customizing-the-deployment-the-catalog-overlay), the only place a tier is kept. Set it in the Manager's [VLM Models panel](#configure-models-from-the-manager), with `PUT /vlm/overlay`, with `PUT /vlm/models/<id>/tier` (`{"tier": "hot"}`, `{"tier": "cold"}`, or `{"tier": null}` to clear it; it writes the overlay's field) or by editing the file. It applies at once, except that a change on the model that is serving waits until another model is activated. An explicit `hot` that the RAM budget cannot hold is demoted to cold, and VIS logs the numbers; `PUT /vlm/models/<id>/tier` refuses such a promotion up front with the arithmetic. Earlier releases kept these pins in `./vis/vlm-state/tier-overrides.json`: VIS folds any it finds there into the overlay once, at startup, deletes the file and logs what it moved.
3. **The RAM budget (the default, `auto`).** Every shipped model says `auto`, and VIS makes the cheapest sleepers hot until the host's RAM budget is spent. The budget is the host's RAM minus a reserve kept for the serving engine, the page cache, VIS, the Engine and the OS: the larger of 40% of host RAM and 8 GiB, or `VLM_RAM_RESERVE_MIB` when you set it.

For example, on a 64 GiB host the budget is 38.4 GiB, which keeps Cosmos3 Edge (8.5 GiB) and Qwen3-VL 4B (13.1 GiB) hot and leaves Gemma and Cosmos3 Nano cold; a 144 GiB host keeps all four sleepers hot. The Manager shows the result for each model; `GET /vlm/status` shows how the budget was spent (`tiers`).

If you never switch to a model, **disable it** ([overlay](#customizing-the-deployment-the-catalog-overlay)) to give its RAM and boot time back.

### Hosts without sleep mode

vLLM's sleep mode needs CUDA UVA, which some platforms (for example WSL2) do not provide. Set `VLM_FORCE_ALL_COLD=true` in `.env` there and recreate VIS: every resting model is parked and every switch is a cold start. `force_all_cold: true` in the overlay (the panel's **Keep every model cold** toggle) does the same, and applies at once.

### Startup order

Each engine is sized assuming the others are asleep while it loads, so after a restart the hot-tier models load first, one at a time, each going to sleep as soon as it is loaded, and the serving model loads **last**. Cold-tier models are not loaded at startup. Streams wait for the whole pool: about 12 minutes with a warm compile cache (`./vis/vlm-cache`), longer on a first boot, when every model also downloads and compiles. A stream started meanwhile begins analyzing when the model finishes loading. Until then the control API answers `503 manager_starting`, and `GET /vlm/status` shows `startup_stage` (`pool-loading: <model> loads after N hot engine(s)`).

A resting model whose container restarts while another model serves stays parked until nothing is serving or it is activated, rather than loading beside the serving one.

---

## Gated models and the HuggingFace token

Gemma is gated: its weights download only for a HuggingFace account that has accepted the model's license. Accept it on the model's page (<https://huggingface.co/google/gemma-3-4b-it>) while logged in as the account whose access token you will use, then give the engines a read token for that account, in one of two places:

- **In the Manager** (recommended): pick the gated model in the **Model Name** dropdown, paste the token in the **HuggingFace token** field and **Save**. It is checked against HuggingFace before it is kept — a token HuggingFace rejects is refused and nothing is stored; a license the account has not accepted yet is named, and the token is kept for when it is. The next activate uses it; no container is recreated. The field then shows `***` and a **Remove** button; the token itself is never shown again, logged, or returned by any API. The same field appears under a refused activate.
- **In `.env`** as `HF_TOKEN`, then recreate the engines (`docker compose --profile vlm up -d`). A token set here wins over one set in the Manager, so a deployment can pin it; the Manager says so when that is the token being refused.

Without a usable token, activating the model is refused at once, before the serving model is touched, and the refusal says which of the three is wrong (no token, a token HuggingFace does not accept, a license not accepted) and links the license page. The serving model keeps serving. A model whose weights are already on disk is not asked about its license again. The same applies to any [model you add](#adding-your-own-model-an-overlay-entry-and-a-slot) with `"gated": true`.

**Where the Manager's token lives.** The Engine keeps a copy in its VOD secrets file under a reserved name that no webhook can use, and hands it to the Video Intelligence Service over the service's API key; the service stores it on the engines' state volume (`./vis/vlm-state/secrets/hf-token`, readable only by the service's user) for the engines to read. Nothing else receives it — not the managed `/v1` endpoint, not a stream, not a browser. The state volume is shared only by the service and the engine containers, the same exposure as the `.env` file the token would otherwise sit in: protect `./vis/` the way you protect `.env`.

A `HF_TOKEN` is also useful for ungated models: it raises HuggingFace's rate limits on the first-boot downloads.

---

## Customizing the deployment: the catalog overlay

VIS ships the model catalog: every supported model's sizing, tuning per GPU class and resting behaviour. A deployment changes it in one optional file, `./vis/models/vlm-catalog.local.json`, which VIS reads when it starts and again whenever you apply a change. It lives under `./vis/`, which is not tracked, so a framework `git pull` never touches it. Edit it, then apply the edit: **Apply file edit** in the Manager, `POST /vlm/overlay/reload`, or a VIS restart (`docker compose restart video-intelligence-service-gpu`); the engines follow the specs VIS writes them without a restart of their own. The Manager's [VLM Models panel](#configure-models-from-the-manager) edits the same file, with no hand editing and no restart. Adding a whole model is the one change that still needs the restart (see [below](#adding-your-own-model-an-overlay-entry-and-a-slot)).

```json
{
  "version": 1,
  "models": [
    { "id": "Qwen/Qwen3-VL-4B-Instruct-FP8", "gpu_memory_utilization": 0.45 },
    { "id": "nvidia/Cosmos3-Nano", "tier": "cold" },
    { "id": "google/gemma-3-4b-it", "disabled": true }
  ]
}
```

Each entry names a model by `id` and sets only the fields it changes; lists such as `tuning` are replaced whole. `force_all_cold: true` at the top level does what `VLM_FORCE_ALL_COLD=true` does. A file VIS cannot use is never fatal: VIS logs an ERROR naming the entry and the field at fault, ignores the whole file and serves the shipped catalog.

**Disabling a model.** `"disabled": true` takes a model out of the deployment: it disappears from `GET /vlm/models` and the Manager's dropdown, it is never pre-flighted or activated (`409 model_disabled`), and its engine container rests on the launcher's health stub for good — no vLLM process, no weights in memory, no GPU context, never the load lock. The container still reports healthy, so `docker compose up --wait` keeps working, and `GET /vif/parked` on it answers with `"disabled": true`. `GET /vlm/status` lists it under `disabled_models`. This is how to free the host RAM and the boot time a model you never use would cost.

Disabling the model that is serving is not refused: it keeps serving, the change comes back as *deferred* (and VIS logs a WARNING naming the model, also when it finds the flag at a start), and the flag takes effect the moment another model is activated.

To bring a model back, remove the flag and apply. It returns to the list and rests at its tier: a hot one loads and then goes to sleep, a cold one stays parked until its next activation.

### Configure models from the Manager

The overlay file and the Engine Manager's **VLM Models** panel are two views of one document: the panel reads the file through VIS and writes the same file, so a change made in either shows in the other. Open the VIF configuration page, then edit or create a VLM stream config on the managed endpoint: the panel sits between **Video Processing** and **Advanced Options**, collapsed. It does not show for a Verify config or for a stream on your own endpoint. In the VOD analysis editor, **Manage models** under the model dropdown opens it on a new VLM config; nothing is saved unless you save that config.

The panel configures the deployment, not the config around it: *settings here apply to every stream and job*. It has its own **Apply**, separate from **Save**, and one Apply makes one write of the whole document. **Activate** stays in the model dropdown; the panel activates nothing.

- **Models.** One row per model: its status (the dropdown's words), a **Tier** select (Auto, Hot, Cold), an **Enabled** toggle, and a **Tuning** section with `gpu_memory_utilization`, `max_model_len`, `max_num_seqs`, `max_num_batched_tokens`, `mm_processor_kwargs`, `image_cap` and the extra vLLM arguments of each tuning tier. Each field shows the shipped value as its placeholder; empty keeps it, and **Reset** puts it back.
- **LoRA adapters.** The adapters of the deployment, with disable and remove, and a form to add your own. A shipped adapter can only be disabled. The form offers only a base model that already has LoRA enabled. Enabling LoRA on a base is a change to the overlay file, not to the panel: set `enable_lora` and `lora_module_prefixes` on that model's entry (and `lora_on_fp8_verified` for an FP8 base), then **Apply file edit**; see [Your own LoRA adapters](#your-own-lora-adapters). No shipped model enables it.
- **Keep every model cold (saves host RAM).** `force_all_cold`; fixed when `VLM_FORCE_ALL_COLD` sets it in `.env`.

**When each change applies.**

| Change | When it takes effect |
|---|---|
| Tier | At once. On the model that is serving it waits until another model is activated (*deferred*). A `hot` the RAM budget cannot hold is demoted to cold, and the result says so |
| Disable | At once: the model leaves the list and its engine parks. The serving model keeps serving and the change is *deferred* until another model is activated |
| Enable | At once. The model returns to the list and rests at its tier: a hot one loads and goes to sleep, a cold one stays parked until activated |
| `gpu_memory_utilization`, `max_model_len`, `max_num_seqs`, `max_num_batched_tokens`, `mm_processor_kwargs`, the tuning `extra_args` | The model's next load. A parked model simply loads with the new value. A model that is serving or asleep keeps the process it has: it is *reload pending* |
| `image_cap` | At once for the limit VIS enforces per request. It is also a vLLM flag, so a running engine is reload pending until it loads again |
| `max_num_seqs`, VIS's own concurrency | The engine follows at its next load, as above. The number of requests VIS sends it at a time follows at the next VIS restart |
| LoRA adapter: add, disable, remove | At once, on a base that already enables LoRA. An adapter that is active when it is disabled or removed is unloaded, and the streams pinned to it degrade like those of a model that is asleep. Giving a base `enable_lora` is an engine setting: a running base is reload pending |
| Keep every model cold | At once for the tiers. A model that is asleep and is now cold is parked |

Adding or removing a whole model is not done here; VIS refuses it (`unsupported_change`). See [Adding your own model](#adding-your-own-model-an-overlay-entry-and-a-slot).

**Reload pending.** A change that only a load can apply leaves the running process alone. The model's row says **Reload pending** with the vLLM flags that differ (for example `--max-model-len`) and offers **Reload now**, which cold-starts that model alone, in one to two minutes: streams using it degrade until it is back and no other model is touched. Reloading the serving model is a cold start of itself; if it cannot start with the new settings (vLLM's own refusal, such as a KV cache that is too small, cannot be predicted), VIS starts it again with the settings it was running with. The reload then ends `activated: false` with `rolled_back: true` and the reason, the model serves again with its old settings and stays reload pending, and **Reload now** remains available once the settings are changed. If that second start fails too, nothing serves, as after any failed activate. Reloading a model that is asleep parks it, and it loads with the new settings the next time it is activated (loading it beside the serving model would risk the card). Or leave it: the model picks the settings up at its next load. The state clears when it loads again. `GET /vlm/models` reports it per model as `reload_pending`, `reload_pending_reason` and `reload_pending_flags`; the flags are names only (for example `--max-model-len`), never their values.

**Who can apply.** Everyone who opens the Manager sees the panel and the current values. Only a Manager user in the `admin` group gets the controls and **Apply**; for everyone else the panel is read-only, with a note that an admin makes these changes. The Engine enforces it: the three writes below are refused with `403 admin_required` for any other user, and reading stays open. For the Engine to tell who is calling, its REST API must authenticate its callers: the `VideoIntelligenceServer` server property must be `authorized` and the REST `AuthenticationMethod` in `Server.xml` must not be `none` (the shipped configuration has `authorized` and `basic`). Without both, nobody can be identified and every write is refused, and the panel says so; so are the writes while the Engine cannot read its user store. For everyone who cannot write, the Engine's read of the overlay hides each tuning tier's extra arguments (they are free-form and can carry a secret) and leaves out the raw file; only an admin sees them.

**Hand edits.** Editing `./vis/models/vlm-catalog.local.json` still works. VIS does not watch the file, so apply an edit with **Apply file edit** (shown on the panel while the file differs from what VIS runs), with `POST /vlm/overlay/reload`, or by restarting VIS. Until then the panel says the file was edited by hand and not applied yet, and `applied` is `false` in `GET /vlm/overlay`. When VIS ignored the file at its start (it logged an ERROR), `applied` is `false` as well and `error` names the entry and field; the values, sources and adapters it reports are what VIS runs, and the panel shows the `error` next to **Apply file edit**. A file that parses but cannot run has to be fixed in the file: applying from the panel would send the same entry back. A hand edit applied this way gives the same result as the same change made in the panel. The panel's own write quotes the file's `etag` (a SHA-256 of its bytes): if the file changed since the panel read it, nothing is written and the panel offers **Reload settings** to read it again, so a hand edit is never overwritten. A document VIS cannot use is refused with `422 invalid_overlay` naming the entry and the field, shown beside that field, and nothing is written.

**The routes.** On VIS, behind `X-API-Key` like the rest of the control API; the Engine relays them under `/v2/vif` with the Manager's REST credentials.

| VIS | Engine (`/v2/vif`) | What it does |
|---|---|---|
| `GET /vlm/overlay` | `GET /vlm/overlay` | The overlay as it is on disk, its `etag`, the effective value of every editable field of every model with its source (`shipped` or `overlay`), the adapters, and `applied`. The Engine adds `can_write` (and `write_blocked_reason` when it is false) |
| `PUT /vlm/overlay` | `PUT /vlm/overlay` (admin) | Replaces the whole document. Needs `If-Match: <etag>` (`428 if_match_required` without it, `409 stale_etag` when the file changed). Validates, writes atomically, applies; answers what applied at once, what is reload pending and what is deferred. Also `409 switching` while a switch or reload runs or the model manager is still starting (the panel shows it as busy, to try again), `422 invalid_overlay`, `422 unsupported_change`, `500 write_failed` |
| `POST /vlm/overlay/reload` | `POST /vlm/overlay/reload` (admin) | Reads the file again after a hand edit and answers like the `PUT` |
| `POST /vlm/models/<id>/reload` | `POST /vlm/reload` with `{"model_id": "<id>"}` (admin) | Reloads a reload-pending model now, like an activate of it (`409 nothing_to_reload` when it is not pending); progress is in `GET /vlm/models` under `activation` |

```bash
curl -H "X-API-Key: $VIS_API_KEY" http://<VIS host>:5001/vlm/overlay                       # document, etag, effective values
curl -X PUT -H "X-API-Key: $VIS_API_KEY" -H "If-Match: <etag from the read>" \
  -H "Content-Type: application/json" -d @overlay.json http://<VIS host>:5001/vlm/overlay
curl -X POST -H "X-API-Key: $VIS_API_KEY" http://<VIS host>:5001/vlm/overlay/reload
curl -X POST -H "X-API-Key: $VIS_API_KEY" http://<VIS host>:5001/vlm/models/google/gemma-3-4b-it/reload
```

`PUT /vlm/models/<id>/tier` still exists and now writes the overlay's `tier` through the same path (a malformed overlay is refused with `422 invalid_overlay`, and `409 stale_etag` when the file changed meanwhile).

### Adding your own model: an overlay entry and a slot

A model VIS does not ship takes two things: its metadata in the overlay, and an engine container to run it in.

**The overlay entry** has an `id` the catalog does not have (the model's HuggingFace id, which is also what streams name as `model_name`) and every field a shipped entry has. The same rules validate it, so a missing or malformed field makes VIS log an ERROR naming the entry and the field and serve the shipped catalog without your file.

```json
{
  "version": 1,
  "models": [
    {
      "id": "acme/acme-vl-2b",
      "label": "Acme VL 2B",
      "min_vram_gb": 8.0,
      "weights_gb": 4.0,
      "max_model_len": 4096,
      "gpu_memory_utilization": 0.85,
      "image_cap": 8,
      "sleep_level_default": 1,
      "sleep_level_source": "spike-pending",
      "gated": false,
      "tuning": [{ "name": "compact", "min_total_vram_gb": 8.0, "extra_args": [] }]
    }
  ]
}
```

`min_vram_gb` must equal the lowest tuning tier's `min_total_vram_gb`; `weights_gb` is the checkpoint's size on disk; `sleep_level_default` is always `1`; `gated: true` for weights behind a HuggingFace license (then a HuggingFace token applies as for Gemma, set in the Manager or as `HF_TOKEN`). `tier` (`auto` by default), `max_num_seqs`, `mm_processor_kwargs` and `sleep_capable` are optional, as for a shipped model. A new `id` must differ from every other model's by more than case and punctuation (`Acme/Acme_VL_2B` and `acme/acme-vl-2b` would share one engine), or VIS rejects the overlay.

**The engine** is a slot: the compose ships two generic services, `vif-model-slot-1` and `vif-model-slot-2`, each behind a profile of its own and told which model to serve by one `.env` line:

```bash
# .env
COMPOSE_PROFILES=default,vlm,vlm-slot-1
VIF_SLOT_1_MODEL=acme/acme-vl-2b
```

Saving the entry (from the Manager, `PUT /vlm/overlay`, or by editing the file) is not enough on its own: the model needs an engine container, and a running VIS keeps its set of models fixed. VIS writes the file and applies everything else in the change at once; the answer lists the model under `restart_required`, `GET /vlm/overlay` keeps listing it under `pending_restart` with its full entry, and the Manager says "Restart VIS to add <model>". Then restart VIS (`docker compose restart video-intelligence-service-gpu`). When it starts it gives each slot that has no model of its own the next custom model of the overlay, in the overlay's order; the slot's launcher picks the assignment up from the state volume and runs that model's engine. The model then appears in `GET /vlm/models` and the Manager's dropdown like any other: it is downloaded on its first activation, rests asleep or parked by the host's RAM, and streams reach it through the managed endpoint. No `.env` line is involved.

The same two slots serve at most two custom models. A change that would leave more custom models than running slots is refused with `422 invalid_overlay` (`field: "models"`, naming the first model that does not fit); `GET /vlm/overlay` reports the count of slots as `slots`. A slot's assignment survives a VIS restart: the slot that serves a model keeps it, and a model you remove frees its slot at the next restart.

**Pinning a model to a slot.** The `vlm-slot-N` profiles and `VIF_SLOT_N_MODEL` still work as before. When `VIF_SLOT_1_MODEL` (or `_2_`) names an overlay entry's id, that slot serves it, whatever VIS would have chosen:

```bash
# .env
VIF_SLOT_1_MODEL=acme/acme-vl-2b
```

What a slot does when something is off, always staying healthy so `docker compose up --wait` keeps working:

- no custom model waits for it: it rests on the launcher's health stub (`/vif/parked` says `"unassigned": true`) and keeps listening for an assignment;
- pinned to a model VIS does not know (not in the overlay, or the overlay was rejected), a shipped model, or a model another slot already serves (the slot that had it first keeps it, across VIS restarts too): its log says which, it rests on the stub, and `GET /vlm/status` lists the slot under `slots` as `misconfigured` with the same reason;
- a model in the overlay that no slot serves yet: `GET /vlm/models` shows it with `resident: false` and the reason, and activating it is refused until a slot serves it.

A model you disable (`"disabled": true`) keeps its slot parked, like a shipped one.

**The entry's fields.** The Manager's form asks for `id`, `label`, `weights_gb`, `min_vram_gb`, `max_model_len`, `gpu_memory_utilization`, `image_cap`, `gated` and a tier. The sleep level (`1`) and a single tuning tier whose floor is `min_vram_gb` are filled in when the entry does not carry them, so a hand-written entry may omit `sleep_level_default`, `sleep_level_source` and `tuning` too.

### Your own LoRA adapters

A LoRA adapter you trained for one of the models is one more model in the dropdown: streams name it as their `model_name`, and it is served by its base model's engine, which routes each request to the adapter or the base by the name it carries.

1. **Copy the adapter** (PEFT's `adapter_config.json` and `adapter_model.safetensors`) under `./vis/vlm-models/`, the weights directory every engine shares, e.g. `./vis/vlm-models/lora/acme-forklifts/`. VIS reads it there too, read-only.
2. **Declare it in the overlay**, with the base's LoRA support in the same file. Enabling LoRA on the base (`enable_lora` and `lora_module_prefixes`) is a file edit; the panel's **Add adapter** form works once the base has it, and the panel does not set these fields:

   ```json
   {
     "version": 1,
     "models": [
       {
         "id": "nvidia/Cosmos3-Nano",
         "enable_lora": true,
         "lora_module_prefixes": ["model.language_model.layers."]
       },
       {
         "kind": "lora",
         "id": "acme/cosmos3-nano-forklifts",
         "label": "Cosmos3 Nano + forklifts",
         "base": "nvidia/Cosmos3-Nano",
         "adapter_path": "lora/acme-forklifts",
         "rank": 8
       }
     ]
   }
   ```

   `adapter_path` is relative to `./vis/vlm-models/`; `rank` is the `r` the adapter was trained with, at most the base's `max_lora_rank` (16 unless the base's entry sets it, one of 1, 8, 16, 32, 64, 128, 256, 320, 512). `lora_module_prefixes` are the module paths, after PEFT's `base_model.model.`, that reach the base's language model: an adapter whose tensors fall outside them would load and change nothing, so VIS refuses it. The base can also be a model you added yourself. Bases that run FP8 weights (every shipped one but Gemma and Cosmos3-Nano) also need `"lora_on_fp8_verified": true`: LoRA on an FP8 base has not been shown to change the pinned vLLM's output, so set it only once you have seen your adapter do so.
3. **Apply it** (the Manager's panel, or the file with **Apply file edit** or `POST /vlm/overlay/reload`; no VIS restart), and reload the base if it is running: an engine reads `--enable-lora` only when it starts, so a running base is *reload pending* until you reload it (**Reload now**, or `docker compose restart vif-model-<base>`). Adding, disabling and removing adapters apply at once. An adapter entry VIS cannot serve — a field that does not validate, a base that is not in the catalog or does not enable LoRA, a rank above the base's limit — is refused with `422` naming it when you apply it; in a file VIS reads at startup it is logged as an ERROR naming it and left out, and the rest of the file applies.

**Uploading an adapter instead of copying it.** `POST /vlm/adapters?id=<adapter id>&base=<base model id>` takes a zip or tar (also `.tar.gz`, `.tar.bz2`, `.tar.xz`) of the adapter as the raw request body, with the two files at its top level or in the one folder that holds them, and stores it under `./vis/vlm-adapters/<adapter id>/`. The base must already have LoRA enabled. Before anything is kept, VIS checks the archive's layout, that `adapter_config.json` parses, that its `r` is within the base's `max_lora_rank`, and that every tensor name falls under the base's `lora_module_prefixes`; a refusal (`422`) says which and nothing is stored. The answer carries the adapter's rank and the overlay entry (`kind: "lora"`, `adapter_path` relative to `./vis/vlm-adapters/`, `source: "upload"`) to declare it with. The size is capped by `VLM_ADAPTER_MAX_UPLOAD_MB` (default 1024; `413` over it). `DELETE /vlm/adapters/<adapter id>` removes the uploaded files, and only those; it is refused (`409`) while the overlay still declares the adapter. An adapter whose files you copied under `./vis/vlm-models/` keeps working as before (`source: "weights"`, the default). Base-model weights are never uploaded this way: they come from the HuggingFace hub or a pre-seeded directory.

Activating the adapter while its base serves is the fastest switch there is: the adapter is loaded into the serving engine and proven with one request, with no pause for the streams on the base. With the base resting, activating the adapter switches to the base first, then loads it. Activating anything else unloads it. An adapter whose files cannot work with its base — a rank that disagrees with its `adapter_config.json`, tensors outside the language model — is refused before the serving engine is touched, with the reason, and appears in `GET /vlm/models` with `loadable_here: false` and the same reason.

vLLM's adapter endpoints (`/v1/load_lora_adapter`, `/v1/unload_lora_adapter`) are mounted on a base with adapters. VIS's managed `/v1` never forwards them; on the engines themselves they sit on the internal network, behind `VLLM_API_KEY` when it is set.

### Per-model settings come from the overlay

Per-model settings live only in the overlay entry of that model: `gpu_memory_utilization`, `max_model_len`, `max_num_seqs`, `max_num_batched_tokens`, `image_cap`, and the `extra_args` of each entry in `tuning` (one list element per whitespace-separated token). `GET /vlm/models` shows the result. The `vlm-env/*.env` profiles of the old single sidecar, the `VLM_CONF` variable that picked one and the per-model `VLM_MAX_MODEL_LEN`, `VLM_GPU_MEMORY_UTILIZATION` and similar knobs they carried were removed; the managed engines never read them.

---

## Sizing and pre-flight

VIS sizes every engine from the card it actually runs on, measured with NVML, not from a number in a config file. If the card or the host's RAM cannot be read, VIS writes no engine commands and refuses every activate with that reason.

**Before any switch**, VIS checks that the model can run here, and refuses — with the arithmetic — before the serving model is touched:

- **The card is below the model's floor** (`min_vram_gb`, in the [model table](#the-models)). Refused first, whatever the rest of the arithmetic says.
- **The weights do not fit.** The card's memory, minus what the sleeping engines still hold on it and a safety margin, cannot hold the model's weights plus what its engine keeps outside its memory pool.
- **The host RAM cannot hold the sleepers.** The switch would leave more sleeping weights in RAM than the host has.

The refusal reaches the Manager as one line under the dropdown, and the API as `409 preflight_refused` with `error.preflight` carrying the numbers field by field. Every refusal names the remedy: free the card, pin other models cold, disable models you do not use, or pick a smaller model.

**Every load is sized again from the card when it starts.** The engine's launcher reads the card's free memory as CUDA reports it, leaves headroom for the load's peak, and starts vLLM with the largest memory fraction that fits, capped at the catalog's value. On an empty card that is exactly the catalog's value; on a card shared with the detection models or another process it is lower. When what is left cannot hold the weights, nothing is started: the engine rests parked and says why (`GET /vlm/status`, `load_sizing`, and the engine's log), and an activate that hits this ends rolled back with the arithmetic. It is never worded as a crash.

**The GPU.** The engines run on GPU 0, the card VIS measures, and the serving engine reserves its memory when it loads. The detection models (object, scene) are allocated lazily as streams use them, and the shipped reservations leave part of the card for them. On a card that is also busy with other work, free memory is what limits the model, not the catalog.

**Frames per request.** The analysis window is one request carrying `duration × inference_fps` images, and the catalog caps images per prompt (8 for every shipped model). Keep `duration × inference_fps` at 8 or below; the Manager enforces it.

**Concurrency.** At startup vLLM logs `Maximum concurrency for <N> tokens per request: <Y>x` — the engine's real ceiling on this GPU (`docker compose logs vif-model-<model>`, or the engine's log file under `./vis/vlm-state/logs/`). Use it to size `max_concurrent_requests` (see the [stream configuration](#stream-configuration-wseconfmodulesvif)).

**Disk.** All five models come to about 70 GB under `./vis/vlm-models`; the compile cache under `./vis/vlm-cache` is small beside it.

---

## Engine logs and troubleshooting

### Where to look

- **The Manager**: the **Engine logs** disclosure under the model dropdown shows the last lines of any engine's output (pick the engine, **Refresh**). It opens on the engine that is loading, else the one being activated, else the serving one. An engine that has not started a process has no log yet, and the view says so.
- **Docker**: `docker compose logs -f vif-model-<model>`; the service name is `vif-model-` plus the model id lowercased, with every run of other characters turned into one `-` (`vif-model-google-gemma-3-4b-it`).
- **Files**: `./vis/vlm-state/logs/<engine key>.log`, the same output. The launcher's first line is a revision marker (`[vlm-launcher] revision <date>`) that tells which copy of the bind-mounted script a deployment runs.
- **The API**: `GET /vlm/status?log_lines=50` returns the tail of every engine's log plus its state, tier, memory sizing and metrics.
- **VIS's own log** (`./vis/logs/`) records each switch, each refusal with its arithmetic, and the tier decisions.

An engine that is resting is **healthy** as far as Docker is concerned, so `docker compose up --wait` and `ps` stay green: a parked or asleep engine is not a failure.

### Symptoms

| You see | Cause and what to do |
|---|---|
| Stream shows **AI offline** / empty `vlm_analysis` with `degraded: true` | The managed endpoint could not take the window. Check `GET /vlm/status` or the Manager's status line. Usual causes are in the next rows |
| Pinned stream degraded, status `engine_asleep` | The model it names is resting (asleep or parked) because another is active. Activate it, or set the stream to **Default** to follow the active model |
| Degraded only for a few seconds during a switch | Normal: new work pauses while a switch runs (`paused: switching model`) and resumes on the new model |
| Degraded, status `engine_failed` | The engine that should serve is down or unreachable, or no model is active. Open **Engine logs** for the serving model; a crashed container is restarted by Docker. If nothing serves, `catastrophic_reason` in `GET /vlm/status` says why and what to do |
| Stream errors with `model_not_found` | `model_name` is not a model this deployment manages (typo, a snapshot path, or a model the overlay disabled). Fix the name; it is deliberately not degraded over |
| Activate refused: `preflight_refused` | The model does not fit this host beside the others; read the arithmetic. See [Sizing and pre-flight](#sizing-and-pre-flight) |
| Activate refused: `gated_model` | No token, a token HuggingFace rejects, or a license not accepted. See [Gated models](#gated-models-and-the-huggingface-token). The message links the license page; if it says the `.env` token is overriding yours, fix it there |
| Activate refused: `manager_starting` | The pool is still loading after startup. Wait; `startup_stage` says what for |
| Activate refused: `sleep_unavailable` | The serving engine has to be put to sleep for the switch and cannot be (it was started without sleep support, or a `VLLM_API_KEY` mismatch). The message names the engine; set that model's tier to cold, or set `VLM_FORCE_ALL_COLD=true` on a platform without sleep mode |
| Activate refused: `activation_in_flight` | One switch runs at a time |
| Activate refused: `model_disabled` / `not_managed_here` | The overlay disabled the model, or it is a [custom model](#adding-your-own-model-an-overlay-entry-and-a-slot) no slot serves yet |
| Activate refused: `host_not_measured` or `state_volume_read_only` | VIS cannot read the GPU/RAM, or cannot write `./vis/vlm-state` (check the mount's ownership; `vis-init` normally fixes it) |
| Activate ended `rolled back` | The load failed; the reason quotes the engine's last error line (or the sizing arithmetic when the card had too little free memory). The previous model is serving again |
| Model status `failed` | Its last load failed. Open its **Engine logs**; fix the cause (memory, disk, network) and activate again |
| Model status `quarantined (wake-failed)` | A wake from sleep failed; the engine was parked and is never put to sleep again until VIS restarts. Activating it is a cold start |
| Model status `parked` on a model that should be hot | Its container restarted while another model serves, or the RAM budget made it cold. See [Tiers](#tiers-hot-and-cold) |
| Model status `not deployed` | A [custom model](#adding-your-own-model-an-overlay-entry-and-a-slot) in the overlay with no slot serving it |
| Download stalls or restarts | Engine logs show the HuggingFace error. The engines reach the Hub over the `vif-engines-egress` network; check DNS and proxy on the host. Set `HF_TOKEN` for rate limits |
| First boot takes very long | Normal for a first boot: every hot-tier model downloads, loads and compiles in turn ([Startup order](#startup-order)). Disable models you do not use, or [pre-seed the weights](#air-gapped-hosts) |

---

## Upgrading from the single sidecar, and going back

Earlier releases ran one `vlm` container (hostname `vlm.docker`) configured by `vlm-env/*.env` files and `VLM_CONF`. The managed engines replace it. The compatibility shim that carried those files and that variable for one release is gone: `vlm-env/`, `VLM_CONF` and `docker-compose.vlm-multi.yaml` no longer exist.

**Upgrade through the release that introduced the managed engines first.** That release still reads `VLM_CONF` once, on the first start, to keep serving the model the old sidecar served. A stack that jumps straight from the single sidecar to a release without the shim loses that seed: VIS makes the first catalog model (Qwen) the active one, whatever the old `.env` said. If you served another model, pick it again with **Activate** in the Manager after the first start. Custom per-model settings do not carry over either; write them as fields of the model's entry in `vis/models/vlm-catalog.local.json` (see [the overlay](#customizing-the-deployment-the-catalog-overlay)).

**Upgrading.**

1. Stop the old stack with the old release's files: `docker compose --profile default --profile vlm down`. The old sidecar holds the GPU.
2. Pull this release and start it: `docker compose --profile default --profile vlm up -d --remove-orphans`.
3. On the first start VIS makes the first catalog model (Qwen) the active one. Activate another from the Manager if the old sidecar served a different model.
4. Stream configs that point at `http://vlm.docker:8000/v1` keep working with no edit. The first time the Engine loads its configs after the upgrade it also moves every VLM block that names the old sidecar to the managed endpoint with an empty `model_name` (follows the active model), keeping a `*.pre-follow-active` copy of each file it changed. The plugin reference, [`README.wse-plugin.md`](README.wse-plugin.md), describes that migration.
5. The first boot downloads and compiles every hot-tier model you did not already have, so it takes long; your existing `./vis/vlm-models` and `./vis/vlm-cache` are reused as they are.

The old `VLM_*` knobs no longer configure anything; [move your tuning into the overlay](#per-model-settings-come-from-the-overlay).

**Going back** to a release with the single `vlm` sidecar:

1. Stop the engines with this release's files first: `docker compose --profile default --profile vlm down`.
2. Restore the Engine's configs from the `*.pre-follow-active` copies (see the plugin reference), and name a model in any config you saved since that follows the active model: earlier releases do not accept an empty `model_name`.
3. Bring the older release up, from that release's own files, with the same `.env`. That release picks its model with `VLM_CONF`: set it in `.env` if the model you were serving was not Qwen.

The older release reuses `./vis/vlm-models` and `./vis/vlm-cache` as they are and ignores `./vis/vlm-state`.

---

## Linux installer: the `-vlm` package

On a Linux host without Docker, the Video Intelligence Service installs from a native package, and the **`-vlm`** variant (`wowza-vis-<version>-linux-<arch>-vlm.tar.xz`) adds the managed engines: VIS starts one launcher process per model in its own systemd control group, and the Manager's dropdown works exactly as in the Docker deployment. The package's own README has the full install instructions; what matters for VLM:

- **NVIDIA driver 580 or newer** (the engines run torch built for CUDA 13.0) and a C compiler on the host (vLLM compiles kernels on the first load). On arm64 the target is SBSA servers (Graviton-class, Grace), not Jetson.
- **Data directory.** `--vlm-data-dir DIR` (default `<prefix>/vlm`, that is `/usr/local/WowzaVideoIntelligenceService/vlm`) holds the engines' state, downloaded weights and compile caches. The catalog's weights come to about 70 GB, so point it at a disk with room. It is kept across upgrades and by `uninstall.sh` without `--purge`.
- **Settings** go in `/etc/wowza-vis/wowza-vis.env`: `HF_TOKEN` (wins over a token saved in the Manager, and needs a service restart), `HF_HUB_OFFLINE=1` for an air-gapped host with weights copied into `<data dir>/hf`, and `VLLM_API_KEY` to require a key on the engines' control endpoints. The engines listen on 127.0.0.1 only either way.
- **Logs and control.** The engines' output is in `<data dir>/state/logs/<model>.log` and in the Manager's **Engine logs**; `systemctl restart wowza-vis` restarts the engines with the service, and stopping the service leaves none behind.
- **Streams** use `http://localhost:5001/v1` (VIS's own port) or the VIS address, exactly as in Docker. There are no slots in this package: a model added in the overlay simply gets an engine.
- Everything in this guide about tiers, pre-flight, activation, gated models and the overlay applies unchanged; the overlay file is `models/vlm-catalog.local.json` under the install prefix unless `VLM_CATALOG_OVERLAY` in the env file names another path.

---

## Air-gapped hosts

Pre-seed the weights on a connected machine — `pip install -U huggingface_hub && HF_HOME=./vis/vlm-models hf download <model id>` for each model you will activate (every hot-tier model is loaded at boot) — copy `./vis/vlm-models` to the target, and set `HF_HUB_OFFLINE=1` in `.env` so boots skip HuggingFace Hub probes. Running the stack once on a connected machine and copying the populated directory works too. The same pre-seeding shortens a first boot on a slow link, where the resident set's weights are tens of GB.

Under `HF_HUB_OFFLINE=1` the engines still serve each model under its HuggingFace id, not its snapshot path, so a config that named the snapshot path must be changed to the id (or to **Default**).

---

## Configuration reference

### Deployment settings (`.env`)

The managed engines take no model configuration from `.env`: VIS resolves each engine's whole command from its model catalog and the card it runs on, and `vif-vlm-launcher.py` at the repo root runs it. The engine containers do not load the whole `.env` — only the variables below are passed to them, keeping Engine/VIS credentials out of the third-party image. Two vLLM flags are always set and deliberately not configurable: `--no-enable-prefix-caching` and `--mm-processor-cache-gb 0` (workload correctness for a stream of ever-changing frames).

| Variable | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | unset | Profiles to start without repeating `--profile`: `default,vlm` for the stack with the engines (the [slots](#adding-your-own-model-an-overlay-entry-and-a-slot) start with `vlm`) |
| `VIF_SLOT_1_MODEL`, `VIF_SLOT_2_MODEL` | unset | Optional: pin the overlay entry with this id to a slot. It wins over the assignment VIS would make. A slot with none takes the next custom model VIS assigns, or rests idle |
| `VLM_ADAPTER_MAX_UPLOAD_MB` | `1024` | The largest LoRA adapter archive VIS accepts on `POST /vlm/adapters` |
| `VLLM_API_KEY` | unset | Optional, never generated. When set, the engines require it, VIS sends it on its own calls to them, and the managed `/v1` passes the caller's key through — streams set the same value as `api_key`. Set it before publishing VIS's port |
| `HF_TOKEN` | unset | HuggingFace token for downloads (higher rate limits) and gated models. One set here wins over one saved in the Manager |
| `HF_HUB_OFFLINE` | unset | Set to `1` on air-gapped hosts with pre-seeded weights to skip Hub probes at boot |
| `VLM_FORCE_ALL_COLD` | unset | `true` parks every resting engine instead of putting it to sleep — for hosts where sleep mode cannot run |
| `VLM_RAM_RESERVE_MIB` | derived | Host RAM kept back from sleeping engines; unset = the larger of 40% of host RAM and 8 GiB |
| `VLM_GPU_IDS` | unset | Kept from the single-sidecar layout and still passed to the engines as their GPU pin. VIS sizes and pre-flights against GPU 0, so leave it unset: placing the engines on another card is not supported by this release |
| `VLM_CATALOG_OVERLAY` | `./models/vlm-catalog.local.json` | Path of the [overlay](#customizing-the-deployment-the-catalog-overlay) inside the VIS container (`./vis/models/vlm-catalog.local.json` on the host) |

**Network:** the engines and VIS share the internal `vif-engines` network, which nothing else joins, so Engine, Manager and every other service cannot reach an engine. The engines also sit on `vif-engines-egress`, which only they join, for their weight downloads. No engine port is published. To use the managed endpoint from another machine, see [Many engines, one VIS](#4-many-engines-one-vis).

### Stream configuration (`wse/conf.modules/vif/`)

Settings live in the `vlm_analysis` block — globally in `Default.json` for defaults, per stream in that stream's file (or in the Manager) to override. Two stream-level settings control the request rate: `inference_fps × duration` ≈ frames per request, one request per `duration` window (e.g. `inference_fps: 2`, `duration: 2` → 4 frames every 2 seconds).

On the managed endpoint the two fields that matter are `endpoint_url` (`http://video-intelligence-service.docker:5001/v1`) and `model_name`: leave it `""` to follow the active model, or name a model to pin the stream to it.

#### Standalone VLM (`detector_type: "vlm"` + `vlm_analysis`)

The standalone analyzer makes **one VLM call per analysis window** and works in one of three ways. There is no `mode` switch — VIS infers what to do from **which fields you set**, so explicit overrides always win. The Engine Manager UI presents these as **Detect / Describe / Custom**:

- **Detect** — set `class_names` (open vocabulary), no custom prompts. Returns a per-class verdict with reasoning (`{class_name, reasoning}`), surfacing only the classes actually present. Optionally attach `class_hints` to disambiguate a class.
- **Describe** — set nothing (no classes, no prompts). Returns a free-text description of each window using the built-in descriptive prompt.
- **Custom** — write your own `system_prompt` / `user_prompt`; output follows your prompt and stays **free-form by default**. Optionally add `class_names` (+ hints) to feed `{class_list}`, and a `response_schema` for structured output. Your prompts and schema are used verbatim. (Setting a custom `user_prompt` is what tells the analyzer you are driving the request, so it no longer imposes the per-class schema — see `response_schema` below.)

##### Detect: Reasoning Level (speed vs. accuracy)

Within **Detect**, the **Reasoning Level** picks how much the model deliberates per window. All three levels surface the same output — **only the detected classes**, rendered identically (class labels in the UI, overlay, webhook/ID3/log) — so the level is invisible downstream. The Engine Manager UI exposes it as a **Low / Medium / High** selector under the Detect class list; hand-written configs use the `reasoning_level` field.

| Level | `reasoning_level` | Reasoning | Speed |
|---|---|---|---|
| **High** (default) | `"high"` | strongest | slowest |
| **Medium** | `"medium"` | moderate | fast |
| **Low** | `"low"` | minimal | fastest |

Tradeoff: Low and Medium trade away some of High's verification effort in exchange for speed — pick the level by how accuracy-sensitive the stream is.

The prompts and output schema behind each level are built into the service — setting the field is all it takes. If the stream sets custom `system_prompt`/`user_prompt`/`response_schema`, those win and `reasoning_level` is ignored.

| Field | Default | Meaning |
|---|---|---|
| `model_name` | from global block | Model name sent to the endpoint |
| `endpoint_url` | from global block | OpenAI-compatible endpoint URL |
| `api_key` | none | Bearer token; for the managed endpoint, the `VLLM_API_KEY` value (omit when it is unset) |
| `class_names` | none | Open-vocabulary classes (Detect, or Custom with `{class_list}`). In Detect mode the engine surfaces per-class verdicts; leave unset for a free-text Describe |
| `reasoning_level` | `"high"` | Detect only: `"high"` (default) / `"medium"` / `"low"` picks how much the model deliberates (see above). Ignored when custom prompts or a `response_schema` are set |
| `class_hints` | none | Optional map of *class → hint* that disambiguates a class (e.g. `{"fire": "visible open flame, not red lighting"}`). **Render-only**: each hint is inlined next to its class in the prompt's `{class_list}` (as `- fire: …`); it never changes the result shape and costs only a few prompt tokens. Keys must be members of `class_names` (case-insensitive) |
| `system_prompt` | built-in | Custom mode: overrides the built-in system prompt. Supports the placeholders below |
| `user_prompt` | built-in | Custom mode: your instruction to the model. Supports the placeholders below |
| `response_schema` | auto | JSON Schema for structured output. The per-class results schema is applied automatically **only in Detect** — `class_names` set and no custom `user_prompt`. Once you supply your own `user_prompt`, output stays free-form unless you also set `response_schema` (so a custom prompt is never overridden by forced class output). A schema you provide is passed to the endpoint **verbatim** (unfiltered) and its output is flattened onto the result |
| `temperature` | `0.1` | Sampling temperature (0.0–2.0) |
| `max_tokens` | `512` | Response budget per request |
| `request_timeout_seconds` | `60.0` | Per-request HTTP timeout, including queue wait at the endpoint |
| `max_concurrent_requests` | `16` | Cap on in-flight requests to this endpoint from this VIS |

**Prompt placeholders** (Custom mode) are substituted in **both** `system_prompt` and `user_prompt`: `{class_list}` (a bullet list of `class_names`, with hints inlined as `- class: hint`; expanded only when `class_names` is set), `{frame_count}` (images in the window), and `{duration_seconds}` (window length). If you set classes but reference `{class_list}` in neither prompt, the classes never reach the model — the Manager UI flags this.

### What you receive

- **Standalone VLM** results depend on the mode: **Detect** carries per class the class name and the model's `reasoning`; **Describe** carries a free-text `description`; **Custom** carries whatever your `response_schema` defines (flattened onto the result). Delivered through the same event listeners as every detector: ID3 tags, webhooks, log files, and video overlays (overlays show class names / text — VLM results have no bounding boxes).
- **Resilience**: VLM streams stay alive while the endpoint is unreachable — VIS emits empty results (with a periodic status log) and resumes analysis automatically once the endpoint is up, so a stream started during the engines' multi-minute first boot simply begins analyzing when the model finishes loading. While the endpoint is down the overlay shows a read-only **"AI offline"** badge, so an outage is distinguishable from a genuinely quiet scene. The same outage is also surfaced off the overlay: it raises a throttled **WARNING** in the WSE log (with an INFO on recovery) and sets a `vlm_degraded` flag on the stream's status that the Manager dashboard renders as a distinct **"AI offline — VLM endpoint unreachable"** line — all three signals reuse the one wire flag and stay separate from the VIS connection `status`, which remains `connected` during a VLM-endpoint outage.

### Structured output

Every shipped model is served with `--structured-outputs-config {"backend":"xgrammar","disable_any_whitespace":true}`. It only affects requests that carry a JSON schema (VIS's class-based detection and verification, any stream `response_schema`), and it does two things:

- **No free whitespace between JSON tokens.** By default the grammar lets the model emit any amount of spaces and newlines between tokens, and small models can fall into padding an answer with spaces until `max_tokens` runs out — the answer arrives truncated, fails to parse, and the window counts as unanswered. Compact JSON removes that failure mode, saves tokens and speeds requests up (measured: a fifth of Cosmos3-Edge's answers truncated with the default grammar, none without, at three times the throughput; Qwen3-VL unchanged in quality).
- **The xgrammar backend, named explicitly.** vLLM requires a named backend for the whitespace setting. xgrammar compiles every schema the Manager UI's schema builder can produce and every schema VIS generates. A hand-written schema that uses `multipleOf`, `uniqueItems`, `contains`, `minContains`, `maxContains`, `patternProperties`, `propertyNames`, or an unusual string `format` is rejected by the endpoint instead of silently routed to another backend; VIS reports the window as degraded. If you need one of those features, serve the model from your own endpoint without the setting.

---

## Appendix: bring your own endpoint

Everything above is the managed path. A VLM stream can instead use **any OpenAI-compatible endpoint that accepts images**: a hosted provider, your own vLLM, or another server on this or another machine. The framework does not manage it: you start it, size it, choose its model and keep it up. Use this when the model you need is not in the catalog and you do not want a [custom catalog entry](#adding-your-own-model-an-overlay-entry-and-a-slot), when the VLM must run on a different machine from VIS, or when you already operate one.

**Point a stream at it** in the `vlm_analysis` block (or in the Manager: set **VLM Server** to **Your own endpoint (advanced)**):

```jsonc
"vlm_analysis": {
  "endpoint_url": "http://my-vlm.internal:8000/v1",
  "model_name": "Qwen/Qwen3-VL-8B-Instruct",   // required: the exact id the endpoint serves
  "api_key": "..."                              // only if the endpoint requires one
}
```

- **`model_name` is required** and must match a model the endpoint serves; there is no "follow the active model" on your own endpoint, and the Manager shows a static list of suggested names plus **Other…** for a custom one. **Verify** lists what the endpoint serves and, when that is a single model differing from your selection, adopts it.
- **Any URL that VIS does not serve itself is bring-your-own**: VIS does not interpret it. A VIS on another machine reached by its own address is also treated this way; it still works.
- **Images per request.** VIS learns the endpoint's per-request image limit at run time from its `400` answer (vLLM's "At most N image(s)"), so there is nothing to mirror in a config. Still keep `duration × inference_fps` within the limit you configured on the server.
- **Pooling.** Streams share one HTTP client per `(endpoint_url, api_key)`. `request_timeout_seconds` and `max_concurrent_requests` are set by the **first** stream to use an endpoint; later streams with different values keep the first ones (a WARNING is logged).
- **Outages degrade, they do not error.** An unreachable endpoint yields empty results with `degraded: true`, exactly as on the managed path; analysis resumes when it is back.
- **Authentication and exposure.** The endpoint's key goes in `api_key`; set one on any endpoint reachable beyond the host.

**Running your own vLLM next to the stack.** Any container that serves an OpenAI-compatible `/v1` on a network the VIS container can reach works: a plain `vllm/vllm-openai` container you run yourself, on its own GPU so a second model serves **at the same time** as the managed one. Streams reach it directly, naming its model in `model_name`. Keep it off GPU 0: VIS sizes the managed engines against the whole card and does not know about your container. The framework no longer ships an example file for this (`docker-compose.vlm-multi.yaml` was removed along with the single-sidecar shim).

Two [deployment topologies](#deployment-topologies) use this path naturally: a VLM on a different machine from VIS, and a model from a hosted provider.
