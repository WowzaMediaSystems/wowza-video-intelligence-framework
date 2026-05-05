# WSE Video Intelligence Module
This module provides an integration with the video intelligence service to perform object and scene detection on a video feed.

## Install
* copy the following Wowza jars to the WSE lib directory

	* wse-plugin-metadata-injection-x.y.z.jar
	* wse-plugin-overlays-x.y.z.jar
	* wse-plugin-thumbnail-api-x.y.z.jar
	* wse-plugin-video-intelligence-x.y.z.jar
* copy the following 3rd party jars to the WSE lib directory
	* commons-text-1.15.0.jar
	* javax-websocket-client-impl-9.4.58.v20250814.jar
	* javax.websocket-api-1.0.jar
	* jetty-client-9.4.58.v20250814.jar
	* websocket-api-9.4.58.v20250814.jar
	* websocket-client-9.4.58.v20250814.jar
	* websocket-common-9.4.58.v20250814.jar

* add server listeners to Server.xml
```xml
<ServerListener>
	<BaseClass>com.wowza.wms.webhooks.WebhookListener</BaseClass>
</ServerListener>
<ServerListener>
	<BaseClass>com.wowza.wms.plugin.module.overlays.OverlayServer</BaseClass>
</ServerListener>
<ServerListener>
	<BaseClass>com.wowza.wms.plugin.videointelligence.VifServer</BaseClass>
</ServerListener>
<ServerListener>
	<BaseClass>com.wowza.wms.plugin.thumbnailapi.ThumbnailServer</BaseClass>
</ServerListener>
```

* Server Properties
```xml
<Property>
	<Name>OverlayServer</Name>
	<Value>unauthorized | authorized</Value>
	<Type>String</Type>
</Property>
<Property>
	<Name>ThumbnailApiServer</Name>
	<Value>unauthorized | authorized</Value>
	<Type>String</Type>
</Property>
<Property>
	<Name>VideoIntelligenceServer</Name>
	<Value>unauthorized | authorized</Value>
	<Type>String</Type>
</Property>
 ```

* add to each Application.xml the following modules
```xml
<Module>
	<Name>ModuleVideoIntelligence</Name>
	<Description>VideoIntelligence</Description>
	<Class>com.wowza.wms.plugin.videointelligence.ModuleVideoIntelligence</Class>
</Module>
<Module>
	<Name>ID3AndPDTInjectionModule</Name>
	<Description>ID3AndPDTInjectionModule</Description>
	<Class>com.wowza.wms.plugin.metadatainjection.module.ID3AndPDTInjectionModule</Class>
</Module>
<Module>
 	<Name>OverlayModule</Name>
	<Description>OverlayModule</Description>
	<Class>com.wowza.wms.plugin.overlays.OverlayModule</Class>
</Module>
```

* add to each Application.xml the following basic properties for ID3 metadata
```xml
<Property>
	<Name>amfToID3ConversionEnabled</Name>
	<Value>true</Value>
</Property>
<Property>
	<Name>amfToID3ConversionAddToManifest</Name>
	<Value>true</Value>
</Property>
<Property>
	<Name>amfToID3ConversionVerboseMaximum</Name>
	<Value>0</Value>
</Property>
```

* add to each Application.xml the following HTTStreamer properties for ID3 metadata
```xml
<Property>
	<Name>cupertinoEnableProgramDateTime</Name>
	<Value>true</Value>
	<Type>Boolean</Type>
</Property>
<Property>
	<Name>cupertinoEnableId3ProgramDateTime</Name>
	<Value>true</Value>
	<Type>Boolean</Type>
</Property>
```

* Need a transcoder template, with one encode, with:
	* `<Name>videoIntelligence</Name>`
	* `<StreamName>mp4:${SourceStreamName}-vi</StreamName>`
	* `<FitMode>match-source</FitMode>`

Overlays will be added to any stream ending with -vi

## Configuration
configuration for the module is stored in `conf/video-intelligence.json`.
The top level configuration contains the default settings then per steam configurations is in the `streams` array of configurations

| Key                  | Default                                           | Purpose                                                                      |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| active             | false                                           | Set to `true` to register WSE with the VI service                            |
| vi_service         | null | WebSocket endpoint for the VI Service. ws://*VI-SERVICE-HOST*:*VIF-SERVICE-PORT*/ws/stream/                                         |
| vi_service_api_key | null                      | API Key for authentication with VI Service.                                 |
| app_name | null | per stream configuration for the application.  if left blank, all applications will work |
| stream_name | null | per stream configuration can contain a regex value to match incommong streams to. ie. `objects.*` |
| vif_event_listeners | null | and array of VIF Event Listeners to get triggered.  See section on VIF Event Listeners below for definition |
| rollup_batch_interval | 2 |   how long in seconds to hold detections for rollup and batch events |
| grayscaled | false | send and process fames as grayscale to reduce network latency, traffic and speed up processing time|
| landscape_video | true | if the video is in landscape |
| object_analysis | null | object detections configuration, see vif-service for details |
| scene_analysis | null | object detections configuration, see vif-service for details |
| ignore_untracked_objects | false |  ignore untracked objects when object tracking_method is set |
| frame_buffer | 10 | size of the frame buffer to hold frames to send to VIF service |
| use_transcoder| true | use transcoder to grab frames |
| skip_frames | 0 | number of frames to skip per second when use_transcoder = true |
| frame_grab_interval | 1 | number of seconds to grab a frame when use_transcoder = false |
| resize_output | true | Resize the `<streamname>-vi` output to the size of model (i.e. 704x396) |

