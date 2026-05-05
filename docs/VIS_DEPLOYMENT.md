# Video Intelligence Service — Deployment Guide

This guide covers deploying the Video Intelligence Service (VIS) on any machine with Docker and an NVIDIA GPU. VIS provides real-time object detection and scene analysis for live video streams managed by Wowza Streaming Engine.

For compute requirements, see the [Compute Requirements](../README.md#compute-requirements-self-hosted-vif) section in the main README.

## Prerequisites

- **Docker Engine** and **Docker Compose** (v2)
- **NVIDIA GPU** with compatible drivers (v570 or above, `nvidia-smi` should work)
- **NVIDIA Container Toolkit** (`nvidia-container-toolkit`) — [installation guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- **A VIS license** (`VIS_LICENSE`, a license string) — contact us via [wowza.com/contact](https://www.wowza.com/contact) if you don't have one
- **A clone or copy of this repository**

## Quick Start

1. Copy the environment template and configure your license and API key:

   ```bash
   cp .env.example .env
   # Edit .env and set VIS_LICENSE to your license string
   # Edit .env and set VIS_API_KEY to a shared secret
   ```

3. Start the service:

   ```bash
   docker compose --profile vi-service up
   ```

4. Verify it is running:

   ```bash
   curl -s http://localhost:5001/health
   ```

> **Startup behavior:**
>
> - **First start** is significantly slower because VIS must download model weights and precompile TensorRT engines for your specific GPU. This is a one-time process — the compiled engines are cached in the `vis/models` volume for subsequent starts. For offline environments, see [Air-Gapped Deployments](#air-gapped-deployments).
> - **Subsequent restarts** still require roughly **1 minute** while the service loads models and initializes.
> - **During initialization**, connections from Wowza Streaming Engine instances are rejected. Engine will automatically reconnect once VIS is ready — no manual intervention is needed.

## Configuration Reference

Environment variables for the `video-intelligence-service-gpu` service (defined in the root `docker-compose.yaml`):

| Variable | Default | Description |
|---|---|---|
| `VIS_PORT` | `5001` | Service listen port |
| `LOG_LEVEL` | `INFO` | Logging verbosity (`DEBUG`, `INFO`, `WARN`, `ERROR`) |
| `ENABLE_NETWORK_METRICS_LOGGING` | `false` | Periodic network metrics logging |
| `VIDEO_FRAME_REQUEST_TIMEOUT_SECONDS` | `2.0` | Timeout for video frame responses (seconds) |
| `VIS_API_KEY` | — | Shared API key for Engine-to-VIS authentication |
| `NVIDIA_VISIBLE_DEVICES` | `all` | GPU devices to expose (e.g., `0,1`) |
| `NVIDIA_DRIVER_CAPABILITIES` | `compute,utility` | Required NVIDIA capabilities |
| `TRT_MODELS` | — | Models to precompile at startup (e.g., `object-detection-medium`) |
| `SSL_KEYFILE` | — | Path to SSL private key (inside container) |
| `SSL_CERTFILE` | — | Path to SSL certificate (inside container) |
| `SSL_KEYFILE_PASSWORD` | — | Password for encrypted SSL key |
| `VIS_LICENSE` | — | License key string (required) |

### Volumes

| Host Path | Container Path | Purpose |
|---|---|---|
| `./vis/models` | `/build/models` | Model checkpoints |
| `./certs` | `/certs:ro` | SSL certificates (optional, read-only) |

## Air-Gapped Deployments

VIS does **not** require direct internet access at runtime, but it must be able to reach the Wowza Streaming Engine instances it serves.

### Object Detection (RF-DETR)

On first start, VIS downloads model weights from Wowza hosting. To deploy without internet, pre-download the checkpoint files and place them in `vis/models/`.

**Available models:**

| Model | Filename | URL | SHA-256 |
|---|---|---|---|
| nano | `rfdetr-nano.pth` | `https://storage.vi.wowza.com/object-detection/v1-0/checkpoint-nano.pth` | `d8d6b9ee57d4d0ed2b1f305163624712a0532cb7bce0c747317984fc5457440d` |
| small | `rfdetr-small.pth` | `https://storage.vi.wowza.com/object-detection/v1-0/checkpoint-small.pth` | `d81979a9213a2109345158ce9232668df4c1ae52e9b8db3f2ec0a8cbad959b33` |
| medium | `rfdetr-medium.pth` | `https://storage.vi.wowza.com/object-detection/v1-0/checkpoint-medium.pth` | `749ff6071828aaffac63e204c4f4135ed3d6cdae4d702e086c360edc3b5768c8` |
| large | `rfdetr-large.pth` | `https://storage.vi.wowza.com/object-detection/v1-0/checkpoint-large.pth` | `0f4e20e19a99c0f8a62b5685f57f6c8b5c371c59081feda6752a0561a79ccf38` |

**Download example (from a connected machine):**

```bash
mkdir -p vis/models

curl -o vis/models/rfdetr-nano.pth \
  https://storage.vi.wowza.com/object-detection/v1-0/checkpoint-nano.pth

curl -o vis/models/rfdetr-medium.pth \
  https://storage.vi.wowza.com/object-detection/v1-0/checkpoint-medium.pth
```

When a checkpoint file is present in `vis/models/`, VIS uses it directly without downloading.

**Custom models:** To use fine-tuned weights, place the `.pth` file in `vis/models/` and set `checkpoint_path` in your `video-intelligence.json` configuration (e.g., `"checkpoint_path": "models/my_custom_weights.pth"`).

### Scene Analysis (Experimental)

The scene detection checkpoint can also be pre-downloaded:

```bash
curl -o vis/models/scene-detector.pth \
  https://storage.vi.wowza.com/scene-detection/v1-0/checkpoint.pth
```

SHA-256: `ff6a69a2641532518cbcd4497a2f246c67ac5e0a930cc7ae90e7fd200ddf5714`

> **Known limitation:** Scene analysis currently requires internet access on first run to download OpenAI CLIP base weights. This will be addressed in a future release.

### Docker Images

Docker images must also be available on the target machine. On a connected machine:

```bash
docker pull wowza/wowza-video-intelligence-service:latest-gpu
docker save wowza/wowza-video-intelligence-service:latest-gpu -o vis-gpu.tar
```

Transfer `vis-gpu.tar` to the air-gapped machine, then:

```bash
docker load -i vis-gpu.tar
```

Alternatively, use a private registry mirror.

## Connecting to Wowza Streaming Engine

VIS and Wowza Streaming Engine communicate over WebSocket and can run on the same or different machines.

1. In your `.env` file, set the `VIS_PROTOCOL`, `VIS_HOST` and `VIS_PORT` variables:

   ```
   VIS_PROTOCOL=ws
   VIS_HOST=my-vis-host.com
   VIS_PORT=5001
   ```

   Use `wss` in VIS_PROTOCOL if SSL is enabled on VIS.

2. Set the same `VIS_API_KEY` value in the `.env` used by both services.

3. Start (or restart) Engine so it picks up the new configuration.

See [`docs/README.wse-plugin.md`](README.wse-plugin.md) for full plugin configuration details.

## SSL/TLS

To enable encrypted connections (HTTPS/WSS), set the following environment variables in `docker-compose.yaml` or `.env`:

```yaml
- SSL_KEYFILE=/certs/server-key.pem
- SSL_CERTFILE=/certs/server-cert.pem
- SSL_KEYFILE_PASSWORD=optional-key-password  # only if key is encrypted
```

Mount your certificates:

```yaml
volumes:
  - ./certs:/certs:ro
```

**Self-signed certificate (development only):**

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout certs/server-key.pem -out certs/server-cert.pem \
  -days 365 -subj "/CN=localhost"
```

For production, use certificates from a CA (e.g., Let's Encrypt) or handle TLS at a reverse proxy in front of VIS.

## Managing the Service

```bash
# View logs
docker compose --profile vi-service logs -f

# Restart
docker compose --profile vi-service restart

# Update to latest image
docker compose pull
docker compose --profile vi-service up -d

# Check status
docker compose ps
```

## Troubleshooting

| Problem | Action |
|---|---|
| Service won't start | Check logs with `docker compose --profile vi-service logs -f` |
| GPU not detected | Verify `nvidia-container-toolkit` is installed and `nvidia-smi` works on the host |
| Engine cannot connect | Check network connectivity, port 5001, and firewall rules between Engine and VIS |
| Engine connection refused after restart | VIS takes ~1 minute to initialize after a restart. Engine will reconnect automatically once VIS is ready — see [Startup behavior](#quick-start) |
| Model download fails | See [Air-Gapped Deployments](#air-gapped-deployments) for manual placement |
