# VLM Analysis Guide

The Video Intelligence framework can run a **vision-language model (VLM)** over your live streams. Unlike the scene and object detectors, which score a fixed set of trained classes, a VLM understands free-text vocabulary — "person wearing a hard hat", "forklift near pedestrians", "smoke without visible flames" — and explains its reasoning with every result.

With `detector_type: "vlm"` the VLM watches the stream directly. Give it a list of classes (any short phrase works) for a per-class verdict with reasoning, ask it for a free-text description, or drive it with your own prompts and output schema.

The VLM is any multi-modal model behind an **OpenAI-compatible HTTP endpoint** — one that reads the stream's frames alongside your text prompts. The framework bundles **managed VLM engines**: one [vLLM](https://docs.vllm.ai) container per supported model, all resident on your GPU, with the Video Intelligence Service (VIS) deciding which one serves and switching between them in seconds. Streams reach them through VIS's own endpoint. You can also point a stream at any other endpoint instead — a hosted provider or your own server. The default model is **Qwen/Qwen3-VL-4B-Instruct-FP8** (commercial-use friendly); see [Choosing the model](#choosing-the-model).

---

## Quick start

Prerequisites: a working framework checkout with `.env` populated (licenses, admin credentials — see [README](README.md)), an NVIDIA GPU with current drivers, and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

**1. Start the full stack with the managed VLM engines:**

```bash
docker compose --profile default --profile vlm up -d
```

Each engine downloads its model's weights into `./vis/vlm-models` the first time it loads, and reuses them on every later boot. The engines load one at a time, the active model first. Watch progress:

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

**4. Make it yours.** Change `class_names` to anything you want to find (it's open vocabulary) — either from the Video Intelligence configuration in Engine Manager (`http://localhost:8088`), or by editing `wse/conf/video-intelligence.json` and restarting the stream to apply - either by toggling its active state or by restarting the encoder.

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

Works out of the box — see [Defaults](#defaults-it-just-works) below.

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

## Defaults: it just works

Spin up everything on one machine and the pieces are pre-wired end to end:

| What | Default | Why it works |
|---|---|---|
| Model | `Qwen/Qwen3-VL-4B-Instruct-FP8` | Bundled, commercial-use friendly, fits a 24 GB GPU |
| Endpoint | `http://video-intelligence-service.docker:5001/v1` | VIS's managed endpoint; it routes each request to the engine serving the stream's `model_name`. The address older configs carry, `http://vlm.docker:8000/v1`, is served the same way |
| Demo stream | `vlm.*` on app `live` | Publish `live/vlm-anything` and analysis starts |
| Weights | cached in `./vis/vlm-models` | Each model downloads once, ever; pre-seedable for air-gapped hosts |
| Compile cache | `./vis/vlm-cache` | vLLM's startup compile happens once per model, not on every container recreation |
| Engine state | `./vis/vlm-state` | The active model, each engine's command and its log; the active model survives restarts |
| GPU tuning | resolved by VIS per model and card | KV-cache precision, memory reservation and CUDA-graph settings follow the card; the small-card caps are dropped on 40 GB+ cards |

The engines run on GPU 0. The serving engine reserves its memory when it loads, while the detection models (object detection, scene detection, …) are allocated lazily as streams start using them; the shipped reservations leave part of the card for them.

---

## Choosing the model

Every supported model has its own engine container (`vif-model-<model>`), and all of them are resident. One serves at a time; the others rest, either **asleep** (weights in host RAM, back in a second or two) or **parked** (no process, weights on disk, back in a cold start of a minute or two). VIS chooses which models may sleep from the host's RAM, and parks the rest.

**Startup order.** Every model's GPU reservation assumes the others are asleep while it loads, so after a restart the models that rest asleep load first, one at a time, each going to sleep as soon as it is loaded, and the serving model loads last. Streams therefore wait for the whole pool to load before analysis starts: about 12 minutes with a warm compile cache (`./vis/vlm-cache`), longer on a first boot, when every model also compiles. Parked models are not loaded at startup. A resting model whose container restarts while another model serves stays parked until nothing is serving or it is activated, rather than loading beside the serving one.

Switch the serving model from the Engine Manager, or through VIS's control API (`X-API-Key` as for the rest of VIS):

```bash
curl -H "X-API-Key: $VIS_API_KEY" http://<VIS host>:5001/vlm/models                  # catalog, residency, state
curl -X POST -H "X-API-Key: $VIS_API_KEY" \
  http://<VIS host>:5001/vlm/models/nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8/activate
curl -H "X-API-Key: $VIS_API_KEY" http://<VIS host>:5001/vlm/status                  # progress of the switch
```

**First activation.** A model whose weights are not on disk yet is downloaded when it is first activated, then loaded and compiled, which takes minutes. The Manager (and `GET /vlm/status`) says which of those it is doing: `downloading` with how much has arrived, `loading`, `compiling`, then a test request. Each of them is skipped when it does not apply, so a model that is already on disk and compiled starts in seconds.

**Engine logs.** The Manager's model dropdown has an **Engine logs** view with the last lines of each engine's output, the same lines `docker compose logs vif-model-<model>` prints, for when a download stalls or a start fails.

The active model persists across restarts. A stream's `model_name` must be the model that is serving: a request for a model that is resting is refused rather than waking it, and the stream reports itself degraded until that model is activated. The Manager UI's **Verify** button reads the models the endpoint serves and adopts the served model into the stream's config.

| Model | Notes | Pre-upgrade `VLM_CONF` |
|---|---|---|
| `Qwen/Qwen3-VL-4B-Instruct-FP8` | Default. Commercial-use friendly, fits a 24 GB card | `qwen` |
| `nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8` | NVIDIA reasoning VLM. Cannot sleep, so it always rests parked | `nemotron` |
| `google/gemma-3-4b-it` | Gated on HuggingFace — accept the license and set a token in the Manager or as `HF_TOKEN` in `.env` ([gated models](#gated-models)); fits a 24 GB card | `gemma` |
| `nvidia/Cosmos3-Edge` | NVIDIA Cosmos reasoning VLM (3.86B); fp8-quantized at load, fits an 8 GB card. Uses the bundled patch mount, already wired in `docker-compose.yaml` | `cosmos-edge` |
| `nvidia/Cosmos3-Nano` | Larger Cosmos reasoning VLM (15.75B, ~32 GB of BF16 weights); needs a 40 GB+ card | `cosmos-nano` |

**Upgrading from the single `vlm` sidecar:** on the first start, VIS makes the model your `.env`'s `VLM_CONF` named the active one, so the stack keeps serving what it served; without `VLM_CONF`, Qwen. `VLM_CONF` is read only for that and can be removed afterwards. The `vlm-env/` files and their `VLM_*` knobs no longer configure the managed engines. Stream configs that point at `http://vlm.docker:8000/v1` keep working with no edit.

**Hosts without sleep mode:** vLLM's sleep mode needs CUDA UVA, which some platforms (e.g. WSL2) do not provide. Set `VLM_FORCE_ALL_COLD=true` in `.env` there: every resting model is parked, and switches take a cold start.

### Customizing the catalog: the local overlay

VIS ships the model catalog: every supported model's sizing, tuning per GPU class and resting behaviour. A deployment changes it in one optional file, `./vis/models/vlm-catalog.local.json`, which VIS reads when it starts. It lives under `./vis/`, which is not tracked, so a framework `git pull` never touches it. Edit it, then restart VIS (`docker compose restart video-intelligence-service-gpu`); the engines follow the specs VIS writes them without a restart of their own.

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

Disabling the model that is serving is not refused: after the restart it keeps serving, VIS logs a WARNING naming it, and the flag takes effect the moment another model is activated. The first start after an upgrade never picks a disabled model either: a `VLM_CONF` naming one falls back to the first model that is not disabled.

To bring a model back, remove the flag and restart VIS. The engine loads again as it would after any restart: at boot if it rests asleep, at its next activation if it is parked.

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

`min_vram_gb` must equal the lowest tuning tier's `min_total_vram_gb`; `weights_gb` is the checkpoint's size on disk; `sleep_level_default` is always `1`; `gated: true` for weights behind a HuggingFace license (then a HuggingFace token applies as for Gemma, set in the Manager or as `HF_TOKEN`). `tier` (`auto` by default), `max_num_seqs`, `mm_processor_kwargs` and `sleep_capable` are optional, as for a shipped model.

**The engine** is a slot: the compose ships two generic services, `vif-model-slot-1` and `vif-model-slot-2`, each behind a profile of its own and told which model to serve by one `.env` line:

```bash
# .env
COMPOSE_PROFILES=default,vlm,vlm-slot-1
VIF_SLOT_1_MODEL=acme/acme-vl-2b
```

Then restart VIS (it reads the overlay) and bring the slot up: `docker compose up -d`. The slot's launcher tells VIS on the state volume which model it was given, VIS answers, and the model appears in `GET /vlm/models` and the Manager's dropdown like any other: it is downloaded on its first activation, rests asleep or parked by the host's RAM, and streams reach it through the managed endpoint.

What the slot does when something is off, always staying healthy so `docker compose up --wait` keeps working:

- enabled with no `VIF_SLOT_N_MODEL`: it rests on the launcher's health stub (`/vif/parked` says `"unassigned": true`);
- assigned a model VIS does not know (not in the overlay, or the overlay was rejected), a shipped model, or a model another slot already serves: its log says which, it rests on the stub, and `GET /vlm/status` lists the slot under `slots` as `misconfigured` with the same reason;
- a model in the overlay with no slot serving it: `GET /vlm/models` shows it with `resident: false` and the reason, and activating it is refused until a slot serves it.

A model you disable (`"disabled": true`) keeps its slot parked, like a shipped one. Bring a slot down by removing its profile from `COMPOSE_PROFILES` and running `docker compose --profile vlm-slot-1 stop vif-model-slot-1`.

### Your own LoRA adapters

A LoRA adapter you trained for one of the models is one more model in the dropdown: streams name it as their `model_name`, and it is served by its base model's engine, which routes each request to the adapter or the base by the name it carries.

1. **Copy the adapter** (PEFT's `adapter_config.json` and `adapter_model.safetensors`) under `./vis/vlm-models/`, the weights directory every engine shares, e.g. `./vis/vlm-models/lora/acme-forklifts/`. VIS reads it there too, read-only.
2. **Declare it in the overlay**, with the base's LoRA support in the same file:

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
3. **Restart VIS**, and the base's engine if it is running (`docker compose restart vif-model-<base>`): an engine reads `--enable-lora` only when it starts. An adapter entry VIS cannot serve — a field that does not validate, a base that is not in the catalog or does not enable LoRA, a rank above the base's limit — is logged as an ERROR naming it and left out, and the rest of the file applies.

Activating the adapter while its base serves is the fastest switch there is: the adapter is loaded into the serving engine and proven with one request, with no pause for the streams on the base. With the base resting, activating the adapter switches to the base first, then loads it. Activating anything else unloads it. An adapter whose files cannot work with its base — a rank that disagrees with its `adapter_config.json`, tensors outside the language model — is refused before the serving engine is touched, with the reason, and appears in `GET /vlm/models` with `loadable_here: false` and the same reason.

vLLM's adapter endpoints (`/v1/load_lora_adapter`, `/v1/unload_lora_adapter`) are mounted on a base with adapters. VIS's managed `/v1` never forwards them; on the engines themselves they sit on the internal network, behind `VLLM_API_KEY` when it is set.

**Migrating from `vlm-env/*.env.local` copies.** The documented way to tune a model used to be copying its profile (`cp vlm-env/qwen.env vlm-env/local.env`, then `VLM_CONF=local`). The managed engines do not read those files. Write the lines you changed as fields of that model's overlay entry instead: `VLM_GPU_MEMORY_UTILIZATION` → `gpu_memory_utilization`, `VLM_MAX_MODEL_LEN` → `max_model_len`, `VLM_MAX_NUM_SEQS` → `max_num_seqs`, `VLM_MAX_NUM_BATCHED_TOKENS` → `max_num_batched_tokens`, `VLM_MAX_IMAGES_PER_PROMPT` → `image_cap`, and `VLM_EXTRA_ARGS` → the `extra_args` of each entry in `tuning` (one list element per whitespace-separated token). `GET /vlm/models` shows the result.

### Gated models

Gemma is gated: its weights download only for a HuggingFace account that has accepted the model's license. Accept it on the model's page (<https://huggingface.co/google/gemma-3-4b-it>) while logged in as the account whose access token you will use, then give the engines a read token for that account, in one of two places:

- **In the Manager** (recommended): pick the gated model under a stream's managed VLM endpoint, paste the token in the **HuggingFace token** field and **Save**. It is checked against HuggingFace before it is kept — a token HuggingFace rejects is refused and nothing is stored; a license the account has not accepted yet is named, and the token is kept for when it is. The next activate uses it; no container is recreated. The field then shows `***` and a **Remove** button; the token itself is never shown again, logged, or returned by any API. The same field appears under a refused activate.
- **In `.env`** as `HF_TOKEN`, then recreate the engines (`docker compose --profile vlm up -d`). A token set here wins over one set in the Manager, so a deployment can pin it; the Manager says so when that is the token being refused.

Without a usable token, activating the model is refused at once, before the serving model is touched, and the refusal says which of the three is wrong (no token, a token HuggingFace does not accept, a license not accepted) and links the license page. The serving model keeps serving. A model whose weights are already on disk is not asked about its license again.

**Where the Manager's token lives.** The Engine keeps a copy in its VOD secrets file under a reserved name that no webhook can use, and hands it to the Video Intelligence Service over the service's API key; the service stores it on the engines' state volume (`./vis/vlm-state/secrets/hf-token`, readable only by the service's user) for the engines to read. Nothing else receives it — not the managed `/v1` endpoint, not a stream, not a browser. The state volume is shared only by the service and the engine containers, the same exposure as the `.env` file the token would otherwise sit in: protect `./vis/` the way you protect `.env`.

### Structured output

Every shipped model is served with `--structured-outputs-config {"backend":"xgrammar","disable_any_whitespace":true}`. It only affects requests that carry a JSON schema (VIS's class-based detection and verification, any stream `response_schema`), and it does two things:

- **No free whitespace between JSON tokens.** By default the grammar lets the model emit any amount of spaces and newlines between tokens, and small models can fall into padding an answer with spaces until `max_tokens` runs out — the answer arrives truncated, fails to parse, and the window counts as unanswered. Compact JSON removes that failure mode, saves tokens and speeds requests up (measured: a fifth of Cosmos3-Edge's answers truncated with the default grammar, none without, at three times the throughput; Qwen3-VL unchanged in quality).
- **The xgrammar backend, named explicitly.** vLLM requires a named backend for the whitespace setting. xgrammar compiles every schema the Manager UI's schema builder can produce and every schema VIS generates. A hand-written schema that uses `multipleOf`, `uniqueItems`, `contains`, `minContains`, `maxContains`, `patternProperties`, `propertyNames`, or an unusual string `format` is rejected by the endpoint instead of silently routed to another backend; VIS reports the window as degraded. If you need one of those features, serve the model from your own endpoint without the setting.

### Serving another model at the same time

The managed engines serve one model at a time. To serve a second model simultaneously, on another GPU, layer the example override `docker-compose.vlm-multi.yaml`: it adds `vlm-2`, a plain vLLM container that VIS does not manage, which streams reach directly at `http://vlm-2.docker:8000/v1`:

```bash
# .env:  VLM_2_CONF=<model file in vlm-env/>   (default nemotron)   VLM_2_GPU_IDS=1
docker compose -f docker-compose.yaml -f docker-compose.vlm-multi.yaml \
  --profile default --profile vlm up -d
```

Keep `vlm-2` off GPU 0: VIS sizes the managed engines against the whole card. Teardown uses the same files: `docker compose -f docker-compose.yaml -f docker-compose.vlm-multi.yaml --profile vlm down`.

---

## Configuration reference

### Deployment settings (`.env`)

The managed engines take no model configuration from `.env`: VIS resolves each engine's whole command from its model catalog and the card it runs on, and `vif-vlm-launcher.py` at the repo root runs it. The engine containers do not load the whole `.env` — only the variables below are passed to them, keeping Engine/VIS credentials out of the third-party image. Two vLLM flags are always set and deliberately not configurable: `--no-enable-prefix-caching` and `--mm-processor-cache-gb 0` (workload correctness for a stream of ever-changing frames). The launcher's first boot-log line is a revision marker (`[vlm-launcher] revision <date>`) that identifies which copy of the bind-mounted script a deployment is running.

| Variable | Default | Meaning |
|---|---|---|
| `VLLM_API_KEY` | unset | Optional, never generated. When set, the engines require it, VIS sends it on its own calls to them, and the managed `/v1` passes the caller's key through — streams set the same value as `api_key`. Set it before publishing VIS's port |
| `HF_TOKEN` | unset | HuggingFace token for the first-boot weight downloads (higher rate limits). Gated models need one here or set in the Manager; one set here wins |
| `HF_HUB_OFFLINE` | unset | Set to `1` on air-gapped hosts with pre-seeded weights to skip Hub probes at boot |
| `VLM_FORCE_ALL_COLD` | unset | `true` parks every resting engine instead of putting it to sleep — for hosts where sleep mode cannot run |
| `VLM_RAM_RESERVE_MIB` | derived | Host RAM kept back from sleeping engines; unset = the larger of 40% of host RAM and 8 GiB |

**Network:** the engines and VIS share the internal `vif-engines` network, which nothing else joins, so Engine, Manager and every other service cannot reach an engine. The engines also sit on `vif-engines-egress`, which only they join, for their weight downloads. No engine port is published.

**Sizing concurrency:** at startup vLLM logs `Maximum concurrency for <N> tokens per request: <Y>x` — the engine's real ceiling on this GPU (`docker compose logs vif-model-<model>`, or `./vis/vlm-state/logs/`). Use it to size `max_concurrent_requests` (below).

**Air-gapped hosts:** pre-seed the weights on a connected machine — `pip install -U huggingface_hub && HF_HOME=./vis/vlm-models hf download <model id>` for each model you will activate (every resident model that is allowed to sleep is loaded at boot) — copy `./vis/vlm-models` to the target, and set `HF_HUB_OFFLINE=1` in `.env` so boots skip HuggingFace Hub probes. (Running the stack once on a connected machine and copying the populated directory works too.) The same pre-seeding shortens a first boot on a slow link, where the resident set's weights are tens of GB.

**Downgrading** to a framework release with the single `vlm` sidecar: stop the engines with this release's files first (`docker compose --profile default --profile vlm down`), then bring the older release up with the same `.env`. Put `VLM_CONF=<name>` back in `.env` if the model you were serving was not Qwen. The older release reuses `./vis/vlm-models` and `./vis/vlm-cache` as they are and ignores `./vis/vlm-state`.

### Stream configuration (`wse/conf/video-intelligence.json`)

Settings live in the `vlm_analysis` block — globally for defaults, per-stream to override. Two stream-level settings control the request rate: `inference_fps × duration` ≈ frames per request, one request per `duration` window (e.g. `inference_fps: 2`, `duration: 2` → 4 frames every 2 seconds).

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
