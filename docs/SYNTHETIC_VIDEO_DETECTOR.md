# Synthetic Video Detector (Deepfake) Guide

The Video Intelligence framework can flag **synthetic / AI-generated (deepfake)
video** on a live stream. A detector type, `detector_type: "synthetic"`, watches
your stream in short windows and returns a per-window **Real vs Fake** verdict —
a `"synthetic"` / `"real"` label with a probability score — backed by the
**NVIDIA Maxine Synthetic Video Detector (SVD)** model.

It is **opt-in** and **bring-your-own endpoint**: nothing about the synthetic
detector runs unless a stream is explicitly configured for it and pointed at a
reachable SVD endpoint. That endpoint can be a **local detector sidecar** this
framework brings up for you (`--profile svd`), or any **hosted / self-hosted SVD
endpoint** you already run (including NVIDIA's hosted dev endpoint).

> **Licensing.** The SVD model is distributed through NVIDIA NGC / NVIDIA AI
> Enterprise and is access-gated; the Wowza ⇄ NVIDIA partnership is what clears
> that entitlement. You authenticate to NVIDIA with your own key. Wowza does not
> redistribute the model image or weights.

---

## Quick start

Prerequisites: a working framework checkout with `.env` populated (licenses,
admin credentials — see [README](../README.md)), an NVIDIA GPU from the
[supported matrix](#gpu-support-matrix) with current drivers, and the [NVIDIA
Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

**1. Authenticate to NVIDIA and set your key** (one time):

```bash
docker login nvcr.io      # username: $oauthtoken   password: <your NGC API key>
```

In `.env`:

```bash
NGC_API_KEY=<your NGC API key>
# Optional, on a multi-GPU host, give the detector its own card:
SVD_GPU_IDS=1
```

**2. Start the stack with the synthetic detector sidecar:**

```bash
docker compose --profile default --profile svd up -d
```

The first boot downloads the GPU-specific model into a local cache (reused on
every later boot). Wait for `svd` to report healthy:

```bash
docker compose --profile svd ps
docker compose --profile svd logs -f svd
```

**3. Publish a stream and point it at the detector.** From the Engine Manager
Video Intelligence configuration (`http://localhost:8088`), add a stream whose
**Detector Type** is `synthetic` and whose **Endpoint** is the in-network
sidecar `svd.docker:8001`. Then publish to it:

```bash
ffmpeg -re -stream_loop -1 -i your-clip.mp4 -c copy -f flv rtmp://localhost:1935/live/synthetic-demo
```

**4. Watch the results.** Each analysis window produces one verdict, surfaced
through the standard event listeners — the log file, ID3 timed-metadata tags in
the stream, webhooks, and a video overlay that burns the verdict into an
overlay rendition:

```bash
tail -f wse/logs/wowzastreamingengine_vi.log
```

---

## What to expect

You don't have to manage any of the underlying infrastructure. Point a stream at an endpoint
and verdicts start flowing. Three things are worth knowing:

- **Your video quality is untouched.** The detector analyzes a copy of your
  source video; it does **not** re-encode your stream, so the bitrate, resolution,
  and image quality your viewers receive are exactly what you published.
- **A verdict trails real time by about one window.** A window has to be fully
  captured and analyzed before a verdict can exist, so each result lands roughly
  one `duration` behind live. Shorter windows shrink that lag but never remove
  it. You can further shorten the window by transcoding your source upstream to a
  smaller GOP size.
- **The GPU requirement is on the detector, not on your engine.** Only the
  machine hosting the SVD model needs the supported GPU hardware below — you can
  run the rest of the Wowza VIF stack on a different machine if needed.

### H.264 requirement

The detector requires an **H.264** source. A non-H.264 source surfaces a clear
error on the stream rather than being silently transcoded. If your source is
another codec, normalize it to H.264 **upstream** (a separate Wowza
source/transcode application) and feed the H.264 result into the Video
Intelligence application.

### A note on window length

A window opens on a keyframe and closes at the first keyframe at or after
`duration` seconds, so the realized window rounds **up to your next keyframe**.
If your encoder's keyframe interval (GOP) is longer than `duration`, your
windows — and therefore your verdict cadence — will be as long as the GOP. For
the cadence you configure to hold, set `duration` to at least your source
keyframe interval. As mentioned above, if you require more frequent detection
than your source stream GOP allows you can transcode your source upstream - on
a different Wowza Streaming Engine application - targeting a smaller GOP size.

---

## GPU support matrix

The SVD model decodes video on the GPU and requires **NVDEC/NVENC hardware plus
Tensor cores**. That hardware decode requirement **excludes the datacenter
training GPUs that ship without NVENC/NVDEC**:

| Supported (NVENC/NVDEC + Tensor cores) | **Not supported** |
| --- | --- |
| T4, A10, A16, A40 | **A100** |
| L4, L40 / L40S | **H100 / H200** |
| RTX 4090, RTX 5090 | **B100 / B200** |
| RTX PRO 6000 Blackwell | (no NVENC/NVDEC) |

> This is a property of the **detector host's** GPU. Nothing else in your Wowza
> deployment adds an encode/decode GPU requirement for this feature.

---

## Deployment option A — local detector sidecar (`--profile svd`)

This is the [Quick start](#quick-start) above. The sidecar comes up on the
internal compose network as `svd.docker:8001`, and no host port is published by
default. Configure your synthetic stream with:

| Setting | Value | Meaning |
| --- | --- | --- |
| Detector Type | `synthetic` | Enables the synthetic detector |
| Endpoint | `svd.docker:8001` | The in-network sidecar (host:port) |
| Classification Threshold | `0.3` | A probability above this is labeled `"synthetic"` |
| Duration | `2.0` | Window length in seconds |

To reach the detector from a Video Intelligence Service running on **another
machine**, uncomment the `ports:` block on the `svd` service in
`docker-compose.yaml` and use that machine's address as the endpoint.

---

## Deployment option B — hosted / bring-your-own endpoint

If you already run an SVD endpoint (self-hosted elsewhere, or NVIDIA's hosted
dev endpoint), **don't** enable the `svd` profile — just point the stream's
configuration at it:

| Setting | Value | Meaning |
| --- | --- | --- |
| Endpoint | `grpc.nvcf.nvidia.com:443` | The hosted endpoint (host:port) |
| API Key | `<your key>` | Sent to authenticate the request |
| Function ID | `<function id>` | Required by NVIDIA's hosted endpoint |
| Classification Threshold | `0.3` | A probability above this is labeled `"synthetic"` |
| Duration | `2.0` | Window length in seconds |

- **Transport security is automatic.** A `:443` endpoint (hosted, public-cert
  services) uses TLS; any other port (your in-network sidecar) stays plaintext.
  Set `Use TLS` explicitly when the port heuristic is wrong, add a CA
  certificate for a private CA, and provide a client certificate + key for
  mutual TLS.
- **API Key and Function ID** are only needed by endpoints that require them
  (NVIDIA's hosted endpoint does; a bare self-hosted endpoint does not).
- NVIDIA's hosted **Try API** has a per-request size cap and is a dev
  convenience, not a production target.

---

## Configuration reference

These settings live on the synthetic stream — globally for defaults, per stream
to override. Set them from the Manager UI or your stream configuration.

| Field | Default | Meaning |
| --- | --- | --- |
| `endpoint` | — (required) | The SVD endpoint as `host:port` (not an http URL) |
| `duration` | `2.0` | Analysis window length in seconds (see [window length](#a-note-on-window-length)) |
| `classification_threshold` | `0.3` | Probability strictly above this ⇒ verdict `"synthetic"` |
| `use_tls` | auto | Force TLS on/off; omit to auto-detect from the port |
| `api_key` | none | Bearer token for the endpoint; omit for a bare self-hosted detector |
| `function_id` | none | Required by NVIDIA's hosted endpoint; omit otherwise |
| `tls_ca_cert` | none | CA certificate for a private-CA endpoint |
| `tls_client_cert` / `tls_client_key` | none | Client certificate + key for mutual TLS (set both) |
| `request_timeout_seconds` | `60.0` | Per-window request timeout |
| `max_concurrent_requests` | `16` | Cap on in-flight requests to this endpoint |
| `include_per_clip_scores` | `false` | Attach the full frame-level score breakdown to each result (forensic drill-down; verbose) |

---

## What you receive

Each window produces one result:

| Field | Meaning |
| --- | --- |
| `verdict` | `"synthetic"`, `"real"`, or `"unknown"` (endpoint unreachable) |
| `synthetic_probability` | `0.0–1.0`; strictly above `classification_threshold` ⇒ `"synthetic"` |
| `synthetic_logit` | the underlying model score the probability is derived from |
| `total_clips` | how many frame-level scores the model produced for the window |
| `per_clip_scores[]` | the full frame-level score breakdown — included only when `include_per_clip_scores` is `true` |

The verdict appears wherever your event listeners deliver results: the log file,
ID3 timed-metadata tags embedded in the stream, webhooks, and as a text overlay
burned into the overlay video rendition.

`verdict: "unknown"` (with a zeroed probability) is emitted when the endpoint is
unreachable, so a slow or down detector **degrades gracefully** — your stream
keeps running and verdicts resume automatically once the endpoint is back.

### Choosing a threshold

The default `0.3` is intentionally conservative: it minimizes missed synthetics,
at the cost of flagging some genuine footage. Use `0.5` for a balanced trade-off
where false positives and false negatives matter equally. Tune to your own
tolerance and review policy.

---

## Air-gapped deployment

The synthetic detector runs **fully offline at inference time** — no telemetry
and no license phone-home while streaming. The only network step is the
**one-time model download** on first boot. To run with no runtime internet:

1. On a machine **with** NGC access, pull the image and pre-seed the model cache
   (run the sidecar once so it populates the cache).
2. Copy the image (`docker save` / `docker load`) and the populated cache
   directory to the air-gapped host.
3. Keep `NGC_API_KEY` set (it is validated against the **local** cache) and
   start with `--profile svd`. With the cache present, the detector serves the
   cached model with **no download and no outbound connection**.

Pin `SVD_NIM_MANIFEST_PROFILE` to the target GPU's profile id (table below) so
the pre-seed matches the air-gapped hardware exactly.

### Manifest profiles (per GPU architecture)

The sidecar auto-selects the right model profile for the detected GPU. To pin it
(useful for air-gapped pre-seeding), set `SVD_NIM_MANIFEST_PROFILE` in `.env`:

| Architecture | Compute cap | Manifest profile id |
| --- | --- | --- |
| Blackwell | 12.0 | `3ce493f31eb1718ca928ae45a6995fc585f7571065106db509e7fce4b6f6d3aa` |
| Ada (L4/L40/RTX 4090) | 8.9 | `6abf19cf36a0d5498b77c466780ac80c8224e641457f4f33a7df694810e2d746` |
| Ampere (A10/A16/A40) | 8.6 | `15d466e43b11fa523e0662603f09bce6e5c7fc92fba33ea5c6122b98ec546bd8` |
| Turing (T4) | 7.5 | `ae4879839cd92b9ca86791d2455b3ce72261f485f00a89e2056e11c3e69d4bc3` |

(Confirm the current ids against the model's own
[release notes](https://docs.nvidia.com/nim/maxine/synthetic-video-detector) —
they can change per model version.)

---

## Compliance note (EU AI Act Article 50)

Article 50 of the EU AI Act (transparency obligations for AI-generated /
manipulated content, applicable **2026-08-02**) is a driver for this feature:
operators can use the synthetic verdict to label or gate AI-generated video. The
detector is a **decision-support signal, not a legal determination** — tune the
threshold and your human-review policy to your obligations.

---

## See also

- [`README.md`](../README.md) — framework quick start and configuration.
- [`VLM_GUIDE.md`](VLM_GUIDE.md) — the VLM sidecar this profile mirrors.
- NVIDIA SVD model docs: <https://docs.nvidia.com/nim/maxine/synthetic-video-detector>
- Try the API: <https://build.nvidia.com/nvidia/synthetic-video-detector>
