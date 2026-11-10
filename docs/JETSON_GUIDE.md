# Running VIF on NVIDIA Jetson

This guide covers running the VIF stack — Wowza Streaming Engine, Manager, and the Video Intelligence Service (VIS) — on an NVIDIA Jetson Orin device, using the `docker-compose.jetson.yaml` overlay that ships with this repository.

For the general VIS reference (configuration variables, TLS, air-gapped model downloads), see [`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md). This guide only covers what differs on Jetson.

## Contents

- [Supported devices](#supported-devices)
- [Compose files for Jetson](#compose-files-for-jetson)
- [What the Jetson overlay changes](#what-the-jetson-overlay-changes)
- [Prerequisites](#prerequisites)
- [1. Configure `.env`](#1-configure-env)
- [2. First start: build the models](#2-first-start-build-the-models)
- [3. Start the full stack](#3-start-the-full-stack)
- [Choosing a detection model](#choosing-a-detection-model)
- [Monitoring on Jetson](#monitoring-on-jetson)
- [Optional sidecars (VLM, SVD)](#optional-sidecars-vlm-svd)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

---

## Supported devices

- **Jetson AGX Orin**
- **Jetson Orin Nano, 8GB model.** The 4GB model is not supported.

Both require **JetPack 7.2**.

## Compose files for Jetson

On a Jetson, run every `docker compose` command with **two** files: the base `docker-compose.yaml` and the Jetson overlay `docker-compose.jetson.yaml`.

```bash
docker compose -f docker-compose.yaml -f docker-compose.jetson.yaml up
```

Without the overlay, Compose uses the base file's VIS image, which is not the Jetson image.

To avoid typing both files every time, set `COMPOSE_FILE` in `.env` as shown in [step 1](#1-configure-env). Every `docker compose` command in the directory then uses both files. The rest of this guide uses that shorter form.

## What the Jetson overlay changes

`docker-compose.jetson.yaml` merges on top of `docker-compose.yaml` and changes only what differs on Jetson:

| Service | Change |
|---|---|
| `video-intelligence-service-gpu` | Image becomes `wowza/wowza-video-intelligence-service:latest-jetpack7` |
| `video-intelligence-service-gpu` | Mounts the host's `/usr/bin/tegrastats` at `/tmp/tegrastats` |
| `wse` | Mounts the host's `/usr/bin/tegrastats` at `/tmp/tegrastats`, so the Manager dashboard can report Jetson GPU stats |

Engine and Manager use the same images as on other platforms.

## Prerequisites

- **A Jetson Orin device** from the [supported list](#supported-devices), running **JetPack 7.2**
- **Docker Engine** and **Docker Compose** (v2)
- **NVIDIA Container Toolkit.** The compose file runs VIS with Docker's `nvidia` runtime.
- **`tegrastats`** at `/usr/bin/tegrastats` on the host. The overlay mounts it into the containers.
- **A Wowza Streaming Engine license key** and **a VIS license string** (`VIS_LICENSE`) — contact us via [wowza.com/contact](https://www.wowza.com/contact) if you don't have one
- **A clone or copy of this repository** on the device. VIS stores model weights and compiled TensorRT engines under `./vis/models`.

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

## 2. First start: build the models

On first start, VIS downloads model weights and compiles TensorRT engines for the device's GPU. The compiled engines are cached in `./vis/models`, so later starts skip this step.

On a **Jetson Orin Nano**, run VIS by itself for the first start. Building the initial models takes about **15–20 minutes**:

```bash
docker compose --profile vi-service up
```

Watch the log until the model builds finish, then stop it with `Ctrl+C`.

VIS takes about a minute to load its models on every later start. Engine reconnects automatically once VIS is ready.

> [!NOTE]
> No internet on the device? Pre-download the checkpoints as described in [Air-Gapped Deployments](VIS_DEPLOYMENT.md#air-gapped-deployments). When transferring the VIS image, use the Jetson tag (`latest-jetpack7`), not the `-gpu` tag shown there.

## 3. Start the full stack

```bash
docker compose up -d
docker compose ps
```

Open Manager at `http://<jetson-ip>:8088` and log in with `WSE_ADMIN_USER` / `WSE_ADMIN_PASSWORD`. From here, publishing a test stream and configuring detection work the same as on any other host — see [Testing Object Detection and VLM Analysis](../README.md#testing-object-detection-and-vlm-analysis) in the main README.

## Choosing a detection model

Object detection uses RF-DETR in four sizes, chosen per stream with `model_name`: `nano`, `small`, `medium`, or `large`. The default stream configuration uses `medium`.

Set the model on Manager's VIF configuration page (`http://<jetson-ip>:8088/Home.htm#plugin/server/vif/stream-config.html`) or through the REST API, as described in [Updating VIF Configuration](../README.md#updating-vif-configuration).

## Monitoring on Jetson

The Manager VIF dashboard shows the Engine host's GPU. On a Jetson Orin, Engine reads these figures from `tegrastats`:

- **GPU utilization** is the GPU load that `tegrastats` reports (`GR3D_FREQ`).
- **Memory** is **shared system RAM usage**, not GPU memory. Jetson's CPU and GPU share one memory pool.

This needs the `tegrastats` mount from the overlay. Without it, the Engine log shows `GpuInfo:Could not find tegrastats for Orin GPU info` and the dashboard has no Jetson GPU figures.

## Optional sidecars (VLM, SVD)

The `vlm` and `svd` profiles are not covered by the Jetson overlay and are not documented for Jetson. See [`VLM_GUIDE.md`](VLM_GUIDE.md) and [`SYNTHETIC_VIDEO_DETECTOR.md`](SYNTHETIC_VIDEO_DETECTOR.md) for where they run.

## Updating

```bash
docker compose pull
docker compose up -d
```

`docker compose down` may be required between version changes.

## Troubleshooting

| Problem | Action |
|---|---|
| VIS runs the `-gpu` image instead of `-jetpack7` | The overlay isn't applied — see [Compose files for Jetson](#compose-files-for-jetson). `docker compose config --images` lists the images Compose will use. |
| Engine log shows `Could not find tegrastats for Orin GPU info` | The overlay isn't applied, or `/usr/bin/tegrastats` is missing on the host. |
| Engine connection refused after a restart | VIS takes about a minute to load its models. Engine reconnects automatically once VIS is ready. |
| Model download fails | Pre-download the checkpoints — see [Air-Gapped Deployments](VIS_DEPLOYMENT.md#air-gapped-deployments). |

For anything else, check the logs with `docker compose logs -f`.

## See also

- [Running on NVIDIA Jetson](../README.md#running-on-nvidia-jetson-optional) in the main README
- [`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md) — VIS configuration reference, TLS, air-gapped deployments
- [`VLM_GUIDE.md`](VLM_GUIDE.md) — Vision Language Model setup
- [`SYNTHETIC_VIDEO_DETECTOR.md`](SYNTHETIC_VIDEO_DETECTOR.md) — SVD deployment and GPU support
