# Deploying VIF on AWS (EC2)

This guide walks through running the full VIF stack — Wowza Streaming Engine, Engine Manager, and the Video Intelligence Service (VIS) — on a single EC2 GPU instance with the Docker Compose stack from this repository. That is the setup this repo ships ready-to-run; everything in the [main README](../README.md) applies unchanged once the instance is prepared.

## EC2 Deployment

### 1. Pick an instance type

Match the instance to the [Compute Requirements](../README.md#compute-requirements-self-hosted-vif) (baseline: ~8 concurrent 720p streams at up to 10 FPS on RF-DETR Medium):

| Workload | Minimum | Recommended |
|---|---|---|
| Object, motion, and scene detection | `g4dn.2xlarge` (1× T4 16 GB, 8 vCPU, 32 GB) | `g6.2xlarge` (1× L4 24 GB, 8 vCPU, 32 GB) or `g6.4xlarge` (16 vCPU, 64 GB) |
| + VLM sidecar (`--profile vlm`) | `g6e.2xlarge` (1× L40S 48 GB, 8 vCPU, 64 GB) — VIS and the VLM share one large card | `g6.12xlarge` (4× L4, 48 vCPU, 192 GB) — give the VLM its own card with `VLM_GPU_IDS` |
| + Synthetic Video Detection (`--profile svd`) | The SVD NIM needs an NVENC/NVDEC GPU. T4 (`g4dn`), L4 (`g6`), and L40S (`g6e`) are on the [support matrix](SYNTHETIC_VIDEO_DETECTOR.md#gpu-support-matrix); A100/H100 (`p4`/`p5`) are **not**. On a multi-GPU instance, dedicate a card to the NIM | |

> [!NOTE]
> New AWS accounts often have a **0 vCPU quota for G-type instances**. If the launch fails with a vCPU-limit error, request a quota increase for *Running On-Demand G and VT instances* in the Service Quotas console first — approval can take a day.

### 2. Launch the instance

- **AMI:** **Deep Learning Base AMI with Single CUDA (Ubuntu 24.04)** — it ships with the NVIDIA driver, Docker, and the NVIDIA Container Toolkit preinstalled, so no GPU or Docker setup is needed. (A plain Ubuntu AMI works too, but then you install the NVIDIA driver **580+**, Docker, and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) yourself.)
- **Storage:** 100 GB+ gp3 root volume. Container images, model weights, the TensorRT engine cache, and (with the VLM sidecar) ~5 GB of VLM weights all live here; 32 GB fills up fast.
- **Addressing:** attach an Elastic IP (or stable DNS name) if encoders will publish to the instance or viewers will play from it.

**Security group** — open only what you use, to only who needs it:

| Port | Protocol | Purpose | Open to |
|---|---|---|---|
| `22` | TCP | SSH | Your admin IP |
| `1935` | TCP | RTMP publish | Encoder IPs |
| `554` | TCP | RTSP | Encoder/viewer IPs (if used) |
| `80` / `443` | TCP | HLS playback | Viewers, as needed |
| `10000` | UDP | SRT | Encoder IPs (if used) |
| `6970–6999` | UDP | WebRTC | As needed |
| `8088` | TCP | Manager UI | Your admin IP only — or keep closed and use the SSH tunnel below |
| `8087` | TCP | WSE REST API | Same as `8088` — the Manager's VIF pages call this port from your browser, so the two always open (or tunnel) together |

> [!CAUTION]
> Never open `8087` (REST API) or `8088` (Manager) to `0.0.0.0/0`. The safest setup keeps both closed in the security group and reaches them through an SSH tunnel (step 5). As a second layer, `IPWHITELIST` in `.env` restricts which source IPs the REST API accepts (the default already covers private ranges — add your admin IP only if you call the REST API across the internet).

### 3. Verify the GPU and Docker

```bash
nvidia-smi   # Driver Version must be 580 or higher
docker run --rm --gpus 'all' -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility \
  nvidia/cuda:12.8.0-base-ubuntu22.04 nvidia-smi
```

Both should list your GPU. If the `docker run` fails, the NVIDIA Container Toolkit is missing — use the Deep Learning Base AMI above, or follow the [install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

### 4. Get the stack and configure it

```bash
git clone https://github.com/WowzaMediaSystems/wowza-video-intelligence-framework.git
cd wowza-video-intelligence-framework
cp .env.example .env
```

Edit `.env` and set at minimum:

- `WSE_LICENSE_KEY` — your [Wowza Streaming Engine license](https://auth.wowza.com/register?type=engine)
- `WSE_ADMIN_USER` / `WSE_ADMIN_PASSWORD` — a strong password, not the placeholder
- `VIS_LICENSE` — your Video Intelligence Service license
- `VIS_API_KEY` — a strong random secret, e.g. `openssl rand -hex 32` (VIS refuses to start without one while `SECURE_MODE=true`, the default)

Leave `VIS_PROTOCOL=ws` and `VIS_HOST=video-intelligence-service.docker` as they are — on a single instance, Engine and VIS talk over the internal Docker bridge.

### 5. Start and verify

```bash
docker compose up -d
docker compose ps        # wait for video-intelligence-service-gpu to report "healthy"
docker compose logs -f video-intelligence-service-gpu   # watch first-boot progress
```

> [!NOTE]
> The **first start can take 20+ minutes**: VIS downloads model weights and compiles TensorRT engines for your GPU. The engines are cached under `./vis/models`, so later restarts take 1–3 minutes.

Reach the Manager UI without opening ports 8088 and 8087 by tunnelling both over SSH from your workstation. Both, because the VIF pages in the Manager call the Engine REST API (port 8087) directly from your browser — with only 8088 forwarded, the Manager loads but the VIF tab reports *"Offline — lost connection to the Engine"*:

```bash
ssh -L 8088:localhost:8088 -L 8087:localhost:8087 ubuntu@<instance-dns>
# then open http://localhost:8088 locally
```

### 6. Publish a test stream

From your workstation (with [FFmpeg](https://www.ffmpeg.org/download.html) installed), publish any MP4 — for example a sample clip from this repository's `videos/` folder — to the instance. A stream name matching `object.*` triggers object detection:

```bash
ffmpeg -stream_loop -1 -re -i "./videos/vi-object-detection-landscape.mp4" \
  -r 25 -g 50 -c:v libx264 -preset veryfast -b:v 2000k -c:a aac -b:a 128k \
  -f flv "rtmp://<instance-dns>/live/object_test1"
```

Then check:

- the VIF dashboard in Manager (`http://localhost:8088/Home.htm#plugin/server/vif/shm.html` through the tunnel), and
- the overlay rendition at `http://<instance-dns>/live/object_test1-vi/playlist.m3u8` (port 80 open), or the Manager's built-in playback page.

### Production notes

- **Reboots:** Docker starts on boot and the services use `restart: unless-stopped`, so the stack survives instance restarts on its own.
- **Keep `./vis/models`:** the TensorRT engine cache is built per GPU architecture. If you replace the instance with the same instance family, carrying this directory over (EBS snapshot or copy) skips the long first-boot compile. After major VIS or model upgrades, clear `./vis/models/engines` as described in [Persistent Volume Mounts](../README.md#persistent-volume-mounts).
- **Upgrades:** `docker compose pull && docker compose up -d`, with a `docker compose down` between version changes.
- **Secrets:** `.env` holds license keys and the VIS API key. Don't bake it into AMIs or paste it into user-data; keep it on the instance (or template it from SSM Parameter Store / Secrets Manager at boot).

### Split topology: Engine and VIS on separate instances

For production you can run Engine on a CPU instance (e.g. `c6i.4xlarge`) and VIS on the GPU instance:

1. On the GPU instance, start VIS alone behind the bundled TLS proxy (a cross-host hop **must** be `wss`): follow [Remote VIS — TLS via the bundled reverse proxy](VIS_DEPLOYMENT.md#remote-vis--tls-via-the-bundled-reverse-proxy-recommended).
2. In the VIS instance's security group, open the TLS port (`5443` by default) **only to the Engine instance's security group**, not to the internet.
3. On the Engine instance, run `docker compose --profile wse up -d` with `.env` pointing at the proxy: `VIS_PROTOCOL=wss`, `VIS_HOST=<vis-instance-dns>` (must match the certificate), `VIS_PORT=5443`, and the same `VIS_API_KEY` on both sides.

## Troubleshooting

| Problem | Action |
|---|---|
| Instance launch fails with a vCPU limit error | Request a G-instance quota increase (see step 1) |
| `nvidia-smi` not found / no devices | Use the Deep Learning Base AMI (step 2), or install the NVIDIA driver (580+) yourself on a plain Ubuntu AMI |
| `docker run --gpus` test fails | NVIDIA Container Toolkit missing — preinstalled on the Deep Learning Base AMI; otherwise follow [NVIDIA's install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) |
| VIS exits immediately at startup | `SECURE_MODE=true` (default) refuses to start without a non-empty `VIS_API_KEY` — set one in `.env` |
| First stream analyzes after a long delay | First boot compiles TensorRT engines (20+ min); watch `docker compose logs -f video-intelligence-service-gpu` |
| Disk fills up | Size the root volume 100 GB+; `docker image prune` after upgrades; old engines under `./vis/models/engines` can be cleared |
| VIF tab shows "Offline — lost connection to the Engine" while the rest of Manager works | The VIF pages call the Engine REST API (8087) from your browser — forward 8087 in the SSH tunnel alongside 8088 (step 5), or open both ports to the same admin IP |
| Manager/REST unreachable | Security group, SSH tunnel, and `IPWHITELIST` in `.env` all gate access — check all three |
