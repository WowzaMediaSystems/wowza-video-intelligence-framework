# Motion Detection Guide

The Video Intelligence framework can detect **movement** on a live stream or a
VOD file. With `detector_type: "motion"`, the framework compares consecutive
frames, groups the changed pixels into regions, tracks each region across
frames, and reports every moving region as a bounding box with class `motion`.

Motion is the framework's cheapest detector: it runs no model. The arithmetic
runs on the CPU inside the Video Intelligence Service, in a few milliseconds
per frame — no GPU requirement, no model download, no external endpoint, and
nothing extra to deploy. That makes it practical in two roles:

- **Standalone alerting** — "tell me when something moves on this camera",
  delivered through the same event listeners every detector uses: webhooks,
  ID3 timed metadata, log files, and a video overlay.
- **The entry gate of a chain** — run motion on every captured frame and wake
  an expensive stage (object detection, a VLM question) only where something
  moved. See [Motion as a chain's entry stage](#motion-as-a-chains-entry-stage).

## Table of contents

- [Quick start](#quick-start)
- [What to expect](#what-to-expect)
- [Configuration reference](#configuration-reference)
- [What you receive](#what-you-receive)
- [Motion on VOD files](#motion-on-vod-files)
- [Motion as a chain's entry stage](#motion-as-a-chains-entry-stage)
- [See also](#see-also)

---

## Quick start

Prerequisites: a working framework checkout with `.env` populated (licenses,
admin credentials — see [README](../README.md)). Motion needs no optional
profile, no GPU on the detector path, and no third-party endpoint.

**1. Start the stack:**

```bash
docker compose up -d
```

**2. Configure a motion stream.** From the Engine Manager Video Intelligence
configuration (`http://localhost:8088`), add a stream whose **Detector Type**
is `motion` and whose stream name pattern is, for example, `motion.*`. The
defaults (Sensitivity 5, Min Displacement 0.02) are a sensible starting point.

**3. Publish a stream** matching the pattern:

```bash
ffmpeg -re -stream_loop -1 -i your-clip.mp4 -c copy -f flv rtmp://localhost:1935/live/motion-demo
```

**4. Watch the results.** Every analyzed frame with sustained movement produces
detections, surfaced through the standard event listeners — the log file, ID3
timed-metadata tags, webhooks, and boxes drawn on the `-vi` overlay rendition
(`http://localhost/live/motion-demo-vi/playlist.m3u8`):

```bash
tail -f wse/logs/wowzastreamingengine_vi.log
```

---

## What to expect

### A detection is a tracked moving region

The detector differences each analyzed frame against the previous one, so a
detection means "these pixels changed between two frames, and the region has
travelled far enough to matter". Each reported region carries:

- `class_name` — always `motion`.
- `bbox` — the region's bounding box.
- `track_id` — the region's identity across frames.
- `confidence` — **how far the region has travelled**, not how certain the
  detector is. See the next section.

### Confidence is distance travelled, not certainty

A motion detection's `confidence` is the track's **net displacement**: the
distance from where the track started to where it is now, as a fraction of the
frame diagonal (0.0–1.0). It rises as the subject keeps moving — typical values
for real subjects are 0.02–0.3 — and it is the heart of the detector's noise
rejection:

- A **walking person** moves away from their starting point, so their
  displacement grows and crosses the reporting threshold.
- A **fluttering leaf, rippling water, or sensor noise** oscillates around a
  fixed point, so its net displacement stays near zero and it is never
  reported, no matter how long it flutters.
- A **slow mover** is delayed rather than suppressed: it is reported once it
  has genuinely travelled `min_displacement`.

Because displacement rises with track age, raising a threshold reports the same
subjects **later** rather than reporting fewer of them.

### Honest limits

Frame differencing has blind spots that no setting removes. Know them before
relying on the detector:

- **Anything that stops disappears.** A subject that halts produces no pixel
  changes and therefore no detections. After 30 analyzed frames without
  movement its track is dropped; when it moves again it returns as a **new
  track with displacement reset to zero**.
- **Loitering looks like flutter.** Someone shuffling in place accumulates
  little net displacement, so a displacement threshold cannot distinguish them
  from a swaying branch. If loitering matters to you, use motion to gate an
  object-detection or VLM stage in a [chain](MODEL_CHAINING.md) instead.
- **Track identities churn more than object detection's.** Difference regions
  merge and split as subjects pass each other, so one real subject can span
  several track ids. Expect per-track aggregates (such as rollup travel) to
  reset at each id change.
- **Slow subjects can split in two.** A subject moving less than its own width
  per frame appears as separate leading- and trailing-edge slivers.
  `merge_distance` bridges that gap; raise it if a single subject is reported
  as a pair of thin boxes, and lower it if genuinely separate subjects merge
  into one box.
- **Global changes are capped, not understood.** A lighting change or camera
  pan changes most of the frame; built-in area and count caps keep such events
  from flooding the output, but a moving camera is not a supported input —
  the detector assumes a fixed view.

### Cost and latency

Motion analyzes individual frames (the `inference_fps` setting controls how
many per second), so alerts have the lowest latency of any detector — there is
no multi-second window to fill before a result can exist. Displacement is
measured across the frames actually sent: at a lower `inference_fps` the
detector does less work and still accumulates the same travel, at the price of
missing very brief movement.

---

## Configuration reference

These settings live on the motion stream — globally for defaults, per stream to
override. Set them from the Manager UI (the **Motion Analysis** section), the
v2 API (`"detector": {"type": "motion", ...}`), or the stream configuration
JSON (`motion_analysis`):

| Field | Default | Meaning |
| --- | --- | --- |
| `sensitivity` | `5` | How faint a pixel change still counts as movement, `1`–`10`. `1` reports only large, high-contrast movement; `10` picks up the smallest and faintest. |
| `min_displacement` | `0.02` | How far a tracked region must travel from where its track started before it is reported, as a fraction of the frame diagonal. `0` reports every tracked region. |
| `merge_distance` | `0.08` | Gap, as a fraction of the frame width, within which neighbouring moving regions merge into one subject. |

In the stream configuration JSON:

```json
{
  "detector_type": "motion",
  "motion_analysis": {
    "sensitivity": 5,
    "min_displacement": 0.02,
    "merge_distance": 0.08
  }
}
```

Tuning order: `sensitivity` decides what counts as movement at all;
`min_displacement` decides how far it must travel to be worth reporting;
`merge_distance` decides when neighbouring regions are one subject.

### A listener's confidence threshold is a travel gate

Event listeners filter detections by `confidence_threshold`, and for motion
that confidence is distance travelled. A listener threshold therefore means
"deliver only subjects that have travelled this far" — useful, for example, to
burn only far-travelling subjects into the overlay while a webhook receives
everything.

The Manager UI defaults a motion listener's threshold to `0.0` (no extra
filtering beyond `min_displacement`). **Do not copy thresholds from object
configs**: `0.7` would mean "moved 70% of the frame diagonal", which almost
nothing does, and would silently blank that listener. Realistic travel gates
are `0.02`–`0.10`.

---

## What you receive

Each analyzed frame with reportable movement produces detections with
`detections_type: "motion"`:

| Field | Meaning |
| --- | --- |
| `class_name` | Always `"motion"`. |
| `bbox` | The moving region's bounding box. |
| `track_id` | The region's identity across frames; changes when a subject stops, or when regions merge or split. |
| `confidence` | Net displacement of this track so far, `0.0`–`1.0` of the frame diagonal. |

Results flow through the standard event listeners: the log file, ID3
timed-metadata tags in the HLS output, webhooks, and boxes with the travel
value drawn on the `-vi` overlay rendition.

### Rollups

Listeners using the `rollup` method receive aggregated intervals with
`detections_type: "motion-rollup"`. Because a motion detection's confidence is
its travel, a rollup bucket's confidence spread (`max − min`) is **the distance
that subject travelled during the interval**. One real subject can span several
buckets when its track id changes mid-interval.

---

## Motion on VOD files

Motion works as a VOD job detector through the v2 API — the same analysis over
a file instead of a live stream, one result row per analyzed frame:

```bash
curl -u "$VIF_USER:$VIF_PASSWORD" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"file": "uploads/clip.mp4", "config": {"detector": {"type": "motion"}}}' \
  "http://localhost:8087/v2/vif/vod/jobs"
```

Job listing, results, cancellation and resume work exactly as for any other
detector — see the [chaining guide's results section](MODEL_CHAINING.md#read-results-and-resume)
for the endpoints.

---

## Motion as a chain's entry stage

Motion's second role is waking expensive stages only when something moves: the
motion entry differences every captured frame, ends quiet windows at the gate,
and routes windows that moved onward — to object detection, a VLM, or crops of
exactly the regions that moved. The
[Wake expensive stages on motion](MODEL_CHAINING.md#wake-expensive-stages-on-motion)
section of the chaining guide has the worked example and the composition rules
(motion must be the entry stage, no synthetic stage in a motion-entry chain,
object stages after motion run untracked).

---

## See also

- [`MODEL_CHAINING.md`](MODEL_CHAINING.md) — chains, routing, and the motion gate pattern.
- [`README.wse-plugin.md`](README.wse-plugin.md) — the plugin's full configuration reference.
- [`README.md`](../README.md) — framework quick start and configuration.
