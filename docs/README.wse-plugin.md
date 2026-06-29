# WSE Video Intelligence Module
This module provides an integration with the video intelligence service to perform object and scene detection on a video feed.

## Install onto an existing Wowza Streaming Engine server (Must be version 4.11 or greater)
### Lib folder and jar files
* copy the following Wowza jars to the WSE lib directory

	* wse-plugin-metadata-injection-x.y.z.jar
	* wse-plugin-overlays-x.y.z.jar
	* wse-plugin-video-intelligence-x.y.z.jar
* copy the following 3rd party jars to the WSE lib directory
	* classgraph-4.8.184.jar
	* commons-text-1.15.0.jar
	* jakarta.websocket-api-2.1.1.jar
	* jakarta.websocket-client-api-2.1.1.jar
	* jetty-ee10-websocket-jakarta-client-12.1.9.jar
	* jetty-ee10-websocket-jakarta-common-12.1.9.jar
	* jetty-websocket-core-client-12.1.9.jar
	* jetty-websocket-core-common-12.1.9.jar

### Server.xml
* add Server Listeners to Server.xml
	```xml
	<ServerListeners>
		<ServerListener>
			<BaseClass>com.wowza.wms.webhooks.WebhookListener</BaseClass>
		</ServerListener>
		<ServerListener>
			<BaseClass>com.wowza.wms.plugin.overlays.OverlayServer</BaseClass>
		</ServerListener>
		<ServerListener>
			<BaseClass>com.wowza.wms.plugin.videointelligence.VifServer</BaseClass>
		</ServerListener>
	```

* add server Properties to Server.xml
	```xml
	<Properties>
		<Property>
			<Name>OverlayServer</Name>
			<Value>authorized</Value>
			<Type>String</Type>
		</Property>

		<Property>
			<Name>VideoIntelligenceServer</Name>
			<Value>authorized</Value>
			<Type>String</Type>
		</Property>
	```

### Application.xml
* add application Modules to each Application.xml that VIF will run under.
	```xml
	<Modules>
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

* add application Properties to each Application.xml that VIF will run under.
	```xml
	<Properties>
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

* add HTTPStreamer Properties to each Application.xml that VIF will run under.
	```xml
	<HTTPStreamer>
		<Properties>
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

* enable the transcoder for each Application.xml that VIF will run under and use `vif-gpu-eva.xml` as the fallback
	```xml
	<Transcoder>
		<LiveStreamTranscoder>transcoder</LiveStreamTranscoder>
		<Templates>${SourceStreamName}.xml,vif-gpu-eva.xml</Templates>
	```

### WSEM
* To enable VIF in WSEM/UI, need to copy to
	```shell
	mkdir -p /usr/local/WowzaStreamingEngine/manager/temp/webapps/enginemanager/wse-plugins/server/vif
	cp -r docker/manager/ui /usr/local/WowzaStreamingEngine/manager/temp/webapps/enginemanager/wse-plugins/server/vif
	```
  or build a new `.war` file with wsem-war/build-war.sh and move it
	```shell
	rm -r /usr/local/WowzaStreamingEngine/manager/temp
	cp WMSManager.war /usr/local/WowzaStreamingEngine/manager
	cp WMSManager.war /usr/local/WowzaStreamingEngine/manager/lib
	```
* If connecting to a remote instance (not localhost), add the specific client IP(s) to the `IPWhiteList` in `RESTInterface` in Server.xml so you can access the VIF REST API. Use a comma-separated list of exact IPs (per-octet wildcards like `192.168.1.*` are supported); avoid `*`, which allows every source IP.
	```xml
	<RESTInterface>
		<IPWhiteList>127.0.0.1,203.0.113.10</IPWhiteList>
	```
* If connecting to a remote instance (not localhost), in WSEM login with `Wowza Streaming Engine URL` = http://<ip_address>:8087

### Misc
* Overlays will be added to the stream ending with `-vi`

* For Ubuntu/linux, you may need to install fonts for overlays to work correctly
	```shell
	apt-get install -y libfreetype6 fontconfig
	```

## VIF Configuration
Configuration files for the module are stored in `conf.modules/vif/`
The top level/defaults are in the `Default.json` file, individual streams are stored in their own file with `<applicationName>_<streamName>.json`

Update the Default.json `vi_service_url` and `vi_service_api_key` to point to the VIS service

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
| catch_up_to_live | true | **Scene/VLM only.** When inference stays slower than real-time, skip the stale buffered backlog and resume at the live edge instead of letting latency grow to the full `frame_buffer` depth. Temporary slowdowns are still absorbed by the buffer. (Object detection bounds latency via `auto_frame_throttle` instead — it can't skip without breaking ByteTrack, so this option has no effect for object.) Every detection reports `behind_live_ms`; the first scene/VLM detection after a skip also carries `caught_up`/`skipped_frames`/`skipped_ms`. |
| catch_up_max_behind_seconds | null (=2s) | **Scene/VLM:** how far behind live (seconds) detections may fall before catch-up skips to live. **Object:** not used — object latency is bounded by the `inference_fps` throttle toward the sustainable rate, and the slow-inference warning fires at a fixed ~1s single-frame round-trip. For **Scene/VLM**, unset derives to the buffer's design headroom (~2s), bounding latency near `inference_time + 2s`; lower for tighter latency, raise to tolerate more lag. |
| auto_frame_throttle | false | Opt-in frame-rate throttle (default **off**, all modes): reduce `inference_fps` when inference falls behind. **Object detection:** its latency lever — keeps the analyzed frame near live and contiguous for the tracker. **Scene/VLM:** a pre-step that throttles before `catch_up_to_live` resorts to skipping, for fewer coverage gaps. Renamed from `auto_scene_frame_throttle` (still accepted on read). |
| use_transcoder| true | use transcoder to grab frames |
| inference_fps | -1 | number of frames to send to inferencing per second when use_transcoder = true. **VLM:** each analysis window is one request carrying `duration × inference_fps` images, and the VLM endpoint caps images per prompt (the bundled vLLM sidecar allows 8) — keep `duration × inference_fps` at 8 or below (e.g. 2 fps × 2s, the example config's values). `-1` resolves to the source frame rate and will exceed the cap, so it is not supported for VLM; the Stream Manager UI enforces this. |
| inference_video_height| -1 | height of the video to be inferenced. -1 = source, 0 = model, >0 actual value |
| frame_grab_interval | 1 | number of seconds to grab a frame when use_transcoder = false |

#### VLM free-form analysis
When a VLM analysis window has no `class_names` (a free-form prompt) — or VIS returns output that can't be parsed as structured results — event listeners receive a single detection with `class_name` set to `description` and the full analysis text in `reasoning`, instead of an empty detections list. Avoid configuring a real VLM class named `description`, as it would be indistinguishable from this synthetic class.

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
* `/v1/{server}/plugin/vif/status` (GET) current system status with all streams
* `/v1/{server}/plugin/vif/config` (GET/PUT) default config
* `/v1/{server}/plugin/vif/applications/{appName}/streams/{streamName}` (GET/PUT) current active config
* `/v1/{server}/plugin/vif/applications/{appName}/streams/{streamName}/config` (GET/PUT/POST/DELETE) current saved config
* `/v1/{server}/plugin/vif/applications/{appName}/streams/{streamName}/status` (GET) current stream status
* `/v1/{server}/plugin/vif/applications/{appName}/streams/{streamName}/thumbnail` (GET) get a thumbnail image
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
Provided is a `docker-compose.yaml` that will start WSE with a pre configured `Server.xml` and `live` application along with a sample json files
