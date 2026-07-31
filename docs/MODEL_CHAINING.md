# Model Chaining Guide

The Video Intelligence framework can run **several detectors over the same frames, in
order, on a single stream**. With `detector_type: "chain"` you compose the leaf detectors —
**object** detection, **scene** classification, and **VLM** analysis — into an ordered
pipeline instead of standing up a separate stream per detector.

A chain gives one detector's output two kinds of influence over the next:

- **Gate** — decide *whether* the next detector runs at all. Read plates only when a
  vehicle was seen; describe the scene only when the classifier flagged smoke. Work you
  skip is GPU time and VLM tokens you don't pay for.
- **Focus** — decide *what* the next detector looks at. Hand it a tight crop around each
  detected vehicle instead of the whole 1080p frame, or one representative frame out of a
  multi-second window instead of every frame in it.

Everything is configured on the stream, exactly like any other detector: set
`detector_type` to `"chain"` and provide a `chain_analysis` block in place of
`object_analysis` / `scene_analysis` / `vlm_analysis`. Nothing new needs deploying — a
chain uses the detectors and endpoints you already have. (Chains that include a VLM stage
need a reachable VLM endpoint, the same one a standalone VLM stream would use — see the
[VLM guide](VLM_GUIDE.md).)

---

## Table of Contents

