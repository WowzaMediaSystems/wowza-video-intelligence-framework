# Deploying VIF on AWS (EC2 or ECS)

This guide walks through running the full VIF stack — Wowza Streaming Engine, Engine Manager, and the Video Intelligence Service (VIS) — on AWS.

**Recommended path: a single EC2 GPU instance running the Docker Compose stack from this repository.** That is the setup this repo ships ready-to-run; everything in the [main README](../README.md) applies unchanged once the instance is prepared. An [ECS section](#ecs-deployment-notes) at the end covers what changes when you port the stack to ECS.

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

- **AMI:** Ubuntu Server 24.04 LTS (x86_64). The *AWS Deep Learning Base GPU AMI* also works and ships with the NVIDIA driver preinstalled — verify `nvidia-smi` reports driver **580 or higher** before skipping step 3.
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
| `8087` | TCP | WSE REST API | Your admin IP only |

> [!CAUTION]
> Never open `8087` (REST API) or `8088` (Manager) to `0.0.0.0/0`. The safest setup keeps both closed in the security group and reaches them through an SSH tunnel (step 6). As a second layer, `IPWHITELIST` in `.env` restricts which source IPs the REST API accepts (the default already covers private ranges — add your admin IP only if you call the REST API across the internet).

### 3. Install the NVIDIA driver (580+)

```bash
sudo apt update
sudo ubuntu-drivers install --gpgpu nvidia:580-server
sudo reboot
```

After the reboot, confirm the driver:

```bash
nvidia-smi   # Driver Version must be 580 or higher
```

### 4. Install Docker and the NVIDIA Container Toolkit

```bash
# Docker Engine + Compose v2
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out/in (or re-SSH) to pick this up

# NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -sL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify Docker can reach the GPU:

```bash
docker run --rm --gpus 'all' -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility \
  nvidia/cuda:12.8.0-base-ubuntu22.04 nvidia-smi
```

### 5. Get the stack and configure it

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

### 6. Start and verify

```bash
docker compose up -d
docker compose ps        # wait for video-intelligence-service-gpu to report "healthy"
docker compose logs -f video-intelligence-service-gpu   # watch first-boot progress
```

> [!NOTE]
> The **first start can take 20+ minutes**: VIS downloads model weights and compiles TensorRT engines for your GPU. The engines are cached under `./vis/models`, so later restarts take 1–3 minutes.

Reach the Manager UI without opening port 8088 by tunnelling it over SSH from your workstation:

```bash
ssh -L 8088:localhost:8088 ubuntu@<instance-dns>
# then open http://localhost:8088 locally
```

### 7. Publish a test stream

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

## ECS Deployment (notes)

The compose stack ports to ECS, with these adjustments:

- **Launch type:** EC2 with the *ECS GPU-optimized AMI* (verify its driver is 580+). Fargate does not offer GPUs.
- **Task layout:** run Engine + Manager as one service, and VIS as its own service pinned to the GPU capacity. Give the VIS container a GPU via `resourceRequirements: [{type: "GPU", value: "1"}]` and keep the `NVIDIA_DRIVER_CAPABILITIES` environment values from the compose file.
- **Init one-shots:** `vis-init` (and `svd-cache-init` for the SVD profile) become containers in the same task with `essential: false` and a `dependsOn` condition of `SUCCESS` on the main container — the same ordering `depends_on: service_completed_successfully` gives in compose.
- **Service discovery:** containers in one task (`awsvpc` mode) share a network namespace, so within a task `VIS_HOST=localhost` works. Across services, use ECS Service Connect / Cloud Map and set `VIS_HOST` to the service name — and once Engine and VIS are on different hosts, the hop must be `wss`/TLS, exactly as in the split EC2 topology above.
- **Volumes:** bind the `wse/*` and `vis/models` paths to host EBS storage on the container instance so config, VOD jobs, and the TensorRT engine cache survive task restarts. Keep the VIS service pinned to one instance family — the engine cache is per GPU architecture.
- **Secrets:** inject `WSE_LICENSE_KEY`, `VIS_LICENSE`, and `VIS_API_KEY` with `secrets` / `valueFrom` from Secrets Manager or SSM Parameter Store instead of a `.env` file.
- **Ingress:** front RTMP/RTSP/SRT with an NLB (TCP/UDP listeners) and HLS with an ALB; keep the Manager and REST ports off any internet-facing load balancer.

> [!TIP]
> Validate your configuration on a single EC2 instance with compose first, then port it. Debugging stream rules and GPU plumbing is much faster with `docker compose logs -f` than through task definitions.

## Troubleshooting

| Problem | Action |
|---|---|
| Instance launch fails with a vCPU limit error | Request a G-instance quota increase (see step 1) |
| `nvidia-smi` not found / no devices | Driver not installed or instance not rebooted after install (step 3) |
| `docker run --gpus` test fails | Container toolkit missing or Docker not restarted after `nvidia-ctk runtime configure` (step 4) |
| VIS exits immediately at startup | `SECURE_MODE=true` (default) refuses to start without a non-empty `VIS_API_KEY` — set one in `.env` |
| First stream analyzes after a long delay | First boot compiles TensorRT engines (20+ min); watch `docker compose logs -f video-intelligence-service-gpu` |
| Disk fills up | Size the root volume 100 GB+; `docker image prune` after upgrades; old engines under `./vis/models/engines` can be cleared |
| Manager/REST unreachable | Security group, SSH tunnel, and `IPWHITELIST` in `.env` all gate access — check all three |
