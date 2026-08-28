# VOD Analysis Guide — analyzing video files

The Video Intelligence framework can analyze **video files** as well as live streams. A **VOD job** points one of the framework's detectors — object detection, scene analysis, VLM analysis, or synthetic video detection — at an MP4 file that is already on the Engine, runs it over the whole file as fast as the analysis backend allows, and leaves behind a complete, queryable record: every detection with its position on the video's timeline, a provenance manifest describing exactly what was run, and a thumbnail.

Everything is driven over the Wowza Streaming Engine REST API — the v2 Video Intelligence API, under `/v2/vif`. Jobs run in the background, survive Engine restarts, recover automatically from transient failures, and can push status updates to your own service via webhooks — so a single `POST` is enough to fire and forget.

---

## Contents

1. [How it works](#how-it-works)
2. [Quick start](#quick-start)
3. [Choosing the analysis: stream group configs and inline configs](#choosing-the-analysis-stream-group-configs-and-inline-configs)
4. [Inputs](#inputs)
5. [Outputs](#outputs)
6. [Playing the source file](#playing-the-source-file)
7. [On-disk layout](#on-disk-layout)
8. [Job lifecycle, failures, and resume](#job-lifecycle-failures-and-resume)
9. [Lifecycle webhooks](#lifecycle-webhooks)
10. [VOD settings and secrets](#vod-settings-and-secrets)
11. [Best practices](#best-practices)
12. [API reference](#api-reference)
13. [Troubleshooting](#troubleshooting)

---

## How it works

```
                    POST /v2/vif/vod/jobs
you ──REST──▶ Engine (VIF plugin) ──WebSocket──▶ VIS ──▶ model / VLM / SVD endpoint
                    │
                    ├── results/<job>.jsonl(.gz)  every detection, timestamped
                    ├── manifests/<job>.json    what ran, how it ended
                    ├── thumbs/<job>/…          representative frame
                    └── lifecycle webhook ──▶ your service
```

A VOD job reuses the same configuration model as live streams — the same detector types, models, thresholds, class names, and listeners, in the same `config` document a stream group config carries. The differences that matter:

- **The file is the clock.** A live stream is analyzed at the rate it arrives; a VOD job runs as fast as the analysis service answers. A 10-minute file can finish in well under a minute, or take longer than 10 minutes with a heavyweight model — wall-clock time depends on the AI inference speed, not the video duration.
- **Progress is media time.** A job reports how far through the *video's timeline* it has gotten (`media_time_ms`), not how long it has been running.
- **Results are always kept raw.** Every response from the analysis service is stored as-is (unless you opt out), independent of any listener filtering. You can page through them over REST, filter them by time range, or download the whole file.
- **No output stream.** Listeners that write into a stream (overlay rendering, ID3 injection) do not apply to a file job and are skipped; log and webhook listeners work exactly as they do for live streams.

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
VIF="http://localhost:8087/v2/vif"
```

> [!NOTE]
> The framework configures the Engine REST API for HTTP Basic authentication, which is what `curl -u` speaks by default. If your Engine is set to digest auth instead (`<AuthenticationMethod>` in `Server.xml` — the default on standalone Engine installs), add `--digest` to every `curl` call in this guide.

**1. Put a video where the Engine can see it.** Jobs analyze files under the Engine's content directory — `./wse/content` in a compose checkout:

```bash
cp videos/vi-object-detection-landscape.mp4 wse/content/
```

Or upload it over the API — the body is the file, the target name rides the query string:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X POST \
  -H "Content-Type: video/mp4" \
  --data-binary @videos/vi-object-detection-landscape.mp4 \
  "$VIF/vod/files?file=vi-object-detection-landscape.mp4"
```

You can list what is analyzable at any time — the listing returns exactly the `file` strings a job submission takes:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/files"
```

**2. Submit a job.** This one runs object detection with an inline config, sampling 5 frames per second; anything you don't specify is inherited from the default config:

```bash
JOB_ID=$(curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
        "file": "vi-object-detection-landscape.mp4",
        "config": {
          "detector": { "type": "object", "classes": ["person", "car", "truck"] },
          "processing": { "inference_fps": 5 }
        },
        "tag": "quickstart"
      }' \
  "$VIF/vod/jobs" | sed -E 's/.*"job_id":"([^"]+)".*/\1/')
echo "$JOB_ID"
```

**3. Watch it run.** Poll the job until its `state` is terminal (`completed`, `failed`, or `cancelled`):

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs/$JOB_ID"
```

Or wait in one line:

```bash
until curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs/$JOB_ID" \
    | grep -qE '"state":"(completed|failed|cancelled)"'; do sleep 5; done
```

A file job runs as fast as the analysis service answers — this 74-second sample finishes in seconds against a local VIS:

```json
{"job_id":"2864f168-7d5d-46da-b9f6-100dd0b03d75","file":"vi-object-detection-landscape.mp4",
 "tag":"quickstart","detector_type":"object","store_results":true,"results_truncated":false,
 "state":"completed","requests_sent":370,"requests_total":371,
 "media_time_ms":73800,"source_duration_ms":74066,
 "queued_at":"2026-08-28T07:37:53.399Z","started_at":"2026-08-28T07:37:53.478Z",
 "ended_at":"2026-08-28T07:38:03.502Z","resumes":0,
 "config":{"…":"the inline config as submitted"},
 "effective_config":{"…":"the configuration the job actually ran with"}}
```

**4. Read the results.** Detections are served as pages of JSON rows, one row per analysis window, each stamped with its position on the video's timeline:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs/$JOB_ID/results?limit=2"
```

```json
{
  "job_id": "2864f168-…", "offset": 0, "limit": 2, "count": 2, "total": 370,
  "results": [
    {
      "type": "detections",
      "detector_type": "object",
      "stream_name": "vod-2864f168-7d5d-46da-b9f6-100dd0b03d75",
      "status": "success",
      "detection_window": {
        "from_frame_id": 0, "to_frame_id": 0, "frame_count": 1,
        "from_frame": "00:00:00.000", "to_frame": "00:00:00.000",
        "from_time_code": 0, "to_time_code": 0
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
  -o results.jsonl "$VIF/vod/jobs/$JOB_ID/results/file"
```

**5. Grab the thumbnail** — the frame currently under analysis while the job runs, a representative frame once it is done:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  -o thumbnail.jpg "$VIF/vod/jobs/$JOB_ID/thumbnail"
```

**6. Clean up when you no longer need the record** — a `204`, no body:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X DELETE "$VIF/vod/jobs/$JOB_ID"
```

## Choosing the analysis: stream group configs and inline configs

A job names its configuration the way the rest of the v2 API does, and it may use either member or both. At least one is required.

**A stream group config** (`"stream_group_config": "live_objectDotStar"`) names a saved group by its `name` — the same documents `GET /v2/vif/persist/stream-group-configs` lists and the Manager's stream-config page edits. Its *match rule plays no part* in a file job: only its `config` is used. The framework ships ready-made groups — `live_objectDotStar`, `live_sceneDotStar`, `live_vlmDotStar`, `live_syntheticDotStar` — and configuration files written before v2 answer to their file name without the extension.

**An inline config** (`"config": { … }`) carries a `Config` document in the request itself: `detector`, `listeners`, `processing`, `service`, `diagnostics`, `active` — exactly the member a stream group config carries under `config`. It is sparse: anything you leave out inherits.

The two layer, and they layer by the contract's own rules:

```
default config  <  stream_group_config  <  config
```

- **`detector` is atomic.** An inline `detector` replaces the group's whole detector; whatever it leaves unset comes from the default config's per-type baseline, not from the detector it replaced.
- **`listeners` layer per entry, by name.** A name the inline config declares owns that whole entry; the entries it does not name pass through from the group.
- **Everything else merges field by field** — `processing`, `service`, `diagnostics`, `active`.

So a group plus a small inline config is the usual shape: reuse a tuned analysis, override the one thing this job needs.

```json
{ "file": "clips/one.mp4",
  "stream_group_config": "live_objectDotStar",
  "config": { "processing": { "inference_fps": 2 } } }
```

Which to use:

- **Stream group configs** are right when the same analysis runs repeatedly, when you manage configurations centrally through the Manager UI, and when jobs should be resumable unattended — the group's credentials live in the group, so the Engine can always reconstruct the job (see [resume](#job-lifecycle-failures-and-resume)).
- **Inline configs** are right for programmatic, per-request variation. Note that inline credentials (a VLM `endpoint.api_key`, for example) are **never written to disk** — the job's record stores a redacted copy — which is good for secret hygiene, but means a failed inline job holding credentials can only be resumed by re-supplying them (automatic resume stands down and tells you why in the log).

What the job resolved to is recorded on it either way, so "which configuration produced these detections" stays answerable even after the group is edited: the single-job read carries `config` (the inline document as submitted, redacted) and `effective_config` (what actually ran, redacted). Editing the group later never touches a job already submitted.

## Inputs

- **Containers:** `.mp4`, `.m4v`, `.mov`, `.f4v` — anything else is not listed and not accepted.
- **Codec:** the file must carry an **H.264** video track.
- **Location:** files are named **relative to the content directory** (the VOD settings' `content_dir`, by default the Engine's `content/` folder — `./wse/content` in a compose checkout). Subdirectories work (`archive/cam3/monday.mp4`); paths that resolve outside the content root are refused.
- **Audio** is ignored; only the video track is analyzed.

> [!NOTE]
> Frame-decoded detector types (`object`, `scene`, `vlm`) decode the file with **ffmpeg**, which must be available on the Engine's `PATH`. Clip-based jobs (`synthetic`) relay encoded H.264 and do not need it.

`GET /vod/files` lists what is currently analyzable (newest first, up to 500 entries, up to 6 directory levels deep) with sizes and modification times; `POST /vod/files?file=<relative path>` puts one there, the raw bytes as the body.

## Outputs

A job produces up to four things:

**1. The job view** — live progress and final status over REST (`GET /vod/jobs/{jobId}`), also the payload of every lifecycle webhook. Fields:

| Field | Meaning |
|---|---|
| `job_id` | The job's identifier, assigned at submit. |
| `file` | The source path as submitted. |
| `tag` | The label the job was submitted with, if any. |
| `detector_type` | The analysis the job runs: `object`, `scene`, `vlm`, or `synthetic`. |
| `stream_group_config` | The stream group config the job was submitted with, by name; absent for an inline-only job. |
| `listener_warning` | The configured listeners a file job cannot serve (overlay, ID3) and skipped; absent when there is nothing to warn about. |
| `store_results` | Whether the job keeps its detections for `…/results`. |
| `results_truncated` | True when a write failure cut the stored results short of the file's end; a resume fills the gap. |
| `state` | `pending`, `connecting`, `running`, `completed`, `failed`, or `cancelled`. |
| `error` | Human-readable failure description; only on a failed job. |
| `error_cause` | Machine-readable failure kind (see [the table below](#failure-causes)); only on a failed job. |
| `requests_sent` | Analysis requests answered so far — the exact meter. |
| `requests_total` | **Up-front estimate** of the total (see note). |
| `media_time_ms` | How far through the video's timeline the analysis has gotten. |
| `source_duration_ms` | The length of that timeline — the denominator for `media_time_ms`. Absent until the file has been measured (normally from submit; a file the submit-time probe could not open reports it once the job runs). |
| `queued_at`, `started_at`, `ended_at` | RFC 3339 timestamps with the Engine's UTC offset; `started_at`/`ended_at` are absent until they happen. |
| `resumes` | How many times the job has been resumed; `0` on a first run. |
| `config` | The inline config as submitted, credentials redacted; `null` for a group-only job. **Single-job read only.** |
| `effective_config` | The configuration the job actually ran with, credentials redacted. **Single-job read only.** |

The listing, the submit's own `201` and the lifecycle payload carry everything except the last two: a page of jobs stays lean, and the two configurations are what the single-job read is for.

> [!NOTE]
> `requests_total` is computed once at start from the container's duration and is a **ceiling estimate** — on some files the realized count lands one short of it. Treat `state` as the completion signal and `media_time_ms / source_duration_ms` as the progress meter; do not wait for `requests_sent == requests_total`.
>
> That ratio is a meter, not a finish line either: the last analysis window can end a little short of the source duration, so a `completed` job's `media_time_ms` may never quite reach `source_duration_ms`. `state` is what says the file was analyzed to the end — never a percentage reaching 100.

**2. Stored results** — every response the analysis service returned, one JSON row per analysis window, exactly as received (no listener filtering). Served as pages (`GET …/results`), filterable by a time range on the source (`?from_ms=…&to_ms=…`), or downloadable as one `.jsonl` file (`GET …/results/file`). Results are readable **while the job is still running** — a partial read is simply a shorter page. Each row carries the analysis window's position on the source timeline and the detections inside it; rows echo the job's identity as `stream_name: "vod-<job id>"`.

Submitting with `"store_results": false` runs a status-only job: nothing is written, `…/results` answers 404, and the job cannot be resumed (there is no record of where it got to). Use it when listeners are the only consumer you need — a job with no runnable listener *and* no stored results is refused at submit, since it would deliver its detections nowhere.

**3. The manifest** — a provenance record written from the moment the job is accepted and kept up to date as it runs: the submitted and effective configuration (credentials redacted), a hash of the configuration as submitted, the resolved file with its size/duration/frame rate at submit time, progress counters, final state, and failure cause. It is what makes a week-old job's results auditable — and what resume and restart recovery are built on.

**4. The thumbnail** — a JPEG of the frame currently being analyzed (running) or a representative frame (finished), at the size the detector actually saw. Clip-based (`synthetic`) jobs never decode a frame and have none — expect 404 there.

Detection events also flow through the **listeners** configured on the job's config, exactly as for a live stream: a log listener writes to the Video Intelligence log, a webhook listener POSTs to your endpoint. Events from a file job carry the job's identity (`vod-<job id>`) as the stream name, plus `job_id` and `source_file` properties. Listeners that need an output stream (overlay, ID3) are skipped for file jobs and named in `listener_warning`.

For webhook-listener routing (the Engine's `Webhooks.json` filters), a file job's events carry the context `vHost: _defaultVHost_`, `app: vod`, `appInstance: _definst_`, `stream: vod-<job id>` — a live-style wildcard filter (`vHost.*.app.*.appInstance.*.stream.*.>`) matches them alongside your live streams, and a filter anchored on `app.vod` selects file-job detections alone.

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

Everything a job leaves behind lives under one directory (the VOD settings' `jobs_dir`, default `vif-vod-jobs/` under the Engine install directory):

```text
vif-vod-jobs/
├── manifests/
│   └── <job id>.json          # provenance manifest (see Outputs)
├── results/
│   └── <job id>.jsonl         # one detection response per line, media-time stamped
│   └── <job id>.jsonl.gz      # the same file, gzipped — what a completed job leaves
└── thumbs/
    └── <job id>/
        └── thumbnail.jpg
```

The REST API is the intended way to consume these, but the files are plain JSON/JPEG and safe to read: manifests and thumbnails are replaced atomically, and result rows are appended a whole line at a time as the job runs. When a job completes with its results fully stored, the plain `.jsonl` is swapped for a gzipped `.jsonl.gz` (typically ~10× smaller); a job that can still be resumed — failed, cancelled, or completed with a storage gap — keeps the plain file so the next run can append to it. Reading the compressed form outside the API is one `gunzip` away.

Deleting a terminal job over REST removes its record **and** its files. Automatic eviction (see `max_jobs` / `job_ttl_seconds` below) does the same. If you need results to outlive the job record, copy them out — or read them over REST and store them in your own system as they complete.

## Job lifecycle, failures, and resume

```
pending ──▶ connecting ──▶ running ──▶ completed │ failed │ cancelled
   ▲                                       │         │
   └──────────────── resume ◀──────────────┴─────────┘
                     (continues from the last answered window)
```

- **pending** — accepted and queued. `max_concurrent_jobs` (default **1**) bounds how many run at once; the rest wait their turn in submit order.
- **connecting / running** — the job holds its own connection to the analysis service and works through the file.
- **completed** — the whole file was analyzed. This is the only state that means "the results are complete".
- **failed** — the job stopped early; `error` says why in words, `error_cause` says what kind of failure it was.
- **cancelled** — a cancel request (`POST /vod/jobs/{jobId}/cancel`) stopped it. Partial results (and the manifest) remain readable until the record is removed, and the job can be resumed later to finish the file.

### How the queue works

`max_concurrent_jobs` (default **1**) bounds how many jobs run at once. Every other accepted job waits in **submit order**, first in, first out.

The queue itself is **unbounded**. `max_jobs` caps how many job *records* are kept and evicts only finished ones, so a queued or running job is never dropped to make room for a new submit — the cap can be exceeded while that many jobs are in flight. Each waiting job costs one manifest on disk. A submit that the Engine accepted is one it will run, so treat submitting as a commitment rather than as flow control.

Two wrinkles are worth knowing:

- **A resumed job re-executes at the back of the queue, but keeps its original place in the listing.** Where it appears in the list is where it was submitted; when it runs is when it was resumed.
- **Above `max_concurrent_jobs: 1`, submit order is start order — not finish order.** Jobs of different lengths end out of order, so `state` is the only thing that says a particular job is done.

To inspect the queue, ask for the queued jobs and read `total`:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs?state=pending&limit=1"
```

Because the listing is newest first, the **last** page of `?state=pending` holds the front of the queue — the job that runs next. Reverse the pages to read the queue in the order it will execute.

The queue does not survive a restart: a job still waiting when the Engine goes down is finalized `failed` with `error_cause: "engine_restart"` and deliberately not auto-resumed (see [Engine restarts](#engine-restarts)).

### Failure causes

`error_cause` is designed for machines: route on it instead of parsing `error`.

| `error_cause` | What happened | Retried automatically? |
|---|---|---|
| `response_timeout` | The analysis service stopped answering mid-run. | Yes — quickly |
| `disconnected` | The connection to the service dropped mid-run. | Yes — quickly |
| `detector_restarted` | The service restarted under the job. | Yes — quickly |
| `send_failed` | A request could not be sent. | Yes — quickly |
| `endpoint_degraded` | The detector's upstream endpoint (VLM, SVD…) reported itself unreachable or still loading. | Yes — patiently |
| `not_connected` / `connect_failed` | No connection to the analysis service could be established. | Yes — patiently |
| `detector_error` | The analysis service reported an error. | Yes — patiently |
| `config_drift` | The configuration no longer matches the run being continued. | No |
| `coverage_shortfall` | The decode stopped short of the end of the file (damaged source). | No |
| `source_error` | The file could not be opened or read (missing, no H.264 track…). | No |
| `store_error` | Results could not be written to disk. | No |
| `engine_restart` | The Engine stopped while the job was running, and nobody had cancelled it. | No — resume it manually |

> [!TIP]
> A job facing a **degraded upstream endpoint fails fast** instead of grinding through the rest of the file for empty results — the opposite of a live stream, which stays up and waits. The failure is cheap by design: resuming loses nothing.

### Resume

`POST /vod/jobs/{jobId}/resume` continues a stopped job **from the last window its stored results answered** — nothing is analyzed twice and nothing is skipped; new rows append to the same results file, and the same job id keeps reporting progress. Answers `202` with the job as it was queued again.

Before continuing, the Engine verifies that the source file is unchanged (size/duration/frame rate as recorded in the manifest) and that the configuration still resolves to the same analysis. A job submitted with a `stream_group_config` reloads that group **by name** and re-layers the inline config it was submitted with, so a group edited in the meantime is caught here: the resume is refused with a `409` naming the drift rather than quietly running a different analysis.

Most resumes need no body. The one exception: a job whose inline credentials were redacted out of its record must re-supply them — `{"config": { … }}` with the same configuration including the credential. A body on a group-built job is refused; its credentials reload from the group.

**Automatic resume** is on by default (the VOD settings' `auto_resume`, or per job with `"auto_resume": false` at submit). When a job fails for a transient reason, the Engine re-runs it on a backoff — seconds apart for blips (`disconnected`, `response_timeout`…), a more patient schedule stretching to minutes for an endpoint that is down or still loading a model (`endpoint_degraded`, `connect_failed`…) — up to 3 attempts. The attempt counter resets whenever a retry gets further than the run before it, so a long file with occasional blips always makes progress, while a dead endpoint stops costing anything after three tries. Every stand-down is logged with its reason; a job left `failed` can always be resumed manually once the cause is fixed.

### Engine restarts

Job records persist across Engine restarts (they are rebuilt from the manifests on startup). A graceful Engine stop cancels a running job, which persists as `cancelled` and resumes like any other. Only a job the Engine never got to finalize *and* nobody had cancelled — a hard kill while it ran, or one still queued when the Engine went — is finalized at the next startup as `failed` with `error_cause: "engine_restart"`, deliberately not auto-resumed. A job you cancelled comes back `cancelled` however the Engine went: the decision is recorded when you make it, not when the run finishes acting on it. Resume it manually; it continues from where it got to. A terminal lifecycle notification that had not been delivered when the Engine stopped is re-sent at startup (see below), so webhook consumers never miss an ending.

## Lifecycle webhooks

If polling doesn't fit your integration, have the job call you: one POST per persisted transition — `running`, then whichever terminal state the job reaches — carries the job view to a URL, with `event: "status_changed"` and a pointer to the results endpoint. (There is no event for `pending`: the submit's own response already carries it.)

```json
{
  "event": "status_changed",
  "job_id": "2864f168-7d5d-46da-b9f6-100dd0b03d75",
  "file": "vi-object-detection-landscape.mp4",
  "tag": "quickstart",
  "detector_type": "object",
  "state": "completed",
  "store_results": true,
  "results_truncated": false,
  "requests_sent": 370,
  "requests_total": 371,
  "media_time_ms": 73800,
  "source_duration_ms": 74066,
  "queued_at": "…", "started_at": "…", "ended_at": "…",
  "resumes": 0,
  "results": "/v2/vif/vod/jobs/2864f168-7d5d-46da-b9f6-100dd0b03d75/results"
}
```

`results` is server-relative — the Engine does not know the host name you reach it by. The payload is otherwise the collection view of the job, so it carries no `config` or `effective_config`; read the job for those.

Configure the destination globally (the VOD settings' `lifecycle_webhook` — every job) or per job (`"lifecycle_webhook": "https://…"` at submit, which overrides the global; an empty string `""` opts a job out entirely). Delivery is ordered per job, retried (3 attempts), never blocks or fails the job, and terminal events are re-delivered after an Engine restart if delivery was never confirmed — design your handler to tolerate an occasional duplicate.

> [!CAUTION]
> A per-job webhook URL is recorded in the job's manifest on disk, so never embed a token in one — it would be on disk for as long as the job record is. Authorization is always a [named webhook secret](#named-webhook-secrets) instead: the VOD settings' `lifecycle_webhook_secret` names the credential for the global destination (sent only there, matched by exact string equality — a URL supplied at submit never receives it, even one differing from the global only by a trailing slash or letter case), and a submit's own `lifecycle_webhook_secret` names one for the job's own destination.

### Named webhook secrets

Every webhook credential lives once, under a name, in the secrets document — `GET/PATCH /v2/vif/persist/secrets`, backed by `conf.modules/vif/vod/secrets.json`. A read answers the **names** only; a value never travels back out.

```bash
curl -si -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/persist/secrets" | grep -i etag
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X PATCH \
  -H "Content-Type: application/merge-patch+json" -H 'If-Match: "<etag>"' \
  -d '{"values": {"partner-a": "Bearer eyJ…"}}' \
  "$VIF/persist/secrets"
```

The patch is a JSON merge patch over `values`: a string sets or rotates a name, `null` removes it, and a name you don't mention is kept. The revision covers the values, so a rotation changes the `ETag` even though the answer looks the same. A submit then refers to a name:

```json
{ "file": "clip.mp4", "stream_group_config": "live_objectDotStar",
  "lifecycle_webhook": "https://partner-a.example/hook",
  "lifecycle_webhook_secret": "partner-a" }
```

Every delivery of that job's notifications carries the named secret's **current** value as the `Authorization` header. The job record stores the name only, so the value is never at rest in a manifest, rotating it applies immediately to jobs already submitted, and a job finalized after an Engine restart still authenticates. A name nothing configures is refused at submit (`400`); a name deleted **while a job runs** delivers unauthenticated (with a warning in the Engine log) rather than not at all.

The global destination authenticates through the same document: the VOD settings' `lifecycle_webhook_secret` names the entry sent on deliveries to its `lifecycle_webhook` — and only there; a job that overrides the URL names its own secret, and a job-named secret wins over the global one when both would apply. A settings patch whose `lifecycle_webhook_secret` names no configured secret is refused with a `400`, and so is a secrets patch that would remove the very entry the settings reference.

Values may be `${ENV_VAR}` placeholders, resolved when the Engine reads the file — recommended in composed deployments. And mind the trust boundary: any client that can submit jobs can direct any named secret's value at a URL of its choosing, so file credentials minted for webhook consumption here — nothing else.

## VOD settings and secrets

How this Engine runs on-demand analysis is a persist document of its own, `GET/PATCH /v2/vif/persist/vod-settings`, stored in `conf.modules/vif/vod/settings.json` — beside the stream configuration and never part of it. Every member is optional; absence means the built-in default rather than a pinned copy of it. Values may be `${ENV_VAR}` placeholders, resolved when the file is read.

| Setting | Default | Meaning |
|---|---|---|
| `max_concurrent_jobs` | `1` | How many jobs run at once; the rest queue. One job already saturates one analysis-model slot, so raise this only if your VIS deployment has capacity to spare. |
| `max_jobs` | `25` | Job records kept; the oldest **finished** jobs (and their stored files) are evicted past the cap. Queued/running jobs are never evicted. |
| `job_ttl_seconds` | `0` (off) | Additionally, forget finished jobs this many seconds after they end. `0` disables the TTL. |
| `content_dir` | Engine `content/` | Where job `file` paths are resolved and uploads land. Applies at the next Engine start. |
| `jobs_dir` | Engine `vif-vod-jobs/` | Where manifests, results, and thumbnails are stored. Applies at the next Engine start. |
| `lifecycle_webhook` | none | Default status-webhook URL for every job. |
| `lifecycle_webhook_secret` | none | Name of a secrets entry whose value is the `Authorization` header on every lifecycle delivery to `lifecycle_webhook`; never sent to a job-supplied destination. A save naming no configured secret is refused. |
| `auto_resume` | `true` | Whether jobs that fail for transient reasons are resumed automatically. |
| `max_upload_bytes` | `10737418240` (10 GiB) | The largest upload `POST /vod/files` accepts; a bigger one is refused with `413` before a byte is written. |

Read it, then edit it with a merge patch that quotes its revision — the same get→edit→save cycle every persist document takes:

```bash
curl -si -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/persist/vod-settings" | grep -i etag
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X PATCH \
  -H "Content-Type: application/merge-patch+json" -H 'If-Match: "<etag>"' \
  -d '{"job_ttl_seconds": 86400}' \
  "$VIF/persist/vod-settings"
```

The answer is the applied document. The caps take effect on the running Engine at once — the worker pool is resized without interrupting a job in flight, and a lowered `max_jobs` evicts immediately. The two directories are read at Engine start and take effect at the next one: moving them under jobs already running would strand them, so a change is logged and left for the restart. Omitting `If-Match` is a `428`; quoting a stale one is a `412`.

**Retention.** The two retention keys compose rather than override: `max_jobs` bounds how many jobs are kept, `job_ttl_seconds` bounds how long, and either one on its own can forget a job — taking its stored results and thumbnail with it. Once a TTL is configured it is swept every 60 seconds, and again whenever a job is submitted or the Engine restarts; a saved TTL also applies at once to the jobs already held. A queued or running job is never touched however old it is. The clock is the moment the job last ended, so a job that was resumed is measured from the run that continued it rather than from the run that stopped.

The credentials the settings and a submit refer to by name live in the secrets document beside it — see [Named webhook secrets](#named-webhook-secrets).

## Best practices

- **Track progress by `state` and `media_time_ms / source_duration_ms`**, not by `requests_sent/requests_total` — the total is an estimate (see [Outputs](#outputs)).
- **Prefer webhooks to polling** for automation; poll for dashboards and ad-hoc checks. Handle the occasional duplicate terminal event.
- **Tag your jobs.** `tag` is free-form and the job list filters on it exactly (`GET /vod/jobs?tag=…`) — use it to group a batch, mark an environment, or carry your own correlation id.
- **Use stream group configs for recurring, unattended work.** They keep credentials out of your requests, make jobs resumable without re-supplying secrets, and centralize tuning in the Manager UI.
- **Mind the analysis cost before submitting.** A file job sends roughly `duration_seconds × inference_fps ÷ frames_per_request` requests. Lowering `inference_fps` is the single biggest lever on how long a job takes and what it costs; for many VOD use cases (finding whether/where something appears) 1–5 fps is plenty.
- **Size the retention to your workflow.** The defaults keep the last 25 jobs forever; a busy pipeline should set `job_ttl_seconds` and copy results into its own storage as jobs complete (webhook → `GET …/results/file` is a clean pattern).
- **Don't parse `error`; route on `error_cause`.** The message is for people and may change; the cause names are the contract.
- **Cancel first, then delete.** `POST …/cancel` stops a queued or running job (state `cancelled`); its record and files stay until you remove them with a DELETE, which only a terminal job accepts.
- **Usage note:** file analysis is metered by media time analyzed, exactly as reported in the manifest's `media_ms_analyzed`.

## API reference

All endpoints are under the Engine REST API (default `http://localhost:8087`), path prefix `/v2/vif`, authenticated with the Engine's REST admin credentials (see the note in [Quick start](#quick-start)), JSON in and out unless noted. [`api/openapi.yaml`](../api/openapi.yaml) is the complete and authoritative reference; when this guide and the specification disagree, the specification is right.

| Method & path | Purpose |
|---|---|
| `GET  /vod/files` | List analyzable files under the content root |
| `POST /vod/files?file=…` | Upload one source file into the content root |
| `POST /vod/jobs` | Submit a job |
| `GET  /vod/jobs` | List jobs (paged, newest first, filterable by tag and state) |
| `GET  /vod/jobs/{jobId}` | One job, with the configuration it was given and the one it ran with |
| `DELETE /vod/jobs/{jobId}` | Remove a finished job — its record, results, and thumbnail |
| `POST /vod/jobs/{jobId}/cancel` | Stop a queued or running job |
| `POST /vod/jobs/{jobId}/resume` | Continue a stopped job from where it got to |
| `GET  /vod/jobs/{jobId}/results` | The job's detections, one page at a time |
| `GET  /vod/jobs/{jobId}/results/file` | The whole results file as newline-delimited JSON |
| `GET  /vod/jobs/{jobId}/thumbnail` | The job's thumbnail (`image/jpeg`) |
| `GET/PATCH /persist/vod-settings` | How this Engine runs on-demand analysis |
| `GET/PATCH /persist/secrets` | The named webhook credentials |

**Responses.** A successful call answers with the operation's payload itself — a submit answers `201` with the job, a read returns the resource, an action answers `202` with the job as it stood when the request was taken, and a DELETE answers `204` with no body. Every **refusal** raised inside the API is one standard shape, `application/problem+json` (RFC 7807):

```json
{"title": "Not found", "status": 404, "detail": "no such job: 00000000-0000-0000-0000-000000000000"}
```

`status` and `title` are always there; `detail` carries the reason in words. Failures *before* a request reaches the API — a router 404, the Engine's auth 401, its license gate 402 — use the Engine's own `{success, code, message}` format instead.

Which status means what, throughout the `/vod` world:

| Status | When |
|---|---|
| `400` | Anything wrong with the request body or a query parameter: an unknown stream group config, neither configuration member, a configuration that selects no detector, a missing or unsupported file, a bad webhook URL, an unknown secret name, a non-numeric page number, a state that is not a state |
| `404` | The job id in the path names no job — and, on the results endpoints, a job that stored no rows |
| `409` | A conflict with the job's own state: cancelling a terminal job, deleting one that is not terminal, every resume refusal, an upload whose name is taken |
| `413` | An upload larger than the VOD settings' `max_upload_bytes` |
| `503` | VOD is unavailable on this Engine — its content or jobs directory could not be resolved or created; the VI log at startup says which |

---

### `GET /vod/files`

Lists analyzable files (`.mp4`, `.m4v`, `.mov`, `.f4v`) under the content root — newest first, up to 6 directory levels deep, up to 500 entries (`"truncated": true` marks a cut-off listing, keeping the newest). The `file` values are exactly what `POST /vod/jobs` takes.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/files"
```

```json
{
  "files": [
    {"file": "vi-object-detection-landscape.mp4", "size_bytes": 11195455, "modified_at": "2026-08-22T21:55:08.361Z"},
    {"file": "archive/cam3/monday.mp4", "size_bytes": 6806761, "modified_at": "2026-08-07T23:26:12.771Z"}
  ],
  "truncated": false
}
```

A listing is not a probe: a file here can still turn out to carry no H.264 track, which the job reports when it runs.

### `POST /vod/files?file=<relative path>`

Uploads one source file into the content root. The request body is the file itself (`Content-Type: video/mp4` or `application/octet-stream`); the target name rides the query string because names carry subdirectory slashes. Subdirectories are created as needed. The bytes are written beside the target and renamed into place, so a partial upload is never visible under an analyzable name — and the file is listed, and submittable, the moment this answers.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X POST \
  -H "Content-Type: video/mp4" --data-binary @clip.mp4 \
  "$VIF/vod/files?file=uploads/clip.mp4"
```

```json
{"file": "uploads/clip.mp4", "size_bytes": 11195455, "modified_at": "2026-08-28T07:41:09.686Z"}
```

`201` on success. Uploads never overwrite: the same name again is a `409`. `400` for no name, an absolute or escaping path, a non-analyzable extension, or a path segment a file already occupies. `413` for an upload past `max_upload_bytes` — declared or actual, so an oversized body is stopped rather than streamed to disk first.

### `POST /vod/jobs`

Submits a job. Answers `201` immediately with the job; the analysis runs in the background.

| Body field | Required | Meaning |
|---|---|---|
| `file` | yes | Path relative to the content root. |
| `stream_group_config` | at least one of the two | A stream group config by name; its config is the middle layer. |
| `config` | | An inline `Config`, layered over the group (or over the default config alone). |
| `store_results` | no (default `true`) | `false` runs the job status-only: no stored rows, no resume. |
| `tag` | no | Free-form label; the job list filters on it. |
| `lifecycle_webhook` | no | Status-webhook URL for this job. Overrides the global; `""` disables notifications for this job. |
| `lifecycle_webhook_secret` | no | Name of an entry in the secrets document; its value is sent as the `Authorization` header on this job's notifications (see [Named webhook secrets](#named-webhook-secrets)). An unknown name is refused. |
| `auto_resume` | no | Overrides the VOD settings' `auto_resume` for this job. |

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"file": "vi-object-detection-landscape.mp4",
       "stream_group_config": "live_objectDotStar", "tag": "nightly"}' \
  "$VIF/vod/jobs"
```

```json
{"job_id": "a110b340-f26c-4474-b629-4482b5d6b8ae", "file": "vi-object-detection-landscape.mp4",
 "tag": "nightly", "detector_type": "object", "stream_group_config": "live_objectDotStar",
 "store_results": true, "results_truncated": false, "state": "pending",
 "requests_sent": 0, "requests_total": 0, "media_time_ms": 0, "source_duration_ms": 74066,
 "queued_at": "2026-08-28T07:41:10.719Z", "resumes": 0}
```

Refusals are `400` (see the status table above) and `503` when VOD has no directories.

### `GET /vod/jobs`

Lists the jobs this Engine knows about, newest first.

| Query param | Default | Meaning |
|---|---|---|
| `tag` | — | Exact-match filter. |
| `state` | — | Filter by state: one name or a comma-separated list (`pending`, `connecting`, `running`, `completed`, `failed`, `cancelled`), in any case. A name that is not one of those is a 400, never a quietly wider listing. |
| `offset` | `0` | Skip this many (after filtering); below zero clamps to zero. |
| `limit` | `100` | Page size, clamped to `[1, 1000]`. |

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs?tag=nightly&limit=10"
```

```json
{"offset": 0, "limit": 10, "count": 1, "total": 1,
 "jobs": [ {"job_id": "…", "file": "…", "tag": "nightly", "state": "running", "…": "…"} ]}
```

`count` is the rows on this page; `total` is everything the filters matched — page with `offset` until `offset + count ≥ total`. The echoed `offset`/`limit` are the clamped values actually applied. A non-numeric `offset`/`limit` is a 400.

The filters compose, and `total` is what they selected together, so `?tag=nightly&state=failed` pages over exactly the failed nightly jobs. A listing is a reading rather than a subscription: a job can leave the state it was selected for before you read the answer.

```bash
# the two filters a jobs panel usually wants: still working, and done
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs?state=pending,connecting,running"
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs?state=completed,failed,cancelled"
```

**Queue depth in one call** — ask for the queued jobs and read `total` rather than counting rows:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs?state=pending&limit=1"
```

```json
{"offset": 0, "limit": 1, "count": 0, "total": 0, "jobs": []}
```

`total` is how many jobs are waiting — zero above, with nothing queued. See [How the queue works](#how-the-queue-works) for what their order means.

A state that is not one of the six is refused rather than widened away:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" "$VIF/vod/jobs?state=nonesuch"
```

```json
{"title": "Bad request", "status": 400,
 "detail": "'nonesuch' is not a job state; state must be one of PENDING, CONNECTING, RUNNING, COMPLETED, FAILED, CANCELLED"}
```

### `GET /vod/jobs/{jobId}`

One job (fields in [Outputs](#outputs)), including `config` — the inline document as submitted, credentials redacted — and `effective_config`, the configuration it actually ran with. `404` for an unknown job.

### `DELETE /vod/jobs/{jobId}`

Removes a **terminal** job (`completed`, `failed`, or `cancelled`): its record, its stored results, and its thumbnail. Answers `204` with no body.

A job that is still queued or running is refused — stop it first with [`POST …/cancel`](#post-vodjobsjobidcancel), then DELETE it once it is terminal:

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X DELETE "$VIF/vod/jobs/$JOB_ID"
```

```json
{"title": "Conflict", "status": 409,
 "detail": "job 1164af1b-… is RUNNING; cancel it first (POST /vod/jobs/1164af1b-…/cancel), then DELETE to remove it"}
```

A job reports its terminal state a moment before its run has finished writing its record, and a DELETE arriving in that moment waits briefly for the record to settle rather than removing half of it. If that wait runs out the removal is refused, and retrying it is the right move:

```json
{"title": "Conflict", "status": 409,
 "detail": "job 1164af1b-… has ended but its run is still writing its record; try again"}
```

Two other outcomes are possible if something else reaches the job first: a resume that started while the DELETE waited answers 409 naming that (cancel the new run before removing it), and a job another request or the retention sweep removed meanwhile answers 404 — which is the state you were asking for anyway.

### `POST /vod/jobs/{jobId}/cancel`

Stops a queued, connecting, or running job. No body.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X POST "$VIF/vod/jobs/$JOB_ID/cancel"
```

Answers `202 Accepted` with the job. The stop is asynchronous, so that view is a snapshot taken as the request was accepted and may still read `running` — poll `GET /vod/jobs/{jobId}` until the state settles to `cancelled`:

```json
{"job_id":"1164af1b-01ae-49a7-8743-3a6ee2d3e7b0","file":"vi-object-detection-landscape.mp4",
 "tag":"cancel-demo","detector_type":"object","store_results":true,"results_truncated":false,
 "state":"running","requests_sent":147,"requests_total":371,
 "media_time_ms":29200,"source_duration_ms":74066,"queued_at":"2026-08-28T07:38:58.724Z",
 "started_at":"2026-08-28T07:38:58.731Z","resumes":0}
```

A cancelled job keeps its record, its stored results, and its thumbnail — it stays readable, and [resume](#resume) can finish the file later. Removing it is a separate DELETE, once it is terminal.

Refusals: `404` (unknown job), and `409` on a job that has already finished — there is nothing left to stop:

```json
{"title": "Conflict", "status": 409,
 "detail": "job 2864f168-7d5d-46da-b9f6-100dd0b03d75 is completed; only a queued or running job can be cancelled"}
```

### `POST /vod/jobs/{jobId}/resume`

Continues a stopped job from the last stored answer. The body is empty except to re-supply an inline job's credentials: `{"config": { … }}`, the same analysis as submitted, from which only the credentials are taken. A body on a group-built job is refused.

Answers `202 Accepted` with the job as it was queued again. Refusals: `400` for a body this API cannot read; `404` for an unknown job; `409` with a `detail` naming the rule — the job is still running or already completed, its run has not finished writing its record yet, it kept no results, the source file changed, the stream group config it was built from is gone or has changed, credentials the record does not hold and the body did not supply, or the resume point cannot be opened.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -X POST "$VIF/vod/jobs/$JOB_ID/resume"
```

```json
{"title": "Conflict", "status": 409,
 "detail": "job 2864f168-… is COMPLETED; re-running a finished job is not a resume"}
```

### `GET /vod/jobs/{jobId}/results`

The stored detections, one page at a time. `offset`/`limit` (default 100, clamped to `[1, 1000]`) page the rows; `from_ms`/`to_ms` first narrow them to the analysis windows starting in `[from_ms, to_ms)` on the source timeline.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" \
  "$VIF/vod/jobs/$JOB_ID/results?from_ms=30000&to_ms=60000&limit=100"
```

```json
{"job_id": "…", "offset": 0, "limit": 100, "count": 100, "total": 150,
 "results": [ { "…": "one analysis response per row" } ]}
```

The rows are the JSON on disk, verbatim — never reshaped on the way out. Readable while the job runs (rows appear as they are answered). A non-numeric `offset`/`limit`/`from_ms`/`to_ms` is a `400`. The `404`s distinguish themselves by `detail`: unknown job, `store_results: false`, or no rows stored yet.

### `GET /vod/jobs/{jobId}/results/file`

Every row the job stored, one JSON object per line, `application/x-ndjson`, served as an attachment named `<job id>.jsonl`. What arrives is the same lines whichever form is on disk: a completed job's gzip-stored file is sent verbatim under `Content-Encoding: gzip` to a client that accepts it (browsers and most HTTP libraries decode this transparently), and decompressed on the way out for one that does not — a bare `curl -o` needs no flags.

```bash
curl -s -u "$WSE_ADMIN_USER:$WSE_ADMIN_PASSWORD" -o results.jsonl "$VIF/vod/jobs/$JOB_ID/results/file"
```

`404` as for the paged results.

### `GET /vod/jobs/{jobId}/thumbnail`

The job's frame as a JPEG — live while running, representative once finished, at the size the detector was given. `404` when the job is unknown or has no frame to show, which is every clip-based (`synthetic`) job and every job before its first frame is decoded.

## Troubleshooting

**The submit is refused with "neither `stream_group_config` nor `config`".** A job has to name its analysis: a group by name, an inline config, or both.

**The submit is refused with "no stream group config named …".** The name is a group's `name` as `GET /v2/vif/persist/stream-group-configs` lists it (a pre-v2 file answers to its file name without `.json`), and the refusal's `detail` lists the names the Engine actually has.

**The submit is refused with "selects no detector".** The layers resolved to a configuration with no detector — a sparse group that names none, and no inline `detector` either. Add one at whichever layer should own it.

**`GET /vod/files` answers `503`.** The content directory could not be resolved or created — check `content_dir` in the VOD settings and the Video Intelligence log from startup.

**An upload answers `413`.** The file is bigger than `max_upload_bytes` in the VOD settings (10 GiB by default). Raise it, or put the file in the content directory by other means.

**The job fails immediately with `source_error`.** The file is missing, unreadable, or carries no H.264 track. The extension filter on `/vod/files` is not a probe — a `.mp4` with only HEVC inside lists fine and fails here.

**`object`/`scene`/`vlm` jobs fail but `synthetic` works.** Frame-decoded jobs need `ffmpeg` on the Engine's `PATH`; clip-based jobs don't. Check the Video Intelligence log for the decoder start failure.

**The job sits in `pending`.** Jobs run `max_concurrent_jobs` at a time (default 1) — it is waiting for the jobs ahead of it.

**`failed` with `endpoint_degraded` almost immediately.** Working as designed: the upstream endpoint (VLM, SVD…) is unreachable or still loading, and the job fails fast rather than burning the file into empty results. Auto-resume retries on a patient backoff; or fix the endpoint and `POST …/resume`.

**A resume answers 409 "the source file has changed".** The file under that path is not the one the job analyzed (size/duration/frame rate differ from the manifest). Restore the original file, or submit a new job.

**A resume answers 409 naming the stream group config.** The group the job was built from has been edited or deleted, so re-running it would not be the same analysis. Submit a new job against the current group, or restore what the group said.

**A DELETE answers 409 "cancel it first".** DELETE only removes terminal jobs, and this one is still queued or running. `POST …/cancel`, poll until the state is `cancelled`, then DELETE.

**A DELETE answers 409 "still writing its record".** The job finished a moment ago and its run has not put the record down yet; the DELETE waited and gave up rather than removing half of it. Retry it. A job that never stops saying this has a listener or a transport that is not returning while the job tears down, which leaves the job unremovable until the Engine restarts.

**A cancel answers 409 "only a queued or running job can be cancelled".** The job already reached `completed`, `failed`, or `cancelled` — there is nothing left to stop. DELETE it if what you wanted was the record gone.

**A settings or secrets PATCH answers 428 or 412.** Persist writes are guarded by `If-Match`: `428` means the header was missing, `412` that the revision it quoted is no longer current. Read the document again and quote the `ETag` it answers with.

**The thumbnail is 404 for a synthetic job.** Expected — clip-based jobs never decode a frame. Every other type has one from the first analyzed frame onward.

**Results are missing for an old job.** Finished jobs are evicted past `max_jobs` (default 25) or after `job_ttl_seconds`, and eviction removes stored files. Copy results out as jobs complete if you need them long-term.

**A completed job shows `requests_sent` one below `requests_total`.** Expected occasionally — the total is an up-front estimate. `"state": "completed"` means the whole file was analyzed.
