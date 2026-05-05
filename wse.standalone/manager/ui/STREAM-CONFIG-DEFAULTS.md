# Stream Config Defaults

This page is a quick reference for how defaults are handled by the VIF Stream Configuration UI in [stream-config.html](/docker/manager/ui/stream-config.html).

## Config-Driven Defaults

These values are loaded from the VIF config API (`/v1/server/plugin/vif/config`), stored in `defaultConfig`, and applied when `+ New Stream Config...` is selected.

Changes to the top-level defaults in [video-intelligence.json](/docker/conf/video-intelligence.json) should flow through to new stream configs for:

- `active`
- `grayscaled`
- `resize_output`
- `skip_frames`
- `object_detections_holdback`
- `scene_detections_holdback`
- `duration`
- `auto_scene_frame_throttle`
- `log_max_messages`
- `log_timing`
- `object_analysis.confidence_threshold`
- `object_analysis.model_name`
- `object_analysis.tracking_method`
- `object_analysis.byte_track_properties.*`
- `scene_analysis.confidence_threshold`
- `scene_analysis.sensitivity`

The relevant UI logic lives in:

- [stream-config.html](/docker/manager/ui/stream-config.html) for `defaultConfig` loading
- [stream-config.html](/docker/manager/ui/stream-config.html) for `applySuggestedDefaultsForNewStream()`
- [stream-config.html](/docker/manager/ui/stream-config.html) for `populateForm(config)`

## UI-Owned Defaults

These defaults are still hardcoded in [stream-config.html](/docker/manager/ui/stream-config.html) and do not automatically follow `video-intelligence.json`.

### New Stream Defaults

- `Application` default value/fallback: `live`
- `Detector Type` default: `object`

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

## When Updating `video-intelligence.json`

If you update top-level detector defaults in [video-intelligence.json](/docker/conf/video-intelligence.json):

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

1. Update [video-intelligence.json](/docker/conf/video-intelligence.json).
2. Check whether the change is top-level detector config or UI-owned listener behavior.
3. If it affects listener defaults or validation, update [stream-config.html](/docker/manager/ui/stream-config.html) too.
4. Open `+ New Stream Config...` and verify the default field values, fallbacks, and toggles match expectations.