### Misc Debugging Options
| Key                  | Default                                           | Purpose                                                                      |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| save_images      | false | save images/video frames from transcoder to /tmp/vif/<stream_name> |
| log_timing       | 0     | delay in seconds between writing logging details/timing metrics to /tmp/vif/<stream_name> 0 is disabled |
| log_max_messages | 0 | maximum number of log messages to write in wse access log for vif/ws/wss messages. -1 is all, 0 is disabled |


### VIF Event Listeners
| Key | Default | Purpose |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| name | null | Descriptive name of the event listener |
| class_name | null | The java class name including namespace for the event. Built in classes are: `Id3Event`, `WebhookEvent2`, `LogFileEvent`, `OverlayEvent`.  Built in classes default to `com.wowza.wms.plugin.videointelligence.event` namespace |
| methods | disabled | What events and how often events are sent.  Options are `disabled` \\| `immediate` \\| `batch` \\| `rollup` |
| confidence_threshold | 0.0 | What threshold to use for objects or scenes. Used by immediate and batch. |
| suppress_empty_detections | false | Don't call the event listener if there are no detections |
| properties| null | A list of key:value pairs for custom properties for the event.  Included by default are `stream_name`, `width`, `height`, `frame_rate`, and `detector_type` |

### Built in VIF Event Listeners

**Id3Event:** Inserts ID3 tags to the video feed

&nbsp;&nbsp;&nbsp;&nbsp;**Custom Properties:** -None-

**WebhookEvent2:** Sends webhook events defined in `Webhooks.json`

&nbsp;&nbsp;&nbsp;&nbsp;**Custom Properties:** -None-

**LogFileEvent:** log all detected events locally to `wowzastreamingengine_vi.log`

&nbsp;&nbsp;&nbsp;&nbsp;**Custom Properties:** -None-

**OverlayEvent:** Updates video postfixed with `-vi` with graphical overlays

&nbsp;&nbsp;&nbsp;&nbsp;**Custom Properties:**

| Key                  | Default                                           | Purpose                                                                      |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| jitter             | 0                                           | amount of jitter in object overlay graphics to ignore |
| debug_string| null | show a string that can include current time such as "'Cur time:' HH:mm:ss MM-dd-yyyy" as a video overlay |
| show_stats|  false | show performance stats as a video overlay. RTT includes PingPong RTT/Ping(ICMP) RTT  |
| overlay_delay | 0 | number of frames to delay drawing overlays.|
| overlay_thread_drawing | false | Draw overlays in a thread |
| replace_video | false | Replaces original video with frame accurate overlays |
| fade_step | 0 | How many frames it takes to fade objects out once they are no longer tracked. Set to 0 for high skip_frame values |


## API
### API pattern is
* `/v1/{server}/plugin/vif/status` current system status with all streams
* `/v1/{server}/plugin/vif/config` default config
* `/v1/{server}/plugin/vif/applications/{appName}/streams/{streamName}` current active config
* `/v1/{server}/plugin/vif/applications/{appName}/streams/{streamName}/config` current saved config
* `/v1/{server}/plugin/vif/applications/{appName}/streams/{streamName}/status` current stream status
* `/v1/{server}/plugin/vif/applications/{appName}/streams/{streamName}/thumbnail` get a thumbnail image
  *   query param: overlay=true|false
  *   query param: frameId=### (0 is latest)


- {_serverName_}: anything
- {_appName_}: name of the app the stream is running on
- {_streamName_}: name of the stream or stream pattern for the configuration

### API supports methods/verbs
`GET | POST | PUT | DELETE`

### Examples
```
# Get status for entire system
curl -X GET http://localhost:8087/v1/server/plugin/vif/status

# Get status for a single stream
curl -X GET http://localhost:8087/v1/server/plugin/vif/applications/live/streams/object/status

# Update configure file for a single stream
curl -X PUT http://localhost:8087/v1/server/plugin/vif/applications/live/streams/object.*/config  \
-d '{ "active":"false" }'

# Update configure file for defaults
curl -X PUT http://localhost:8087/v1/server/plugin/vif/config  \
-d '{ "active":"false" }'

# Update active configuration for a single stream
curl -X PUT http://localhost:8087/v1/server/plugin/vif/applications/live/streams/object  \
-d '{ "active":"false" }'

# Update active configuration for a single stream
curl -X PUT http://localhost:8087/v1/server/plugin/vif/applications/live/streams/object \
-d '{ "vif_event_listeners": { "Overlays": { "methods":  ["disabled"]} } }'
```

Can include vhost and appinstance if needed, otherwise defaults to `_defaultVHost_`,`_definst_`
`/v1/server/plugin/vif/vhosts/_defaultVHost_/applications/live/instances/_definst_/streams/myStream/config`


## UI

### Test Player to see video
View the stream, see id3 tags and overlays
[View the page](http://localhost:8088/vif/vif-viewer.html)
### Sample Monitor page to see stats
View the status of WSE and the streams being processed [View the page](http://localhost:8088/vif/vif-status.html)

## Docker compose
Provided is a `docker-compose.yaml` that will start WSE with a pre configured `Server.xml` and `live` application along with a sample `video-intelligence.json`
