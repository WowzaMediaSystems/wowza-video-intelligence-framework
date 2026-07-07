# Synthetic Video Detector (Deepfake) Guide

The Video Intelligence framework can flag **synthetic / AI-generated (deepfake)
video** on a live stream. A new detector type, `detector_type: "synthetic"`,
sends each short window of the source video to the **NVIDIA Maxine Synthetic
Video Detector (SVD) NIM** and returns a per-window **Real vs Fake** verdict
with a probability and a per-clip score breakdown.

It is **opt-in** and **bring-your-own endpoint**: nothing about the synthetic
detector runs unless a stream is explicitly configured for it and pointed at a
reachable SVD endpoint. The endpoint can be a **local NIM sidecar** this
framework brings up for you (`--profile svd`), or any **hosted / self-hosted SVD
endpoint** you already run (including NVIDIA's hosted NVCF dev endpoint).

> **Partnership / licensing.** The SVD NIM is distributed through NVIDIA NGC /
> NVIDIA AI Enterprise and is access-gated; the Wowza ⇄ NVIDIA VI-550
> partnership is what clears that entitlement. You authenticate to NGC with your
> own key. Wowza does not redistribute the NIM image or weights.

---

## How it works (and the one latency caveat)

```
WSE source H.264 ──▶ VIC taps the source packets, remuxes a `duration`-second
                     window into a short CFR MP4  (NO re-encode — stream copy)
                  ──▶ VIS relays the MP4 to the SVD NIM over bidirectional gRPC
                  ──▶ NIM returns per-clip logits + an aggregate verdict
                  ──▶ VIS emits a `synthetic_analysis` result back to WSE
```

- **No transcode, no re-encode, anywhere in Wowza's code.** VIC stream-copies
  the existing H.264 NAL units into an MP4 container and only rewrites timing to
  make it constant-frame-rate. The bitstream the NIM analyzes is the original
  one. VIS never encodes or decodes — it is a pure gRPC relay.
- **The detector is GPU-side in the NIM.** VIS needs no GPU for this feature;
  the GPU requirement lives entirely on the NIM (see the matrix below).
- **Inherent latency.** A verdict cannot exist until a whole window has been
  captured, muxed, uploaded, decoded and inferred, so the result is always **≥
  one `duration` window behind real time**. Shorter windows shrink the floor but
  never remove it. This is expected, not a bug.

### H.264-only

The detector requires an **H.264** source. Non-H.264 streams (HEVC/AV1/VP9) are
**out of scope**: VIC detects a non-H.264 source and surfaces a clear error
rather than transcoding. If your source is another codec, normalize it to H.264
**upstream** (a separate WSE source/transcode application) and feed the H.264
result into the VIF application.

---

## GPU support matrix

The SVD NIM decodes video on the GPU and requires **NVDEC/NVENC hardware plus
Tensor cores**. That hardware decode requirement **excludes the datacenter
training GPUs that ship without NVENC/NVDEC**:

| Supported (NVENC/NVDEC + Tensor cores) | **Not supported** |
| --- | --- |
| T4, A10, A16, A40 | **A100** |
| L4, L40 / L40S | **H100 / H200** |
| RTX 4090, RTX 5090 | **B100 / B200** |
| RTX PRO 6000 Blackwell | (no NVENC/NVDEC) |

> This is a property of the **NIM's** GPU, not of WSE or VIS. WSE's remux is a
> stream-copy and VIS is a pure relay — neither adds an encode/decode GPU
> requirement.

### Manifest profiles (per GPU architecture)

The NIM auto-selects the right model profile for the detected GPU. To pin it
(useful for air-gapped pre-seeding), set `NIM_MANIFEST_PROFILE` in `.env` —
leave it commented out otherwise, as an empty-but-set value disables
auto-selection and the NIM won't start:

| Architecture | Compute cap | Manifest profile id |
| --- | --- | --- |
| Blackwell | 12.0 | `3ce493f31eb1718ca928ae45a6995fc585f7571065106db509e7fce4b6f6d3aa` |
| Ada (L4/L40/RTX 4090) | 8.9 | `6abf19cf36a0d5498b77c466780ac80c8224e641457f4f33a7df694810e2d746` |
| Ampere (A10/A16/A40) | 8.6 | `15d466e43b11fa523e0662603f09bce6e5c7fc92fba33ea5c6122b98ec546bd8` |
| Turing (T4) | 7.5 | `ae4879839cd92b9ca86791d2455b3ce72261f485f00a89e2056e11c3e69d4bc3` |

(Confirm the current ids against the NIM's own
`docs.nvidia.com/nim/maxine/synthetic-video-detector` release notes — they can
change per NIM version.)

---

## Deployment option A — local NIM sidecar (`--profile svd`)

Prerequisites: a working framework checkout with `.env` populated, an NVIDIA GPU
from the supported matrix with current drivers, and the [NVIDIA Container
Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

**1. Authenticate to NGC and set your key** (one time):

```bash
docker login nvcr.io      # username: $oauthtoken   password: <your NGC API key>
```

In `.env`:

```bash
NGC_API_KEY=<your NGC API key>
# Optional, on a multi-GPU host, give the NIM its own card:
SVD_GPU_IDS=1
```

**2. Start the stack with the SVD sidecar:**

```bash
docker compose --profile default --profile svd up -d
```

The first boot downloads the GPU-specific model profile into the
`svd-nim-cache` Docker volume and reuses it on every later boot (the volume
survives `docker compose down`; only `down -v` removes it). Wait for `svd` to
report healthy:

```bash
docker compose --profile svd ps
docker compose --profile svd logs -f svd
```

> **Why a Docker volume plus a chown step?** The NIM runs as a non-root user
> (uid 1000, `triton-server`) and its image doesn't pre-create
> `/opt/nim/.cache`, so a fresh cache mount is created **root-owned** and the
> NIM can't write it (`Permission denied: '/opt/nim/.cache/…'`) and won't
> start — this is true for a `./vis` bind mount **and** for a named volume.
> The stack handles it automatically: a one-shot `svd-cache-init` service
> chowns the `svd-nim-cache` volume to the NIM's uid before the NIM boots, so
> the NIM itself stays non-root. This is the one place the SVD sidecar needs
> setup the VLM sidecar (which runs as root) doesn't.

**3. Point a stream at it.** In `wse/conf/video-intelligence.json` (or the
Manager UI), configure a synthetic stream whose endpoint is the in-network
sidecar:

```jsonc
{
  "detector_type": "synthetic",
  "endpoint": "svd.docker:8001",   // gRPC host:port — the sidecar
  "ssl_mode": "disabled",          // in-network, no TLS needed
  "classification_threshold": 0.3, // > this probability ⇒ "synthetic"
  "duration": 2.0                  // window length in seconds
}
```

VIS connects to `svd.docker:8001` on the compose network — no host port is
published by default. To reach the NIM from a VIS running on **another machine**,
uncomment the `ports:` block on the `svd` service in `docker-compose.yaml`.

---

## Deployment option B — hosted / bring-your-own endpoint

If you already run an SVD endpoint (self-hosted elsewhere, or NVIDIA's hosted
NVCF dev endpoint), **don't** enable the `svd` profile — just point the stream's
config at it:

```jsonc
{
  "detector_type": "synthetic",
  "endpoint": "grpc.nvcf.nvidia.com:443", // example: NVCF hosted dev endpoint
  "ssl_mode": "tls",
  "api_key": "<NGC / NVCF key>",          // sent as: authorization: Bearer <key>
  "function_id": "<SVD function id>",      // sent as: function-id metadata
  "classification_threshold": 0.3,
  "duration": 2.0
}
```

- `ssl_mode`: `disabled` | `tls` | `mtls`. For `tls`/`mtls`, also set
  `tls_ca_cert` (and `tls_client_cert` / `tls_client_key` for mTLS).
- `api_key` + `function_id` are only needed by endpoints that require them
  (NVCF does; a bare self-hosted NIM with `ssl_mode: disabled` does not).
- The NVCF Try API has a 500 MB per-request cap and is a dev convenience, not a
  production target.

---

## Air-gapped deployment

The SVD NIM runs **fully offline at inference time** — no telemetry and no
license phone-home during streaming. The only network step is the **one-time
model download** on first boot, which lands in the `svd-nim-cache` Docker
volume (see Deployment option A above for why the cache is a volume, not a
`./vis` folder). Pre-seeding therefore means populating that volume on the
air-gapped host:

1. **On a machine with NGC access**, pull the image and populate the cache by
   running the sidecar once (`docker compose --profile svd up -d svd`, then wait
   for it to report healthy). Export the image and the populated volume:
   ```bash
   docker save nvcr.io/nim/nvidia/synthetic-video-detector:latest -o svd-nim-image.tar
   docker run --rm -v svd-nim-cache:/cache -v "$PWD":/out busybox \
     tar czf /out/svd-nim-cache.tgz -C /cache .
   ```
2. **Copy** `svd-nim-image.tar` and `svd-nim-cache.tgz` to the air-gapped host,
   load the image, and restore the volume **before** the first `--profile svd`
   start:
   ```bash
   docker load -i svd-nim-image.tar
   docker volume create svd-nim-cache
   docker run --rm -v svd-nim-cache:/cache -v "$PWD":/in busybox \
     tar xzf /in/svd-nim-cache.tgz -C /cache
   ```
3. Keep `NGC_API_KEY` set (the NIM still validates it against the **local**
   cache) and start with `--profile svd`. With the volume pre-populated, the NIM
   serves the cached profile with **no download and no outbound connection**.

Pin `NIM_MANIFEST_PROFILE` to the target GPU's profile id (table above) so the
pre-seed matches the air-gapped hardware exactly.

---

## What you receive

Each window produces one `synthetic_analysis` result:

| Field | Meaning |
| --- | --- |
| `verdict` | `"synthetic"`, `"real"`, or `"unknown"` (endpoint unreachable) |
| `synthetic_probability` | `0.0–1.0`; `> classification_threshold` ⇒ `"synthetic"` |
| `synthetic_logit` | mean per-clip logit (pre-sigmoid) |
| `total_clips` | number of clips the NIM scored in the window |
| `per_clip_scores[]` | `{frame_index, frame_id, logit, probability}` per clip |

`verdict: "unknown"` (with zeroed probability/logit) is emitted when the
endpoint is unreachable, so a slow or down NIM **degrades** the stream instead
of stalling it — the same fire-and-forget posture as the VLM sidecar.

### Choosing a threshold

The NIM default `0.3` is intentionally conservative (minimizes missed
synthetics, at the cost of some real footage being flagged). Use `0.5` for a
balanced trade-off where false positives and false negatives matter equally.

---

## Compliance note (EU AI Act Article 50)

Article 50 of the EU AI Act (transparency obligations for AI-generated/
manipulated content, applicable **2026-08-02**) is a driver for this feature:
operators can use the synthetic verdict to label or gate AI-generated video.
The detector is a **decision-support signal**, not a legal determination —
tune the threshold and human-review policy to your obligations.

---

## See also

- [`README.md`](../README.md) — framework quick start and configuration.
- [`VLM_GUIDE.md`](VLM_GUIDE.md) — the VLM sidecar this profile mirrors.
- NVIDIA SVD NIM docs: `https://docs.nvidia.com/nim/maxine/synthetic-video-detector`
- Try the API: `https://build.nvidia.com/nvidia/synthetic-video-detector`
