# Deploying VIF on Google Cloud (Compute Engine)

This guide walks through running the full VIF stack — Wowza Streaming Engine, Engine Manager, and the Video Intelligence Service (VIS) — on a single Compute Engine GPU VM with the Docker Compose stack from this repository. That is the setup this repo ships ready-to-run; everything in the [main README](../README.md) applies unchanged once the VM is prepared.

The commands below use the [gcloud CLI](https://cloud.google.com/sdk/docs/install); every step can also be done in the Cloud Console. Replace `ZONE` with a zone that offers your GPU (`gcloud compute accelerator-types list --filter="zone:ZONE"`).

## Compute Engine Deployment

### 1. Pick a machine type

Match the VM to the [Compute Requirements](../README.md#compute-requirements-self-hosted-vif) (baseline: ~8 concurrent 720p streams at up to 10 FPS on RF-DETR Medium). On Google Cloud, L4 GPUs come built into **G2** machine types; T4 GPUs are attached to **N1** machine types.

| Workload | Minimum | Recommended |
|---|---|---|
| Object, motion, and scene detection | `n1-standard-8` + 1× T4 16 GB (8 vCPU, 30 GB) | `g2-standard-8` (1× L4 24 GB, 8 vCPU, 32 GB) or `g2-standard-16` (16 vCPU, 64 GB) |
| + VLM sidecar (`--profile vlm`) | `g2-standard-24` (2× L4, 24 vCPU, 96 GB) — give the VLM its own card with `VLM_GPU_IDS=1` | `g2-standard-48` (4× L4, 48 vCPU, 192 GB), or `g4-standard-48` (1× RTX PRO 6000 Blackwell 96 GB, 48 vCPU, 180 GB) where VIS and the VLM share one large card |
| + Synthetic Video Detection (`--profile svd`) | The SVD NIM needs an NVENC/NVDEC GPU. T4, L4 (`g2`), and RTX PRO 6000 Blackwell (`g4`) are on the [support matrix](SYNTHETIC_VIDEO_DETECTOR.md#gpu-support-matrix); A100/H100 (`a2`/`a3`) are **not**. On a multi-GPU VM, dedicate a card to the NIM | |

> [!NOTE]
> - **GPU quota:** GPU VMs need two quotas in the region you deploy to: the global **GPUs (all regions)** quota and the per-family regional quota (`GPU_FAMILY:NVIDIA_L4` for G2, `NVIDIA_T4_GPUS` for T4, `GPU_FAMILY:NVIDIA_RTX_PRO_6000` for G4). Check them on the *IAM & Admin → Quotas* page and request an increase before you create the VM — new projects often can't launch a GPU VM until you do.
> - **T4 end of support:** Google lists NVIDIA T4 GPUs as reaching end of support on August 1, 2027. Prefer G2 (L4) for new deployments.
> - **Avoid fractional G4 sizes** (`g4-standard-6` / `-12` / `-24` get 1/8–1/2 of a GPU): they need a vGPU driver that the image below does not include.

### 2. Create the VM

- **Image:** a **Deep Learning VM** image from project `deeplearning-platform-release`, family `common-cu129-ubuntu-2404-nvidia-580` — Ubuntu 24.04 with the NVIDIA **580** driver and CUDA preinstalled, so no driver setup is needed. Unlike the AWS Deep Learning AMI, Google does not document Docker or the NVIDIA Container Toolkit as part of these images, so step 3 checks for both. (A plain Ubuntu image works too, but then you also install the NVIDIA driver **580+** yourself.)
- **Maintenance policy:** GPU VMs can't live-migrate, so `--maintenance-policy=TERMINATE` is required. `--restart-on-failure` brings the VM back after host maintenance.
- **Boot disk:** 100 GB+. Container images, model weights, the TensorRT engine cache, and (with the VLM sidecar) ~5 GB of VLM weights all live here; a small disk fills up fast.
- **Addressing:** reserve a static external IP (or a stable DNS name) if encoders will publish to the VM or viewers will play from it.

G2 (L4) example:

```bash
gcloud compute instances create vif-1 \
  --zone=ZONE \
  --machine-type=g2-standard-8 \
  --maintenance-policy=TERMINATE --restart-on-failure \
  --image-project=deeplearning-platform-release \
  --image-family=common-cu129-ubuntu-2404-nvidia-580 \
  --boot-disk-size=100GB --boot-disk-type=pd-balanced \
  --tags=vif
```

For a T4, use `--machine-type=n1-standard-8 --accelerator=type=nvidia-tesla-t4,count=1` instead (G2 and G4 machine types include their GPUs, so they take no `--accelerator` flag). G4 machine types use Hyperdisk only: pass `--boot-disk-type=hyperdisk-balanced`.

**Firewall rules** — open only what you use, to only who needs it. The rules target the `vif` network tag set above:

| Port | Protocol | Purpose | Open to |
|---|---|---|---|
| `22` | TCP | SSH | Your admin IP — or only IAP's range `35.235.240.0/20` (see step 5) |
| `1935` | TCP | RTMP publish | Encoder IPs |
| `554` | TCP | RTSP | Encoder/viewer IPs (if used) |
| `80` / `443` | TCP | HLS playback | Viewers, as needed |
| `10000` | UDP | SRT | Encoder IPs (if used) |
| `6970–6999` | UDP | WebRTC | As needed |
| `8088` | TCP | Manager UI | Your admin IP only — or keep closed and use the SSH tunnel below |
| `8087` | TCP | WSE REST API | Same as `8088` — the Manager's VIF pages call this port from your browser, so the two always open (or tunnel) together |

For example, to let one encoder publish over RTMP:

```bash
gcloud compute firewall-rules create vif-rtmp \
  --allow=tcp:1935 --source-ranges=ENCODER_IP/32 --target-tags=vif
```

Always pass `--source-ranges`: a rule without one defaults to `0.0.0.0/0`, the whole internet.

> [!CAUTION]
> Don't open `8087` (REST API) or `8088` (Manager) to `0.0.0.0/0` — out of the box, both carry admin credentials over plain HTTP. The SSH tunnel (step 5) is the recommended way in: both ports stay closed and the hop is encrypted. Opening them to your admin IP works too, but the traffic is still cleartext — fine across a VPN or private network, not the open internet. Serving the Manager over TLS on `8443` instead takes extra setup: a keystore mounted into the Manager container (`JKS_FILE`) **and** TLS enabled on the REST API (`SSLConfig` in `Server.xml`), because an HTTPS Manager page makes your browser call the REST API over HTTPS as well. As a second layer, `IPWHITELIST` in `.env` restricts which source IPs the REST API accepts (the default already covers private ranges — add your admin IP only if you call the REST API across the internet).

### 3. Prepare the GPU and Docker

SSH in (`gcloud compute ssh vif-1 --zone=ZONE`) and check the driver:

```bash
nvidia-smi   # Driver Version must be 580 or higher
```

Then check that Docker is installed and has the `nvidia` runtime registered — the VIS service in `docker-compose.yaml` runs with `runtime: nvidia`, so it won't start without it:

```bash
docker --version
docker info | grep -i runtimes   # must list "nvidia"
```

If Docker is missing, install Docker Engine and the Compose plugin following [Docker's Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/), then let your user run it without `sudo` (log out and back in afterwards):

```bash
sudo usermod -aG docker $USER
```

If `nvidia` is not among the runtimes, install the NVIDIA Container Toolkit (from [NVIDIA's install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)) and register it with Docker:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Finally, confirm a container can see the GPU:

```bash
docker run --rm --gpus 'all' -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility \
  nvidia/cuda:12.8.0-base-ubuntu22.04 nvidia-smi
```

> [!NOTE]
> This `--gpus` test can pass even when the `nvidia` runtime is **not** registered, so check `docker info` as well — otherwise VIS fails later with `unknown or invalid runtime name: nvidia`.

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

Leave `VIS_PROTOCOL=ws` and `VIS_HOST=video-intelligence-service.docker` as they are — on a single VM, Engine and VIS talk over the internal Docker bridge.

If you run the VLM sidecar, also decide where it lives. On a multi-GPU machine type, set `VLM_GPU_IDS=1` in `.env` to give it its own card. On a single GPU, lower `VLM_GPU_MEMORY_UTILIZATION` so VIS still fits next to it — see [Defaults: it just works](VLM_GUIDE.md#defaults-it-just-works) in the VLM guide.

### 5. Start and verify

```bash
docker compose up -d                                  # object, motion, and scene detection
# or, with the VLM sidecar:
docker compose --profile default --profile vlm up -d
docker compose ps        # wait for video-intelligence-service-gpu to report "healthy"
docker compose logs -f video-intelligence-service-gpu   # watch first-boot progress
```

> [!NOTE]
> The **first start can take 20+ minutes**: VIS downloads model weights and compiles TensorRT engines for your GPU. The engines are cached under `./vis/models`, so later restarts take 1–3 minutes.

Reach the Manager UI without opening ports 8088 and 8087 by tunnelling both over SSH from your workstation. Both, because the VIF pages in the Manager call the Engine REST API (port 8087) directly from your browser — with only 8088 forwarded, the Manager loads but the VIF tab reports *"Offline — lost connection to the Engine"*. Arguments after `--` are passed to `ssh`:

```bash
gcloud compute ssh vif-1 --zone=ZONE -- -L 8088:localhost:8088 -L 8087:localhost:8087
# then open http://localhost:8088 locally
```

Through the tunnel, the browser's REST calls reach the Engine from inside the VM, so the default `IPWHITELIST` already allows them.

To keep port 22 closed to the internet as well, add `--tunnel-through-iap` to the command above and allow SSH only from IAP's range (your account needs the *IAP-secured Tunnel User* role):

```bash
gcloud compute firewall-rules create vif-ssh-iap \
  --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=vif
```

### 6. Publish a test stream

From your workstation (with [FFmpeg](https://www.ffmpeg.org/download.html) installed), publish any MP4 — for example a sample clip from this repository's `videos/` folder — to the VM. A stream name matching `object.*` triggers object detection:

```bash
ffmpeg -stream_loop -1 -re -i "./videos/vi-object-detection-landscape.mp4" \
  -r 25 -g 50 -c:v libx264 -preset veryfast -b:v 2000k -c:a aac -b:a 128k \
  -f flv "rtmp://<vm-external-ip>/live/object_test1"
```

Then check:

- the VIF dashboard in Manager (`http://localhost:8088/Home.htm#plugin/server/vif/shm.html` through the tunnel), and
- the overlay rendition at `http://<vm-external-ip>/live/object_test1-vi/playlist.m3u8` (port 80 open), or the Manager's built-in playback page.

### Production notes

- **Reboots and host maintenance:** GPU VMs stop for host maintenance instead of live-migrating. With `--restart-on-failure` the VM comes back on its own; Docker starts on boot and the services use `restart: unless-stopped`, so the stack follows.
- **Keep `./vis/models`:** the TensorRT engine cache is built per GPU architecture. If you replace the VM with the same machine series, carrying this directory over (disk snapshot or copy) skips the long first-boot compile. After major VIS or model upgrades, clear `./vis/models/engines` as described in [Persistent Volume Mounts](../README.md#persistent-volume-mounts).
- **Upgrades:** `docker compose pull && docker compose up -d`, with a `docker compose down` between version changes.
- **Secrets:** `.env` holds license keys and the VIS API key. Don't bake it into custom images or put it in instance metadata or startup scripts; keep it on the VM (or template it from Secret Manager at boot).

### Split topology: Engine and VIS on separate VMs

For production you can run Engine on a CPU VM (e.g. `n2-standard-16`) and VIS on the GPU VM:

1. On the GPU VM, start VIS alone behind the bundled TLS proxy (a cross-host hop **must** be `wss`): follow [Remote VIS — TLS via the bundled reverse proxy](VIS_DEPLOYMENT.md#remote-vis--tls-via-the-bundled-reverse-proxy-recommended).
2. Tag the VMs (e.g. `vif-engine` and `vif-vis`) and open the TLS port (`5443` by default) **only from the Engine VM**, not the internet:
   ```bash
   gcloud compute firewall-rules create vif-vis-tls \
     --allow=tcp:5443 --source-tags=vif-engine --target-tags=vif-vis
   ```
3. On the Engine VM, run `docker compose --profile wse up -d` with `.env` pointing at the proxy: `VIS_PROTOCOL=wss`, `VIS_HOST=<vis-vm-dns>` (must match the certificate), `VIS_PORT=5443`, and the same `VIS_API_KEY` on both sides.

## Troubleshooting

| Problem | Action |
|---|---|
| VM creation fails with a quota error | Request both the **GPUs (all regions)** quota and the regional GPU-family quota (see step 1) |
| VM creation fails with `ZONE_RESOURCE_POOL_EXHAUSTED` | The zone has no free GPUs of that type right now — retry later or pick another zone that offers it |
| `nvidia-smi` not found / no devices | Use the `common-cu129-ubuntu-2404-nvidia-580` Deep Learning VM image (step 2), or install the NVIDIA driver (580+) yourself on a plain Ubuntu image |
| `docker run --gpus` test fails | NVIDIA Container Toolkit missing — install it (step 3) |
| VIS fails with `unknown or invalid runtime name: nvidia` | The toolkit is installed but not registered with Docker — run `sudo nvidia-ctk runtime configure --runtime=docker` and `sudo systemctl restart docker` (step 3) |
| VIS exits immediately at startup | `SECURE_MODE=true` (default) refuses to start without a non-empty `VIS_API_KEY` — set one in `.env` |
| VIS or the VLM runs out of GPU memory | They share the card — set `VLM_GPU_IDS` on a multi-GPU machine type, or lower `VLM_GPU_MEMORY_UTILIZATION` (step 4) |
| First stream analyzes after a long delay | First boot compiles TensorRT engines (20+ min); watch `docker compose logs -f video-intelligence-service-gpu` |
| Disk fills up | Size the boot disk 100 GB+ (it can be resized in place); `docker image prune` after upgrades; old engines under `./vis/models/engines` can be cleared |
| VIF tab shows "Offline — lost connection to the Engine" while the rest of Manager works | The VIF pages call the Engine REST API (8087) from your browser — forward 8087 in the SSH tunnel alongside 8088 (step 5), or open both ports to the same admin IP |
| VIF tab shows "The Engine REST API refused this browser's address (403)" | Your browser's public IP is not in `IPWHITELIST` — use the SSH tunnel (step 5), or add your IP to `IPWHITELIST` in `.env` and recreate the stack |
| Manager/REST unreachable | Firewall rules, SSH tunnel, and `IPWHITELIST` in `.env` all gate access — check all three |
