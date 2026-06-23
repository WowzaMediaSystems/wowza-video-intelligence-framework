# WSE Video Intelligence Plugin
This folder contains the files required to install the WSE Video Intelligence Plugin on an existing install of WSE. 

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

If connecting to a remote instance (not localhost), update the `IPWhiteList` in `RESTInterface` in `Server.xml` so you can access the VIF REST API
```xml
<RESTInterface>
	<IPWhiteList>*</IPWhiteList>
```
If connecting to a remote instance (not localhost), in WSEM login with `Wowza Streaming Engine URL` = http://<ip_address>:8087

For Ubuntu/linux, you may need to install fonts for overlays to work correctly

```shell
apt-get install -y libfreetype6 fontconfig
```

> [!NOTE] 
> Restart WSE after installing fonts
