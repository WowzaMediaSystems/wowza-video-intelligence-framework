# Running VIF on NVIDIA Jetson

This guide covers running the full VIF stack — Wowza Streaming Engine, Manager, and the Video Intelligence Service (VIS) — on a single NVIDIA Jetson Orin device, using the `docker-compose.jetson.yaml` overlay that ships with this repository.

For the general VIS reference (configuration variables, TLS, air-gapped model downloads), see [`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md). This guide only covers what differs on Jetson.

## Contents

- [Supported devices](#supported-devices)
- [Compose files for Jetson](#compose-files-for-jetson)
- [What the Jetson overlay changes](#what-the-jetson-overlay-changes)
- [Prerequisites](#prerequisites)
- [1. Configure `.env`](#1-configure-env)
- [2. First start: build the models](#2-first-start-build-the-models)
- [3. Start the full stack](#3-start-the-full-stack)
- [4. Pick a model that fits the device](#4-pick-a-model-that-fits-the-device)
- [Monitoring on Jetson](#monitoring-on-jetson)
- [Optional sidecars (VLM, SVD)](#optional-sidecars-vlm-svd)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

---

## Supported devices

| Device | Supported | Notes |
|---|---|---|
| Jetson AGX Orin | Yes | |
| Jetson Orin Nano 8GB | Yes | Run VIS alone on first start to build the models (see [step 2](#2-first-start-build-the-models)) |
| Jetson Orin Nano 4GB | **No** | The Orin Nano requires the 8GB model |

All devices require **JetPack 7.2**.

The [Compute Requirements](../README.md#compute-requirements-self-hosted-vif) baseline in the main README (about 8 concurrent 720p streams at up to 10 FPS on RF-DETR Medium) is sized for discrete NVIDIA GPUs. To size a Jetson deployment, measure your own workload with the dashboard described in [Monitoring on Jetson](#monitoring-on-jetson).

## Compose files for Jetson

On a Jetson, run every `docker compose` command with **two** files: the base `docker-compose.yaml` and the Jetson overlay `docker-compose.jetson.yaml`.

```bash
docker compose -f docker-compose.yaml -f docker-compose.jetson.yaml --profile default up -d
```

Leaving out the overlay doesn't fail visibly. The base file's VIS image (`1.2.0-gpu`) also has an arm64 build, so Docker pulls it without an error, but it isn't the Jetson image.

To avoid typing both files every time, set `COMPOSE_FILE` in `.env` as shown in [step 1](#1-configure-env). Every `docker compose` command in the directory then uses both files, and the rest of this guide uses that shorter form.

## What the Jetson overlay changes

`docker-compose.jetson.yaml` merges on top of `docker-compose.yaml` and changes only what differs on Jetson:

| Service | Change |
|---|---|
| `video-intelligence-service-gpu` | Image becomes `wowza/wowza-video-intelligence-service:latest-jetpack7` |
| `video-intelligence-service-gpu` | Mounts the host's `/usr/bin/tegrastats` at `/tmp/tegrastats` |
| `wse` | Mounts the host's `/usr/bin/tegrastats` at `/tmp/tegrastats`, so the Manager dashboard can report Jetson GPU stats |

Everything else comes from the base file unchanged. The Engine and Manager images (`wowza/wowza-streaming-engine:vif-1.2.0`, `wowza/wowza-streaming-engine-manager:vif-1.2.0`) are published for both amd64 and arm64, so the same tags run on Jetson.

> [!IMPORTANT]
> **Pin the VIS version.** The base file pins VIS to a release (`1.2.0-gpu`), but the overlay uses the floating `latest-jetpack7` tag, so a later `docker compose pull` can move VIS ahead of Engine. Each release is also published with a versioned Jetson tag. To keep VIS on the same release as Engine, edit the image line in `docker-compose.jetson.yaml`:
>
> ```yaml
>     video-intelligence-service-gpu:
>         image: wowza/wowza-video-intelligence-service:1.2.0-jetpack7
> ```

## Prerequisites

- **A Jetson Orin device** from the [supported list](#supported-devices), flashed with **[JetPack 7.2](https://developer.nvidia.com/embedded/jetpack)**
- **Docker Engine** and **Docker Compose** (v2)
- **NVIDIA Container Toolkit**, registered with Docker as the `nvidia` runtime. The VIS service runs with `runtime: nvidia`, and the Engine service reserves an NVIDIA device.
- **`tegrastats`** at `/usr/bin/tegrastats` (part of JetPack)
- **A Wowza Streaming Engine license key** and **a VIS license string** (`VIS_LICENSE`) — contact us via [wowza.com/contact](https://www.wowza.com/contact) if you don't have one
- **A clone or copy of this repository** on the device. VIS stores model weights and compiled TensorRT engines under `./vis/models`, so put the checkout on storage with room to spare; NVMe is recommended.

Check the host before you start:

```bash
docker compose version
docker info --format '{{json .Runtimes}}'   # must include "nvidia"
ls -l /usr/bin/tegrastats
```

## 1. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` and set:

| Variable | Value |
|---|---|
| `WSE_LICENSE_KEY` | Your Wowza Streaming Engine license key |
| `WSE_ADMIN_USER` / `WSE_ADMIN_PASSWORD` | Admin login for Engine and Manager |
| `VIS_API_KEY` | A shared secret between Engine and VIS. Generate one with `openssl rand -hex 32`. VIS refuses to start without it while `SECURE_MODE=true` (the default). |
| `VIS_LICENSE` | Your VIS license string |

Then turn on the Jetson overlay by uncommenting this line in the NVIDIA Jetson section of `.env`:

```bash
COMPOSE_FILE=docker-compose.yaml:docker-compose.jetson.yaml
```

With `COMPOSE_FILE` set, every `docker compose` command in this directory (`up`, `down`, `logs`, `pull`) applies the overlay automatically. If you leave it unset, add both `-f` files to each command in this guide, as shown in [Compose files for Jetson](#compose-files-for-jetson).

## 2. First start: build the models

On first start, VIS downloads model weights and compiles TensorRT engines for the device's GPU. On a Jetson this takes a while — about **15–20 minutes on an Orin Nano**. Run VIS by itself for this step. This is required on the Orin Nano; on an AGX Orin it's optional, but it lets you watch the build before the rest of the stack starts:

```bash
docker compose --profile vi-service up
```

Leave it in the foreground and watch the log until the model builds finish, then stop it with `Ctrl+C`.

The compiled engines are cached in `./vis/models`, so later starts skip the build. VIS still takes about a minute to load its models on each restart.

> [!NOTE]
> No internet on the device? Pre-download the checkpoints as described in [Air-Gapped Deployments](VIS_DEPLOYMENT.md#air-gapped-deployments). When transferring the VIS image, save and load the Jetson tag (for example `1.2.0-jetpack7`), not the `-gpu` tag shown there.

## 3. Start the full stack

```bash
docker compose --profile default up -d
docker compose ps
```

Open Manager at `http://<jetson-ip>:8088` and log in with `WSE_ADMIN_USER` / `WSE_ADMIN_PASSWORD`. From here, publishing a test stream and configuring detection work the same as on any other host — see [Testing Object Detection and VLM Analysis](../README.md#testing-object-detection-and-vlm-analysis) in the main README.

## 4. Pick a model that fits the device

Object detection uses RF-DETR in four sizes, chosen per stream with `model_name` (`nano`, `small`, `medium`, `large`). The default stream configuration uses `medium`.

On a Jetson, Engine (including the transcoding for the `-vi` overlay stream), Manager, and VIS all share the device's memory. On an **Orin Nano**, start with `nano` or `small` and a modest number of streams, then raise them while watching the dashboard. Set the model on Manager's VIF configuration page (`http://<jetson-ip>:8088/Home.htm#plugin/server/vif/stream-config.html`) or through the REST API, as described in [Updating VIF Configuration](../README.md#updating-vif-configuration).

## Monitoring on Jetson

The Manager VIF dashboard shows the Engine host's GPU. On a Jetson Orin, Engine reads these figures from `tegrastats`:

- **GPU utilization** comes from the GPU load that `tegrastats` reports (`GR3D_FREQ`).
- **Memory** is **shared system RAM usage**, not GPU memory. Jetson's CPU and GPU share one memory pool, so this is the figure to watch on an Orin Nano.

This needs the `tegrastats` mount from the overlay. Without it, the GPU card has no Jetson figures and the Engine log shows `GpuInfo:Could not find tegrastats for Orin GPU info`.

To watch the device directly, run `tegrastats` on the host.

## Optional sidecars (VLM, SVD)

The Jetson overlay doesn't cover the `vlm` or `svd` profiles, and neither is documented for Jetson. The [SVD GPU support matrix](SYNTHETIC_VIDEO_DETECTOR.md#gpu-support-matrix) lists discrete GPUs only.

To use a VLM with a Jetson stack, run it on a separate GPU host and point the stream's `endpoint_url` at that host — see [`VLM_GUIDE.md`](VLM_GUIDE.md).

## Updating

```bash
docker compose pull
docker compose --profile default up -d
```

If you [pinned the VIS version](#what-the-jetson-overlay-changes), update the tag in `docker-compose.jetson.yaml` to match the new Engine release before you pull. Run `docker compose down` first if containers don't pick up the new version.

## Troubleshooting

| Problem | Action |
|---|---|
| `unknown or invalid runtime name: nvidia` | The NVIDIA Container Toolkit isn't registered with Docker. `docker info --format '{{json .Runtimes}}'` must include `nvidia`. |
| `could not select device driver "nvidia"` when starting `wse` | Same cause: Docker can't see the NVIDIA runtime. Fix the toolkit setup, then restart Docker. |
| VIS uses the `-gpu` image instead of `-jetpack7` | The overlay isn't applied — see [Compose files for Jetson](#compose-files-for-jetson). `docker compose config --images` shows which images will run. |
| First start on an Orin Nano doesn't complete | Start VIS alone (`--profile vi-service`) so Engine and Manager aren't running, and confirm the device is the 8GB model. |
| Manager dashboard shows no Jetson GPU figures; Engine log shows `Could not find tegrastats for Orin GPU info` | The overlay isn't applied, or `/usr/bin/tegrastats` is missing on the host. |
| Engine connection refused after a restart | VIS takes about a minute to load its models. Engine reconnects automatically once VIS is ready. |
| Model download fails | Pre-download the checkpoints — see [Air-Gapped Deployments](VIS_DEPLOYMENT.md#air-gapped-deployments). |

For anything else, check the logs with `docker compose --profile default logs -f`.

## See also

- [Running on NVIDIA Jetson](../README.md#running-on-nvidia-jetson-optional) in the main README
- [`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md) — VIS configuration reference, TLS, air-gapped deployments
- [`VLM_GUIDE.md`](VLM_GUIDE.md) — Vision Language Model setup
- [`SYNTHETIC_VIDEO_DETECTOR.md`](SYNTHETIC_VIDEO_DETECTOR.md) — SVD deployment and GPU support
