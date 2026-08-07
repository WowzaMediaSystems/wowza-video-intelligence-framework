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

2. Start the service:

   ```bash
   docker compose --profile vi-service up
   ```

3. Verify it is running:

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
| `LOG_PATH` | `/logs` | Directory where log files are written. For the compose stack, set `LOG_DIR` in `.env` instead — it feeds both this variable and the `./vis/logs` bind-mount target |
| `LOG_FILE_RETENTION_DAYS` | `30` | Number of rotated daily log files to keep (minimum 1) |
| `ENABLE_NETWORK_METRICS_LOGGING` | `false` | Periodic network metrics logging |
| `VIDEO_FRAME_REQUEST_TIMEOUT_SECONDS` | `5.0` | Fallback timeout (seconds) for inbound messages from Engine, used only when a stream advertises no window duration — streams sending `duration_seconds > 0` derive the timeout from it (`max(1.0, duration × 1.5)`). After 10 consecutive misses the stream is closed |
| `VIS_API_KEY` | — | Shared API key for Engine-to-VIS authentication (clients send it as `X-API-Key`). Empty/unset disables authentication — see `SECURE_MODE` |
| `SECURE_MODE` | `true` | Fail-closed startup guard: VIS refuses to start unless a non-empty `VIS_API_KEY` is set. Set to `false` only for internal-only / air-gapped deployments that consciously accept unauthenticated access. Independent of port publishing: the compose file keeps the VIS `ports:` block commented out (service reachable only on the internal compose network) — if you publish the port for remote-Engine deployments, keep `SECURE_MODE` on with a real `VIS_API_KEY` |
| `INFERENCE_THREADS_PER_GPU` | `32` | Inference thread pool size per GPU; total threads = `min(128, gpu_count × value)`. Higher values support more concurrent streams at higher memory overhead |
| `NVIDIA_VISIBLE_DEVICES` | `all` | GPU devices to expose (e.g., `0,1`) |
| `NVIDIA_DRIVER_CAPABILITIES` | `compute,utility` | Required NVIDIA capabilities |
| `TRT_MODELS` | — | Models to precompile at startup (e.g., `object-detection-medium`); default is to scan the `models/` folder |
| `SSL_KEYFILE` | — | Path to SSL private key (inside container) |
| `SSL_CERTFILE` | — | Path to SSL certificate (inside container) |
| `SSL_KEYFILE_PASSWORD` | — | Password for encrypted SSL key |
| `VIS_LICENSE` | — | License key string (required). Takes precedence over license files |
| `VIS_LICENSE_DIR` | `licenses` | Directory scanned for license files when `VIS_LICENSE` is unset |

### Volumes

| Host Path | Container Path | Purpose |
|---|---|---|
| `./vis/models` | `/build/models` | Model checkpoints and cached TensorRT engines |
| `./vis/logs` | `/logs` (or `$LOG_DIR`) | Log files |
| `./certs` | `/certs:ro` | SSL certificates (optional, read-only) |

### Logging

VIS always writes logs to a file under `LOG_PATH` in addition to stderr. The filename is fixed (`videointelligenceservice.log`) and rotates daily at UTC midnight; rotated files are named `videointelligenceservice.YYYY-MM-DD.log` and pruned to the newest `LOG_FILE_RETENTION_DAYS`. Rotation is safe with multiple workers/processes (file locks coordinate it) and needs no external tools.

> **Non-root user (handled automatically).** The image runs as the non-root
> `vis` user (uid/gid **1001**). A bundled one-shot `vis-init` service `chown`s
> the `./vis/models` and `./vis/logs` mounts to `1001` before VIS starts, so no
> manual `chown` is required.

