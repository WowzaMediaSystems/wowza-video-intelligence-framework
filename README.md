# Wowza Streaming Engine · Video Intelligence Framework BETA

**Docker-based Wowza Streaming Engine with a Video Intelligence add-on for real-time object detection and scene understanding.**  

Using VIF, incoming streams in Wowza Streaming Engine can be matched for real-time AI analysis across edge and cloud environments. The stream name determines which type of AI analysis is performed. 

[![Docker](https://img.shields.io/badge/docker-required-blue?logo=docker&style=flat-square)](https://docs.docker.com/engine/install/)
[![WSE](https://img.shields.io/badge/Wowza%20Streaming%20Engine-license%20required-orange?style=flat-square)](https://auth.wowza.com/register?type=engine)
[![License](https://img.shields.io/badge/license-proprietary-red?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-beta-yellow?style=flat-square)](#)

---

## Quick Summary

| | |
|---|---|
| **What it is** | Ready-to-run WSE configuration with prebuilt plugin JARs for video intelligence workflows |
| **Primary workflow** | Object detection |
| **Experimental workflow** | Scene understanding |
| **How it runs** | `docker compose --profile all up` starts three containers: `wse` (Wowza Streaming Engine), `manager` (Engine Manager UI), and `video-intelligence-service-gpu` (Video Intelligence Service, or VIS, running on GPU) |
| **Alternative workflow (optional)** | `docker compose --profile wse up` starts only `wse` and `manager`. Use this only when connecting to a remote VIS endpoint. |
| **VI Service deployment** | Connect to a remote VI Service instance (`wss://`) or run VIF locally via Docker |

## Prerequisites
- [Docker Engine](https://docs.docker.com/engine/install/)
- A valid [Wowza Streaming Engine](https://auth.wowza.com/register?type=engine) license key
- A valid Video Intelligence Service license (`VIS_LICENSE`) for local VIS deployments
- A valid Flowplayer license key (Provided by Wowza)
- For local GPU inference: an NVIDIA GPU and compatible NVIDIA drivers
- (Optional) [FFmpeg](https://www.ffmpeg.org/download.html) for publishing test streams

## Table of Contents
- [Repository Layout](#repository-layout)
- [Persistent Volume Mounts](#persistent-volume-mounts)
- [Running Wowza VIF Locally (Quick Start)](#running-wowza-vif-locally-quick-start)
- [Testing Object Detection and Scene Understanding](#testing-object-detection-and-scene-understanding)
- [Default Model Coverage and Configuration](#default-model-coverage-and-configuration)
- [Updating VIF Configuration](#updating-vif-configuration)
- [Plugin Configuration Reference](#plugin-configuration-reference)
- [Deploying Your Own VIF Service (Optional)](#deploying-your-own-vif-service-optional)
- [Compute Requirements (Self-Hosted VIF)](#compute-requirements-self-hosted-vif)
- [Running VIS Only (Optional)](#running-vis-only-optional)

## Repository Layout

```text
.
|- docker-compose.yaml                 # WSE + Manager + VIS containers
|- .env.example                        # Environment variables template
|- wse.standalone
|  |- conf/                            # WSE + VIF plugin configuration (including video-intelligence.json)
|  |- lib/                             # Plugin JARs mounted into WSE
|  |- manager/                         # Manager UI extension assets
|  |- transcoder/                      # Transcoder templates used by VIF workflows
|- videos/                             # Sample VOD files for test publishing
|- docs/                               # Deployment docs
```

Local directories such as `logs/`, `tmp/`, `vis/`, and `wse/` are gitignored. In the current `docker-compose.yaml`, WSE bind mounts and the VIS models mount are enabled. Docker Compose creates the local `./wse/*` and `./vis/models` directories on first startup if they do not already exist.
- `vis/` # Optional local VI service assets. `./vis/models/` stores model files, model weights/checkpoints (`.pth`), and TensorRT engines.
- `wse/` # Local bind-mounted WSE runtime folders for Docker (for example `conf/`, `content/`, `transcoder/`, `logs/`). This is separate from `wse.standalone/` — see Persistent Volume Mounts below.
- `logs/` # Runtime log output

**What you usually edit:**

- `.env` - license key, admin credentials, player/API keys
- VIF stream/default configuration - use the [VIF configuration](http://localhost:8088/Home.htm#plugin/server/vif/stream-config.html) page in WSE Manager, or the WSE REST API
- `wse/conf/video-intelligence.json` - if local WSE volume mounts are enabled, advanced users can directly edit this file to configure video intelligence routing, service connection settings, and feature behavior

## Persistent Volume Mounts

In the current `docker-compose.yaml`, WSE bind mounts and the VIS models mount are enabled by default. These map host folders into the containers:

- `./wse/conf -> /usr/local/WowzaStreamingEngine/conf`
- `./wse/content -> /usr/local/WowzaStreamingEngine/content`
- `./wse/transcoder -> /usr/local/WowzaStreamingEngine/transcoder`
- `./wse/logs -> /usr/local/WowzaStreamingEngine/logs`
- `./vis/models -> /build/models`

What this enables:

- Persistent WSE config and runtime files across container recreation.
- Editing WSE config directly in your repo and seeing those changes in the running container.
- Keeping WSE logs on the host for troubleshooting and historical inspection.
- Keeping transcoder templates/content under source control (or local backup) instead of only inside container storage.
- Persisting VIS model files, custom model weights/checkpoints, downloaded checkpoints, and generated TensorRT engines across restarts.

This persistence makes testing and iteration easier, but after major WSE, VIS, model, or plugin changes you may need to remove outdated persisted files before retesting:

- `./wse/*` can preserve older runtime or config state that masks image changes.
- `./vis/models/engines` can preserve stale TensorRT engines built for an older runtime, model set, or GPU environment.
- Take care with `./vis/models/`: it may also contain custom model weights (`.pth`) that you want to keep.

If you disable these mounts, WSE and VIS fall back to container filesystem defaults and local changes are not preserved when containers are recreated.

## Running Wowza VIF Locally (Quick Start)

Make sure you have a valid [Wowza Streaming Engine key](https://www.wowza.com/free-trial).

Before starting, confirm your machine meets the [Compute Requirements (Self-Hosted VIF)](#compute-requirements-self-hosted-vif). The default local workflow runs all three containers (`wse`, `manager`, and `video-intelligence-service-gpu`).

1. Create `.env` from the example and edit values:

```bash
cp .env.example .env
```

Example:

```text
WSE_LICENSE_KEY=REPLACE_WITH_YOUR_WSE_LICENSE_KEY
WSE_ADMIN_USER=admin
WSE_ADMIN_PASSWORD=CHANGE_THIS_PASSWORD
PLAYER_TOKEN=REPLACE_WITH_YOUR_FLOWPLAYER_TOKEN
VIS_PROTOCOL=ws
VIS_HOST=video-intelligence-service.docker
VIS_PORT=5001
VIS_API_KEY=REPLACE_WITH_YOUR_VIS_API_KEY
VIS_LICENSE=REPLACE_WITH_YOUR_VIS_LICENSE
```

> [!IMPORTANT]
> **`VIS_HOST` value depends on your deployment:**
> - **Local Docker (`--profile all`):** Set `VIS_HOST=video-intelligence-service.docker`. WSE and VIS run in the same Docker network; using `localhost` will not work because it resolves to the WSE container itself, not the VIS container.
> - **Remote VIS:** Set `VIS_HOST` to the hostname or IP of your remote VIS instance.

> [!CAUTION]  
> `WSE_ADMIN_USER` and `WSE_ADMIN_PASSWORD` bootstrap local Manager/REST access. Do not keep defaults — use a strong password.  
> `VIS_API_KEY` protects access to the Video Intelligence Service. Use a long, random, high-entropy key and rotate it regularly.  

2. Start WSE + Manager + VIS:

```bash
docker compose --profile all up
```

> [!TIP]  
> If you change images or mounted config between runs, run `docker compose down` first.

3. Verify services are running:

| Service | URL |
|---|---|
| Manager UI | `http://localhost:8088` |
| WSE REST API | `http://localhost:8087` |

**Exposed ports:**

| Port | Protocol | Purpose |
|---|---|---|
| `80` | HTTP | HLS |
| `443` | HTTPS | TLS |
| `554` | RTSP | RTSP |
| `1935` | TCP | RTMP |
| `8087` | HTTP | REST API |
| `8089` | HTTP | REST API docs (if enabled) |
| `10000` | UDP | SRT |

> [!NOTE]  
> - The first time Docker Compose is run, the containers may take up to 20 minutes to download all required files. Actual time may vary based on available bandwidth  
> - Each time the Video Intelligence Service (VIS) container starts, it may take approximately 3 minutes before detections are available

## Testing Object Detection and Scene Understanding

In the default examples included in this repository, a stream with a name matching `object.*` triggers object detection using an RF-DETR Medium model capable of identifying up to 80 COCO object categories, including people, vehicles, animals, and more. A stream matching `scene.*` triggers scene understanding, which classifies the overall activity or situation visible in the video and is currently experimental.

Out of the box, VIF renders bounding box overlays on the transcoded `-vi` stream and injects ID3 metadata into the HLS output. Webhook delivery to third-party platforms and local log file events are available. Developers can further customize event handling using [Wowza Streaming Engine modules](https://www.wowza.com/docs/use-wowza-streaming-engine-java-modules).

> [!NOTE]  
> - Streams automatically appear in the [VIF dashboard](http://localhost:8088/Home.htm#plugin/server/vif/shm.html) in Wowza Streaming Engine Manager.
> - Streams can be managed via REST or configured using the [VIF configuration](http://localhost:8088/Home.htm#plugin/server/vif/stream-config.html) page in Wowza Streaming Engine Manager.

1. [Install FFmpeg](https://www.ffmpeg.org/download.html).
2. Start WSE using the quick-start steps above.
3. Use the sample clips in `./videos/`, or publish your own files. For best results, keep source videos under 720p resolution.
4. For object detection, publish a stream to the WSE `live` application. The default configuration matches stream names using the `object.*` regex — any name starting with `object` will trigger object detection:

```bash
ffmpeg -stream_loop -1 -re -i "./videos/vi-object-detection-landscape.mp4" -r 25 -g 50 -c:v libx264 -preset veryfast -b:v 2000k -c:a aac -b:a 128k -f flv "rtmp://localhost/live/object_mystream1"
```

5. Scene understanding is **experimental**. The underlying models are actively evolving, and results will improve over time. Output quality and behavior may change between releases. The default configuration matches stream names using the `scene.*` regex. If the `scene.*` rule is enabled in the [VIF configuration](http://localhost:8088/Home.htm#plugin/server/vif/stream-config.html) page or REST API, publish a stream to the WSE `live` application:

```bash
ffmpeg -stream_loop -1 -re -i "./videos/vi-scene-detection.mp4" -r 25 -g 50 -c:v libx264 -preset veryfast -b:v 2000k -c:a aac -b:a 128k -f flv "rtmp://localhost/live/scene_mystream1"
```

6. Expected output for streams analyzed by VIF:

   - The `-vi` rendition includes overlays. For example, publish `object_mystream1`, then play `http://localhost/live/object_mystream1-vi/playlist.m3u8` in an HLS player.
   - ID3 metadata is injected into HLS output for analyzed streams.
   - If the `LogFiles` listener is enabled, events are written to `wowzastreamingengine_vi.log` (under `./wse/logs/` when WSE log mounts are enabled).


## Default Model Coverage and Configuration

By default, VIF uses a RF-DETR based computer vision model capable of detecting up to 80 object categories defined by the COCO dataset. 

The objects to detect and scene descriptions to analyze can be configured in the [VIF configuration](http://localhost:8088/Home.htm#plugin/server/vif/stream-config.html) page or through the WSE REST API, allowing you to tailor detection behavior, routing, and scene-understanding workflows to your deployment.

VIF also supports importing custom RF-DETR-based object detection models, enabling domain-specific detection beyond the default COCO classes.

To test a custom model, copy your model weights/checkpoint file (`.pth`) into `./vis/models/`, update `checkpoint_path` for the matching stream in the [VIF configuration](http://localhost:8088/Home.htm#plugin/server/vif/stream-config.html) page or REST API, and restart the VIS container so the service loads the new model.

## Updating VIF Configuration

You can update VIF defaults and per-stream settings in two ways:

- **WSE Manager UI:** Open the [VIF configuration](http://localhost:8088/Home.htm#plugin/server/vif/stream-config.html) page to add or update stream rules such as `object.*` and `scene.*`, event listeners, class names, thresholds, and service connection settings.
- **REST API:** Use the WSE REST API for scripted updates. For example, disable overlays on the active `object_mystream1` stream:

```bash
curl -X PUT "http://localhost:8087/v1/server/plugin/vif/applications/live/streams/object_mystream1" \
  -H "Content-Type: application/json" \
  -d '{ "vif_event_listeners": { "Overlays": { "methods": ["disabled"] } } }'
```

For the full field reference and additional API examples, see [`README.wse-plugin.md`](docs/README.wse-plugin.md).

## Plugin Configuration Reference

Use [`README.wse-plugin.md`](docs/README.wse-plugin.md) as the detailed configuration guide for the Wowza Streaming Engine (WSE) Video Intelligence plugin.

- Includes field-level options and behavior for VIF settings exposed through the Manager UI, REST API, and the underlying `video-intelligence.json` schema.
- Useful when tuning object detection settings (for example `model_name`, `checkpoint_path`, thresholds, and per-stream overrides).

## Deploying Your Own VIF Service (Optional)

If you want your own Video Intelligence Service deployment (for example on NVIDIA Brev), see [`docs/VIS_DEPLOYMENT.md`](docs/VIS_DEPLOYMENT.md).

## Compute Requirements (Self-Hosted VIF)

Recommended baseline for self-hosted VIF: approximately 8 concurrent 720p streams analyzed at up to 10 FPS under standard production conditions using an RF-DETR medium model, assuming GPU-backed inference and typical overlay/event generation settings.

- `1x NVIDIA T4 (16 GB)` minimum
- `1x NVIDIA L4 (24 GB)` recommended
- `8 vCPU` minimum
- `16 vCPU` recommended
- `32 GB RAM`
- `32 GB disk storage` minimum
- `NVMe` storage recommended
- `10 GbE` networking preferred for multi-stream deployments

Actual capacity depends on the model variant, frame preprocessing, overlay configuration, event listeners, and downstream integrations. Higher density workloads, heavier models, or full-frame-rate analysis may require additional resources.

## Running VIS Only (Optional)

```powershell
docker compose --profile vi-service up
```

Use this profile only when you intentionally want the VIS container by itself (for example, debugging or integration with an external WSE instance).

> [!TIP]
> `docker compose down` may be required between version changes.

