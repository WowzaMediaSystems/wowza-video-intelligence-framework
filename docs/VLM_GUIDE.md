# VLM Analysis Guide

The Video Intelligence framework can run a **vision-language model (VLM)** over your live streams. Unlike the scene and object detectors, which score a fixed set of trained classes, a VLM understands free-text vocabulary — "person wearing a hard hat", "forklift near pedestrians", "smoke without visible flames" — and explains its reasoning with every result.

With `detector_type: "vlm"` the VLM watches the stream directly. Give it a list of classes (any short phrase works) for a per-class verdict with reasoning, ask it for a free-text description, or drive it with your own prompts and output schema.

The VLM is any **OpenAI-compatible HTTP endpoint** — the framework bundles a ready-to-run [vLLM](https://docs.vllm.ai) sidecar serving **Qwen/Qwen3-VL-4B-Instruct-FP8** (commercial-use friendly), so everything can run locally on your GPU, or you can point at a hosted provider instead.

---

## Quick start

Prerequisites: a working framework checkout with `.env` populated (licenses, admin credentials — see [README](README.md)), an NVIDIA GPU with current drivers, and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

**1. Start the full stack with the VLM sidecar:**

```bash
docker compose --profile default --profile vlm up -d
```

The first boot downloads ~5 GB of model weights into `./vis/vlm-models` (reused on every later boot). Watch progress and wait for `vlm` to report healthy:

```bash
docker compose logs -f vlm     # model download + load progress
docker compose ps              # 'vlm' flips to (healthy) when ready
```

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

Any permutation works — everything on one machine, the engine split from VIS, one engine fanning out to many VIS instances, or many engines sharing one VIS.

### 1. Everything on one machine (default)

```
┌─────────────────────────────────────┐
│  engine ──▶ VIS ──▶ vlm sidecar     │
│              GPU(s)                 │
└─────────────────────────────────────┘
docker compose --profile default --profile vlm up -d
```

Works out of the box — see [Defaults](#defaults-it-just-works) below. On a multi-GPU machine, give the VLM its own card with `VLM_GPU_IDS` in `.env`.

### 2. Engine on one machine, VIS + VLM on another

Put inference on the GPU box and keep the engine wherever your streaming runs:

```
┌── box A ───────────┐      ┌── box B (GPU) ──────────┐
│  engine + manager  │─────▶│  VIS ──▶ vlm sidecar    │
└────────────────────┘ :5001└─────────────────────────┘

box B:  docker compose --profile vlm up -d          # VIS + VLM only
box A:  docker compose --profile wse up -d          # engine + manager only
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

Run each GPU box with `docker compose --profile vlm up -d` — with the default configuration, each VIS uses its own local VLM sidecar.

### 4. Many engines, one VIS

Multiple engines can share one VIS deployment — point each engine's `VIS_HOST` at the same box. VIS pools models across streams, and all streams targeting the same VLM endpoint share one HTTP client pool. Note that the pool's `request_timeout_seconds` and `max_concurrent_requests` are set by the **first** stream to use that endpoint; later streams with different values keep the first ones (a WARNING is logged).

> **Splitting VIS and the VLM across machines** is also possible: uncomment the `ports:` block on the `vlm` service to publish its port, set `VLLM_API_KEY` in `.env` on the VLM box (the endpoint is otherwise unauthenticated), and point `endpoint_url` at `http://<vlm box>:8000/v1` with the same key as `api_key`.

---

## Defaults: it just works

Spin up everything on one machine and the pieces are pre-wired end to end:

| What | Default | Why it works |
|---|---|---|
| Model | `Qwen/Qwen3-VL-4B-Instruct-FP8` | Bundled, commercial-use friendly, fits a 24 GB GPU |
| Endpoint | `http://vlm.docker:8000/v1` | Pre-set in the shipped `video-intelligence.json`; resolves on the compose network |
| Demo stream | `vlm.*` on app `live` | Publish `live/vlm-anything` and analysis starts |
| Weights | cached in `./vis/vlm-models` | One ~5 GB download, ever; pre-seedable for air-gapped hosts |
| Compile cache | `./vis/vlm-cache` | vLLM's ~40 s startup compile happens once, not on every container recreation |
| GPU tuning | auto-probed at startup | KV-cache precision and concurrency ceiling adapt to your card |

GPU placement is the one thing worth a decision on multi-GPU machines: the sidecar reserves 90% of one card by default, so give it a dedicated GPU with `VLM_GPU_IDS` in `.env` (e.g. `VLM_GPU_IDS=1`) and let the detectors use the rest. On a single-GPU machine that must run everything, lower `VLM_GPU_MEMORY_UTILIZATION` (e.g. `0.4`–`0.5`) so the detector models still fit.

---

## Configuration reference

### Sidecar tuning (`.env`)

All knobs are environment variables read by `vis/vlm-entrypoint.sh` (which also documents them in detail — defaults adapt to your hardware, and you should never need to edit the file itself):

| Variable | Default | Meaning |
|---|---|---|
| `VLM_MODEL` | `Qwen/Qwen3-VL-4B-Instruct-FP8` | Any vLLM-supported vision model |
| `VLM_GPU_IDS` | unset (first visible GPU) | Pin the sidecar to specific card(s), e.g. `1` or `2,3`; indices match `nvidia-smi` |
| `VLM_TENSOR_PARALLEL_SIZE` | `1` | Shard the model across N GPUs |
| `VLM_GPU_MEMORY_UTILIZATION` | `0.90` | Fraction of the GPU vLLM reserves; assumes a dedicated card |
| `VLM_KV_CACHE_DTYPE` | probed | `fp8` on Ada/Hopper+ GPUs, `auto` on older cards; set to force |
| `VLM_MAX_MODEL_LEN` | `16384` | Context window per request |
| `VLM_MAX_NUM_SEQS` | `auto` | Concurrency ceiling; `auto` lets vLLM size it to your GPU's KV capacity |
| `VLM_MAX_NUM_BATCHED_TOKENS` | `8192` | Scheduler batch size |
| `VLM_MAX_PIXELS` / `VLM_MIN_PIXELS` | `401408` / `3136` | Per-image resolution cap (≈512 vision tokens/image at the default) |
| `VLM_MAX_IMAGES_PER_PROMPT` | `8` | Max frames per request; keep `inference_fps × duration` at or below this |
| `VLM_PORT` | `8000` | Served port; the compose healthcheck follows it |
| `VLLM_API_KEY` | unset | Require an API key on the endpoint (set when publishing the port) |
| `HF_TOKEN` | unset | HuggingFace token for the first-boot weight download (higher rate limits) |
| `HF_HUB_OFFLINE` | unset | Set to `1` on air-gapped hosts with pre-seeded weights to skip Hub probes at boot |
| `VLM_EXTRA_ARGS` | unset | Raw passthrough for any other `vllm serve` flag |

Sizing tip: at startup vLLM logs `Maximum concurrency for <N> tokens per request: <Y>x` — that's your endpoint's real ceiling on this GPU. Use it to size `max_concurrent_requests` (below); vLLM doesn't expose it over HTTP, so VIS can't read it automatically.

### Stream configuration (`wse/conf/video-intelligence.json`)

Settings live in the `vlm_analysis` block — globally for defaults, per-stream to override. Two stream-level settings control the request rate: `inference_fps × duration` ≈ frames per request, one request per `duration` window (e.g. `inference_fps: 2`, `duration: 2` → 4 frames every 2 seconds).

#### Standalone VLM (`detector_type: "vlm"` + `vlm_analysis`)

The standalone analyzer makes **one VLM call per analysis window** and works in one of three ways. There is no `mode` switch — VIS infers what to do from **which fields you set**, so explicit overrides always win. The Engine Manager UI presents these as **Detect / Describe / Custom**:

- **Detect** — set `class_names` (open vocabulary), no custom prompts. Returns a per-class verdict with reasoning (`{class_name, reasoning}`), surfacing only the classes actually present. Optionally attach `class_hints` to disambiguate a class.
- **Describe** — set nothing (no classes, no prompts). Returns a free-text description of each window using the built-in descriptive prompt.
- **Custom** — write your own `system_prompt` / `user_prompt`; output follows your prompt and stays **free-form by default**. Optionally add `class_names` (+ hints) to feed `{class_list}`, and a `response_schema` for structured output. Your prompts and schema are used verbatim. (Setting a custom `user_prompt` is what tells the analyzer you are driving the request, so it no longer imposes the per-class schema — see `response_schema` below.)

##### Detect: Reasoning Level (speed vs. accuracy)

Within **Detect**, a **Reasoning Level** trades decode speed for robustness against false positives. All three levels surface the same thing — **only the detected classes**, rendered identically (chips, overlay, webhook/ID3/log) — so the level is invisible downstream; it only changes how hard the model deliberates and, at Low/Medium, drops the per-class `reasoning` text from the payload. The Engine Manager UI exposes it as a **Low / Medium / High** selector under the Detect class list; hand-written configs select it with a `reasoning_level` field.

| Level | `reasoning_level` | Output | Speed | Use it when |
|---|---|---|---|---|
| **High** (default) | *(field absent)* | per class `{class_name, reasoning}` | slowest | accuracy matters most; you want the model's per-class justification in the payload |
| **Medium** | `"medium"` | booleans, preceded by an internal `scene` inventory of what's visible | fast | you want most of High's grounding at a fraction of the cost — a good default when throughput matters |
| **Low** | `"low"` | one boolean per class | fastest | maximum throughput; the scene is simple and false positives are cheap to tolerate |

Why the middle rung exists: High's free-text `reasoning` (~200 output tokens/request) dominates decode latency, but it also does real grounding work — dropping it entirely (Low) can make a model call *everything* present on ambiguous footage like color-bars test patterns. **Medium** keeps a short (~20-word) `scene` field in which the model **lists the salient objects and actions it actually sees** *before* it emits the booleans; the classes are then judged against that inventory, recovering most of High's grounding for a few extra tokens. The `scene` value is an internal deliberation aid only — it is **never** shown on any output surface.

Accepted tradeoff: Low has no safety net beyond its guardrail prompt and `temperature: 0.0`, and Medium adds only the `scene` inventory anchor — either can still return an all-present result on adversarial input. Pick the level to match how costly a false positive is for your use case.

> **Do not set `reasoning_level` in the global `vlm_analysis` defaults block.** Low/Medium require their injected prompts *and* a per-class response schema sent together, and that schema is built per stream from its own class list. A `reasoning_level` in the global defaults would propagate to every VLM stream without its matching schema; the Engine detects such a mismatched (or otherwise incomplete) block on load and safely treats that stream as High. Set the level per stream — the Manager UI does this for you.

| Field | Default | Meaning |
|---|---|---|
| `model_name` | from global block | Model name sent to the endpoint |
| `endpoint_url` | from global block | OpenAI-compatible endpoint URL |
| `api_key` | none | Bearer token; omit for the bundled sidecar |
| `class_names` | none | Open-vocabulary classes (Detect, or Custom with `{class_list}`). In Detect mode the engine surfaces per-class verdicts; leave unset for a free-text Describe |
| `reasoning_level` | *(absent = High)* | Detect only: `"low"` or `"medium"` selects a faster reasoning level (see above). Low/Medium also require the injected `system_prompt`/`user_prompt`/`response_schema` — set them per stream (the Manager UI does), never in the global defaults block |
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
- **Resilience**: VLM streams stay alive while the endpoint is unreachable — VIS emits empty results (with a periodic status log) and resumes analysis automatically once the endpoint is up, so a stream started during the sidecar's multi-minute first boot simply begins analyzing when the model finishes loading. While the endpoint is down the overlay shows a read-only **"AI offline"** badge, so an outage is distinguishable from a genuinely quiet scene. The same outage is also surfaced off the overlay: it raises a throttled **WARNING** in the WSE log (with an INFO on recovery) and sets a `vlm_degraded` flag on the stream's status that the Manager dashboard renders as a distinct **"AI offline — VLM endpoint unreachable"** line — all three signals reuse the one wire flag and stay separate from the VIS connection `status`, which remains `connected` during a VLM-endpoint outage.
