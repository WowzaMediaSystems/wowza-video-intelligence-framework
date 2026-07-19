# Synthetic Video Detector Guide

The Video Intelligence framework can flag **synthetic / AI-generated video**
on a live stream, backed by the **NVIDIA Maxine Synthetic Video Detector (SVD)** model.
With `detector_type: "synthetic"`, the framework watches your stream in short windows 
and returns a per-window **Real vs Fake** verdict, based on a configurable threshold


It is **opt-in** and **bring-your-own endpoint**: nothing about the synthetic
detector runs unless a stream is explicitly configured for it and pointed at a
reachable SVD endpoint. That endpoint can be a **local detector sidecar** this
framework brings up for you (`--profile svd`), or any **hosted / self-hosted SVD
endpoint** you already run (including NVIDIA's hosted dev endpoint - for evaluation purposes only).

> **Licensing.** The SVD model is distributed through NVIDIA NGC / NVIDIA AI
> Enterprise and is access-gated. You authenticate to NVIDIA with your own key. 
> Wowza does not redistribute the model image or weights. To get a key, join
> NVIDIA's AI for Media Private Access Program and generate an NGC API key
> with at least the **NGC Catalog** permission — NVIDIA's [Generate an API
> Key](https://docs.nvidia.com/nim/maxine/synthetic-video-detector/latest/getting-started.html#generate-an-api-key)
> walks through it.

## Table of Contents

- [Quick start](#quick-start)
- [What to expect](#what-to-expect)
- [GPU support matrix](#gpu-support-matrix)
- [Deployment option A — local detector sidecar](#deployment-option-a--local-detector-sidecar---profile-svd)
- [Deployment option B — hosted / bring-your-own endpoint](#deployment-option-b--hosted--bring-your-own-endpoint)
- [Deployment topologies](#deployment-topologies)
- [Configuration reference](#configuration-reference)
- [What you receive](#what-you-receive)
- [Air-gapped deployment](#air-gapped-deployment)
- [Compliance note (EU AI Act Article 50)](#compliance-note-eu-ai-act-article-50)
- [See also](#see-also)

---

## Quick start

Prerequisites: a working framework checkout with `.env` populated (licenses,
admin credentials — see [README](../README.md)), an NVIDIA GPU from the
[supported matrix](#gpu-support-matrix) with current drivers, and the [NVIDIA
Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

**1. Authenticate to NVIDIA and set your key** (one time; no key yet? — see
[how to get one](https://docs.nvidia.com/nim/maxine/synthetic-video-detector/latest/getting-started.html#generate-an-api-key)):

```bash
docker login nvcr.io      # username: $oauthtoken   password: <your NGC API key>
```

In `.env`:

```bash
NGC_API_KEY=<your NGC API key>
```

Optional, on a multi-GPU host: give the detector its own card by editing the
`svd` service's device reservation in `docker-compose.yaml` — replace
`count: all` with e.g. `device_ids: ["1"]` (indices match `nvidia-smi`).

**2. Start the stack with the synthetic detector sidecar:**

```bash
docker compose --profile default --profile svd up -d
```

The first boot downloads the GPU-specific model into the `svd-nim-cache` Docker
volume and reuses it on every later boot (the volume survives `docker compose
down`; only `down -v` removes it). Wait for `svd` to report healthy:

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
  and image quality your viewers receive are exactly what you published. (The one
  exception is opting into the verdict overlay, which adds a *separate* transcoded
  rendition and leaves your source rendition untouched — see
  [Overlays](#overlays-require-transcoding).)
- **A verdict trails real time by about one window.** A window has to be fully
  captured and analyzed before a verdict can exist, so each result lands roughly
  one `duration` behind live. Shorter windows shrink that lag but never remove
  it. You can shorten the window by giving the source a smaller GOP — ideally set
  at the source encoder, but transcoding is an alternative as well (see
  [Transcoding and detection accuracy](#transcoding-and-detection-accuracy)).
- **The GPU requirement is on the detector, not on your engine.** Only the
  machine hosting the SVD model needs the supported GPU hardware below — you can
  run the rest of the Wowza VIF stack on a different machine if needed.

### H.264 requirement

The detector requires an **H.264** source. A non-H.264 source surfaces a clear
error on the stream rather than being silently transcoded. If your source is
another codec, convert it to H.264 in a separate application and feed the result
into the Video Intelligence application — see
[Feeding the detector a normalized stream](#feeding-the-detector-a-normalized-stream-separate-application),
and mind the encoding rule in
[Transcoding and detection accuracy](#transcoding-and-detection-accuracy).

### A note on window length

A window opens on a keyframe and closes at the first keyframe at or after
`duration` seconds, so the realized window rounds **up to your next keyframe**.
If your encoder's keyframe interval (GOP) is longer than `duration`, your
windows — and therefore your verdict cadence — will be as long as the GOP. For
the cadence you configure to hold, set `duration` to at least your source
keyframe interval. If you need a shorter cadence than your source GOP allows, the
clean fix is a smaller keyframe interval on the source encoder (then stream-copy
downstream); re-encoding purely to shrink the GOP risks accuracy unless done
carefully — see [Transcoding and detection accuracy](#transcoding-and-detection-accuracy).

### Transcoding and detection accuracy

By default the detector analyzes an untouched copy of your source, so its accuracy
is simply whatever your source encoder produced. When you need to normalize the
stream for the detector — convert a non-H.264 source to H.264, or shorten the GOP
for a faster verdict cadence — the **Wowza Streaming Engine Transcoder is the
right tool and your first choice**; you just configure the encode so the re-encode
keeps the signal.

The detector keys on subtle artifacts of AI generation, and a
re-encode loses them in exactly one way: by **not spending enough bits**. The
Transcoder's default rate control is *average* bitrate, which under-spends on
low-motion footage (a talking head, a locked-off camera) and quantizes the
artifacts away — so a genuinely synthetic clip can read `"real"`. Configure the
encode to avoid that:

- **Use constant bitrate (CBR), not the default average/variable bitrate.** This
  is the single most important setting — CBR forces the encoder to actually spend
  the bits, which is what keeps the artifacts intact.
- **Set a high bitrate, and scale it to how far you shrink the GOP.** A shorter
  GOP packs in more keyframes (I-frames), and I-frames cost far more bits — so the
  smaller the new GOP is relative to the source, the higher the bitrate you need
  to hold detail. Start around **1.5–2× your source bitrate** and go higher for
  aggressive GOP reductions. (Lossless preserves the score exactly, if you can
  spare the bandwidth.)
- **Upscale low-resolution sources.** Low-res footage carries little
  high-frequency detail for the model to weigh; upscaling to a higher resolution
  in the same transcode can improve accuracy on low-res inputs — worth trying and
  validating.

If you only need a shorter GOP and you control the source encoder, you can also
skip the re-encode entirely: set the keyframe interval there and stream-copy
downstream (no re-encode, no accuracy cost). Either way, **validate against
representative known-synthetic samples** — the right bitrate depends on your
content and on how much you change the GOP.

Illustrative, from one known-synthetic clip (0.37 on its pristine source, GOP
shortened to 2 s):

| Transcode rate control | Verdict |
| --- | --- |
| CBR at a high bitrate (~1.5–2× source), or lossless | **~0.34–0.39 / 0.37** — preserved |
| average bitrate (the default — under-spends on easy content) | **~0.20 → "real"** |

### Feeding the detector a normalized stream (separate application)

The detector only analyzes the **ingested source** of its application; it ignores
any rendition that the *same* application's transcoder produces. So to run it on a
normalized (H.264 / shorter-GOP) stream, route that stream into a **separate**
Video Intelligence application, where it arrives as a fresh ingest and is analyzed
normally:

- **App A** ingests your source and uses the **Engine Transcoder** to produce the
  normalized H.264 rendition, then pushes it to App B (a Stream Target on App A or
  a MediaCaster on App B).
- **App B** is your Video Intelligence application; a synthetic config whose
  `stream_name` matches the pushed stream taps it.

Its main use is the non-H.264 case from [H.264 requirement](#h264-requirement):
convert HEVC/AV1/VP9 → H.264 in App A, analyze in App B. Accuracy depends on how
App A's transcoder is configured — apply the CBR + high-bitrate rule above; the
routing itself does not affect the verdict.

### If the detector can't keep up

A verdict can't exist until its window has been fully captured and analyzed, so
if your endpoint is slower than the window length — a heavily loaded GPU, a
distant hosted endpoint, or many streams sharing one detector — verdicts can't
be produced as fast as windows are captured.

When that happens the framework keeps verdicts close to live rather than letting
a backlog build: it always analyzes the **most recent** completed window and
**skips the windows that elapsed while it was waiting** for the previous verdict.
It never queues windows up. The consequences are:

- **Latency stays bounded.** Verdicts keep landing roughly one window behind
  live (plus the detector's processing time); they don't fall progressively
  further and further behind, and nothing piles up in memory.
- **Coverage has gaps.** The skipped windows are never analyzed — you get a
  verdict on a recent slice of the stream, not on every consecutive window.

If gap-free coverage matters more than staying close to live, give the detector
enough headroom to finish each window within the window length: a faster or
dedicated GPU, fewer streams per endpoint, or a longer `duration`. Separately,
`request_timeout_seconds` (default 60s) is a backstop for a single window that
hangs — if one request exceeds it, that window is abandoned and reported as
`"unknown"` rather than blocking the stream indefinitely.

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

The table lists the cards NVIDIA validates. Other consumer GeForce RTX cards
that carry NVENC/NVDEC and one of the [listed compute
capabilities](#manifest-profiles-per-gpu-architecture) generally work too — the
detector auto-selects the model profile by compute capability (for example, an
RTX 5070 Ti, compute 12.0, selects the same Blackwell profile as an RTX 5090) —
but validate on your card before relying on it.

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
| Classification Threshold | `0.3` | A score above this is labeled `"synthetic"` |
| Duration | `2.0` | Window length in seconds |

The sidecar can also serve a Video Intelligence Service running on **another
machine** — see [Deployment topologies](#deployment-topologies) for publishing
the port and securing the connection.

---

## Deployment option B — hosted / bring-your-own endpoint

If you already run an SVD endpoint (self-hosted elsewhere, or NVIDIA's hosted
dev endpoint — **for evaluation only, not production**), **don't** enable the
`svd` profile — just point the stream's configuration at it:

| Setting | Value | Meaning |
| --- | --- | --- |
| Endpoint | `grpc.nvcf.nvidia.com:443` | The hosted endpoint (host:port) |
| API Key | `<your key>` | Sent to authenticate the request |
| Function ID | `<function id>` | Required by NVIDIA's hosted endpoint |
| Classification Threshold | `0.3` | A score above this is labeled `"synthetic"` |
| Duration | `2.0` | Window length in seconds |

- **Transport security is automatic.** A `:443` endpoint (hosted, public-cert
  services) uses TLS; any other port (your in-network sidecar) stays plaintext.
  Set `Use TLS` explicitly when the port heuristic is wrong, add a CA
  certificate for a private CA, and provide a client certificate + key for
  mutual TLS.
- **Use a key with invocation scope for NVIDIA's hosted endpoint.** NVIDIA
  issues keys with different scopes, and the key that pulls the sidecar image
  and model from NGC is **not necessarily authorized to invoke** the hosted
  endpoint. If the key is wrong or under-scoped, the stream still runs but
  **every verdict comes back `"unknown"`**, and the Video Intelligence Service
  log shows `PERMISSION_DENIED: Authorization failed` for each window. Generate
  an invocation-scoped key (for example from
  [build.nvidia.com](https://build.nvidia.com/nvidia/synthetic-video-detector))
  and use that as the API Key.
- **API Key and Function ID** exist for NVIDIA's hosted endpoint only — and
  that endpoint is for **evaluation, not production**. A self-hosted detector
  ignores them entirely; to control who can use it, use
  [mTLS](#securing-the-connection-mtls) instead.
- NVIDIA's hosted **Try API** has a per-request size cap and is a dev
  convenience, not a production target.

---

## Deployment topologies

The detector sidecar and the Video Intelligence Service that queries it don't
have to share a machine — a common split puts the sidecar alone on a GPU host
from the [support matrix](#gpu-support-matrix) and the rest of the stack
elsewhere.

### Same host (the default)

Everything as in the [Quick start](#quick-start): the sidecar and the service
share the internal compose network, the endpoint is `svd.docker:8001`, and
**no host port is published** — the detector is unreachable from outside the
machine, so there is nothing extra to secure.

### Remote detector host

To serve a Video Intelligence Service on another machine, publish the gRPC
port — uncomment the `ports:` block on the `svd` service in
`docker-compose.yaml` on the detector host — and use `<detector-host>:8001`
as the stream's endpoint.

A published port accepts connections from the network, and it speaks
**plaintext gRPC by default**: the video crosses the network unencrypted, and
anyone who can reach the port can submit video for analysis (a self-hosted
detector does not check API keys — only NVIDIA's hosted endpoint does).
Restrict who can reach the port (firewall / security group) and secure the
connection with [mTLS](#securing-the-connection-mtls).

### Securing the connection (mTLS)

The detector terminates TLS natively, in two modes: **TLS** encrypts the
traffic and proves the detector's identity to streams; **mutual TLS (mTLS)**
additionally authenticates every client — only holders of a client
certificate signed by your CA can use the detector. A self-hosted detector
does not check API keys, so **mTLS is the only built-in way to control who
can use a published endpoint** — prefer it unless something else (network
isolation, a fronting proxy) already restricts access.

**1. Generate the certificates.** Any PKI works — if your organization runs
one, request the certificates there. For a self-contained setup, with
OpenSSL:

```bash
# One-time CA -- signs everything; keep ca-key.pem offline and safe
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout ca-key.pem -out ca-cert.pem -subj "/CN=my-vif-ca"

# Server certificate -- CN/SAN must match the hostname streams dial
# (the <detector-host> in the stream's endpoint)
openssl req -newkey rsa:2048 -nodes \
  -keyout server-key.pem -out server.csr -subj "/CN=<detector-host>"
openssl x509 -req -in server.csr -sha256 -days 825 \
  -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -extfile <(printf "subjectAltName=DNS:<detector-host>") \
  -out server-cert.pem

# Client certificate -- one per Video Intelligence Service allowed in
openssl req -newkey rsa:2048 -nodes \
  -keyout client-key.pem -out client.csr -subj "/CN=vis-client"
openssl x509 -req -in client.csr -sha256 -days 825 \
  -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -out client-cert.pem
```

**2. Configure the detector host.** Place `server-cert.pem`,
`server-key.pem`, and `ca-cert.pem` in `./certs/`, readable by the container
(the detector runs as a non-root user — `chmod 644` the files). Uncomment
the `./certs` mount on the `svd` service in `docker-compose.yaml`, and set
in `.env`:

```bash
NIM_SSL_MODE=mtls
NIM_SSL_CERT_PATH=/certs/server-cert.pem
NIM_SSL_KEY_PATH=/certs/server-key.pem
NIM_SSL_CA_CERTS_PATH=/certs/ca-cert.pem
```

(For encryption-only TLS without client authentication, set
`NIM_SSL_MODE=tls` and omit `NIM_SSL_CA_CERTS_PATH`.)

Recreate the sidecar: `docker compose --profile svd up -d svd`.

TLS covers the gRPC endpoint (`8001`). The HTTP health/metrics port (`8000`)
stays plaintext — the bundled container healthcheck keeps working unchanged —
so if you publish `8000` at all, treat it as unencrypted.

**3. Configure the streams.** In the Manager UI's synthetic stream
configuration, set **Transport Security (TLS)** to *Force TLS* (automatic
transport detection assumes plaintext on non-`443` ports, so it must be set
explicitly for `<detector-host>:8001`), then enter the certificate paths
under the collapsible **TLS Certificates** group:

- **CA Certificate Path** — the CA certificate (`ca-cert.pem`); required
  whenever the server certificate is not from a public CA.
- **Client Certificate Path** + **Client Key Path** — the client
  certificate pair (mTLS; set both).

Equivalently, in the stream configuration JSON:

```json
"synthetic_analysis": {
  "endpoint": "<detector-host>:8001",
  "use_tls": true,
  "tls_ca_cert": "/certs/ca-cert.pem",
  "tls_client_cert": "/certs/client-cert.pem",
  "tls_client_key": "/certs/client-key.pem"
}
```

The three certificate properties are **file paths readable by the Video
Intelligence Service**, preferably stored in the mounted `./certs/` folder.
Drop the files in `./certs/` on the machine where VIS runs, uncomment the
`./certs` mount on the `video-intelligence-service-gpu` service, and use
`/certs/<file>.pem` as shown.

---

## Configuration reference

These settings live on the synthetic stream — globally for defaults, per stream
to override. Set them from the Manager UI or your stream configuration.

| Field | Default | Meaning |
| --- | --- | --- |
| `endpoint` | — (required) | The SVD endpoint as `host:port` (not an http URL) |
| `duration` | `2.0` | Analysis window length in seconds (see [window length](#a-note-on-window-length)) |
| `classification_threshold` | `0.3` | Scores strictly above this ⇒ verdict `"synthetic"` |
| `use_tls` | auto | Force TLS on/off; omit to auto-detect from the port |
| `api_key` | none | Only for NVIDIA's hosted evaluation endpoint; a self-hosted detector ignores it |
| `function_id` | none | Only for NVIDIA's hosted evaluation endpoint; omit otherwise |
| `tls_ca_cert` | none | CA certificate for a private-CA endpoint |
| `tls_client_cert` / `tls_client_key` | none | Client certificate + key for mutual TLS (set both) |
| `request_timeout_seconds` | `60.0` | Per-window request timeout |
| `max_concurrent_requests` | `16` | Cap on in-flight requests to this endpoint |
| `include_per_clip_scores` | `false` | Attach the full frame-level score breakdown to each result (forensic drill-down; verbose) |
| `use_transcoder` | `false` | Synthetic relays without transcoding by default, so the verdict **overlay is unavailable** (log / ID3 / webhook listeners still deliver it). Set `true` to transcode an overlay rendition with the verdict burned in — see [Overlays](#overlays-require-transcoding) |

---

## What you receive

Each window produces one result:

| Field | Meaning |
| --- | --- |
| `verdict` | `"synthetic"`, `"real"`, or `"unknown"` (no verdict — endpoint unreachable or rejecting requests) |
| `synthetic_score` | `0.0–1.0`; strictly above `classification_threshold` ⇒ `"synthetic"` |
| `synthetic_logit` | the underlying model output the score is derived from |
| `total_clips` | how many frame-level scores the model produced for the window |
| `per_clip_scores[]` | the full frame-level score breakdown — included only when `include_per_clip_scores` is `true` |

The verdict appears wherever your event listeners deliver results: the log file,
ID3 timed-metadata tags embedded in the stream, webhooks, and — when transcoding
is enabled (see below) — as a text overlay burned into a separate overlay video
rendition.

### Overlays require transcoding

> **The verdict overlay is off by default.** Burning the verdict into the picture
> — the overlay rendition you play back over HLS, and the overlay on the stream
> thumbnail — requires re-encoding, which the default synthetic configuration does
> **not** do: it relays the source without transcoding. So out of the box the
> log / ID3 / webhook listeners carry the verdict, but the **overlay does not
> appear on playback or the thumbnail** (the thumbnail shows the source video with
> no overlay). To turn it on, set `use_transcoder: true` on the stream. The engine
> then produces a separate overlay rendition with the verdict burned in — your
> source rendition stays untouched — at the cost of transcoding that one extra
> rendition.

`verdict: "unknown"` (with a zeroed score) is emitted when the endpoint is
unreachable — or reachable but rejecting requests, for example on an invalid or
under-scoped API key (see [Deployment option
B](#deployment-option-b--hosted--bring-your-own-endpoint)) — so a slow, down, or
misconfigured detector **degrades gracefully**: your stream keeps running and
verdicts resume automatically once the endpoint accepts requests again.

### Choosing a threshold

The default `0.3` is intentionally conservative: it minimizes missed synthetics,
at the cost of flagging some genuine footage. Use `0.5` for a balanced trade-off
where false positives and false negatives matter equally. Tune to your own
tolerance and review policy.

---

## Air-gapped deployment

The synthetic detector runs **fully offline at inference time** — no telemetry
and no license phone-home while streaming. The only network step is the
**one-time model download** on first boot, which lands in the `svd-nim-cache`
Docker volume (see [Deployment option
A](#deployment-option-a--local-detector-sidecar---profile-svd) for why the cache
is a volume). Pre-seeding therefore means populating that volume on the
air-gapped host:

1. **On a machine with NGC access**, pull the image and populate the cache by
   running the sidecar once (`docker compose --profile svd up -d svd`, then wait
   for it to report healthy). Export the image and the populated volume (the
   image tar is **~36 GB** — plan transfer media accordingly; the cache is well
   under 1 GB):
   ```bash
   docker save nvcr.io/nim/nvidia/synthetic-video-detector:latest -o svd-nim-image.tar
   docker run --rm --user 0:0 --entrypoint tar \
     -v svd-nim-cache:/cache -v "$PWD":/out \
     nvcr.io/nim/nvidia/synthetic-video-detector:latest \
     czf /out/svd-nim-cache.tgz -C /cache .
   ```
2. **Copy** `svd-nim-image.tar` and `svd-nim-cache.tgz` to the air-gapped host,
   load the image, and restore the volume **before** the first `--profile svd`
   start:
   ```bash
   docker load -i svd-nim-image.tar
   docker volume create svd-nim-cache
   docker run --rm --user 0:0 --entrypoint tar \
     -v svd-nim-cache:/cache -v "$PWD":/in \
     nvcr.io/nim/nvidia/synthetic-video-detector:latest \
     xzf /in/svd-nim-cache.tgz -C /cache
   ```
   The tar helper runs inside the detector image itself (just loaded on the
   line above), so nothing beyond the two files needs to reach the air-gapped
   host.
3. Keep `NGC_API_KEY` set (it is validated against the **local** cache) and
   start with `--profile svd`. With the volume pre-populated, the detector
   serves the cached model with **no download and no outbound connection**.

Pin `NIM_MANIFEST_PROFILE` to the target GPU's profile id (table below) so the
pre-seed matches the air-gapped hardware exactly.

### Manifest profiles (per GPU architecture)

The sidecar auto-selects the right model profile for the detected GPU. To pin it
(useful for air-gapped pre-seeding), set `NIM_MANIFEST_PROFILE` in `.env` —
leave it commented out otherwise, as an empty-but-set value disables
auto-selection and the detector won't start:

| Architecture | Compute cap | Manifest profile id |
| --- | --- | --- |
| Blackwell | 12.0 | `3ce493f31eb1718ca928ae45a6995fc585f7571065106db509e7fce4b6f6d3aa` |
| Ada (L4/L40/RTX 4090) | 8.9 | `6abf19cf36a0d5498b77c466780ac80c8224e641457f4f33a7df694810e2d746` |
| Ampere (A10/A16/A40) | 8.6 | `15d466e43b11fa523e0662603f09bce6e5c7fc92fba33ea5c6122b98ec546bd8` |
| Turing (T4) | 7.5 | `ae4879839cd92b9ca86791d2455b3ce72261f485f00a89e2056e11c3e69d4bc3` |

(Confirm the current ids against NVIDIA's [Model Manifest Profiles
table](https://docs.nvidia.com/nim/maxine/synthetic-video-detector/latest/getting-started.html#model-manifest-profiles) —
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
- NVIDIA SVD model docs: <https://docs.nvidia.com/nim/maxine/synthetic-video-detector/latest/index.html>
- Try the API: <https://build.nvidia.com/nvidia/synthetic-video-detector>
