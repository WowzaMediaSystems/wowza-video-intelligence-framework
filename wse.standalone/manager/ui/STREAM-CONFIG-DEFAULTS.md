# Stream Config Defaults

This page is a quick reference for how defaults are handled by the VIF Stream Configuration UI in [stream-config.html](/docker/manager/ui/stream-config.html).

## Config-Driven Defaults

These values are loaded from the VIF config API (`/v1/server/plugin/vif/config`), stored in `defaultConfig`, and applied when `+ New Stream Config...` is selected.

Changes to the top-level defaults in [Default.json](/docker/conf.modules/vif/Default.json) should flow through to new stream configs for:

- `active`
- `grayscaled`
- `resize_output`
- `skip_frames`
- `object_detections_holdback`
- `scene_detections_holdback`
- `duration`
- `catch_up_to_live`
- `auto_frame_throttle`
- `log_max_messages`
- `log_timing`
- `object_analysis.confidence_threshold`
- `object_analysis.model_name`
- `object_analysis.tracking_method`
- `object_analysis.byte_track_properties.*`
- `object_analysis.tiling_mode`
- `object_analysis.tiling_properties.*`
- `scene_analysis.confidence_threshold`
- `scene_analysis.sensitivity`

The relevant UI logic lives in:

- [stream-config.html](/docker/manager/ui/stream-config.html) for `defaultConfig` loading
- [stream-config.html](/docker/manager/ui/stream-config.html) for `applySuggestedDefaultsForNewStream()`
- [stream-config.html](/docker/manager/ui/stream-config.html) for `populateForm(config)`

## UI-Owned Defaults

These defaults are still hardcoded in [stream-config.html](/docker/manager/ui/stream-config.html) and do not automatically follow json files.

### New Stream Defaults

- `Application` default value/fallback: `live`
- `Detector Type` default: `object`

### VLM Analysis Mode (UI)

The VLM section (shown for `Detector Type = vlm`, behind `?vlm=true`) is mode-driven — **Detect / Describe / Custom**. The mode is a UI construct: the VI service infers behavior from which `vlm_analysis` keys are set, so `buildConfigJson()` serializes **only the active mode's** class/prompt keys (the mode-bleed guard).

- **Mode default**: `Detect`. `populateForm()` infers the mode from a loaded config — operator prompts or `response_schema` → Custom; else a class list → Detect; else Describe.
- **Detect**: a per-class repeater (one row per class + optional hint) → serializes `class_names` (+ `class_hints` for rows with a hint).
- **Describe**: no class/prompt fields → none serialized.
- **Custom**: `system_prompt` / `user_prompt` (required) / an optional **per-class repeater** (the same one Detect uses — one row per class + optional hint → `class_names` (+ `class_hints`), feeding `{class_list}` in your prompts) / an **Output Schema**. Output Schema is a 3-way **kind** selector: **Free-form** (default — no schema sent; paired with the VIS rule that no longer auto-imposes the class schema once a custom `user_prompt` is set, output stays free even when classes are listed), **Per-class verdicts** (posts the built-in class schema sourced **live** from `defaultConfig.vlm_defaults.detect.response_schema` — relayed by VIS at `GET /vlm/defaults`, never mirrored — so VIS enforces `{class_name, reasoning}`), and **Custom schema** (reveals the `vlm-schema-builder.js` editor). The Custom editor has two losslessly-converting sub-modes: a guided **Fields** builder (types *string / number / integer / boolean / string[] / enum* and *object / object[]* with recursive nesting; generates `response_schema` for you) and a **Raw JSON** editor (constraints, `$ref`, `oneOf`, non-string enums). On load, `applyVlmOutputSchema()` picks the kind (the live default schema → Per-class verdicts; anything else → Custom), and `loadVlmSchema()` decomposes it into Fields when representable, else Raw JSON — so no schema is ever dropped.
- Shared connection fields (Endpoint, API Key, Request Timeout; hidden Model Name) sit above the selector. `Temperature` / `Max Tokens` live under an **Advanced** disclosure. `max_concurrent_requests` is JSON-only (set it in `Default.json`).
- UI-owned validation: Custom mode requires a non-empty `user_prompt`; the **Raw JSON** schema (Custom kind only) must be valid JSON (the Fields builder always emits valid JSON); a non-blocking lint warns when classes are set but neither prompt references `{class_list}`.

### Event Listener Defaults

- new listener `methods`: `disabled`
- listener confidence threshold default: `0.7`
- built-in listener presets shown in the create UI:
  - `OverlayEvent`
  - `Id3Event`
  - `LogFileEvent`
  - `WebhookEvent2`
  - `ObjectTracking`

### Listener Property Defaults

These are defined inline under `window.VIF_LISTENER_PROPERTIES`:

- `OverlayEvent` property defaults
- `ObjectTracking` property defaults
- all `regions_of_interest` item defaults

#### Examples include:

- `OverlayEvent.fade_step`
- `OverlayEvent.show_stats`
- `ObjectTracking.overlays`
- `ObjectTracking.untracked_object_color`
- ROI defaults like `name`, `x`, `y`, `x2`, `y2`, `triggers`, `count_max`, etc.

### Validation Rules

Numeric and text validation is UI-owned under `FIELD_RULES` and listener property rules. Examples:

- skip frame range
- holdback range
- scene sensitivity range
- listener confidence range
- `ObjectTracking` CSS color validation

## When Updating `Default.json`

If you update top-level detector defaults in [Default.json](/docker/conf.modules/vif/Default.json):

- new stream configs should mostly follow automatically
- check the UI once to confirm the default field values and fallback behavior still look right

If you update any of the following, you will likely also need a manual UI change in [stream-config.html](/docker/manager/ui/stream-config.html):

- listener presets
- listener confidence defaults
- listener property defaults
- ROI defaults
- validation ranges
- detector type or application placeholder default behavior

## Recommended Update Workflow

1. Update [Default.json](/docker/conf.modules/vif/Default.json).
2. Check whether the change is top-level detector config or UI-owned listener behavior.
3. If it affects listener defaults or validation, update [stream-config.html](/docker/manager/ui/stream-config.html) too.
4. Open `+ New Stream Config...` and verify the default field values, fallbacks, and toggles match expectations.
