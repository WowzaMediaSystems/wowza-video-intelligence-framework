# VOD Analysis Guide — analyzing video files

The Video Intelligence framework can analyze **video files** as well as live streams. A **VOD job** points one of the framework's detectors — object detection, scene analysis, VLM analysis, or synthetic video detection — at an MP4 file that is already on the Engine, runs it over the whole file as fast as the analysis backend allows, and leaves behind a complete, queryable record: every detection with its position on the video's timeline, a provenance manifest describing exactly what was run, and a thumbnail.

Everything is driven over the Wowza Streaming Engine REST API. Jobs run in the background, survive Engine restarts, recover automatically from transient failures, and can push status updates to your own service via webhooks — so a single `POST` is enough to fire and forget.

---

## Contents

1. [How it works](#how-it-works)
2. [Quick start](#quick-start)
3. [Choosing the analysis: inline detectors and stored configs](#choosing-the-analysis-inline-detectors-and-stored-configs)
4. [Inputs](#inputs)
5. [Outputs](#outputs)
6. [Playing the source file](#playing-the-source-file)
7. [On-disk layout](#on-disk-layout)
8. [Job lifecycle, failures, and resume](#job-lifecycle-failures-and-resume)
9. [Lifecycle webhooks](#lifecycle-webhooks)
10. [Global settings: the `vod` block](#global-settings-the-vod-block)
11. [Best practices](#best-practices)
12. [API reference](#api-reference)
13. [Troubleshooting](#troubleshooting)

---

## How it works

```
                    POST /vod/jobs
you ──REST──▶ Engine (VIF plugin) ──WebSocket──▶ VIS ──▶ model / VLM / SVD endpoint
                    │
                    ├── results/<job>.jsonl     every detection, timestamped
                    ├── manifests/<job>.json    what ran, how it ended
                    ├── thumbs/<job>/…          representative frame
                    └── lifecycle webhook ──▶ your service
```

A VOD job reuses the same detector configuration model as live streams — the same detector types, models, thresholds, class names, and event listeners. The differences that matter:

- **The file is the clock.** A live stream is analyzed at the rate it arrives; a VOD job runs as fast as the analysis service answers. A 10-minute file can finish in well under a minute, or take longer than 10 minutes with a heavyweight model — wall-clock time depends on the AI inference speed, not the video duration.
- **Progress is media time.** A job reports how far through the *video's timeline* it has gotten (`media_time_ms`), not how long it has been running.
- **Results are always kept raw.** Every response from the analysis service is stored as-is (unless you opt out), independent of any event-listener filtering. You can page through them over REST, filter them by time range, or download the whole file.
- **No output stream.** Event listeners that write into a stream (overlay rendering, ID3 injection) do not apply to a file job and are skipped; `LogFiles` and `Webhook` listeners work exactly as they do for live streams.

All detector types are supported:

| Detector type | Analysis | Windowing | Thumbnail |
|---|---|---|---|
| `object` | Object detection (RF-DETR family) | Decoded frames at `inference_fps` | Yes |
| `scene` | Scene analysis | Decoded frames at `inference_fps` | Yes |
| `vlm` | Vision-language model | Decoded frames at `inference_fps` | Yes |
| `synthetic` | Synthetic/AI-generated video detection | Keyframe-aligned clips of ~`duration` seconds | No (clips are relayed encoded, never decoded) |

## Quick start

Prerequisites: a running framework stack with `.env` populated (see the [README](../README.md)), and `WSE_ADMIN_USER` / `WSE_ADMIN_PASSWORD` exported in your shell. All VOD endpoints live under one base URL and authenticate with the Engine's REST admin credentials:

```bash
export WSE_ADMIN_USER=admin WSE_ADMIN_PASSWORD=your-password   # values from your .env
VIF="http://localhost:8087/v1/server/plugin/vif"
```

> [!NOTE]
> The framework configures the Engine REST API for HTTP Basic authentication, which is what `curl -u` speaks by default (stock Engine installs also ship `basic`). If your Engine is set to digest auth instead (`<AuthenticationMethod>` in `Server.xml`), add `--digest` to every `curl` call in this guide.

**1. Put a video where the Engine can see it.** Jobs analyze files under the Engine's content directory — `./wse/content` in a compose checkout:

```bash
cp videos/vi-object-detection-landscape.mp4 wse/content/
```

Or upload it over REST instead of copying — the Manager's VOD page does exactly this behind its Upload button and drag-and-drop:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -T videos/vi-object-detection-landscape.mp4 \
  "$VIF/vod/files/upload?file=vi-object-detection-landscape.mp4"
```

You can list what is analyzable at any time — the listing returns exactly the `file` strings a job submission takes:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/files"
```

**2. Submit a job.** This one runs object detection with an inline detector definition, sampling 5 frames per second; anything you don't specify is inherited from your global Video Intelligence defaults:

```bash
JOB_ID=$(curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
        "file": "vi-object-detection-landscape.mp4",
        "detector": {
          "detector_type": "object",
          "inference_fps": 5,
          "object_analysis": { "class_names": ["person", "car", "truck"] }
        },
        "tag": "quickstart"
      }' \
  "$VIF/vod/jobs" | sed -E 's/.*"job_id":"([^"]+)".*/\1/')
echo "$JOB_ID"
```

**3. Watch it run.** Poll the job until its `state` is terminal (`COMPLETED`, `FAILED`, or `CANCELLED`):

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs/$JOB_ID"
```

Or wait in one line:

```bash
until curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs/$JOB_ID" \
    | grep -qE '"state":"(COMPLETED|FAILED|CANCELLED)"'; do sleep 5; done
```

A file job runs as fast as the analysis service answers — this 74-second sample finishes in seconds against a local VIS:

```json
{"job_id":"ff612ac6-28e6-45be-b072-9078ef40e708","file":"vi-object-detection-landscape.mp4",
 "tag":"quickstart","state":"COMPLETED","requests_sent":370,"requests_total":371,
 "media_time_ms":73800,"queued_at":"2026-08-12 00:43:07.371",
 "started_at":"2026-08-12 00:43:07.439","ended_at":"2026-08-12 00:43:16.579"}
```

**4. Read the results.** Detections are served as pages of JSON rows, one row per analysis window, each stamped with its position on the video's timeline:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs/$JOB_ID/results?limit=2"
```

```json
{
  "job_id": "ff612ac6-…", "offset": 0, "limit": 2, "count": 2, "total": 370,
  "results": [
    {
      "type": "detections",
      "detector_type": "object",
      "stream_name": "vod-ff612ac6-28e6-45be-b072-9078ef40e708",
      "status": "success",
      "detection_window": {
        "from_frame": "00:00:00.000", "to_frame": "00:00:00.000",
        "from_time_code": 0, "to_time_code": 0, "frame_count": 1
      },
      "detections": [
        {"class_name": "person", "confidence": 0.94, "frame_id": 0,
         "bbox": {"x": 242, "y": 311, "w": 173, "h": 340, "x2": 415, "y2": 651}}
      ]
    },
    { "…": "one row per analysis window" }
  ]
}
```

Or download everything as one newline-delimited JSON file:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  -o results.jsonl "$VIF/vod/jobs/$JOB_ID/results?format=jsonl"
```

**5. Grab the thumbnail** — the frame currently under analysis while the job runs, a representative frame once it is done:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  -o thumbnail.jpg "$VIF/vod/jobs/$JOB_ID/thumbnail"
```

**6. Clean up when you no longer need the record:**

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X DELETE "$VIF/vod/jobs/$JOB_ID"
```

## Choosing the analysis: inline detectors and stored configs

Every submission names its analysis in exactly one of two ways:

**An inline detector** (`"detector": {…}`) carries the configuration in the request itself. The body is a standard Video Intelligence detector definition — the same fields you would put in a per-stream config file: `detector_type`, `inference_fps`, `duration`, the analysis block for the detector type (`object_analysis`, `scene_analysis`, `vlm_analysis`, `synthetic_analysis`), `vif_event_listeners`, and so on. Unset fields inherit from the global defaults (`Default.json`), so a minimal inline detector can be as small as `{"detector_type": "object"}`. See the [plugin configuration reference](README.wse-plugin.md) for the full field catalogue.

**A stored config** (`"config": "live_objectDotStar"`) references a configuration file under `conf.modules/vif/` by name (the file name, with or without `.json`). The framework ships ready-made entries — `live_objectDotStar`, `live_sceneDotStar`, `live_vlmDotStar`, `live_syntheticDotStar` — and any config you create through the Manager UI or REST API works the same way. The config's `stream_name` matching rule is irrelevant to a file job; only its analysis settings are used.

Which to use:

- **Stored configs** are right when the same analysis runs repeatedly, when you manage configurations centrally through the Manager UI, and when jobs should be resumable unattended — a stored config's credentials live in the config file, so the Engine can always reconstruct the job (see [resume](#job-lifecycle-failures-and-resume)).
- **Inline detectors** are right for programmatic, per-request variation. Note that inline credentials (a `vlm_analysis.api_key`, for example) are **never written to disk** — the job's manifest stores a redacted copy — which is good for secret hygiene, but means a failed inline job holding credentials can only be resumed by re-supplying them (automatic resume stands down and tells you why in the log).

The manifest records what was submitted either way, so "which configuration produced these detections" stays answerable even after a stored config is edited — including a hash of the config as it was at submit time.

## Inputs

- **Containers:** `.mp4`, `.m4v`, `.mov`, `.f4v` — anything else is not listed and not accepted.
- **Codec:** the file must carry an **H.264** video track.
- **Location:** files are named **relative to the content directory** (`vod.content_dir`, by default the Engine's `content/` folder — `./wse/content` in a compose checkout). Subdirectories work (`archive/cam3/monday.mp4`); paths that resolve outside the content root are refused. Files get there by copying them in or by [`PUT /vod/files/upload`](#put-vodfilesupload) — the Manager's Upload button and drag-and-drop.
- **Audio** is ignored; only the video track is analyzed.

> [!NOTE]
> Frame-decoded detector types (`object`, `scene`, `vlm`) decode the file with **ffmpeg**, which must be available on the Engine's `PATH`. Framework Engine images with the VOD feature ship a static build; a bring-your-own (standalone) Engine must have ffmpeg installed. Clip-based jobs (`synthetic`) relay encoded H.264 and do not need it.

The `GET /vod/files` endpoint lists what is currently analyzable (newest first, up to 500 entries, up to 6 directory levels deep) with sizes and modification times.

## Outputs

A job produces up to four things:

**1. The job view** — live progress and final status over REST (`GET /vod/jobs/{jobId}`), also the payload of every lifecycle webhook. Fields:

| Field | Meaning |
|---|---|
| `job_id` | The job's identifier, assigned at submit. |
| `file` | The source path as submitted. |
| `tag` | The label the job was submitted with, if any. |
| `store_results` | Present only as `false`, when the job was submitted with result storage off. |
| `state` | `PENDING`, `CONNECTING`, `RUNNING`, `COMPLETED`, `FAILED`, or `CANCELLED`. |
| `error` | Human-readable failure description; only on a failed job. |
| `error_cause` | Machine-readable failure kind (see [the table below](#failure-causes)); only on a failed job. |
| `requests_sent` | Analysis requests sent so far — the exact meter. |
| `requests_total` | **Up-front estimate** of the total (see note). |
| `media_time_ms` | How far through the video's timeline the analysis has gotten. |
| `queued_at`, `started_at`, `ended_at` | Wall-clock timestamps (`yyyy-MM-dd HH:mm:ss.SSS`); absent until they happen. |
| `resumes` | How many times the job has been resumed; absent until it has been. |

> [!NOTE]
> `requests_total` is computed once at start from the container's duration and is a **ceiling estimate** — on some files the realized count lands one short of it. Treat `state` as the completion signal and `media_time_ms` as the progress meter; do not wait for `requests_sent == requests_total`.

**2. Stored results** — every response the analysis service returned, one JSON row per analysis window, exactly as received (no event-listener filtering). Served as pages (`GET …/results`), filterable by a time range on the source (`?from_ms=…&to_ms=…`), or downloadable as one `.jsonl` file (`?format=jsonl`). Results are readable **while the job is still running** — a partial read is simply a shorter page. Each row carries the analysis window's position on the source timeline and the detections inside it; rows echo the job's identity as `stream_name: "vod-<job id>"`.

Submitting with `"store_results": false` runs a status-only job: nothing is written, `…/results` answers 404, and the job cannot be resumed (there is no record of where it got to). Use it when event listeners are the only consumer you need.

**3. The manifest** — a provenance record written from the moment the job is accepted and kept up to date as it runs: the submitted and effective configuration (credentials redacted), a hash of the config as submitted, the resolved file with its size/duration/frame rate at submit time, progress counters, final state, and failure cause. It is what makes a week-old job's results auditable — and what resume and restart recovery are built on.

**4. The thumbnail** — a JPEG of the frame currently being analyzed (running) or a representative frame (finished), at the size the detector actually saw. Clip-based (`synthetic`) jobs never decode a frame and have none — expect 404 there.

Detection events also flow through the **event listeners** configured on the detector, exactly as for a live stream: `LogFiles` writes to the Video Intelligence log, `Webhook` listeners POST to your endpoints. Events from a file job carry the job's identity (`vod-<job id>`) as the stream name, plus `job_id` and `source_file` properties. Listeners that need an output stream (overlay, ID3) are skipped for file jobs.

## Playing the source file

The Manager's VOD report can play the analyzed file, seeking it by clicking the score strip. Playback rides the Engine's own HLS — the standard `vod` application, which streams the very directory VOD jobs read — at:

```
http://<engine>:1935/vod/_definst_/mp4:<file>/playlist.m3u8
```

(The `_definst_` segment is required for files in subdirectories — without it the Engine reads the subdirectory as an application-instance name.) What playback needs:

- **Standalone installs: nothing.** Stock Wowza Streaming Engine ships the `vod` application pointing at `content/`, with HLS on 1935 and CORS enabled by default.
- **Compose stacks:** framework Engine images with the VOD feature ship the `vod` application. A `wse/` runtime directory seeded by an **older** image lacks it — add it once from the updated image and restart:

  ```bash
  docker compose exec wse cp -r /usr/local/WowzaStreamingEngine/conf.default/vod /usr/local/WowzaStreamingEngine/conf/vod
  docker compose restart wse
  ```

- **H.264 video** (the same rule as analysis) with AAC audio, since HLS repackages rather than transcodes.
- Port **1935** reachable from the browser — published by the compose file, the standard streaming port on standalone.

If the Manager is served over HTTPS, browsers block plain-HTTP media: point the player at an HTTPS streaming port with the `playback_host` / `playback_port` Video Intelligence plugin properties (the same overrides the live dashboard player honors).

## On-disk layout

Everything a job leaves behind lives under one directory (`vod.jobs_dir`, default `vif-vod-jobs/` under the Engine install directory — the compose file bind-mounts it to `./wse/vif-vod-jobs` so job history survives container recreation):

```text
vif-vod-jobs/
├── manifests/
│   └── <job id>.json          # provenance manifest (see Outputs)
├── results/
│   └── <job id>.jsonl         # one detection response per line, media-time stamped
└── thumbs/
    └── <job id>/
        └── thumbnail.jpg
```

The REST API is the intended way to consume these, but the files are plain JSON/JPEG and safe to read: manifests and thumbnails are replaced atomically, and result rows are appended a whole line at a time as the job runs.

Deleting a terminal job over REST removes its record **and** its files. Automatic eviction (see `max_jobs` / `job_ttl_seconds` below) does the same. If you need results to outlive the job record, copy them out — or read them over REST and store them in your own system as they complete.

## Job lifecycle, failures, and resume

```
PENDING ──▶ CONNECTING ──▶ RUNNING ──▶ COMPLETED │ FAILED │ CANCELLED
   ▲                                                 │         │
   └──────────────────── resume ◀────────────────────┴─────────┘
                         (continues from the last answered window)
```

- **PENDING** — accepted and queued. `vod.max_concurrent_jobs` (default **1**) bounds how many run at once; the rest wait their turn in submit order.
- **CONNECTING / RUNNING** — the job holds its own connection to the analysis service and works through the file.
- **COMPLETED** — the whole file was analyzed. This is the only state that means "the results are complete".
- **FAILED** — the job stopped early; `error` says why in words, `error_cause` says what kind of failure it was.
- **CANCELLED** — a cancel request (`POST /vod/jobs/{jobId}/cancel`) stopped it. Partial results (and the manifest) remain readable until the record is removed, and the job can be resumed later to finish the file.

### Failure causes

`error_cause` is designed for machines: route on it instead of parsing `error`.

| `error_cause` | What happened | Retried automatically? |
|---|---|---|
| `RESPONSE_TIMEOUT` | The analysis service stopped answering mid-run. | Yes — quickly |
| `DISCONNECTED` | The connection to the service dropped mid-run. | Yes — quickly |
| `DETECTOR_RESTARTED` | The service restarted under the job. | Yes — quickly |
| `SEND_FAILED` | A request could not be sent. | Yes — quickly |
| `ENDPOINT_DEGRADED` | The detector's upstream endpoint (VLM, SVD…) reported itself unreachable or still loading. | Yes — patiently |
| `NOT_CONNECTED` / `CONNECT_FAILED` | No connection to the analysis service could be established. | Yes — patiently |
| `DETECTOR_ERROR` | The analysis service reported an error. | Yes — patiently |
| `CONFIG_DRIFT` | The configuration no longer matches the run being continued. | No |
| `COVERAGE_SHORTFALL` | The decode stopped short of the end of the file (damaged source). | No |
| `SOURCE_ERROR` | The file could not be opened or read (missing, no H.264 track…). | No |
| `STORE_ERROR` | Results could not be written to disk. | No |
| `ENGINE_RESTART` | The Engine stopped while the job was running. | No — resume it manually |

> [!TIP]
> A job facing a **degraded upstream endpoint fails fast** instead of grinding through the rest of the file for empty results — the opposite of a live stream, which stays up and waits. The failure is cheap by design: resuming loses nothing.

### Resume

`POST /vod/jobs/{jobId}/resume` continues a stopped job **from the last window its stored results answered** — nothing is analyzed twice and nothing is skipped; new rows append to the same results file, and the same job id keeps reporting progress. The Engine verifies before continuing that the source file is unchanged (size/duration/frame rate as recorded in the manifest) and that the configuration still matches the original run — a mismatch is refused with a 409 explaining which rule refused it.

Most resumes need no body. The one exception: an inline-detector job whose credentials were redacted from the manifest must re-supply them — `{"detector": {…}}` with the same configuration including the credential. Stored-config jobs never need this; their credentials reload from the config file.

**Automatic resume** is on by default (`vod.auto_resume`, or per job with `"auto_resume": false` at submit). When a job fails for a transient reason, the Engine re-runs it on a backoff — seconds apart for blips (`DISCONNECTED`, `RESPONSE_TIMEOUT`…), a more patient schedule stretching to minutes for an endpoint that is down or still loading a model (`ENDPOINT_DEGRADED`, `CONNECT_FAILED`…) — up to 3 attempts. The attempt counter resets whenever a retry gets further than the run before it, so a long file with occasional blips always makes progress, while a dead endpoint stops costing anything after three tries. Every stand-down is logged with its reason; a job left `FAILED` can always be resumed manually once the cause is fixed.

### Engine restarts

Job records persist across Engine restarts (they are rebuilt from the manifests on startup). A job that was running when the Engine stopped is finalized as `FAILED` with `error_cause: "ENGINE_RESTART"` — deliberately not auto-resumed. Resume it manually; it continues from where it got to. A terminal lifecycle notification that had not been delivered when the Engine stopped is re-sent at startup (see below), so webhook consumers never miss an ending.

## Lifecycle webhooks

If polling doesn't fit your integration, have the job call you: every state change POSTs the job view to a URL, with `event: "status_changed"` and a pointer to the results endpoint.

```json
{
  "event": "status_changed",
  "job_id": "ff612ac6-28e6-45be-b072-9078ef40e708",
  "file": "vi-object-detection-landscape.mp4",
  "tag": "quickstart",
  "state": "COMPLETED",
  "requests_sent": 370,
  "requests_total": 371,
  "media_time_ms": 73800,
  "queued_at": "…", "started_at": "…", "ended_at": "…",
  "results": "/v1/server/plugin/vif/vod/jobs/ff612ac6-28e6-45be-b072-9078ef40e708/results"
}
```

Configure it globally (`vod.lifecycle_webhook` — every job) or per job (`"lifecycle_webhook": "https://…"` at submit, which overrides the global; an empty string `""` opts a job out entirely). Delivery is ordered per job, retried (3 attempts), never blocks or fails the job, and terminal events are re-delivered after an Engine restart if delivery was never confirmed — design your handler to tolerate an occasional duplicate.

> [!CAUTION]
> A per-job webhook URL is recorded in the job's manifest on disk. Don't put tokens in the URL — put the secret in the global `vod.lifecycle_webhook_auth` setting instead, which is sent verbatim as the `Authorization` header on every delivery and is never written to any job record.

## Global settings: the `vod` block

VOD behavior is configured by an optional `"vod"` block in the global Video Intelligence configuration (`Default.json`) — via the Manager UI, the REST API, or the file directly. Every field is optional; absence means the default.

| Setting | Default | Meaning |
|---|---|---|
| `max_concurrent_jobs` | `1` | How many jobs run at once; the rest queue. One job already saturates one analysis-model slot, so raise this only if your VIS deployment has capacity to spare. |
| `max_jobs` | `25` | Job records kept; the oldest **finished** jobs (and their stored files) are evicted past the cap. Queued/running jobs are never evicted. |
| `job_ttl_seconds` | off | Additionally, forget finished jobs this many seconds after they end. `0` (or absent) disables the TTL. |
| `content_dir` | Engine `content/` | Where job `file` paths are resolved. |
| `jobs_dir` | Engine `vif-vod-jobs/` | Where manifests, results, and thumbnails are stored. |
| `lifecycle_webhook` | none | Default status-webhook URL for every job. |
| `lifecycle_webhook_auth` | none | `Authorization` header value sent on every lifecycle delivery. |
| `auto_resume` | `true` | Whether jobs that fail for transient reasons are resumed automatically. |

Read the current configuration with `GET $VIF/config`; update it with a `PUT` carrying just the keys you want to change (a PUT merges, and the response echoes the full updated configuration):

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  -X PUT -H "Content-Type: application/json" \
  -d '{"vod": {"job_ttl_seconds": 86400}}' \
  "$VIF/config"
```

## Best practices

- **Track progress by `state` and `media_time_ms`**, not by `requests_sent/requests_total` — the total is an estimate (see [Outputs](#outputs)).
- **Prefer webhooks to polling** for automation; poll for dashboards and ad-hoc checks. Handle the occasional duplicate terminal event.
- **Tag your jobs.** `tag` is free-form and the job list filters on it exactly (`GET /vod/jobs?tag=…`) — use it to group a batch, mark an environment, or carry your own correlation id.
- **Use stored configs for recurring, unattended work.** They keep credentials out of your requests, make jobs resumable without re-supplying secrets, and centralize tuning in the Manager UI.
- **Mind the analysis cost before submitting.** A file job sends roughly `duration_seconds × inference_fps ÷ frames_per_request` requests. Lowering `inference_fps` is the single biggest lever on how long a job takes and what it costs; for many VOD use cases (finding whether/where something appears) 1–5 fps is plenty.
- **Size the retention to your workflow.** The defaults keep the last 25 jobs forever; a busy pipeline should set `job_ttl_seconds` and copy results into its own storage as jobs complete (webhook → `GET …/results?format=jsonl` is a clean pattern).
- **Don't parse `error`; route on `error_cause`.** The message is for people and may change; the cause names are the contract.
- **Cancel first, then delete.** `POST …/cancel` stops a queued or running job (state `CANCELLED`); its record and files stay until you remove them with a DELETE, which only a terminal job accepts.
- **Usage note:** file analysis is metered by media time analyzed, exactly as reported in the manifest's `media_ms_analyzed`.

## API reference

All endpoints are under the Engine REST API (default `http://localhost:8087`), path prefix `/v1/server/plugin/vif`, authenticated with the Engine's REST admin credentials (see the note in [Quick start](#quick-start)), JSON in and out unless noted.

| Method & path | Purpose |
|---|---|
| `GET  /vod/files` | List analyzable files under the content root |
| `PUT  /vod/files/upload` | Upload one source file into the content root |
| `POST /vod/jobs` | Submit a job |
| `GET  /vod/jobs` | List jobs (paged, newest first, filterable by tag) |
| `GET  /vod/jobs/{jobId}` | One job's status and progress |
| `DELETE /vod/jobs/{jobId}` | Remove a finished job — its record, results, and thumbnail |
| `POST /vod/jobs/{jobId}/cancel` | Stop a queued or running job |
| `GET  /vod/jobs/{jobId}/results` | The job's detections (paged or `?format=jsonl` download) |
| `GET  /vod/jobs/{jobId}/thumbnail` | The job's thumbnail (`image/jpeg`) |
| `POST /vod/jobs/{jobId}/resume` | Continue a stopped job from where it got to |

**Responses.** A successful call answers with the operation's payload itself — a submit echoes the submission plus its `job_id`, a read returns the resource, a DELETE returns the removed job's final view plus a `message` saying what happened. Every **refusal** is one standard shape: the HTTP status, echoed as `code`, with `success: false` and a `message` naming the reason:

```json
{"success": false, "code": "404", "message": "no such job: 00000000-0000-0000-0000-000000000000"}
```

> [!TIP]
> Refusal bodies honor content negotiation. curl's default `Accept: */*` renders some refusals as XML — add `-H "Accept: application/json"` if your client does not already prefer JSON (browser `fetch` and most HTTP libraries do).

---

### `GET /vod/files`

Lists analyzable files (`.mp4`, `.m4v`, `.mov`, `.f4v`) under the content root — newest first, up to 6 directory levels deep, up to 500 entries (`"truncated": true` marks a cut-off listing). The `file` values are exactly what `POST /vod/jobs` takes.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/files"
```

```json
{
  "files": [
    {"file": "vi-object-detection-landscape.mp4", "size_bytes": 11195455, "modified_at": "2026-08-12 00:43:07.018"},
    {"file": "archive/cam3/monday.mp4", "size_bytes": 6806761, "modified_at": "2026-08-07 23:26:12.771"}
  ]
}
```

### `PUT /vod/files/upload`

Uploads one source file into the content directory: the raw video bytes as the request body, the target name — relative, subdirectories allowed and created — in the `file` query parameter.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -T monday.mp4 \
  "$VIF/vod/files/upload?file=archive/cam3/monday.mp4"
```

```json
{"success": true, "file": "archive/cam3/monday.mp4", "size_bytes": 6806761}
```

The body streams to a temporary file and is renamed into place only once complete — a partial upload is never listed and never analyzable. Refusals: a name that resolves outside the content root or lacks an analyzable extension (`400`), a target that already exists — uploads never overwrite (`409`), a body over 10 GB (`413`). The extension gate is the listing's own and content is not probed: an HEVC-only `.mp4` uploads fine and then fails analysis as `SOURCE_ERROR`.

### `POST /vod/jobs`

Submits a job. Answers immediately with the `job_id`; the analysis runs in the background.

| Body field | Required | Meaning |
|---|---|---|
| `file` | yes | Path relative to the content root. |
| `config` | exactly one of the two | Stored config name (file name under `conf.modules/vif/`, `.json` optional). |
| `detector` | | Inline detector definition (see the [plugin configuration reference](README.wse-plugin.md)). |
| `store_results` | no (default `true`) | `false` runs the job status-only: no stored rows, no resume. |
| `tag` | no | Free-form label; the job list filters on it. |
| `lifecycle_webhook` | no | Status-webhook URL for this job. Overrides the global; `""` disables notifications for this job. |
| `auto_resume` | no | Overrides the global `vod.auto_resume` for this job. |

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"file": "vi-object-detection-landscape.mp4", "config": "live_objectDotStar", "tag": "nightly"}' \
  "$VIF/vod/jobs"
```

```json
{"file": "vi-object-detection-landscape.mp4", "config": "live_objectDotStar", "tag": "nightly", "job_id": "a88b9ebe-a70e-43fc-977a-1efb994fcaf4"}
```

Refusals (standard error shape): naming both or neither of `config`/`detector`; an unknown stored config (the message lists what is available); a file that does not exist, is not a supported container, or resolves outside the content root.

### `GET /vod/jobs`

Lists the jobs this Engine knows about, newest first.

| Query param | Default | Meaning |
|---|---|---|
| `tag` | — | Exact-match filter. |
| `offset` | `0` | Skip this many (after filtering). |
| `limit` | `100` | Page size, clamped to `[1, 1000]`. |

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs?tag=nightly&limit=10"
```

```json
{"tag": "nightly", "jobs": [ {"job_id": "…", "file": "…", "tag": "nightly", "state": "RUNNING", …} ], "offset": 0, "limit": 10, "count": 1, "total": 1}
```

`count` is the rows on this page; `total` is everything the filter matched — page with `offset` until `offset + count ≥ total`. The echoed `offset`/`limit` are the clamped values actually applied. A non-numeric `offset`/`limit` is a 400.

### `GET /vod/jobs/{jobId}`

The job view (fields in [Outputs](#outputs)). 404 for an unknown job.

### `DELETE /vod/jobs/{jobId}`

Removes a **terminal** job (`COMPLETED`, `FAILED`, or `CANCELLED`): its record, its stored results, and its thumbnail. Answers `200` with the job's final view plus `"message": "job removed"` ([example below](#post-vodjobsjobidcancel)).

A job that is still queued or running is refused — stop it first with [`POST …/cancel`](#post-vodjobsjobidcancel), then DELETE it once it is terminal:

```bash
# deleting a running job is refused
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -H "Accept: application/json" -X DELETE "$VIF/vod/jobs/$JOB_ID"
```

```json
{"success": false, "code": "409", "message": "job ff612ac6-28e6-45be-b072-9078ef40e708 is RUNNING; cancel it first (POST /vod/jobs/ff612ac6-28e6-45be-b072-9078ef40e708/cancel), then DELETE to remove it"}
```

404 for an unknown job.

### `POST /vod/jobs/{jobId}/cancel`

Stops a queued, connecting, or running job. No body.

```bash
# cancel it instead
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X POST "$VIF/vod/jobs/$JOB_ID/cancel"
```

Answers `202 Accepted` with the job view. The stop is asynchronous, so that view is a snapshot taken as the request was accepted and may still read `RUNNING` — poll `GET /vod/jobs/{jobId}` until the state settles to `CANCELLED`:

```json
{"job_id":"ff612ac6-28e6-45be-b072-9078ef40e708","file":"vi-object-detection-landscape.mp4",
 "tag":"quickstart","state":"RUNNING","requests_sent":118,"requests_total":371,
 "media_time_ms":23400,"queued_at":"2026-08-12 00:43:07.371",
 "started_at":"2026-08-12 00:43:07.439"}
```

A cancelled job keeps its record, its stored results, and its thumbnail — it stays readable, and [resume](#resume) can finish the file later. Removing it is a separate DELETE, once it is terminal:

```bash
# ...poll until terminal, then remove it
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X DELETE "$VIF/vod/jobs/$JOB_ID"
```

```json
{"job_id":"ff612ac6-28e6-45be-b072-9078ef40e708","file":"vi-object-detection-landscape.mp4",
 "tag":"quickstart","state":"CANCELLED","requests_sent":118,"requests_total":371,
 "media_time_ms":23400,"queued_at":"2026-08-12 00:43:07.371",
 "started_at":"2026-08-12 00:43:07.439","ended_at":"2026-08-12 00:43:24.902",
 "message":"job removed"}
```

Refusals: `404` (unknown job), and `409` on a job that has already finished — there is nothing left to stop:

```json
{"success": false, "code": "409", "message": "job ff612ac6-28e6-45be-b072-9078ef40e708 is COMPLETED; only a queued or running job can be cancelled"}
```

### `GET /vod/jobs/{jobId}/results`

The stored detections. Two forms:

**Paged JSON** (default): `offset`/`limit` (default 100, clamped to `[1, 1000]`) page the rows; `from_ms`/`to_ms` first narrow them to the analysis windows starting in `[from_ms, to_ms)` on the source timeline.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  "$VIF/vod/jobs/$JOB_ID/results?from_ms=30000&to_ms=60000&limit=100"
```

```json
{"job_id": "…", "offset": 0, "limit": 100, "count": 100, "total": 150, "results": [ { …one analysis response per row… } ]}
```

**File download** (`?format=jsonl`): the results file exactly as it is on disk — one JSON object per line, `application/x-ndjson`, served as an attachment.

Readable while the job runs (rows appear as they are answered). 404s distinguish themselves by message: unknown job, `store_results: false`, or no rows stored yet.

### `GET /vod/jobs/{jobId}/thumbnail`

The job's frame as a JPEG — live while running, representative once finished. 404 with "no frame to show" for clip-based (`synthetic`) jobs and before the first frame is decoded.

### `POST /vod/jobs/{jobId}/resume`

Continues a stopped job from the last stored answer. Body is empty except to re-supply an inline job's credentials: `{"detector": {…}}`.

Answers `202 Accepted` with the fresh job view. Refusals: `404` (unknown job), `409` with a message naming the rule — the job is still running or already completed, it kept no results, the source file changed, the configuration no longer matches, or the resume point cannot be opened.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -H "Accept: application/json" \
  -X POST "$VIF/vod/jobs/$JOB_ID/resume"
```

A refusal names its rule — resuming a job that finished, for example:

```json
{"success": false, "code": "409", "message": "job ff612ac6-… is COMPLETED; re-running a finished job is not a resume"}
```

## Troubleshooting

**The submit is refused with "supply exactly one of 'config' … or 'detector'".** The request named both or neither. Pick one.

**The submit is refused with "no stored config named …".** The name is a config file name under `conf.modules/vif/` (`.json` optional), and the refusal message lists the names the Engine actually has.

**`GET /vod/files` answers with an `error` field.** The content directory could not be listed — check `vod.content_dir` and the Video Intelligence log from startup.

**The job fails immediately with `SOURCE_ERROR`.** The file is missing, unreadable, or carries no H.264 track. The extension filter on `/vod/files` is not a probe — a `.mp4` with only HEVC inside lists fine and fails here.

**`object`/`scene`/`vlm` jobs fail but `synthetic` works.** Frame-decoded jobs need `ffmpeg` on the Engine's `PATH`; clip-based jobs don't. Check the Video Intelligence log for the decoder start failure.

**The job sits in `PENDING`.** Jobs run `vod.max_concurrent_jobs` at a time (default 1) — it is waiting for the jobs ahead of it.

**`FAILED` with `ENDPOINT_DEGRADED` almost immediately.** Working as designed: the upstream endpoint (VLM, SVD…) is unreachable or still loading, and the job fails fast rather than burning the file into empty results. Auto-resume retries on a patient backoff; or fix the endpoint and `POST …/resume`.

**A resume answers 409 "the source file has changed".** The file under that path is not the one the job analyzed (size/duration/frame rate differ from the manifest). Restore the original file, or submit a new job.

**A DELETE answers 409 "cancel it first".** DELETE only removes terminal jobs, and this one is still queued or running. `POST …/cancel`, poll until the state is `CANCELLED`, then DELETE.

**A cancel answers 409 "only a queued or running job can be cancelled".** The job already reached `COMPLETED`, `FAILED`, or `CANCELLED` — there is nothing left to stop. DELETE it if what you wanted was the record gone.

**The thumbnail is 404 for a synthetic job.** Expected — clip-based jobs never decode a frame. Every other type has one from the first analyzed frame onward.

**Results are missing for an old job.** Finished jobs are evicted past `vod.max_jobs` (default 25) or after `vod.job_ttl_seconds`, and eviction removes stored files. Copy results out as jobs complete if you need them long-term.

**A completed job shows `requests_sent` one below `requests_total`.** Expected occasionally — the total is an up-front estimate. `state: "COMPLETED"` means the whole file was analyzed.
