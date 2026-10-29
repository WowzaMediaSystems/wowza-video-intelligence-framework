# Model chaining

A chain is a detector built out of other detectors. Instead of running one
model on a stream, a chain runs named **stages** — each an ordinary `scene`,
`object`, `vlm`, `motion` or `synthetic` detector — over the same captured
media, and decides for every window which stages actually run. The usual reason
is cost: run a cheap stage on everything and wake an expensive one only when
the cheap one saw something. Ask a VLM about a frame only when motion was
detected, review a clip only when it scored as synthetic, read a license plate
only when a car is in view.

Use a chain wherever the v2 API accepts a `config.detector`: inline VOD jobs,
saved stream group configs, per-stream overrides, or a running stream's
detector. A frame-only chain works on VOD and live streams; a chain containing
a synthetic stage is VOD-only. Chains and Verify cannot be nested inside a
stage.

## Table of contents

- [How a chain runs](#how-a-chain-runs)
- [Before you start: detector baselines and endpoints](#before-you-start-detector-baselines-and-endpoints)
- [Run a first chain](#run-a-first-chain)
- [Choose an execution mode](#choose-an-execution-mode)
- [Conditional mode: route on what a stage found](#conditional-mode-route-on-what-a-stage-found)
- [Wake expensive stages on motion](#wake-expensive-stages-on-motion)
- [Crop detected regions](#crop-detected-regions)
- [Dynamic mode: let an installed Java listener choose the next stage](#dynamic-mode-let-an-installed-java-listener-choose-the-next-stage)
- [Service compatibility](#service-compatibility)
- [Save and reuse the definition](#save-and-reuse-the-definition)
- [Read results and resume](#read-results-and-resume)
- [Latency](#latency)
- [Live streams](#live-streams)

## How a chain runs

Everything a detector does happens inside an **analysis window**: the unit of
media the Engine captures and sends for analysis. Depending on the detector, a
window is a single frame, a batch of frames covering a few seconds, or an
encoded clip. A chain adds one idea on top: within each window, several stages
can take their turn on that same captured media.

Every window starts at the chain's **entry stage**, `stages[0]`. Each time a
stage runs is one **execution** — called a **ring** in stored results. After an
execution, the chain picks what happens next: the next stage in order (linear
mode), a routing rule's target (conditional mode), or whatever your Java code
returns (dynamic mode) — until a stage ends the window or nothing is left to
run. The sequence actually taken is the window's **path**. It can differ from
window to window, skip stages, and revisit a stage; `max_rings` bounds the
executions per window.

A chain captures the **largest unit any of its stages consumes**:

| Stages | Cadence | A window is |
|---|---|---|
| any `synthetic` stage in the chain | clip | an encoded clip of the window (VOD only) |
| else any `scene` or `vlm` stage | window | the frames captured over `window_seconds` |
| only `object` and `motion` stages | frame | one frame per request |

A chain whose object or motion entry is followed by a scene or VLM stage
therefore runs at window cadence and requires a service that advertises
`chain.window_entry` (see [Service compatibility](#service-compatibility)).

When a window ends, its results flow where a detector's results always flow:
each VOD window is stored as one result row, and event listeners — webhooks,
ID3 tags, log files, overlays — receive the final stage's result, or every
execution when `result_mode` is `combined`.

## Before you start: detector baselines and endpoints

Use matching Engine plugin and Video Intelligence Service versions that support
the chains API. Configure the ordinary detector baselines first; each stage
inherits its own type's baseline. No separate chain baseline is needed.

The API uses Engine REST credentials. In the commands below, set `VIF_USER` and
`VIF_PASSWORD` to your credentials:

```bash
VIF_URL=http://localhost:8087/v2/vif
curl -u "$VIF_USER:$VIF_PASSWORD" -i "$VIF_URL/persist/configs/default"
```

To change default endpoints, PATCH that resource with the `ETag` from the read:

```json
{
  "detectors": {
    "vlm": {
      "type": "vlm",
      "mode": "describe",
      "endpoint": { "url": "http://your-vlm:8000/v1" }
    },
    "synthetic": {
      "type": "synthetic",
      "endpoint": { "address": "your-svd:8001" }
    }
  }
}
```

Use `Content-Type: application/merge-patch+json` and `If-Match: <the returned ETag>`.
The addresses must be reachable from the analysis service. VLM uses an
OpenAI-compatible HTTP base URL; SVD uses a gRPC `host:port`, without an HTTP
scheme. Add the endpoint's `api_key` only when that endpoint needs it.

A stage may override any ordinary detector setting, including endpoints,
thresholds, object tracking and VLM generation settings. The API never echoes
stage credentials.

## Run a first chain

List the files available under the Engine's content directory:

```bash
curl -u "$VIF_USER:$VIF_PASSWORD" "$VIF_URL/vod/files"
```

Save this request as `chain-job.json`, replacing the file with a listed path:

```json
{
  "file": "uploads/clip.mp4",
  "config": {
    "detector": {
      "type": "chain",
      "stages": [
        {
          "name": "objects",
          "detector": { "type": "object", "classes": ["person"] }
        },
        {
          "name": "describe",
          "detector": { "type": "vlm", "mode": "describe" }
        }
      ]
    }
  }
}
```

```bash
curl -u "$VIF_USER:$VIF_PASSWORD" -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @chain-job.json \
  "$VIF_URL/vod/jobs"
```

The response includes `job_id`, `state` and `detector_type: chain`.
Without a mode, stages run in their listed order. The second stage sees the same
captured media; it does not automatically receive crops of the detected people.

Put capture settings such as `window_seconds` and `inference_fps` in the
parent's `config.processing`, never inside a stage — the chain's cadence comes
from the largest unit its stages consume (see
[How a chain runs](#how-a-chain-runs)).

Sharing a window does not mean sharing a rate: the chain captures once, and each
stage chooses how much of that capture it analyzes. A stage without
`frame_selection` reads every captured frame; a stage that needs fewer adds
`"frame_selection": {"mode": "middle"}` to its stage wrapper. Modes are `all`,
`first`, `middle`, `last` and `every_nth`; the last requires `stride >= 2`
and always includes the first and last captured frames. A frame-cadence chain
has only one frame per request, so it refuses any `frame_selection` other than
`all`.

## Choose an execution mode

| Mode | Who picks the next stage | Use it when |
|---|---|---|
| `linear` (default) | The stage order | Every window should run the same stages. |
| `conditional` | Routing rules in the config | The next stage depends only on which classes the last stage found, how many, and how confidently. No code. |
| `dynamic` | Your Java class, installed in Engine | The decision needs anything else: the text of a VLM answer, earlier stages in the window, earlier windows, time of day, or a system outside Video Intelligence. |

Start with `conditional` when its rules can express the decision; move to
`dynamic` when they cannot. Dynamic mode supports frame detectors only (no
synthetic stages).

## Conditional mode: route on what a stage found

This conditional chain scores each video window and asks the VLM to review only
windows classified as synthetic:

```json
{
  "file": "uploads/clip.mp4",
  "config": {
    "processing": { "window_seconds": 5, "inference_fps": 1 },
    "detector": {
      "type": "chain",
      "mode": "conditional",
      "stages": [
        {
          "name": "score",
          "detector": { "type": "synthetic", "classification_threshold": 0.7 },
          "routing": {
            "rules": [{ "classes": ["synthetic"] }],
            "on_match": { "stage": "describe" },
            "on_no_match": { "end": true }
          }
        },
        {
          "name": "describe",
          "detector": { "type": "vlm", "mode": "describe" },
          "frame_selection": { "mode": "middle" }
        }
      ]
    }
  }
}
```

A routing rule counts detections whose class matches, ignoring case, and whose
confidence is at least `min_confidence` (default 0). It matches when
`min_count` (default 1) qualify. `match: any` is the default; `match: all`
requires every rule. Missing or empty classes never match. An empty rules list
never matches, in either mode.

SVD's verdict is synthetic when its score is **strictly greater than** its
`classification_threshold`. A routing `min_confidence` is an additional
filter and includes equality. For example, a score of exactly 0.7 is real with
the threshold above, even though it passes a confidence filter of 0.7.

A target is exactly one of `{"stage": "name"}` or `{"end": true}`. A
conditional stage without routing falls through to the next stage. Omitting
`on_no_match` ends the chain on a miss. Revisits are allowed;
`max_rings` limits executions per window to 8 by default, with a range of
1–64. It is a loop bound, not the number of configured stages.

Routing has a second, unconditional shape: `on_done` alone, combined with no
rule member — a target taken whatever the stage returned. Ending through
`on_done` is an answer, not a filter: the window reports
`end_reason: "completed"` and delivers the stage's detections. A free-form VLM
stage (`describe` mode, or `custom` without a `response_schema`) produces no
classes for rules to match, so `on_done` is the only routing it accepts. The
`describe` stage above ends the chain by being last; give such a stage
`"routing": {"on_done": {"stage": ...}}` to continue past it instead.

A window that ends on a miss was **filtered out**, and under the default
`result_mode: final` its event listeners receive the gate stage's response type
with no detections — not the detections the routing judged uninteresting. The
window, timing and `end_reason: "no_match"` still arrive, so a listener with
`suppress_empty_detections: true` skips filtered windows entirely while one
without it can tell "filtered by the gate" from "analyzed, nothing found".
Ending through `on_match` (`end_reason: "match_end"`) is an affirmative answer
and delivers the stage's detections. Use `result_mode: combined` when listeners
should see every executed stage, filtered windows included.

## Wake expensive stages on motion

A motion entry stage is a cheap gate: it compares consecutive frames on the CPU and
reports each moving region as a detection with class `motion`. A quiet request yields no
detections, no rule matches, and the chain ends before any downstream stage runs:

```json
{ "type": "chain", "mode": "conditional", "stages": [
    { "name": "watch", "detector": { "type": "motion" },
      "routing": { "rules": [{ "classes": ["motion"] }],
                   "on_match": { "stage": "describe" },
                   "on_no_match": { "end": true } } },
    { "name": "describe", "detector": { "type": "vlm", "mode": "describe" },
      "frame_selection": { "mode": "middle" } } ] }
```

`motion → object` and `motion → scene` compose the same way. The VLM stage gives the
chain above window cadence: motion compares each consecutive pair of frames within the
window, carrying its state across windows, and `describe` is asked once per window
that moved — here with the window's middle frame, per its `frame_selection`; omit
that to send every captured frame. Motion is only supported as the entry stage
(`stages[0]`) and cannot be cropped onto. Object stages behind a motion entry run
untracked: the entry filters which frames reach them, so track IDs would be
unreliable. An object stage behind it must set `"tracking": {"method": "none"}`.

The gate and the expensive stage need not analyze at the same rate. The capture
rate is set once, in `config.processing`; each stage's `frame_selection` then
narrows that stage alone. `inference_fps: -1` captures at the source frame rate,
so on a 30 fps stream with `window_seconds: 2` every window carries 60 frames:
the motion entry differences all 60 — a movement between any two captured frames
cannot slip past it — while giving the VLM stage
`"frame_selection": {"mode": "every_nth", "stride": 15}` sends it five of them
(the first, every fifteenth, and the last).

Ask the VLM what the scene shows, not whether it moved. Sampled frames reach a
vision-language model as separate stills, and a modest position change between
them — even one the motion gate flags loudly — reads as near-identical images;
small models confidently describe a moving object as static. The motion
detections already carry each moving region and its displacement; use the VLM
for what is visible within a frame.

No route may target the motion entry stage, including its own `routing`: a revisited
motion stage re-differences the same window — at frame cadence it can never fire, and
at window cadence it would re-report the window's own motion.

A motion-entry chain cannot contain a synthetic stage: a synthetic stage switches the
chain to clip-window transport, which the motion entry does not support yet.

Motion `confidence` is the region's net track displacement as a fraction of the frame
diagonal, typically 0.02–0.3. It is **not** a quality score. Tune the gate with the
motion detector's `sensitivity` (1–10, default 5), `min_displacement` (default 0.02)
and `merge_distance` (default 0.08), not with a routing `min_confidence`; use
`min_count` to require several moving regions. The motion detector itself is covered
in the [Motion Detection guide](MOTION_DETECTION.md).

## Crop detected regions

To run a stage on the preceding execution's boxes, add this to its stage wrapper:

```json
{
  "crop": {
    "classes": ["person"],
    "min_confidence": 0.5,
    "padding": 0.1,
    "max_crops": 16
  }
}
```

Crop defaults are all classes, confidence 0, padding 0 and a `max_crops` budget
of 16 per **window**: the highest-confidence boxes across all of the window's
source frames are kept. When the parent object ring tracks, each track is
cropped once per window — its highest-confidence box — so the budget counts
objects, not appearances. No matching boxes produces an empty stage result.

The first stage, motion stages and synthetic stages cannot crop. In linear mode, the preceding
stage must be an object or motion detector, the two types whose detections carry boxes.
A stage after a motion entry crops to the moving regions, with `min_confidence`
gating parents by their net displacement. A cropped object stage must disable tracking
and tiling. Object tracking also requires every captured frame to reach the tracking
stage exactly once. A chain of only object stages provides that on every stage; a
scene or VLM stage anywhere puts the chain at window cadence, where only the entry
stage still sees every captured frame, so only an object entry may track — with
`frame_selection` left at `all`, and not on a dynamic chain, whose listener may
revisit the entry. A chain with a synthetic stage, or one whose entry is not an
object stage, cannot track at all. Set `"tracking": {"method": "none"}` where a
stage's inherited tracking would otherwise violate these rules.

Crop child coordinates refer to the original full frame. The result's
`source_ring_index` and `source_detection_index` identify the parent execution
and detection.

## Dynamic mode: let an installed Java listener choose the next stage

In dynamic mode, Engine calls your Java class after every stage execution, and
the class returns the next stage to run, optionally on crops, or ends the window.
Because it is ordinary Java running inside Engine, it can base that choice on
anything it can compute or reach: the full result of the stage that just ran,
including VLM text; the earlier executions in the window; state kept across
windows; or a system outside Video Intelligence. Dynamic chains run on VOD and
live streams and support frame detectors only.

### A minimal listener

This chain looks for people on every window but asks the VLM to describe them at
most once per cooldown period, a limit that routing rules cannot express:

```json
{
  "type": "chain",
  "mode": "dynamic",
  "decision_timeout_seconds": 5,
  "decision_listener": {
    "class_name": "com.example.PersonReviewDecision",
    "properties": { "cooldownSeconds": 60 }
  },
  "stages": [
    { "name": "objects", "detector": { "type": "object", "classes": ["person"] } },
    { "name": "describe", "detector": { "type": "vlm", "mode": "describe" } }
  ]
}
```

Compile your class against the installed Engine and plugin APIs, put its JAR in
the Engine's library directory, and restart Engine before using it:

```java
package com.example;

import java.util.HashMap;
import com.wowza.wms.application.IApplicationInstance;
import com.wowza.wms.stream.IMediaStream;
import com.wowza.wms.plugin.videointelligence.api.ChainDecision;
import com.wowza.wms.plugin.videointelligence.api.ChainDecisionContext;
import com.wowza.wms.plugin.videointelligence.api.IVifChainDecisionListener;

public class PersonReviewDecision implements IVifChainDecisionListener {
    private long cooldownMs;
    private long lastReviewMs;

    public static String getVersion() { return "1.0.0"; }

    public void onInit(IApplicationInstance app, IMediaStream stream,
                       HashMap<String, Object> properties) {
        cooldownMs = 1000L * Long.parseLong(
            String.valueOf(properties.getOrDefault("cooldownSeconds", 60)));
    }

    public void onShutdown() {}

    public ChainDecision decide(ChainDecisionContext context) {
        if (!"objects".equals(context.stageName()) || !context.sawClass("person"))
            return ChainDecision.done();
        long now = System.currentTimeMillis();
        if (now - lastReviewMs < cooldownMs)
            return ChainDecision.done();
        lastReviewMs = now;
        return ChainDecision.advance("describe");
    }
}
```

`ChainDecision.advance(name)` runs that stage next; `ChainDecision.done()`
completes the window. Returning null or an unknown stage name also completes
it, with a warning in the Engine log. A stage may be chosen again (revisited),
up to `max_rings` executions per window.

The class must be public and concrete, implement `IVifChainDecisionListener`,
and expose a public no-argument constructor. A static `getVersion()` is
recommended for version reporting. Configuration reads and writes never execute
its decisions; the class is checked before analysis starts.

### What a decision can read

`ChainDecisionContext` describes the execution that just finished:

| Member | Contents |
|---|---|
| `stageName()` | Configured name of the stage that just ran. |
| `current()` | That execution's result, a `StageResult`. Never null. |
| `history()` | The earlier executions in this window as `StageResult`s, oldest first, excluding the current one. |
| `path()` | The stage name of every execution so far, oldest first, ending with the current stage. |
| `executionIndex()` | Zero-based count of executions in this window, including revisits. |
| `sawClass(name)`, `count(name)` | Whether, and how many, detections of the current execution have that class name — ignoring case, like routing rules and crop classes. |
| `streamName()` | The stream name. For a VOD job, the job's stream name. |
| `properties()` | The configured `properties`, plus `stream_name` and `detector_type`. VOD jobs add `job_id` and `source_file`. This is the same map `onInit` received. |

A `StageResult` carries `stageName()`, `detections()` (never null), the same
`count`/`has` class queries, and `window()` with the covered media range
(`fromMs()`/`toMs()`, and frame ids where the source has them).

Every `Detection` carries `kind()` — `"object"`, `"scene"`, `"vlm"`,
`"synthetic"` or `"motion"`, with constants on `Detection` — next to
`className()` and `confidence()`. What a detector adds beyond those lives on
its typed view: `object()` exposes `box()` (full-frame pixel coordinates),
`trackId()` and the crop-source anchors for object stages, and `vlm()` exposes
`reasoning()` and `data()` for VLM stages; each view is null for detections of
any other kind. A VLM in describe mode yields one detection whose class is
`description` and whose `vlm().reasoning()` holds the text; a VLM stage with a
custom `response_schema` yields one detection whose `vlm().data()` carries the
whole schema output. A motion entry stage's detections are always class
`motion`, and their `confidence` is the track's net displacement as a fraction
of the frame diagonal, not a quality score. Future releases may add kinds, so
treat an unrecognized `kind()` as a detection with only the common members.

Because the context is built from these small interfaces, your listener is
unit-testable without Engine: construct a `ChainDecisionContext` from your own
fake `StageResult`s and assert on the returned `ChainDecision`.

### Choosing crops

To run the next stage on crops of the current execution's boxes, return
`ChainDecision.advanceCropped` with a `CropSpec`:

```java
public ChainDecision decide(ChainDecisionContext context) {
    if (context.count("car") == 0)
        return ChainDecision.done();
    return ChainDecision.advanceCropped("plates",
        CropSpec.ofClasses("car").withMinConfidence(0.5).withPadding(0.1).withMaxCrops(8));
}
```

`CropSpec.all()` crops every class. Unset crop fields use the same defaults as
a configured `crop`. Crops come from detections that carry boxes — object
stages, and a motion entry stage's moving regions. A cropped object stage
must have tracking and tiling disabled.

### Instance lifecycle and threading

- Engine creates one instance of your class per live stream and per VOD job, and
  calls `onInit` once before the first window. Streams that name the same class
  get separate instances, so instance fields hold per-stream state. To share
  state across streams, use your own static or external store.
- On a live stream, `onInit` receives the application instance and the stream.
  For a VOD job the application instance is null and the stream answers only
  `getName()`.
- `onShutdown` runs when the stream stops, its analysis is disabled, or the VOD
  job ends. Any edit to a running stream's chain detector restarts analysis:
  the old instance is shut down and a new one initialized, so instance state does
  not carry over. A resumed VOD job also starts with a new instance.
- An instance receives one decision at a time, on an Engine worker thread rather
  than the thread that called `onInit`. Fields that only your decision code
  touches need no locking. State that your own threads (pollers, callbacks from
  other systems) also update must be thread-safe, for example `volatile` fields
  or concurrent collections.
- Keep decisions fast and never wait on the network inside one. When a decision
  exceeds `decision_timeout_seconds`, Engine interrupts it, completes the window
  with the results obtained, and makes later decisions on a fresh thread. A
  decision that ignores the interrupt can still be running when the next one
  starts. Fetch outside data ahead of time instead, as in the next example.

### Share one instance with an event listener

When a `custom` event listener on the same stream names the decision listener's
class, both roles get **one shared instance**, so instance fields can carry
state between deciding stages and reacting to results — for example, posting an
incident back to the external system the decisions already poll. The contract:

- `onInit` runs twice on the shared object: the event-role call first, with the
  event listener's `properties`, then the decision-role call with the decision
  listener's. `onShutdown` runs once.
- On a VOD job the event role is skipped unless your class overrides
  `requires()` to declare what it actually needs, so only the decision-role
  `onInit` runs there.
- A config whose decision listener class matches **more than one** event
  listener is refused at submit: with several candidates, which one would share
  its instance (and whose properties `onInit` would see) is ambiguous.

### Example: combine detections with an access-control system

A loading dock has an access-control system that reports whether the door alarm
is armed and when the last badge was presented. The goal: when someone is on
camera while the door is armed and no badge was presented recently, check
whether they are wearing a high-visibility vest; if nobody is, produce an
incident description, at most once every two minutes per camera.

The access-control system answers `GET <doorStateUrl>` with:

```json
{ "armed": true, "lastBadgeMs": 1760102345000 }
```

The chain:

```json
{
  "type": "chain",
  "mode": "dynamic",
  "result_mode": "combined",
  "decision_timeout_seconds": 1,
  "decision_listener": {
    "class_name": "com.example.DockAccessDecision",
    "properties": {
      "doorStateUrl": "http://access-control.example.internal/api/doors/dock-2",
      "badgeGraceSeconds": 30,
      "cooldownSeconds": 120
    }
  },
  "stages": [
    { "name": "people", "detector": { "type": "object", "classes": ["person"] } },
    {
      "name": "ppe",
      "detector": {
        "type": "vlm",
        "mode": "detect",
        "detect": { "classes": ["high-visibility vest"] }
      },
      "frame_selection": { "mode": "middle" }
    },
    {
      "name": "incident",
      "detector": { "type": "vlm", "mode": "describe" },
      "frame_selection": { "mode": "middle" }
    }
  ]
}
```

The listener:

```java
package com.example;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wowza.wms.application.IApplicationInstance;
import com.wowza.wms.stream.IMediaStream;
import com.wowza.wms.plugin.videointelligence.api.ChainDecision;
import com.wowza.wms.plugin.videointelligence.api.ChainDecisionContext;
import com.wowza.wms.plugin.videointelligence.api.CropSpec;
import com.wowza.wms.plugin.videointelligence.api.IVifChainDecisionListener;

public class DockAccessDecision implements IVifChainDecisionListener {
    private static final long STALE_AFTER_MS = 10_000;
    private static final ObjectMapper JSON = new ObjectMapper();

    private record DoorState(boolean armed, long lastBadgeMs, long fetchedMs) {}

    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2)).build();
    private volatile DoorState door = new DoorState(true, 0, 0);
    private ScheduledExecutorService poller;
    private URI doorStateUrl;
    private long badgeGraceMs;
    private long cooldownMs;
    private long lastIncidentMs;

    public static String getVersion() { return "1.0.0"; }

    public void onInit(IApplicationInstance app, IMediaStream stream,
                       HashMap<String, Object> properties) {
        doorStateUrl = URI.create(String.valueOf(properties.get("doorStateUrl")));
        badgeGraceMs = 1000L * longProperty(properties, "badgeGraceSeconds", 30);
        cooldownMs = 1000L * longProperty(properties, "cooldownSeconds", 120);
        poller = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "dock-door-poller");
            thread.setDaemon(true);
            return thread;
        });
        poller.scheduleWithFixedDelay(this::pollDoor, 0, 2, TimeUnit.SECONDS);
    }

    public void onShutdown() {
        if (poller != null)
            poller.shutdownNow();
    }

    public ChainDecision decide(ChainDecisionContext context) {
        switch (context.stageName()) {
            case "people": return afterPeople(context);
            case "ppe":    return afterPpe(context);
            default:       return ChainDecision.done();
        }
    }

    private ChainDecision afterPeople(ChainDecisionContext context) {
        if (!context.sawClass("person"))
            return ChainDecision.done();
        DoorState state = door;
        long now = System.currentTimeMillis();
        boolean current = now - state.fetchedMs() < STALE_AFTER_MS;
        if (current && !state.armed())
            return ChainDecision.done();
        if (current && now - state.lastBadgeMs() < badgeGraceMs)
            return ChainDecision.done();
        return ChainDecision.advanceCropped("ppe",
            CropSpec.ofClasses("person").withMinConfidence(0.6).withPadding(0.15).withMaxCrops(4));
    }

    private ChainDecision afterPpe(ChainDecisionContext context) {
        if (context.sawClass("high-visibility vest"))
            return ChainDecision.done();
        long now = System.currentTimeMillis();
        if (now - lastIncidentMs < cooldownMs)
            return ChainDecision.done();
        lastIncidentMs = now;
        return ChainDecision.advance("incident");
    }

    private void pollDoor() {
        try {
            HttpRequest request = HttpRequest.newBuilder(doorStateUrl)
                .timeout(Duration.ofSeconds(2)).GET().build();
            JsonNode body = JSON.readTree(
                http.send(request, HttpResponse.BodyHandlers.ofString()).body());
            door = new DoorState(
                body.required("armed").asBoolean(),
                body.required("lastBadgeMs").asLong(),
                System.currentTimeMillis());
        } catch (Exception e) {
            // Keep the last state; decisions treat it as unknown once it is stale.
        }
    }

    private static long longProperty(HashMap<String, Object> properties, String name, long fallback) {
        Object value = properties.get(name);
        return value == null ? fallback : Long.parseLong(String.valueOf(value));
    }
}
```

What each window does:

1. `people` runs on every window. With nobody in view, the window ends there.
2. With someone in view, the listener reads the door state the poller fetched
   most recently. A disarmed door, or a badge presented within the last 30
   seconds, ends the window: the visit is authorized.
3. Otherwise `ppe` asks the VLM about crops of up to four people from the
   window's middle frame.
4. If the VLM finds no vest, `incident` describes the full frame, unless an
   incident was already described on this stream within the cooldown.

Design points the example illustrates:

- **Outside state is fetched ahead of time.** The poller refreshes the door state
  every 2 seconds on its own thread and publishes it through a `volatile`
  field, so a decision only reads memory and a slow access-control system cannot
  push it past the 1-second `decision_timeout_seconds`.
  It parses the response with Jackson, which Engine already provides, so the
  listener JAR needs no extra dependencies.
- **Choose how to fail.** When the door state is more than 10 seconds old, the
  listener ignores it and reviews the person anyway. If false alarms cost you
  more than missed entries, end the window instead.
- **State lives in the instance.** The cooldown is per stream and starts over
  whenever analysis restarts. The example uses wall-clock time, which suits live
  streams; a VOD job is analyzed faster than real time.
- **Image budget.** `frame_selection` is applied before cropping, so `ppe` sends
  at most four images per window, within the VLM's per-request image limit.
- **Results.** `result_mode: combined` delivers every execution of the window to
  your event listeners, so a webhook receives the person boxes, the vest verdict
  and the incident text together.

### Timeouts, failures and intermediate events

The timeout uses seconds with millisecond precision, from 0.001 through
2147483.647. Timeout or callback failure finishes the current window with the
results obtained. Five consecutive callback exceptions disable the listener and
call its `onShutdown`. `dispatch_intermediate_rings: true` also sends
intermediate events to ordinary event listeners. They do not count as completed
VOD windows or create resume checkpoints. Synthetic stages and conditional
routing are unavailable in dynamic mode.

## Service compatibility

Chains created or changed through v2 require the service to support their selected
options. Crop, including an empty object, requires chain.crop; a frame selection
other than all requires chain.frame_selection; an object or motion entry followed by
a scene or VLM stage requires chain.window_entry. Missing support fails the handshake
before config or media is sent. The UNSUPPORTED_CHAIN_CAPABILITY error identifies
the setting, such as config.detector.stages[1].crop, and the missing capability.

A dynamic listener can first request a crop after the entry stage runs. Missing
support fails the VOD job without storing the incomplete window as a successful
result. Live analysis pauses with the same error and can resume after a successful
handshake with a compatible service. Upgrade the service or change the selected
options; the chain does not silently advance on full frames instead.

An existing native chain retains its warning-and-omission behavior when viewed or
saved through v2 without changing the chain itself. Editing unrelated listeners
or match rules does not change that compatibility policy.

A native chain whose stage routing or crop holds settings the v2 contract cannot
express (an unknown member, a value of the wrong type, or a routing without
modellable rules) reads through v2 without them, and a v2 write to that config is
refused with 409 Conflict rather than dropping them, whichever member it changes.
The detail names the first such setting, for example
`config.detector.stages[0].routing.rules[0].priority: this config holds stage
settings the v2 contract cannot express; edit it natively.` Edit the file natively
to remove or convert that setting; the config is then editable through v2 again.

## Save and reuse the definition

Create a named config using `POST /persist/stream-group-configs`:

```json
{
  "name": "PeopleReview",
  "match": { "application": "vod", "stream_pattern": "people-review" },
  "config": {
    "detector": {
      "type": "chain",
      "stages": [
        { "name": "objects", "detector": { "type": "object", "classes": ["person"] } },
        { "name": "describe", "detector": { "type": "vlm", "mode": "describe" } }
      ]
    }
  }
}
```

Then submit with
`{"file":"uploads/clip.mp4","stream_group_config":"PeopleReview"}`.
You can add `config.processing` to vary capture settings per job. Supplying a
new `config.detector` replaces the selected detector atomically.

Manager's **New Analysis → Stored config** picker shows the chain's stages and
any VOD-only restriction. Its **Edit** link opens the chain in Manager's
**Stream Configs** page, where chains are edited visually; the API remains
available for scripted edits.

Read a saved config to obtain its ETag before PATCHing. The `stages` array is
replaced as a whole: send every stage that should remain, and send each stage
complete — the merge-patch rule that an omitted member keeps its stored value
stops at the array boundary, so a member left off a stage is removed, not kept.
Edit the document you read rather than rebuilding stages from scratch. Stage
names must be unique and nonblank, without surrounding whitespace or control
characters. `__terminal__` and `__done__` are reserved internal names.

Reordering stages preserves credentials by stage name and detector type.
Renaming a stage or changing its detector type creates a new identity. Omitted
or null credential values retain stored secrets; an empty string clears them.
Treat a mode change as a change of execution policy: conditional routing belongs
to conditional mode, and decision-listener settings belong to dynamic mode.

## Read results and resume

```bash
curl -u "$VIF_USER:$VIF_PASSWORD" "$VIF_URL/vod/jobs/<job_id>"
curl -u "$VIF_USER:$VIF_PASSWORD" "$VIF_URL/vod/jobs/<job_id>/results?offset=0&limit=50"
curl -u "$VIF_USER:$VIF_PASSWORD" "$VIF_URL/vod/jobs/<job_id>/results?from_ms=5000&to_ms=10000"
curl -u "$VIF_USER:$VIF_PASSWORD" -o chain-results.jsonl "$VIF_URL/vod/jobs/<job_id>/results/file"
```

Each stored row represents one completed media window. Selected fields from a
two-execution result:

```json
{
  "detections_type": "chain",
  "detection_window": { "from_time_code": 0, "to_time_code": 5000 },
  "path_taken": ["score", "describe"],
  "is_terminal": true,
  "end_reason": "completed",
  "rings": [
    {
      "ring_index": 0,
      "stage_name": "score",
      "detections_type": "synthetic",
      "synthetic": { "verdict": "synthetic", "synthetic_score": 0.82, "degraded": false }
    },
    {
      "ring_index": 1,
      "stage_name": "describe",
      "detections_type": "vlm",
      "vlm": [{ "content": "The clip shows a person walking.", "degraded": false }]
    }
  ]
}
```

`rings` is execution order, not configured stage order; a stage may be skipped
or appear more than once. Object, scene and motion stages carry `detections`, VLM
stages carry `vlm`, and synthetic stages carry `synthetic`.

`result_mode: final` (the default) sends only the last stage's result to event
listeners; a window whose routing missed (`end_reason: "no_match"`) sends the
gate type empty instead, as above. `combined` sends all stages. Stored VOD
results retain the complete terminal history with either setting. Older records
that stored only the final result remain readable; unavailable earlier history
is not reconstructed. Manager shows these records as having incomplete
historical detail.

Terminal results carry `end_reason` — on the stored rows and on every listener
response built from them — answering one question per window: did the chain
produce an answer, or stop short, and why?

| `end_reason` | The chain stopped because | `final` mode delivers |
|---|---|---|
| `completed` | it ran past the last stage, or ended through an `on_done` | the last stage's detections |
| `match_end` | a rule **fired** into `{"end": true}` — stopping is the answer | that stage's detections |
| `no_match` | a rule **missed** — the window was filtered out | the gate's type, no detections |
| `max_rings` | the execution cap cut it off — the result is truncated | the last ring's detections |
| *(absent)* | nothing routing-related ended it: a dynamic chain your decision listener ends, or an older service | the last ring's detections, as before the field existed |

`match_end` and `no_match` come from which routing branch fired, not from the
target — `on_match` and `on_no_match` may both end the chain, but only one of
them is an answer.

Cancel and resume use the usual endpoints:

```bash
curl -u "$VIF_USER:$VIF_PASSWORD" -X POST "$VIF_URL/vod/jobs/<job_id>/cancel"
curl -u "$VIF_USER:$VIF_PASSWORD" -X POST "$VIF_URL/vod/jobs/<job_id>/resume"
```

Resume keeps committed windows and reruns an interrupted window from its entry
stage. It does not resume inside a stage or preserve arbitrary Java listener
state. External listener side effects from an interrupted window can repeat.
A changed source or changed nested detector configuration causes a drift
refusal; restore the original configuration before resuming. Saved-config
credentials are resolved again. If an inline job needs redacted credentials,
resubmit the same inline config with those credentials in the resume body.

`store_results: false` remains status-only and supplies no retained stage
history or durable resume point. Job listing, cancellation, deletion and
lifecycle notifications use the same resources for chains and ordinary
detectors.

## Latency

Event listeners receive a window's results only after every executed stage
finishes. Conditional chains run their stages serially, so a window costs the
sum of its stages; crop-free linear chains run them concurrently, so a window
costs its slowest stage; dynamic chains emit each ring as it completes while
the window stays open. Overlay boxes are composited onto the live frame at the
moment results arrive, with no frame matching, so boxes computed from a window
trail the live video by roughly the chain's processing time plus the window's
age in the buffer. Put the object stage first when box timeliness matters — the
ordering tracking requires anyway once a scene or VLM stage gives the chain
window cadence. `auto_frame_throttle` lowers the inference FPS
when the stages cannot keep up.

## Live streams

Use a frame-only chain in a saved matching group, a per-stream override, or the
running stream's `/runtime/apps/{app}/streams/{stream}/detector` resource.
Runtime edits require that detector resource's current ETag. A synthetic stage
causes a clear live-stream refusal; use a VOD job for that chain.
