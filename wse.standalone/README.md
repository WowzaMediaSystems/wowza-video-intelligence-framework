# WSE Video Intelligence Plugin

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

## Manually updating Wowza Streaming Engine


The following folders contain examples of the changes required for the WSE XML files and plugin configuration:
* conf
* conf.modules
* lib
* lib-native
* manager
* transcoder

1. Copy files to local install of WSE
	```shell
	sudo cp -r wse.standalone/conf.modules /usr/local/WowzaStreamingEngine/
	sudo cp -r wse.standalone/lib/ /usr/local/WowzaStreamingEngine/
	sudo cp -r wse.standalone/lib-native/ /usr/local/WowzaStreamingEngine/
	sudo cp -r wse.standalone/transcoder /usr/local/WowzaStreamingEngine/
	```

2. Apply the required changes to `Server.xml` and `Application.xml`. See [`Server.xml`](../docs/README.wse-plugin.md#serverxml) and [`Application.xml`](../docs/README.wse-plugin.md#applicationxml) for the full XML snippets (ServerListeners, Server Properties, Application Modules, Application Properties, and Transcoder Templates).

3. Copy `WMSManager.war` to the `manager` and `manager/lib` directory of your WSE install. This replaces the WSE Manager UI with the VIF-enabled version.
	```shell
	sudo rm -r /usr/local/WowzaStreamingEngine/manager/temp
	sudo cp wse.standalone/WMSManager.war /usr/local/WowzaStreamingEngine/manager
	sudo cp wse.standalone/WMSManager.war /usr/local/WowzaStreamingEngine/manager/lib
	```
> [!NOTE]
> Restart WSEM after copying files

If connecting to a remote instance (not localhost), add the specific client IP(s) to the `IPWhiteList` in `RESTInterface` in `Server.xml` so you can access the VIF REST API. Use a comma-separated list of exact IPs (per-octet wildcards like `192.168.1.*` are supported); avoid `*`, which allows every source IP.
```xml
<RESTInterface>
	<IPWhiteList>127.0.0.1,203.0.113.10</IPWhiteList>
```
If connecting to a remote instance (not localhost), in WSEM login with `Wowza Streaming Engine URL` = http://<ip_address>:8087

For Ubuntu/linux, you may need to install fonts for overlays to work correctly

```shell
apt-get install -y libfreetype6 fontconfig
```

> [!NOTE] 
> Restart WSE after installing fonts
