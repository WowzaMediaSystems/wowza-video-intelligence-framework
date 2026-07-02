# Tier-A Security Hardening — Verification Guide

This document describes the secure-by-default hardening applied to the VIF
docker-compose stack and how to verify each behavior. It is intended for anyone
validating a deployment or reviewing the changes.

## What was hardened

| Area | Change | Ticket |
|---|---|---|
| VIS network exposure | The Video Intelligence Service (VIS) port is no longer published to the host by default; VIS is reached over the internal Docker bridge. VIS fails closed (refuses to start) without an API key unless explicitly opted out. | A1 |
| WSE control plane | `IPWHITELIST` is an operator-configurable `.env` knob (default `*`). Control ports stay published; hardening is via a strong admin password, TLS, IPWHITELIST narrowing, and a host firewall. | A4 |
| Non-root VIS | The VIS service process runs as a non-root user (`vis`, uid/gid `1001`). | A5 |
| Transport encryption | Documentation and an opt-in TLS-terminating reverse proxy for encrypting the Engine↔VIS link when they run on different hosts. | A2 |

> **Cross-repo dependency.** The API-key fail-closed behavior (`SECURE_MODE`),
> the non-root runtime, and the SSL-disabled boot warning are implemented in the
> **VIS service image**. Tests that exercise them require a VIS image that
> includes those changes. Record the image tag under test.

## Prerequisites & environments

| Environment | Needed for |
|---|---|
| Host with an NVIDIA GPU | Any test that starts VIS (inference, model init) |
| A second machine on the LAN | Tests that assert something is / isn't reachable from another host |
| VIS image with the service-side changes | `SECURE_MODE`, non-root, SSL boot warning |

Setup:
```bash
cp .env.example .env      # set WSE_LICENSE_KEY, VIS_LICENSE, WSE_ADMIN_PASSWORD, VIS_API_KEY
```
Throughout, the VIS container is referred to as `$VIS`:
```bash
VIS=$(docker compose ps -q video-intelligence-service-gpu)
```

### Testing reachability on WSL2 (important)

On WSL2, Docker runs inside a NAT'd VM, so by default **no** service is
reachable from other LAN hosts regardless of how it is bound. A failed
connection from another machine therefore does **not** prove a binding is
correct. To get a faithful topology, either enable **mirrored networking**
(`.wslconfig` → `[wsl2]` → `networkingMode=mirrored`, then `wsl --shutdown`), or
run the reachability tests on a native Linux host / cloud VM. From Windows on
the same box, services reach WSL over `localhost` (localhost forwarding), which
is *not* a substitute for a real remote-host test.

---

## Static checks (no runtime)

| # | Check | Command | Expected |
|---|---|---|---|
| S1 | `.env.example` ships no real API key | `grep '^VIS_API_KEY=' .env.example` | `VIS_API_KEY=` (empty) |
| S2 | Secure mode defaults on | `grep '^SECURE_MODE=' .env.example` | `SECURE_MODE=true` |
| S3 | `IPWHITELIST` is a configurable knob | `grep 'IPWHITELIST' docker-compose.yaml` | `IPWHITELIST=${IPWHITELIST:-*}` (interpolated from `.env`) |
| S5 | VIS port not published | `docker compose config` | no `published: "5001"` under the VIS service |
| S7 | Compose validates (main + TLS overlay) | `docker compose config -q && docker compose -f docker-compose.yaml -f docker-compose.tls-proxy.yaml config -q` | exit 0 for both |
| S8 | TLS proxy config is valid | `docker run --rm -v $PWD/vis-tls-proxy.conf:/etc/nginx/nginx.conf:ro -v $PWD/certs:/certs:ro nginx:stable-alpine nginx -t` | "syntax is ok / test is successful" |

---

## VIS network exposure (A1)

| # | Case | Steps | Expected |
|---|---|---|---|
| A1.1 | Port 5001 not published on the host | `docker compose --profile vi-service up -d`; `docker compose port video-intelligence-service-gpu 5001`; `curl -sS --max-time 3 http://localhost:5001/health` | `port` returns nothing; curl **fails** (connection refused) |
| A1.2 | Port 5001 not reachable from the LAN | from another host: `nc -zv <host-lan-ip> 5001` | **fails / times out** |
| A1.3 | Engine reaches VIS on the bridge | full stack up; confirm connectivity (see command below) | VIS resolves and accepts on the bridge; no "Connection refused" in WSE logs |
| A1.4 | Fail-closed without a key *(needs VIS image support)* | `VIS_API_KEY=` + `SECURE_MODE=true`; `docker compose --profile vi-service up` | VIS **refuses to start**, non-zero exit, explicit log |
| A1.5 | Starts with a key | `VIS_API_KEY=$(openssl rand -hex 32)` + `SECURE_MODE=true` | VIS starts |
| A1.6 | Conscious opt-out | `VIS_API_KEY=` + `SECURE_MODE=false` | VIS starts without auth |

Bridge connectivity check (A1.3):
```bash
NET=$(docker inspect "$VIS" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
docker run --rm --network "$NET" busybox nc -z -w3 video-intelligence-service.docker 5001 && echo OPEN
```

---

## WSE control plane (A4)

Control ports stay published and `IPWHITELIST` defaults to `*`. The hardening
is that `IPWHITELIST` is an operator-configurable `.env` knob, plus
admin-password / TLS / firewall guidance.

