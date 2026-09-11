# Chains through the v2 API

A chain runs named detector stages over the same captured media. Use it wherever
v2 accepts a `config.detector`: inline VOD jobs, saved stream group configs,
per-stream overrides, or a running stream's detector.

Stages can use `scene`, `object`, `vlm`, or `synthetic`. A frame-only chain
works on VOD and live streams. Including synthetic video detection makes the
chain VOD-only. Chains and Verify cannot be nested inside a stage.

## Configure endpoints once

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

## Run a simple chain

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

The entry stage fixes capture cadence: an object-first chain uses frame cadence;
scene- or VLM-first chains use window cadence. A synthetic stage anywhere makes
the chain use clip windows. Put capture settings such as `window_seconds` and
`inference_fps` in the parent's `config.processing`, never inside a stage.

For a stage that needs fewer frames, add
`"frame_selection": {"mode": "middle"}` to its stage wrapper. Modes are `all`,
`first`, `middle`, `last` and `every_nth`; the last requires `stride >= 2`
and always includes the first and last captured frames.

## Review only synthetic windows

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

Crop defaults are all classes, confidence 0, padding 0 and at most 16 crops per
source frame. When there are more boxes, the highest-confidence boxes are kept.
No matching boxes produces an empty stage result.

The first stage and synthetic stages cannot crop. In linear mode, the preceding
stage must be an object detector. A cropped object stage must disable tracking
and tiling. Object tracking also requires an object-first chain with no synthetic
stage; set `"tracking": {"method": "none"}` when a stage's inherited tracking
would otherwise violate that requirement.

Crop child coordinates refer to the original full frame. The result's
`source_ring_index` and `source_detection_index` identify the parent execution
and detection.

## Let an installed Java listener choose the next stage

Dynamic chains support frame detectors on both VOD and live streams. Configure
the same stages with `mode: dynamic` and a decision listener:

```json
{
  "type": "chain",
  "mode": "dynamic",
  "decision_timeout_seconds": 5,
  "dispatch_intermediate_rings": false,
  "decision_listener": {
    "class_name": "com.example.PersonReviewDecision",
    "properties": { "reviewStage": "describe" }
  },
  "stages": [
    { "name": "objects", "detector": { "type": "object", "classes": ["person"] } },
    { "name": "describe", "detector": { "type": "vlm", "mode": "describe" } }
  ]
}
```

Compile your class against the installed Engine and plugin APIs, put its JAR in
the Engine's library directory, and restart Engine before using it. For example:

```java
package com.example;

import java.util.HashMap;
import com.wowza.wms.application.IApplicationInstance;
import com.wowza.wms.stream.IMediaStream;
import com.wowza.wms.plugin.videointelligence.api.ChainDecisionContext;
import com.wowza.wms.plugin.videointelligence.api.IVifChainDecisionListener;

public class PersonReviewDecision implements IVifChainDecisionListener {
    public static String getVersion() { return "1.0.0"; }
    public void onInit(IApplicationInstance app, IMediaStream stream,
                       HashMap<String, Object> properties) {}
    public void onShutdown() {}

    public String decideNextStage(ChainDecisionContext context) {
        if ("objects".equals(context.currentStageName) && context.sawClass("person"))
            return String.valueOf(context.properties.getOrDefault("reviewStage", "describe"));
        return null;
    }
}
```

The callback always sees every execution. Returning a stage name advances;
returning null completes the window. For crop decisions, override
`decide(ChainDecisionContext)` and return
`ChainDecision.advanceCropped(name, CropSpec.ofClasses("person"))`.
The callback class must be public and concrete, implement
`IVifChainDecisionListener`, and expose a public no-argument constructor.
A static `getVersion()` is recommended for version reporting. Configuration
reads and writes never execute its decisions; the class is checked before
activating analysis. Use `currentStageName` to identify the configured stage and
`executionIndex()` to count executions, including revisits.

The timeout uses seconds with millisecond precision, from 0.001 through
2147483.647. Timeout or callback failure finishes the current window with the
results obtained; repeated callback exceptions disable that listener.
`dispatch_intermediate_rings: true` also sends intermediate events to ordinary
event listeners. They do not count as completed VOD windows or create resume
checkpoints. Synthetic stages and conditional routing are unavailable in dynamic
mode.

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
any VOD-only restriction. Its **View** link opens a read-only definition.
Use the API to edit chains until the visual chain editor is available.

Read a saved config to obtain its ETag before PATCHing. The `stages` array is
replaced as a whole: send every stage that should remain. Stage names must be
unique and nonblank, without surrounding whitespace or control characters.
`__terminal__` and `__done__` are reserved internal names.

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
or appear more than once. Object and scene stages carry `detections`, VLM
stages carry `vlm`, and synthetic stages carry `synthetic`.

`result_mode: final` (the default) sends only the last stage's result to event
listeners. `combined` sends all stages. Stored VOD results retain the complete
terminal history with either setting. Older records that stored only the final
result remain readable; unavailable earlier history is not reconstructed.
Manager shows these records as having incomplete historical detail.

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

## Live streams

Use a frame-only chain in a saved matching group, a per-stream override, or the
running stream's `/runtime/apps/{app}/streams/{stream}/detector` resource.
Runtime edits require that detector resource's current ETag. A synthetic stage
causes a clear live-stream refusal; use a VOD job for that chain.