- [Quick start](#quick-start)
- [What a chain is](#what-a-chain-is)
- [The first-stage cadence rule](#the-first-stage-cadence-rule)
- [Mode 1 — linear](#mode-1--linear)
- [Mode 2 — conditional](#mode-2--conditional)
- [Mode 3 — dynamic](#mode-3--dynamic)
- [Focusing a stage](#focusing-a-stage)
- [The decision listener (Java)](#the-decision-listener-java)
- [Configuration reference](#configuration-reference)
- [What you receive](#what-you-receive)
- [Constraints and validation](#constraints-and-validation)
- [Performance notes](#performance-notes)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

---

## Quick start

Prerequisites: a working framework checkout with `.env` populated and the stack running
(see the [README](../README.md)). For the VLM stage below, start the VLM sidecar too:

```bash
docker compose --profile default --profile vlm up -d
```

**1. Add a chain stream entry.** Save the following as
`wse/conf.modules/vif/live_chain-linearDotStar.json` (the same per-stream fragment shape as
the shipped `live_objectDotStar.json`). Anything it doesn't set is inherited from
`Default.json`:

```jsonc
{
	"active": true,
	"app_name": "live",
	"stream_name": "chain-linear.*",
	"vif_event_listeners": {
		"LogFiles": { "class_name": "LogFileEvent", "methods": ["immediate"] },
		"Id3Tags":  { "class_name": "Id3Event",     "methods": ["immediate"] }
	},
	"frame_buffer": 10,
	"inference_fps": 8,

	"detector_type": "chain",
	"chain_analysis": {
		"mode": "linear",
		"result_mode": "combined",
		"stages": [
			{
				"name": "detect",
				"detector_type": "object",
				"object_analysis": {
					"model_name": "medium",
					"confidence_threshold": 0.4,
					"class_names": ["person", "car", "truck"]
				}
			},
			{
				"name": "describe",
				"detector_type": "vlm",
				"vlm_analysis": {
					"model_name": "Qwen/Qwen3-VL-4B-Instruct-FP8",
					"endpoint_url": "http://vlm.docker:8000/v1",
					"user_prompt": "Describe the scene in one sentence.",
					"max_tokens": 256
				}
			}
		]
	}
}
```

> These per-stream files are JSONC — `//` comments are tolerated by the plugin's loader.
> Strip them before pasting a snippet into a strict JSON parser or the Engine Manager UI.

**2. Publish a matching stream:**

```bash
ffmpeg -re -stream_loop -1 -i your-clip.mp4 -c copy -f flv rtmp://localhost:1935/live/chain-linear-demo
```

**3. Watch the results.** With `result_mode: "combined"` you get both stages' output:

```bash
tail -f wse/logs/wowzastreamingengine_vi.log
```

**4. Make it yours.** Chains are also editable from the Video Intelligence configuration
page in Engine Manager (`http://localhost:8088`): pick **Chain** as the detector type and
the **Chain Analysis (Conveyor)** editor builds the `chain_analysis` block for you — one
card per stage, plus the routing, frame-selection and crop controls described below.

---

## What a chain is

A chain is an **ordered list of named stages**.

- Each **stage** is one leaf detector — `object`, `scene`, or `vlm`. A stage is never
  itself a chain; there is no nesting.
- The chain captures **one** frame feed at **one** cadence, fixed by the **first** stage.
  Every stage runs on those same frames.
- A **ring** is one *executed* stage. Running a chain produces a list of rings in
  execution order, and the result carries that list.

```
      ┌─────────── one frame batch, captured once, at one cadence ───────────┐
      │                                                                      │
 stage "detect"                stage "describe"
 (object)      ──── ring 0 ────▶ (vlm)      ──── ring 1 ────▶ …
      │                                                                      │
      └── every stage sees the SAME frames; a stage can only NARROW them ────┘
```

By default the stages run in declared order and you receive the last stage's result. Three
per-stage opt-ins extend that:

| Opt-in | Channel | What it does |
| --- | --- | --- |
| `routing` | gate | Branch to another stage, or stop, based on what this stage detected. Decided inside the service — no round-trip. Requires `mode: "conditional"`. |
| `crop` | focus | Run this stage on crops of the **preceding** stage's detections instead of the full frame. Any mode. |
| `frame_selection` | focus | Run this stage on a subset of the captured frames. Any mode. |

### When a chain is the right tool

- One detector's output should gate or refine another — vehicle then plate, person then
  activity description, scene classification then a written summary.
- You want object **and** scene **and** VLM signals on the *same* frames, correlated, in
  one stream.
- You want an expensive detector to run only on the regions a cheap one found.

### When it isn't

- A single detector answers your question. A plain `object` / `scene` / `vlm` stream is
  simpler and cheaper.
- You need each detector at its **own** cadence — say object detection every frame *and*
  scene classification over independent 4-second windows. A chain has exactly one cadence.
  Run separate streams.
- You need object tracking behind a scene- or VLM-first chain. That combination is
  rejected — see [Constraints and validation](#constraints-and-validation).

---

## The first-stage cadence rule

**Read this before mixing detector types.** A chain's capture cadence is fixed once, at
stream open, by the **first** stage's `detector_type` — and the same frames feed every
later stage:

| First stage | Cadence | What every stage receives |
| --- | --- | --- |
| `object` | **per-frame** — one frame per ring | one frame |
| `scene` | **windowed** — a `duration`-second batch per ring | the whole window |
| `vlm` | **windowed** — a `duration`-second batch per ring | the whole window |

The window holds `duration × inference_fps` frames (e.g. `duration: 2`, `inference_fps: 2`
→ 4 frames per ring). For an object-first chain `duration` is not used.

Consequences worth internalising:

- `[object, scene]` runs the scene classifier on **one** frame per ring. Scene
  classification is a temporal judgement, so this is weak — the plugin logs a warning
  naming the affected stage, but the chain still runs.
- `[scene, object]` runs object detection per-frame across the whole window. Detection
  works fine; **tracking** does not, and is rejected.
- `[object, vlm]` and `[scene, vlm]` are the well-behaved shapes.

A later stage can only ever **narrow** the frames it sees (`frame_selection`) or the
region it sees (`crop`). It can never re-capture at a wider or different cadence. Put the
stage whose frame shape you care about **first**.

> **In the Engine Manager editor**, a chain-level **Duration** control (0–5 s) appears only
> for a scene- or VLM-first chain. It is hidden for an object-first chain, which captures
> one frame per ring.

---

## Mode 1 — linear

Every stage runs, in declared order. No branching, no customer code. This is the default
(`mode` may be omitted).

Use it when the pipeline is fixed: always detect, then always describe.

```jsonc
"detector_type": "chain",
"chain_analysis": {
	"mode": "linear",
	"result_mode": "combined",   // deliver every stage's detections, not just the last
	"max_rings": 8,
	"stages": [
		{
			"name": "detect",
			"detector_type": "object",
			"object_analysis": {
				"model_name": "medium",
				"tracking_method": "none",
				"confidence_threshold": 0.4,
				"class_names": ["person", "car", "truck", "bus", "motorcycle", "bicycle"]
			}
		},
		{
			"name": "describe",
			"detector_type": "vlm",
			"vlm_analysis": {
				"model_name": "Qwen/Qwen3-VL-4B-Instruct-FP8",
				"endpoint_url": "http://vlm.docker:8000/v1",
				"class_names": ["scene_description"],
				"temperature": 0.2,
				"max_tokens": 256,
				"request_timeout_seconds": 6.0
			}
		}
	]
}
```

The first stage is `object`, so the chain runs at per-frame cadence and the VLM stage sees
the same single frame the detector just analysed.

---

## Mode 2 — conditional

Each stage carries a `routing` block naming where to go next. The rules are evaluated by
the service, immediately after the stage runs, from that stage's own detections — no extra
network round-trip and no customer code.

Use it when the branch is expressible as "did I see enough of class X with enough
confidence?".

```jsonc
"detector_type": "chain",
"chain_analysis": {
	"mode": "conditional",
	"result_mode": "combined",
	"max_rings": 4,
	"stages": [
		{
			"name": "vehicles",
			"detector_type": "object",
			"object_analysis": {
				"model_name": "medium",
				"tracking_method": "byte-track",
				"confidence_threshold": 0.35,
				"class_names": ["car", "truck", "bus", "motorcycle"]
			},
			"routing": {
				// A rule fires when >= min_count detections have a class in any_class_in
				// (case-insensitive) at confidence >= min_confidence.
				// "match": "any" = any rule fires; "all" = every rule must fire.
				"rules": [
					{ "any_class_in": ["car", "truck", "bus", "motorcycle"], "min_confidence": 0.5, "min_count": 1 }
				],
				"match": "any",
				"on_match": "plates",
				"on_no_match": "__terminal__"
			}
		},
		{
			"name": "plates",
			"detector_type": "vlm",
			"vlm_analysis": {
				"model_name": "Qwen/Qwen3-VL-4B-Instruct-FP8",
				"endpoint_url": "http://vlm.docker:8000/v1",
				"user_prompt": "Read any visible license plate. If none is legible, say so.",
				"max_tokens": 64,
				"request_timeout_seconds": 4.0
			}
			// no routing -> the chain terminates after this stage
		}
	]
}
```

When a vehicle is present the chain runs `vehicles → plates`; otherwise it stops after
`vehicles` and the expensive VLM call never happens. Route targets must name a declared
stage or the `"__terminal__"` sentinel.

Note that `tracking_method: "byte-track"` is legal here **only because the object stage is
first**, giving it the per-frame cadence the tracker requires.

---

## Mode 3 — dynamic

Your own Java code picks the next stage after every ring. The service holds the captured
frames alive between rings and runs whichever stage you name next on those same frames.

Use it when the branch depends on something rules can't express — accumulated state across
rings, an external lookup, a business rule, a stage you want to revisit.

```jsonc
"vif_chain_decision_listener": {
	"class_name": "com.example.PlateChainDecision",
	"properties": {
		"min_confidence": 0.5,
		"vehicle_classes": ["car", "truck", "bus", "motorcycle"]
	}
},

"detector_type": "chain",
"chain_analysis": {
	"mode": "dynamic",
	"result_mode": "combined",

	// how long your listener has to answer before the chain aborts and the service
	// frees the held frames. Raise it for a slow VLM.
	"chain_decision_timeout_ms": 7000,

	// true = every ring reaches your event listeners; false (default) = only the final
	// one. The decision listener always sees every ring regardless.
	"dispatch_intermediate_rings": true,

	"max_rings": 4,
	"stages": [
		{
			"name": "vehicles",
			"detector_type": "object",
			"object_analysis": {
				"model_name": "medium",
				"tracking_method": "byte-track",
				"confidence_threshold": 0.3,
				"class_names": ["car", "truck", "bus", "motorcycle"]
			}
		},
		{
			"name": "plates",
			"detector_type": "vlm",
			"vlm_analysis": {
				"model_name": "Qwen/Qwen3-VL-4B-Instruct-FP8",
				"endpoint_url": "http://vlm.docker:8000/v1",
				"class_names": ["license_plate"],
				"max_tokens": 64,
				"request_timeout_seconds": 4.0
			}
		},
		{
			"name": "describe",
			"detector_type": "vlm",
			"vlm_analysis": {
				"model_name": "Qwen/Qwen3-VL-4B-Instruct-FP8",
				"endpoint_url": "http://vlm.docker:8000/v1",
				"class_names": ["scene_description"],
				"temperature": 0.3,
				"max_tokens": 256,
				"request_timeout_seconds": 6.0
			}
		}
	]
}
```

`vif_chain_decision_listener` is a **top-level** stream key, a sibling of
`vif_event_listeners` — not part of `chain_analysis`.

> **Dynamic mode needs a listener.** If the class is missing or fails to load, the stream
> is not rejected: the chain auto-completes after the first ring and a warning is logged.
> Prefer `conditional` whenever the branch is declarative — it costs no round-trip and no
> code.

---

## Focusing a stage

Both focus controls apply to one stage only, and both can only ever narrow what that stage
sees. `frame_selection` is applied first (which frames), then `crop` (which region of
them).

### `frame_selection` — pick frames out of the window

A scene- or VLM-first chain captures a whole window per ring. A downstream VLM usually
wants one good frame, not twelve.

```jsonc
"duration": 2,
"inference_fps": 2,

"detector_type": "chain",
"chain_analysis": {
	"mode": "linear",
	"result_mode": "combined",
	"stages": [
		{
			"name": "classify",
			"detector_type": "scene",
			"scene_analysis": {
				"class_names": ["fire", "smoke", "fighting"],
				"confidence_threshold": 0.3,
				"sensitivity": 7
			}
		},
		{
			"name": "describe",
			"detector_type": "vlm",
			"frame_selection": "middle",
			"vlm_analysis": {
				"model_name": "Qwen/Qwen3-VL-4B-Instruct-FP8",
				"endpoint_url": "http://vlm.docker:8000/v1",
				"user_prompt": "Describe what is happening in the scene.",
				"max_tokens": 256,
				"request_timeout_seconds": 6.0
			}
		}
	]
}
```

`classify` sees the whole 4-frame window; `describe` sees only its middle frame.

| Value | Frames the stage runs on (window length `L`) |
| --- | --- |
| `"all"` (default) | every frame — no change, no cost |
| `"first"` | the first frame |
| `"middle"` | the middle frame (`L / 2`, rounded down) |
| `"last"` | the last frame |
| `"every_nth"` | every `frame_selection_n`-th frame; first and last always included |

**Why it matters.** A windowed VLM stage left on `"all"` sends every captured frame as one
prompt. If that exceeds what your endpoint accepts per request (the bundled sidecar allows
8 images), the service evenly subsamples the window down to fit — keeping the first and
last frame — logs a throttled warning, and keeps the stream running. Nothing breaks, but
you paid to capture frames that were thrown away. `frame_selection` lets you choose which
frames go, instead of relying on the subsample.

### `crop` — run a stage on the previous stage's boxes

A `crop` block makes a stage run on sub-regions of the **immediately-preceding** stage's
detections. The classic use is a plate reader that should see a tight, padded box around
each vehicle rather than the whole frame.

```jsonc
"detector_type": "chain",
"chain_analysis": {
	"mode": "linear",
	"result_mode": "combined",
	"stages": [
		{
			// entry stage: an object detector, so it produces the boxes to crop from.
			// `crop` is INVALID here — there is no preceding stage.
			"name": "vehicles",
			"detector_type": "object",
			"object_analysis": {
				"model_name": "medium",
				"tracking_method": "none",
				"confidence_threshold": 0.4,
				"class_names": ["car", "truck", "bus", "motorcycle"]
			}
		},
		{
			"name": "plates",
			"detector_type": "vlm",
			"crop": {
				"classes": ["car", "truck", "bus", "motorcycle"],  // omit/null = all classes
				"min_confidence": 0.5,                             // only crop boxes at >= 0.5
				"padding": 0.1,                                    // grow each box by 10%
				"max_crops": 8                                     // at most 8 crops per frame
			},
			"vlm_analysis": {
				"model_name": "Qwen/Qwen3-VL-4B-Instruct-FP8",
				"endpoint_url": "http://vlm.docker:8000/v1",
				"user_prompt": "Read any visible license plate. If none is legible, say so.",
				"max_tokens": 64,
				"request_timeout_seconds": 4.0
			}
		}
	]
}
```

**Coordinates come back in full-frame space.** You never do coordinate math. The service
crops server-side from its own detections, so every bounding box in a crop stage's result
is already expressed in **original full-frame pixels** — the same space a non-cropped
detection uses. Overlays, ID3 tags and webhooks need no special handling for crop rings.

Each crop-ring detection can also carry two back-pointers to the parent box it came from —
`source_detection_index` (the parent's position in the preceding ring) and
`source_ring_index` (which ring produced that parent). Together they pin a child detection
to exactly one parent. Both are omitted for detections that did not come from a crop.

Other crop behaviours worth knowing:

- **Nothing matched ⇒ empty result.** A crop that matches no parent detection produces an
  empty result for that stage. There is no full-frame fallback — that is deliberate, so a
  quiet frame doesn't silently turn into a full-frame VLM bill.
- **Crop bounds its own cost.** A crop stage runs one inference **per crop**, so
  `max_crops` and the `classes` / `min_confidence` filters are your cost controls. Tighten
  them for busy frames.
- **Consecutive crop stages compose.** Boxes stay in full-frame pixels throughout.
- In the Engine Manager editor, crop is a per-stage control. It is disabled on the entry
  stage, and the editor blocks a save that would produce a rejected combination.

---

## The decision listener (Java)

Only needed for `mode: "dynamic"`. Implement `IVifChainDecisionListener` (package
`com.wowza.wms.plugin.videointelligence.api`), build it into a jar on the WSE classpath —
exactly as you would a custom `IVifEventListener` — and name the class in
`vif_chain_decision_listener.class_name`.

After each ring the plugin calls your listener off the WebSocket thread, under a watchdog.
Five consecutive exceptions disable it, the same policy `IVifEventListener` uses.

```java
package com.example;

import java.util.HashMap;

import com.wowza.wms.application.IApplicationInstance;
import com.wowza.wms.stream.IMediaStream;
import com.wowza.wms.plugin.videointelligence.api.ChainDecisionContext;
import com.wowza.wms.plugin.videointelligence.api.IVifChainDecisionListener;

public class PlateChainDecision implements IVifChainDecisionListener
{
    public static String getVersion() { return "1.0.0"; }

    @Override
    public void onInit(IApplicationInstance appInstance, IMediaStream stream, HashMap<String, Object> properties) { }

    @Override
    public void onShutdown() { }

    @Override
    public String decideNextStage(ChainDecisionContext ctx)
    {
        // saw a vehicle? read the plate next; otherwise finish the chain
        if (ctx.sawClass("car") || ctx.sawClass("truck"))
            return "plates";
        return null;   // null, "__done__", or an unknown stage name all end the chain
    }
}
```

`ChainDecisionContext` gives your code the just-finished ring plus the history:
`currentRingResult`, `currentStageName`, `currentStageIndex`, `priorRingResults`,
`streamName`, your configured `properties`, and the helpers `sawClass(name)`,
`count(name)` and `stageNames()`.

### Asking for crops from a listener

To request cropping per ring, additionally override `decide(ctx)` and return a
`ChainDecision`. `decideNextStage(...)` stays required by the interface but can become a
stub once you override `decide(...)`, because the controller calls `decide(...)`:

```java
@Override
public ChainDecision decide(ChainDecisionContext ctx)
{
    if ("vehicles".equals(ctx.currentStageName) && (ctx.sawClass("car") || ctx.sawClass("truck")))
    {
        return ChainDecision.advanceCropped("plates",
                CropSpec.ofClasses("car", "truck")
                        .withMinConfidence(0.5)
                        .withPadding(0.1)
                        .withMaxCrops(8));
    }
    return ChainDecision.done();
}
```

- `ChainDecision.advance(stage)` — run the next stage on the full held frame(s).
- `ChainDecision.advanceCropped(stage, crop)` — run it on crops.
- `ChainDecision.done()` (or `advance(null)`) — finish the chain.
- `CropSpec.all()` crops every detection with defaults; `CropSpec.ofClasses(...)` plus the
  `withMinConfidence` / `withPadding` / `withMaxCrops` builders cover the rest.

Existing listeners that only implement `decideNextStage` keep working unchanged — the
default `decide(...)` delegates to it and never crops.

### One class, both roles

A single class may implement **both** `IVifChainDecisionListener` and `IVifEventListener`
and be registered under both `vif_chain_decision_listener` and `vif_event_listeners`. The
plugin resolves both registrations to the **same object instance** per stream, so plain
instance fields share state between the "react to detections" role and the "pick the next
stage" role — no static maps, no external singleton. Both `onInit` overloads fire on that
one instance, and `onShutdown` fires exactly once.

Compile-ready sketches of both shapes — decision-only and combined — ship with the
plugin's example configurations.

---

## Configuration reference

### The `chain_analysis` block

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `"linear"` | `"linear"` / `"conditional"` / `"dynamic"` — how the next stage is chosen |
| `stages` | — (required) | Ordered list of stages, at least one |
| `result_mode` | `"final"` | `"final"` delivers only the last stage's detections to your event listeners; `"combined"` delivers every stage's |
| `max_rings` | `8` | Safety cap (1–64) on how many stages execute before the chain terminates; also the cycle guard for conditional and dynamic chains |
| `chain_decision_timeout_ms` | `5000` | **Dynamic only.** How long the service holds the frames waiting for your listener's answer before aborting the chain |
| `dispatch_intermediate_rings` | `false` | Whether intermediate rings — not just the final one — reach your ID3 / overlay / webhook / log listeners |

Cadence and connection settings — `duration`, `inference_fps`, `frame_buffer`,
`vi_service_url` and the rest — live at the **stream level**, outside `chain_analysis`, as
they do for any other detector.

### A stage

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | `stage_N` | Unique within the chain. Routing targets, the decision listener and the results all reference stages by this name |
| `detector_type` | — (required) | `"object"`, `"scene"`, or `"vlm"` |
| `object_analysis` / `scene_analysis` / `vlm_analysis` | — | The per-detector config matching `detector_type` — **the same fields you would use on a standalone stream** of that type |
| `routing` | none | Declarative branching; conditional mode only |
| `crop` | none | Run this stage on crops of the preceding stage's detections |
| `frame_selection` | `"all"` | `all` / `first` / `middle` / `last` / `every_nth` |
| `frame_selection_n` | `2` | Stride (≥ 2) for `every_nth`; ignored otherwise |

Because each stage's analysis block is the standalone config for that detector, the
existing per-detector documentation applies unchanged: object model variants, thresholds,
`byte_track_properties`, scene `sensitivity`, and the whole VLM field set including
`endpoint_url`, prompts and `response_schema` (see the [VLM guide](VLM_GUIDE.md)).

A per-stage `duration` is **not** supported and is rejected — a chain has one cadence, set
by its first stage. Use `frame_selection` to narrow a stage's frames.

### The `routing` block

| Field | Default | Meaning |
| --- | --- | --- |
| `rules` | — | Conditions evaluated against this stage's detections |
| `match` | `"any"` | `"any"` fires when any rule matches; `"all"` requires every rule |
| `on_match` | — | Next stage name when the rules fire, or `"__terminal__"` to stop |
| `on_no_match` | `"__terminal__"` | Next stage name when they don't, or `"__terminal__"` |

Each rule:

| Field | Default | Meaning |
| --- | --- | --- |
| `any_class_in` | none | Class names to look for (case-insensitive). Empty or unset never matches |
| `min_confidence` | `0.0` | Minimum confidence (inclusive) for a detection to count |
| `min_count` | `1` | How many qualifying detections the rule needs to fire |

> **Routing off a VLM stage requires structured output.** When the VLM stage runs in
> Detect mode (with `class_names`), uses a reasoning preset, or has a custom
> `response_schema`, each returned class projects into routing just like an object or
> scene detection. Free-text VLM output (Describe mode or a custom prompt with no
> schema) carries no per-detection class, so routing on it always takes `on_no_match`.
> One caveat: the built-in Detect schema has no confidence field, so those classes
> route with confidence 1.0 — a `min_confidence` rule only discriminates when a custom
> schema returns a numeric `confidence` per entry.

### The `crop` block

| Field | Default | Meaning |
| --- | --- | --- |
| `classes` | all | Only crop parent detections whose class is in this list (case-insensitive) |
| `min_confidence` | `0.0` | Only crop parents at this confidence or above |
| `padding` | `0.0` | Fractional padding grown around each box before cropping (`0.1` = 10%), clamped to the frame |
| `max_crops` | `16` | Cap on crops per frame (1–256); highest-confidence kept on overflow |

---

## What you receive

Chain detections reach you through the same **VIF event listeners** as every other stream
— `LogFileEvent` (writes `wowzastreamingengine_vi.log`), `WebhookEvent2`, `Id3Event`,
`OverlayEvent`, or your own `IVifEventListener`. Two knobs shape what is delivered:

| Knob | Default | Effect |
| --- | --- | --- |
| `result_mode` | `"final"` | `"final"` = only the last stage's detections; `"combined"` = every stage's. All stages are always computed; this filters delivery only |
| `dispatch_intermediate_rings` | `false` | `false` = only the final ring reaches your listeners; `true` = every ring does. A dynamic decision listener always sees every ring regardless |

**Which knob applies depends on the mode.** They answer different questions:

- In **linear** and **conditional** mode the whole chain runs in one pass and the service
  returns a single result bundling every ring. Intermediate stages are surfaced with
  `result_mode: "combined"`; `dispatch_intermediate_rings` has no separate messages to act
  on and is inert (the Engine Manager editor disables it outside dynamic mode).
- In **dynamic** mode each ring arrives as its own result, so
  `dispatch_intermediate_rings: true` is what forwards the non-final ones — and
  `result_mode` still shapes the content of each.

Rule of thumb: *combined* for linear and conditional, *dispatch-intermediate-rings* for
dynamic.

Every result reports the rings that actually executed, in execution order, each with its
0-based `ring_index` and a `stage_name` naming the configured stage that produced it. A
stage can run zero times (skipped by routing) or more than once (revisited by a dynamic
listener), so the *n*-th configured stage is not necessarily the *n*-th ring — match rings
to stages by `stage_name`, not by position.

---

## Constraints and validation

Some of these are caught when you save the configuration (in Engine Manager, through the
REST API, or on config-file load); the rest are enforced by the Video Intelligence Service
when the stream opens. Either way the stream will not start until the configuration is
fixed. **Configuration errors surface in the WSE error log**
(`wse/logs/wowzastreamingengine_error.log`) — that is the first place to look when a chain
stream refuses to start.

**Rejected:**

| Rejected | Why |
| --- | --- |
| Duplicate stage `name` within a chain | Names are how routing, listeners and results address a stage; they must be unique |
| A stage with no `detector_type`, or one that isn't `object` / `scene` / `vlm` | A stage is always a leaf detector — chains do not nest |
| A stage missing the analysis block matching its `detector_type` | An `object` stage needs `object_analysis`, and so on |
| A per-stage `duration` | A chain has one cadence, fixed by the first stage. Use `frame_selection` instead |
| `routing` on a stage while `mode` is not `"conditional"` | Routing is only meaningful in conditional mode |
| A route target that is neither a declared stage name nor `"__terminal__"` | A dangling route would strand the chain silently |
| `crop` on the entry stage | There is no preceding stage to crop from |
| `crop` **and** `tracking_method: "byte-track"` on the same object stage | Track continuity across independent per-crop inferences is undefined — IDs would be meaningless |
| `crop` **and** tiling (`tiling_mode` other than `"none"`) on the same object stage | Tiling subdivides a crop that is already a few hundred pixels at most. Drop one or the other |
| `crop` whose immediately-preceding stage is not an object detector — **linear mode only** | In linear mode the declared order is the execution order, so that predecessor demonstrably produces no boxes. Conditional and dynamic order is decided at runtime, so the same shape is only warned about there |
| `tracking_method: "byte-track"` on an object stage when the first stage is `scene` or `vlm` | The tracker ages one tick per frame regardless of the real gap between windowed frames, so the track IDs would be silently wrong. Put the tracking stage first, or drop tracking |
| `frame_selection` that isn't one of `all` / `first` / `middle` / `last` / `every_nth`, or `every_nth` with a stride below 2 | Invalid or degenerate |

**Warned about — the chain still runs:**

- A first stage whose cadence disagrees with a later stage's natural appetite:
  `[object, scene]` (scene gets one frame), or a VLM behind a windowed first stage (the
  VLM gets the whole window — add `frame_selection`). The warning names the affected stage.
- `crop` whose preceding stage is not an object detector, in **conditional** or **dynamic**
  mode. The running order isn't known in advance, so it is not rejected; at runtime it
  simply yields an empty result if there were no boxes.

**Not errors at all — runtime behaviours to expect:**

- A crop that matches nothing produces an empty result for that stage. No full-frame
  fallback.
- A windowed VLM stage handed more frames than the endpoint accepts is evenly subsampled
  to fit (first and last kept), with a throttled warning.
- A dynamic chain with no working decision listener auto-completes after the first ring,
  with a warning.

---

## Performance notes

- **A chain costs one inference per executed stage.** A two-stage chain is roughly two
  detectors' worth of work on the same frames. That is still cheaper than two streams,
  because the frames are captured, decoded and transferred once.
- **Gating is the biggest lever.** A conditional chain that terminates on a quiet frame
  skips every downstream inference. On a stream that is mostly idle this is the difference
  between paying for a VLM continuously and paying for it on events.
- **Prefer conditional over dynamic when the branch is declarative.** Conditional decides
  inside the service with no round-trip; dynamic adds a network round-trip plus your
  decision latency to every ring.
- **Crop bounds its own cost** through `max_crops` and the crop filters — one inference per
  crop.
- **`frame_selection` cuts windowed cost.** A VLM behind a scene-first chain otherwise
  receives the whole window; `"middle"` sends one frame.
- **`result_mode: "combined"` and `dispatch_intermediate_rings: true` increase delivery
  volume, not inference cost.** They change how much reaches your listeners. Leave them at
  their defaults unless you need the intermediate data.

---

## Troubleshooting

**The stream won't start.** Check `wse/logs/wowzastreamingengine_error.log` for the
rejection message — it names the offending stage and the rule it broke. Work through
[Constraints and validation](#constraints-and-validation).

**A field I set had no effect.** Two likely causes. First: the plugin and the Video
Intelligence Service are versions apart, so the service didn't advertise support for that
refinement and the plugin degraded it — `crop` to a full-frame run, `frame_selection` to
all frames — logging one warning as it did so. Check the WSE logs and confirm both
components are on matching versions. Second: a misspelled field name is ignored silently —
check it against the [configuration reference](#configuration-reference).

**My crop stage returns nothing.** That is the designed behaviour when nothing matched.
Verify that the preceding **object** stage actually produced boxes of those classes above
that confidence, and check `crop.classes` (case-insensitive; unset means all classes) and
`crop.min_confidence` (inclusive).

**I only see the last stage's detections.** That is `result_mode: "final"`, the default.
Set `"result_mode": "combined"`.

**My conditional route never fires.** If the routing block is on a VLM stage, the stage
must produce structured output (Detect mode with `class_names`, a reasoning preset, or a
custom `response_schema`) — free-text VLM output carries no per-detection class, so
routing on it always takes `on_no_match`. On the built-in Detect schema every class
routes with confidence 1.0, so a `min_confidence` rule above 1.0 can never fire and any
value at or below 1.0 always passes. Otherwise check that `min_confidence` and
`min_count` are actually reachable for your scene, and remember class matching is
case-insensitive but must otherwise be exact.

**My dynamic chain stops after one ring.** Either no decision listener loaded (check the
WSE error log for a class-loading warning, and confirm the jar is on the WSE classpath and
`class_name` matches the class's package), or your listener returned `null` / `"__done__"`
/ an unknown stage name, or it did not answer within `chain_decision_timeout_ms`.

**Scene classification in my chain looks weak.** Check the first stage. If it's an object
detector, the chain is running at per-frame cadence and your scene stage is classifying a
single frame. Reorder so the scene stage is first.

**Tracking IDs aren't what I expect.** Object tracking requires an object-first chain. It
is rejected behind a scene- or VLM-first chain, and rejected on a crop-enabled stage.

**Where do results show up?** Wherever your `vif_event_listeners` deliver them —
`wowzastreamingengine_vi.log`, webhooks, ID3 timed metadata, and video overlays — shaped by
`result_mode` and `dispatch_intermediate_rings`.

---

## See also

- [`README.md`](../README.md) — framework quick start and configuration.
- [`README.wse-plugin.md`](README.wse-plugin.md) — the full plugin configuration reference,
  including stream-level fields and the VIF event listeners a chain delivers through.
- [`VLM_GUIDE.md`](VLM_GUIDE.md) — deploying and tuning the VLM endpoint that `vlm` stages
  call.
- [`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md) — deploying the Video Intelligence Service.