| # | Case | Steps | Expected |
|---|---|---|---|
| A4.1 | REST/Manager reachable | `docker compose --profile default up -d`; `docker compose port wse 8087`; `docker compose port manager 8080` | published on `0.0.0.0` |
| A4.2 | REST API reachable with auth | from another machine: `curl -u admin:$WSE_ADMIN_PASSWORD http://<wse-host>:8087/v2/servers/_defaultServer_` | `200` (or `401` on wrong credentials) |
| A4.3 | `IPWHITELIST` is a knob, default `*` | `docker compose exec wse env \| grep IPWHITELIST` | `IPWHITELIST=*` |
| A4.4 | **Manager ↔ WSE works out of the box** | open `http://<wse-host>:8088`, log in, browse a server/app | Manager lists WSE data |
| A4.5 | `IPWHITELIST` is operator-configurable | set `IPWHITELIST=127.0.0.1,10.0.0.5` in `.env`; `up`; `docker compose exec wse env \| grep IPWHITELIST` | reflects the new value (and REST then rejects other IPs) |
| A4.6 | Placeholder admin password rejected *(needs WSE image support)* | leave `WSE_ADMIN_PASSWORD=CHANGE_THIS_PASSWORD`; `up` | WSE warns/refuses to start (the primary A4 mitigation; lives in the WSE image) |

---

## Non-root VIS service (A5)

The VIS process runs as `vis` (uid/gid `1001`).

> **Verify the service process, not an `exec` shell.** The container starts as
> root and drops to `vis` at launch, so a fresh `docker exec … id` reports
> `root` — that is the exec session's user, **not** the running service. Inspect
> PID 1 (or `docker top`) instead.

| # | Case | Command | Expected |
|---|---|---|---|
| A5.1 | Service process is non-root | `docker top "$VIS"` — or `docker exec "$VIS" cat /proc/1/status \| grep ^Uid` | `UID 1001` / `Uid: 1001 1001 1001 1001` |
| A5.2 | Writes succeed on host-owned bind mounts | leave `./vis/logs` and `./vis/models` owned by root (or remove them so Docker recreates them as root); `up` | VIS starts with **no `EACCES`**; `vis/logs/videointelligenceservice.log` is written |
| A5.3 | Ownership after boot | `ls -lan vis/logs vis/models` | owned by `1001:1001` |
| A5.4 | Checkpoint download | first clean start | `.pth` files land in `vis/models/`, no permission error |
| A5.5 | TensorRT engine build | first start | artifacts appear under `vis/models/engines/` |
| A5.6 | Log rotation | run for a while / force rotation | rotates under `vis/logs/` without `EACCES` |
| A5.7 | GPU inference unaffected | run a detection stream | detections succeed; GPU active in `nvidia-smi` |

---

## Transport encryption for remote VIS (A2)

Plaintext `ws://` is only safe when Engine and VIS share a host (traffic stays
on the internal bridge). For a remote VIS, terminate TLS at the bundled proxy.

| # | Case | Steps | Expected |
|---|---|---|---|
| A2.1 | Boot log warns when SSL is off *(needs VIS image support)* | start VIS without SSL; `docker compose logs video-intelligence-service-gpu \| grep -i ssl` | a **WARNING** that the server is starting without SSL |
| A2.2 | Proxy starts and presents the cert | place a cert/key at `./certs/server-cert.pem` and `./certs/server-key.pem`; `docker compose -f docker-compose.yaml -f docker-compose.tls-proxy.yaml --profile vi-service up -d`; `openssl s_client -connect localhost:5443 </dev/null` | TLS handshake succeeds, cert shown |
| A2.3 | `wss` routes through to VIS | `curl -k https://localhost:5443/` | proxied to VIS (`video-intelligence-service.docker:5001`) |
| A2.4 | WebSocket upgrade passes | `websocat -k wss://localhost:5443/<path>` | `101` upgrade, connects |
| A2.5 | Real CA cert validates without `-k` | use a CA-issued cert; set `VIS_HOST` to the cert's name | `curl https://<host>:5443/` validates without `-k` |
| A2.6 | Docs/.env require `wss` for remote | `grep -rn 'MUST use \`wss\`\|MUST use wss' docs/VIS_DEPLOYMENT.md .env.example` | callouts present |

Engine side, when using the proxy:
```
VIS_PROTOCOL=wss
VIS_HOST=<proxy-host-public-name>   # must match the certificate
VIS_PORT=5443                       # = VIS_TLS_PORT
```

---

## Known behaviors & gotchas

- **`VIS_HOST` for a same-host stack must be the bridge hostname**
  (`video-intelligence-service.docker`), not `host.docker.internal` or a host
  IP. Because the VIS port is no longer published, an Engine configured to reach
  VIS through the host will get "Connection refused". This is a migration point
  for `.env` files carried over from older deployments.
- **Container health status** depends on tooling present in the VIS image; if a
  health check reports `unhealthy` while the service is demonstrably up and
  serving, confirm the check command can run inside the image.
- **`wss` must target the TLS proxy, not VIS.** With `VIS_PROTOCOL=wss`, set
  `VIS_HOST`/`VIS_PORT` to the proxy (`:5443`). Pointing at VIS's plaintext port
  (`:5001`) yields `Unsupported or unrecognized SSL message`; an untrusted or
  name-mismatched cert yields a certification-path error. Use a CA-issued cert
  whose name matches `VIS_HOST`.
- **Media/streaming ports** (80/443/554/1935, WebRTC, SRT) remain published on
  all interfaces by design — only the control and VIS-internal ports were
  restricted.