> **Hardening — read-only models mount (optional).** VIS deserializes `.pth`
> files under `./vis/models` at startup, so write access to that host directory
> is a code-execution surface. For a locked-down deployment that pre-seeds all
> weights and pre-builds the TensorRT engines and uses no custom models, mount
> the directory read-only in `docker-compose.yaml`:
> `- ./vis/models:/build/models:ro`. Read-only, VIS cannot download weights,
> build/refresh engines, or write the cache at runtime — so seed everything
> first.

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

   > ⚠️ **If VIS runs on a separate host from Engine, you MUST use `wss`.**
   > Plaintext `ws://` is only safe in the same-host default, where traffic
   > stays on the internal Docker bridge. Over the network it exposes frames and
   > the API key. See [SSL/TLS](#ssltls) for the bundled reverse-proxy path that
   > gives you `wss` with a real CA cert and no Engine-side truststore changes.

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
  -days 365 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

A self-signed cert also has to be trusted on the Engine side — see
[Self-signed certs end to end](#self-signed-certs-end-to-end-vis--engine).

For production, use certificates from a CA (e.g., Let's Encrypt) or handle TLS at a reverse proxy in front of VIS (recommended — see below).

### Remote VIS — TLS via the bundled reverse proxy (recommended)

When VIS runs on a **separate host** from Engine, the connection **must** be
encrypted. The simplest path needs no changes to VIS or to Engine's truststore:
the framework ships an opt-in nginx reverse proxy (the `docker-compose.tls-proxy.yaml`
overlay) that terminates TLS with a real CA cert and forwards to VIS over the
internal bridge. VIS's own port stays unpublished; only the TLS port is exposed.

1. On the VIS host, place a CA-issued certificate and key (issued for that
   host's public DNS name) at:

   ```
   ./certs/server-cert.pem
   ./certs/server-key.pem
   ```

2. Start VIS with the TLS proxy overlay merged in via `-f`:

   ```bash
   docker compose -f docker-compose.yaml -f docker-compose.tls-proxy.yaml \
     --profile vi-service up -d
   ```

   The proxy listens on `5443` (override with `VIS_TLS_PORT` in `.env`).

3. On the **Engine** host, set in its `.env`:

   ```
   VIS_PROTOCOL=wss
   VIS_HOST=<vis-host-public-name>   # must match the certificate
   VIS_PORT=5443                     # = VIS_TLS_PORT
   ```

Because the proxy presents a real CA certificate, Engine validates it with no
truststore surgery. Self-signed certs would re-introduce that friction — use a
real CA (e.g. Let's Encrypt) for the proxy.

**Point Engine at the proxy, not at VIS.** With `wss`, `VIS_HOST`/`VIS_PORT`
must target the TLS proxy (`:5443`), never VIS's plaintext port (`:5001`).

Troubleshooting `wss`:
- `Unsupported or unrecognized SSL message` — Engine is doing TLS against a
  plaintext endpoint; it's still pointing at VIS `:5001`. Point it at the proxy `:5443`.
- Certificate/`valid certification path` error — the cert isn't trusted by
  Engine's Java or its name doesn't match `VIS_HOST`. Use a CA-issued cert whose
  name equals `VIS_HOST`, or follow
  [Self-signed certs end to end](#self-signed-certs-end-to-end-vis--engine) to
  trust a self-signed one.

### Self-signed certs end to end (VIS + Engine)

Serve the certificate on the VIS side, then trust it on the Engine side.

**1. Create the certificate (VIS host)**

`VIS_HOST` must appear in the cert's `subjectAltName`:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout certs/server-key.pem -out certs/server-cert.pem \
  -days 365 -subj "/CN=vis.internal.example" \
  -addext "subjectAltName=DNS:vis.internal.example"
```

Replace `vis.internal.example` with the exact value Engine will use as
`VIS_HOST` — the DNS name of the VIS host, or its IP address. For an IP, use
the `IP:` form in the SAN (`-subj "/CN=10.0.0.9" -addext "subjectAltName=IP:10.0.0.9"`).

**2. Serve it — pick one**

- *Via the TLS proxy* (same layout as above): leave the cert at
  `./certs/server-cert.pem` + `./certs/server-key.pem` and start the stack with
  the `docker-compose.tls-proxy.yaml` overlay. Engine then uses `VIS_PORT=5443`.
  The proxy terminates TLS, so VIS's own `SSL_CERTFILE`/`SSL_KEYFILE`/
  `SSL_KEYFILE_PASSWORD` stay commented out — they are only for the option below.
- *Directly in VIS*: uncomment `SSL_CERTFILE`/`SSL_KEYFILE` and the
  `./certs:/certs:ro` volume in the VIS service, and publish `VIS_PORT` (5001).
  Don't use the TLS proxy overlay in this case.

**3. Build a truststore for Engine**

Copy Engine's JDK truststore and add the cert to the copy:

```bash
docker run --rm -v "$PWD/certs:/certs" eclipse-temurin:21-jre sh -c '
  cp /opt/java/openjdk/lib/security/cacerts /certs/vis-truststore.jks &&
  keytool -importcert -noprompt -alias vis-self-signed \
    -file /certs/server-cert.pem -keystore /certs/vis-truststore.jks \
    -storepass changeit'
```

The store password is `changeit`. If VIS and Engine are on separate machines,
copy `certs/vis-truststore.jks` (or just `server-cert.pem`, and run the command
above) on the Engine host.

**4. Point Engine at that truststore**

Mount the certs directory into the `wse` service in `docker-compose.yaml`:

```yaml
    wse:
        volumes:
             - ./certs:/certs:ro
```

Add these options to the `<VMOptions>` block in `wse/conf/Tune.xml`:

```xml
<VMOption>-Djavax.net.ssl.trustStore=/certs/vis-truststore.jks</VMOption>
<VMOption>-Djavax.net.ssl.trustStorePassword=changeit</VMOption>
```

Set `VIS_PROTOCOL=wss` plus the matching `VIS_HOST`/`VIS_PORT` in Engine's
`.env`, then restart Engine: `docker compose restart wse`.

**5. Verify**

```bash
# From the Engine host: the served cert and its SAN
openssl s_client -connect "$VIS_HOST:$VIS_PORT" -servername "$VIS_HOST" </dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
```

Then check Engine's log for a successful VIS connection.

**Several VIS hosts**

One Engine can target several VIS instances by overriding `vi_service_url` per
stream — see [One engine, many VIS](VLM_GUIDE.md#3-one-engine-many-vis). Repeat
steps 1–2 on each VIS host, then import every certificate into the *same*
truststore under its own alias:

```bash
keytool -importcert -noprompt -alias vis-b \
  -file vis-b-cert.pem -keystore certs/vis-truststore.jks -storepass changeit
```

Each certificate's SAN must match the host used in its own `vi_service_url`.
Step 4 stays the same — a single truststore covers all of them.

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
