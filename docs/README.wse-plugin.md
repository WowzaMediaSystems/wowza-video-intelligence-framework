# WSE Video Intelligence Module
This module provides an integration with the video intelligence service to perform object and scene detection on a video feed.

You can install WSE Video Intelligence Module onto an existing Wowza Streaming Engine server (Must be version 4.11.1 or greater)

## Using the plugin installer to update Wowza Streaming Engine

The WSE Video Intelligence jar includes a script to update your Wowza Streaming Engine.  This will update the xml files, copy necessary files to your Wowza Streaming Engine installation.
```
java -jar wse-plugin-video-intelligence-x.y.z.jar Install
```

If your system does not have java installed natively, you can use the java that comes with WSE
```
/usr/local/WowzaStreamingEngine/java/bin/java
```
or
```
C:\Program Files\Wowza Media Systems\Wowza Streaming Engine x.y.z+vv\jre\bin\java
```

Add  `--help` to the above commands to see all the options available.

The installer prepares the REST API for the Manager UI (CORS policy and IP white list) but does not put TLS on it. If Manager is served over HTTPS, read [Manager over HTTPS](#manager-over-https) before opening the VIF tab.

## Manually updating Wowza Streaming Engine

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

* copy the lib-native `.so` or `.dll` files to the WSE lib-native folder, depending on your architecture
    * x86_64
        * linux64/amd64/libturbojpeg.so.0.2.0
        * linux64/amd64/libvif-mcframes.so
    * arm64
        * linux64/aarch64/libturbojpeg.so.0.2.0
        * linux64/aarch64/libvif-mcframes.so
    * windows
        * win64/turbojpeg.dll
        * win64/vif-mcframes.dll

* copy the conf.modules files to the WSE conf.modules folder

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

		<Property>
			<Name>VideoIntelligenceLogRootDir</Name>
			<Value>/usr/local/WowzaStreamingEngine/logs</Value>
			<Type>String</Type>
		</Property>
	```

* set the REST API CORS policy in the `<Properties>` block inside `<RESTInterface>` in Server.xml. The installer sets it to exactly this value, replacing any existing one.
	```xml
	<RESTInterface>
		...
		<Properties>
			<Property>
				<Name>restUserHTTPHeaders</Name>
				<Value>Access-Control-Allow-Origin:*|Access-Control-Allow-Methods:GET,POST,PUT,DELETE,PATCH,OPTIONS|Access-Control-Allow-Headers:Content-Type,Authorization,If-Match|Access-Control-Expose-Headers:ETag</Value>
				<Type>String</Type>
			</Property>
		</Properties>
	</RESTInterface>
	```

	The `restUserHTTPHeaders` property is the CORS policy for the Engine REST API. The Manager
	UI calls the API cross-origin (Manager on 8088, Engine REST on 8087), and the v2 API's
	concurrency handshake needs `If-Match` allowed on requests and `ETag` exposed on responses —
	without them every save from the browser fails its CORS preflight or loses its revision,
	which reads like the Engine being down. `V2CorsPolicyTest` pins the shipped policy to what
	the browser SDK actually sends, and pins the installer's value to the shipped policy.

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

* add the `waitForCodecs` stream Property (under `<Streams><Properties>`) to each Application.xml that VIF will run under.
	```xml
	<Streams>
		<Properties>
			<Property>
				<Name>waitForCodecs</Name>
				<!-- waitForCodecs valid values are: none, audio, video, all -->
				<Value>video</Value>
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

* copy the VIF transcoder template files to the WSE transcoder/templates directory

### WSEM
* To enable VIF in WSEM/UI, need to copy to
	```shell
	mkdir -p /usr/local/WowzaStreamingEngine/manager/wse-plugins/server/vif
	cp -r docker/manager/ui /usr/local/WowzaStreamingEngine/manager/wse-plugins/server/vif
	```
* If connecting to a remote instance (not localhost), add the specific client IP(s) to the IPWhiteList in RESTInterface in Server.xml so you can access the VIF REST API. Use a comma-separated list of exact IPs (per-octet wildcards like 192.168.1.* are supported); avoid *, which allows every source IP.
	```xml
	<RESTInterface>
		<IPWhiteList>127.0.0.1,172.*.*.*,192.168.*.*,10.*.*.*</IPWhiteList>
	```
* If connecting to a remote instance (not localhost), in WSEM login with `Wowza Streaming Engine URL` = http://<ip_address>:8087
* If Manager itself is served over HTTPS, the REST API must serve HTTPS too - see [Manager over HTTPS](#manager-over-https).
* The VIF dashboard (`docker/manager/ui`, entry page `shm.html` per `config.json`) is reachable only through the WSE Manager — there is no standalone entry page; for standalone dev/preview use the `qa_automation` harness's static-server mode (VIS repo).

### Misc
* Overlays will be added to the stream ending with `-vi`

* For Ubuntu/linux, you may need to install fonts for overlays to work correctly
	```shell
	apt-get install -y libfreetype6 fontconfig
	```

## Manager over HTTPS

The VIF pages in Manager call the Engine REST API (port 8087) directly from the browser. A browser refuses plain `http://` requests from an `https://` page (mixed content), so when Manager is served over HTTPS (`httpsPort` in `manager/conf/tomcat.properties`) the UI addresses `https://<host>:8087`, and the Engine REST API has to serve HTTPS as well. Until it does, the VIF dashboard shows "Offline - lost connection to the Engine" even though Engine and VIS are fine.

Wowza documents the Manager side in [Connect to Wowza Streaming Engine Manager over HTTPS](https://www.wowza.com/docs/how-to-connect-to-wowza-streaming-engine-manager-over-https) and the `SSLConfig` fields in the [Server.xml configuration reference](https://www.wowza.com/docs/wowza-streaming-engine-serverxml-configuration-reference). The step below is the one that article does not cover: stock Manager talks to Engine server-side and never needed it.

Add the keystore Manager uses (the same StreamLock `.jks` works) to the REST interface's own `SSLConfig` in `Server.xml`. It is separate from the one under `HostPort` 443 in `VHost.xml`:

```xml
<RESTInterface>
	<Port>8087</Port>
	...
	<SSLConfig>
		<Enable>true</Enable>
		<KeyStorePath>${com.wowza.wms.context.VHostConfigHome}/conf/<domain>.streamlock.net.jks</KeyStorePath>
		<KeyStorePassword><password></KeyStorePassword>
		<KeyStoreType>JKS</KeyStoreType>
	</SSLConfig>
```

`<Enable>` is what switches the REST API to HTTPS; a keystore alone does nothing. A `Server.xml` from a recent Engine already carries this block with `<Enable>false</Enable>` and Wowza's bundled `conf/tls.jks`, so on those the change is flipping `Enable` and pointing the keystore at your certificate.

Restart Engine:

```shell
sudo systemctl restart WowzaStreamingEngine
```

Then sign in to Manager with `Wowza Streaming Engine URL` = `https://<domain>.streamlock.net:8087`: port 8087 no longer accepts plain HTTP, and the certificate is valid for that hostname, not for `localhost`. The `IPWhiteList` in `RESTInterface` still applies to the browser's address. None of this depends on whether Engine reaches VIS over `ws` or `wss`; that is `vi_service_url` below.

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

#### VLM Analysis Modes (Detect / Describe / Custom)

The standalone `detector_type="vlm"` analyzer issues **exactly one VLM request per analysis window**. The bundled vLLM sidecar runs without prefix caching, so each request re-runs the full vision-token prefill over the window's frames — adding classes to one shared prompt is cheap; fanning out per-class requests is not. The Stream Manager UI (behind `?vlm=true`) exposes three modes. The mode is a UI construct: the VI service infers behavior from *which fields the config sets*, so no mode discriminator is sent on the wire.

- **Detect** (default) — set `class_names` (short words/phrases, open vocabulary) and the analyzer returns a per-class verdict, surfacing only the classes actually visible as `{class_name, reasoning}` detections. Optionally attach **`class_hints`** — a map of *class name → hint* that disambiguates a class (e.g. `{"fire": "visible open flame, not red lighting"}`). Hints are **optional** and **render-only**: each is inlined next to its class in the prompt at a cost of only a few prompt tokens, and they never change the result shape. In the UI, Detect is a per-class repeater — one row per class, each with an optional hint field.
- **Describe** — set no `class_names` and no prompts. The analyzer returns a free-form written description of each window (see the fallback note below).
- **Custom** (advanced) — supply your own `user_prompt` (required) and optionally a `system_prompt`, a `class_names` list, and a custom `response_schema`. Both prompts support the placeholders `{class_list}` (the configured classes as a bullet list, with any hints inlined — injected only where the placeholder appears), `{frame_count}` (images in the window) and `{duration_seconds}` (window length in seconds). A custom `response_schema` flows through to the model verbatim for structured extraction (e.g. read a gauge value). In the UI the schema is built with a guided **Fields** editor — one row per output field (name, optional description, a *required* toggle, and a type) that generates the JSON Schema for you. Supported types are *string / number / integer / boolean / string[] / enum* (a string allowed-value list) and *object / object[]* (which open an indented sub-builder, recursively). A **Raw JSON** toggle remains for anything the builder can't express (numeric/string constraints, `$ref`, `oneOf`/`anyOf`, non-string enums, …). The two views convert losslessly: switching to Raw serializes the builder, and switching back imports the JSON when it decomposes into supported shapes — otherwise a complex schema simply stays in Raw JSON and is never dropped.

**Custom-schema output.** When a custom `response_schema` produces JSON that is not the default `{"results":[{class_name, reasoning}]}` shape, the whole structure is attached to the detection's `data` field and flows — structured — through the webhook, ID3 and log sinks (no per-schema configuration). The on-screen overlay can't pick a field from an arbitrary schema, so it renders a generic `vlm` label for custom-schema windows. ID3 timed-metadata has practical size limits, so consume large custom schemas via the webhook or log sinks. Detect/Describe output is unchanged.

**Free-form / fallback detection.** In Describe mode — or when the VI service returns output that can't be parsed as structured results (e.g. truncated) — event listeners receive a single detection with `class_name` set to `description` and the full analysis text in `reasoning`, instead of an empty detections list. Avoid configuring a real VLM class named `description`, as it would be indistinguishable from this synthetic class.

### VOD Jobs
VOD job settings live in a file of their own, `conf.modules/vif/vod/settings.json` — a persist document of the v2 API (`GET/PATCH /v2/vif/persist/vod-settings`), beside the stream configuration and never part of it; a `vod` block left in `Default.json` by an earlier build is ignored. Every key is optional — leave one out and it falls through to the built-in default rather than being pinned to it. Values may be `${ENV_VAR}` placeholders, resolved when the file is read.

```json
{
    "max_concurrent_jobs": 1,
    "max_jobs": 25,
    "job_ttl_seconds": 0,
    "content_dir": "/usr/local/WowzaStreamingEngine/content",
    "jobs_dir": "/usr/local/WowzaStreamingEngine/vif-vod-jobs",
    "auto_resume": true,
    "lifecycle_webhook": "https://example.com/vif/vod-jobs",
    "lifecycle_webhook_secret": "my-consumer",
    "max_upload_bytes": 10737418240
}
```

| Key                  | Default                                           | Purpose                                                                      |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| max_concurrent_jobs | 1 | how many VOD jobs are analysed at once. One job saturates a VIS model slot, so raise it only with the capacity to match |
| max_jobs | 25 | how many job records are kept. Past this the oldest *finished* jobs are forgotten, and their stored results and thumbnails go with them; a queued or running job is never evicted |
| job_ttl_seconds | 0 | how long a finished job is kept after it ends, in seconds. `0` keeps it until `max_jobs` forgets it |
| content_dir | `<ConfigHome>/content` | where a job's `file` is resolved from. A request that resolves outside this directory is refused |
| jobs_dir | `<ConfigHome>/vif-vod-jobs` | where job records, results and thumbnails are kept |
| auto_resume | true | whether a job that stopped for a transient reason is resumed automatically. Unset means on; `false` turns it off for every job that did not decide for itself |
| lifecycle_webhook | *(none)* | where every job's state changes are POSTed, for jobs that did not name a destination of their own. Unset or empty sends nothing |
| lifecycle_webhook_secret | *(none)* | name of an entry in the secrets document whose value is sent as the `Authorization` header on every lifecycle POST to `lifecycle_webhook`; a job-supplied destination never receives it. A save that names no configured secret is refused |
| max_upload_bytes | 10737418240 | the largest upload `POST /v2/vif/vod/files` accepts (10 GiB); a larger one is refused with `413` before a byte is written |

The document is edited over REST with `PATCH /v2/vif/persist/vod-settings` (a JSON merge patch guarded by `If-Match`, like every persist document; a `null` value restores a key's default). The two caps apply to the running Engine as soon as the patch is applied — the worker pool is resized without interrupting a job in flight, and a lowered `max_jobs` evicts immediately. The two directories take effect on the next Engine restart: moving them under jobs that are already running would strand them, so a change is logged and left for the restart.

The secrets document, `conf.modules/vif/vod/secrets.json`, is a flat map of named `Authorization` values referenced from `lifecycle_webhook_secret` here or from a submit's own `lifecycle_webhook_secret`; see the VOD guide's "Named webhook secrets". `GET /v2/vif/persist/secrets` answers the names only, and `PATCH` sets, rotates (a string) or removes (`null`) a name — a value never travels back out.

**Retention.** The two retention keys compose rather than override: `max_jobs` bounds how many jobs are kept, `job_ttl_seconds` bounds how long, and either one on its own can forget a job — taking its stored results and thumbnail with it. Once a TTL is configured it is swept every 60 seconds, and again whenever a job is submitted or the Engine restarts; a saved TTL also applies at once to the jobs already held. A queued or running job is never touched however old it is. The clock is the moment the job last ended, so a job that was resumed is measured from the run that continued it rather than from the run that stopped. `0` — the default — means no TTL: it has to be a value rather than a missing key, because a config save merges and cannot un-set one.

#### VOD Job Lifecycle Webhooks

A job POSTs its state changes to a URL of its own if the submit named one, and to the settings document's `lifecycle_webhook` otherwise. The submit body's `lifecycle_webhook` field decides which:

| `lifecycle_webhook` on the submit | What the job does |
| --- | --- |
| omitted (`null`) | uses the settings document's `lifecycle_webhook` as it is configured at each transition, so a later save applies to jobs already running |
| `""` | sends nothing, whatever the global says |
| a URL | posts there instead of the global |

One POST goes out per *persisted* transition — `running`, then whichever of `completed` / `failed` / `cancelled` the job reaches. A graceful Engine stop cancels a running job, which persists — and posts — `cancelled`; a job the Engine never got to finalise (a hard kill while it ran, or one still queued when the Engine went) is finalised as `failed` on the next startup and posts then, which is the one transition a consumer that polls can never observe. There is no event for `pending`: the submit's own 201 already carries that.

```json
{
  "event": "status_changed",
  "job_id": "8b1f…", "state": "completed",
  "file": "clips/one.mp4", "tag": "nightly",
  "requests_sent": 40, "requests_total": 40, "media_time_ms": 24000,
  "queued_at": "2026-08-09T11:02:13.004Z",
  "started_at": "2026-08-09T11:02:13.221Z",
  "ended_at": "2026-08-09T11:04:51.118Z",
  "resumes": 1,
  "results": "/v2/vif/vod/jobs/8b1f…/results"
}
```

`event` is always `status_changed` — a discriminator for consumers that route several kinds of hook to one URL; which transition this is, is `state`. The body is otherwise the same shape `GET /v2/vif/vod/jobs/{jobId}` serves, plus `results`, a server-relative path (the Engine does not know the host name you reach it by). `error` and `error_cause` are present on a failure; the destination URL is never echoed back.

Delivery is asynchronous and never affects the job: one POST at a time, in transition order per job, `Content-Type: application/json`, 5s to connect and 10s for the response, up to 3 attempts with 2s and 10s between them. Anything but a 2xx is a failed attempt; after the third the notification is dropped with a WARN naming the job and the state, and the job is unaffected either way. Terminal events are additionally at-least-once across restarts: a successful delivery is recorded in the job's manifest, and a startup that hydrates a terminal job whose notification was never recorded — the Engine can stop with deliveries still queued or failing — pushes that event again. A consumer may therefore see a terminal event twice (route on `job_id` and `state`), and configuring a webhook after jobs have finished means their terminal events arrive on the next restart.

**Carrying a secret.** Every webhook credential is a name in the secrets document — `conf.modules/vif/vod/secrets.json`, edited through `PATCH /v2/vif/persist/secrets` (a string sets or rotates a name, `null` removes it; a read answers names only, never a value) — referenced by name and resolved at delivery time, never recorded against a job. The settings document's `lifecycle_webhook_secret` authorizes only deliveries to its own `lifecycle_webhook` (matched by exact string equality) — a destination named on a submit never receives it, so one submit cannot exfiltrate the operator's credential to a collector of its own. A per-job destination that needs authentication names its own entry at submit (`lifecycle_webhook_secret` in the body; an unknown name is refused, and a job-named secret wins over the global one). Don't put tokens in webhook URLs: a per-job URL is written verbatim into the job's manifest — it has to be, or the job could not be reported after a restart — so a `?token=` in one is on disk for as long as the job record is. A submit whose `lifecycle_webhook` is not an absolute http(s) URL is refused outright. See the VOD guide's "Named webhook secrets" for the full semantics, including the trust boundary of the secrets document.

#### Automatic Resume

A job that stops for a *transient* reason is put back on the queue by itself, after a wait. It is on by default: set `auto_resume: false` in the VOD settings document to turn it off for the Engine, or `auto_resume` on the submit body to decide for one job (`true` or `false`; the per-job value wins over the global either way).

**No window is ever lost or skipped.** A retry is the same resume a `POST .../resume` makes: the new run continues from the window after the last one the stored results answered, and appends to the same results file under the same job id. The combined output is identical to what an uninterrupted run would have produced, and `resumes` counts every run — automatic or manual.

Every failure records an `error_cause` alongside its `error`, on the job view and in the lifecycle webhook payload. The cause is what decides whether a retry happens at all:

| Class | Causes | Backoff |
| --- | --- | --- |
| transient, short | `response_timeout`, `disconnected`, `detector_restarted`, `send_failed` | 5s, 15s, 30s |
| transient, slow | `endpoint_degraded`, `not_connected`, `connect_failed`, `detector_error` | 15s, 1m, 5m |
| never retried | `config_drift`, `coverage_shortfall`, `source_error`, `store_error`, `engine_restart` | — |

Three attempts, and each failure picks its own backoff — a dropped connection waits 5s, and if the retry finds the service still down (`connect_failed`) the next wait is a minute, then five. An attempt that got *further* than the one before it starts the count again, so a long file with the occasional blip is never starved out. After the third the job stays `failed` with everything it had analysed, and a manual resume picks it up from there.

Some jobs are never retried whatever the cause: one submitted with `store_results: false` (it has no resume point), and an inline job whose credentials were redacted out of its manifest (a resume needs a body only the caller can supply). Each stand-down is logged with its reason. A job interrupted by an Engine restart is not retried at startup either — `ENGINE_RESTART` is deliberately in the never-retried class. And a retry waiting on its backoff never pins the job: `max_jobs` can still evict it, which cancels the retry with it.

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

## Logging
By default logging is added to the standard Wowza Streaming log files `wowzastreamingengine_access.log` and `wowzastreamingengine_error.log`.  If you want to log just VIF events from WSE, you can create a new Logger with the name `VIFLogger`.  Add the logger to the `Loggers` section of the `log4j2-config.xml` file.
```
    <Loggers>
		<Logger name="VIFLogger" level="info" additivity="false">
			<AppenderRef ref="stdout"/>
			<AppenderRef ref="serverAccess"/>
			<AppenderRef ref="vifLogFile"/>
		</Logger>
    </Loggers>
```
with an appender that creates a rolling log file named `vif4j_access.log`:
```
    <Appenders>
		<RollingFile name="vifLogFile" fileName="${sys:com.wowza.wms.ConfigHome}/logs/vif4j_access.log" filePattern="${sys:com.wowza.wms.ConfigHome}/logs/vif4j_access.%d{yyyy-MM-dd}.log">
			<PatternLayout>
				<Header>#Version: 1.0\n#Start-Date: %d{yyyy-MM-dd HH:mm:ss zzz}\n#Software: ${sys:wse-software-version}\n#Date: %d{yyyy-MM-dd}\n#Fields: date\ttime\ttz\tx-event\tx-category\tx-severity\tx-status\tx-comment%n</Header>
				<Pattern>%d{yyyy-MM-dd}\t%d{HH:mm:ss}\t%d{z}\t%replace{%X{x-event}}{^$}{-}\t%replace{%X{x-category}}{^$}{-}\t%replace{%X{x-severity}}{^$}{-}\t%replace{%X{x-status}}{^$}{-}\t%replace{%X{x-comment}}{^$}{-}%n</Pattern>
				<AlwaysWriteExceptions>false</AlwaysWriteExceptions>
			</PatternLayout>
			<Policies>
				<TimeBasedTriggeringPolicy />
			</Policies>
			<DefaultRolloverStrategy>
				<Delete basePath="${sys:com.wowza.wms.ConfigHome}/logs" maxDepth="1">
					<IfLastModified age="5d" />
				</Delete>
			</DefaultRolloverStrategy>
		</RollingFile>
	</Appenders>
```
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

On-demand analysis is served by the v2 API alone — `/v2/vif/vod/files`, `/v2/vif/vod/jobs[/{jobId}[/cancel|/resume|/results|/results/file|/thumbnail]]`, and the two settings documents `/v2/vif/persist/vod-settings` and `/v2/vif/persist/secrets`. See [`api/README.md`](api/README.md) for the orientation and copy-paste examples, [`docs/VOD_GUIDE.md`](docs/VOD_GUIDE.md) for the walkthrough, and [`api/openapi.yaml`](api/openapi.yaml) for the reference.

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
