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

**A box is the span of movement, not the subject's outline.** The detector
compares each analyzed frame with the previous one, so a region covers where
the subject was *and* where it is now. At keyframe rates (about one frame a
second) that is roughly the subject plus one step; at native frame rate a slow
subject shows only its moving edges, and a subject that stops disappears. Read
a box as "something moved here". When you need the subject's own extent, or a
subject that is present but still, use object detection — the `person` class
for people — on its own or as the stage a motion gate wakes.

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
- **Whole-picture changes are filtered, not understood.** A cut, a lighting
  change or a camera move alters nearly the whole picture; the detector judges
  such a frame by the extent of the change alone and reports nothing for it.
  That rule has edges in both directions — see
  [Whole-picture changes](#whole-picture-changes), which also explains how to
  switch the filter off.

### Whole-picture changes

A cut to another camera, a light switched on or a camera pan changes nearly
every pixel between two analyzed frames. Frame differencing alone would report
that as one huge moving region, so the detector filters it first: when the
change between two analyzed frames **spans at least 95% of the picture in both
height and width and covers at least 60% of its area**, the frame counts as a
change of the whole picture, not movement within it. It yields no regions, and
the next frame starts over.

"The picture" is the area inside any letterbox or pillarbox bars: rows and
columns that stay nearly black are left out. A cut or a lighting change inside
a letterboxed film is therefore still caught.

What the filter catches:

- **Cuts and dissolves** — a sports feed switching cameras, a newscast cutting
  to a report.
- **Lighting changes** — a lamp switched on or off in a corridor, a cloud
  passing over a car park, the camera's auto-exposure jumping.
- **Camera moves at keyframe rates** — pans, handheld shots, drone footage.

What it deliberately lets through:

- **A large close-up subject.** Someone walking right past the lens changes a
  big area, but not the picture edge to edge, so they are reported like any
  other region.
- **Two far-apart movers.** Two people entering a lobby from opposite ends span
  the picture between them but fill little of it; each is reported.
- **A change confined to part of the picture.** A signage screen in that lobby
  cutting between slides is, to the detector, movement within the picture,
  however abrupt the change on the screen.

Measured on several hundred real clips, the filter misjudges three situations:

- **A camera moving at native frame rate is not filtered.** Between two
  consecutive frames a pan shifts the picture only slightly, so it reads as
  many small movers rather than one change of the picture.
- **A cut with a static band is reported as one large region.** A station logo
  or a banner, an unchanged sky, or bars that are not black stay still across
  the cut; the change then spans less than 95% of the picture and is reported
  as one large region instead of being filtered.
- **At low analysis rates, a close subject or a crowd can be filtered too.** At
  one or two analyzed frames a second, a subject close to the camera or a
  crowd can change more than 60% of the picture between two samples. Raising
  `inference_fps` makes that rare.

#### Turning the filter off

Sometimes the whole-picture change is the event you want:

- **Tamper detection** — someone covers the lens of a corridor camera or turns
  it to face the wall.
- **A blackout** — the scene goes dark, or the feed goes black.
- **Lights in a secured room** — the lights come on in a room that should be
  dark and empty.
- **A scene change as a trigger** — a cut that should start other analysis,
  through a chain stage or a webhook.

For these, set `suppress_global_changes` to `false`. In the Manager UI it is
the **Global Changes** field of the **Motion Analysis** section, with the
choices **Suppress** (the default) and **Report**; left blank, a stream
inherits the value of the default configuration. On the v2 API it is
`"detector": {"type": "motion", "suppress_global_changes": false}`, and in the
stream configuration JSON `motion_analysis.suppress_global_changes`.

`false` switches the filter off entirely: a frame whose change covers the
whole picture is reported as the moving regions it produces, at most 20 per
frame as always. The cost is that every cut, every light switch and every
camera move at keyframe rates becomes a motion event — on a sports feed with
frequent cuts or a handheld camera, leave the filter on.

**To hear about a change on the frame it happens, also set `min_displacement`
to `0`.** A region is reported once its track has travelled
`min_displacement`. A one-frame event — a cut, a light switched on — produces
a region whose track starts on that very frame, so it has travelled nothing
yet and is normally not reported at the default `0.02`. (It can slip through
when something was moving just before the change: the picture-wide region
then continues that subject's track and inherits its travel.) With only the
filter off, you reliably hear about a whole-picture change only when it
persists and moves (a slow fade, a pan), not about a single abrupt switch.
With `min_displacement` at `0` the
region is reported on the frame of the change with `confidence` `0`, so the
listener that should receive it must keep its confidence threshold at `0.0` —
the Manager UI's default for a motion listener (see
[A listener's confidence threshold is a travel gate](#a-listeners-confidence-threshold-is-a-travel-gate)).
`min_displacement` at `0` also reports every other tracked region, flutter
included, so give that camera its own stream configuration:

```json
{
  "detector_type": "motion",
  "motion_analysis": {
    "suppress_global_changes": false,
    "min_displacement": 0
  }
}
```

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
| `suppress_global_changes` | `true` | Whether a change of the whole picture — a cut, a lighting change, a camera move at keyframe rates — is filtered out before regions are extracted. `false` reports it as moving regions. See [Whole-picture changes](#whole-picture-changes). |

In the stream configuration JSON:

```json
{
  "detector_type": "motion",
  "motion_analysis": {
    "sensitivity": 5,
    "min_displacement": 0.02,
    "merge_distance": 0.08,
    "suppress_global_changes": true
  }
}
```

Tuning order: `sensitivity` decides what counts as movement at all;
`min_displacement` decides how far it must travel to be worth reporting;
`merge_distance` decides when neighbouring regions are one subject; and
`suppress_global_changes` decides whether a change of the whole picture
counts as movement in the first place.

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
| `bbox` | The span of the movement between the two compared frames (where the subject was and where it is now), not the subject's outline. |
| `track_id` | The region's identity across frames; changes when a subject stops, or when regions merge or split. |
| `confidence` | Net displacement of this track so far, `0.0`–`1.0` of the frame diagonal. |

Results flow through the standard event listeners: the log file, ID3
timed-metadata tags in the HLS output, webhooks, and boxes with the travel
value drawn on the `-vi` overlay rendition.

### Rollups

Listeners using the `rollup` method receive aggregated intervals with
`detections_type: "motion-rollup"`. Because a motion detection's confidence is
its travel, a rollup bucket's confidence spread (`max − min`) is **the distance
that tracked region travelled during the interval**. One real subject can span
several buckets when its track id changes mid-interval.

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

The entry stage takes the same members as a motion stream — `sensitivity`,
`min_displacement`, `merge_distance` and `suppress_global_changes`.

---

## See also

- [`MODEL_CHAINING.md`](MODEL_CHAINING.md) — chains, routing, and the motion gate pattern.
- [`README.wse-plugin.md`](README.wse-plugin.md) — the plugin's full configuration reference.
- [`README.md`](../README.md) — framework quick start and configuration.
