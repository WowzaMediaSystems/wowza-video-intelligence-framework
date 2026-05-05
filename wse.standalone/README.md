# WSE Video Intelligence Plugin
This folder contains the files required to install the WSE Video Intelligence Plugin on an existing install of WSE.

1. The following folders contain examples of the changes required for the WSE XML files and plugin configuration:
	* conf
	* lib
	* lib-native
	* manager
	* transcoder

2. Copy the contents of the `lib` folder (plugin JARs and 3rd party JARs) to the WSE `lib` directory. See [`docs/README.wse-plugin.md`](../docs/README.wse-plugin.md) for the full list of required JARs.

3. Copy `WMSManager.war` to the `manager/lib` directory of your WSE install. This replaces the WSE Manager UI with the VIF-enabled version.

4. Copy `conf/video-intelligence.json` to the WSE `conf` directory and configure it for your deployment. See [`docs/README.wse-plugin.md`](../docs/README.wse-plugin.md) for configuration reference.

5. Apply the required changes to `Server.xml` and `Application.xml`. See [`docs/README.wse-plugin.md`](../docs/README.wse-plugin.md) Install section for the full XML snippets (ServerListeners, Server Properties, Modules, ID3 properties, and transcoder template).
