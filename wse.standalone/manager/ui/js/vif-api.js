// Generated from api/openapi.yaml by api/sdk/generate.sh. Do not edit by hand.
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // api/sdk/build/gen/runtime.ts
  var BASE_PATH = "http://localhost:8087/v2/vif".replace(/\/+$/, "");
  var Configuration = class {
    constructor(configuration = {}) {
      this.configuration = configuration;
    }
    set config(configuration) {
      this.configuration = configuration;
    }
    get basePath() {
      return this.configuration.basePath != null ? this.configuration.basePath : BASE_PATH;
    }
    get fetchApi() {
      return this.configuration.fetchApi;
    }
    get middleware() {
      return this.configuration.middleware || [];
    }
    get queryParamsStringify() {
      return this.configuration.queryParamsStringify || querystring;
    }
    get username() {
      return this.configuration.username;
    }
    get password() {
      return this.configuration.password;
    }
    get apiKey() {
      const apiKey = this.configuration.apiKey;
      if (apiKey) {
        return typeof apiKey === "function" ? apiKey : () => apiKey;
      }
      return void 0;
    }
    get accessToken() {
      const accessToken = this.configuration.accessToken;
      if (accessToken) {
        return typeof accessToken === "function" ? accessToken : async () => accessToken;
      }
      return void 0;
    }
    get headers() {
      return this.configuration.headers;
    }
    get credentials() {
      return this.configuration.credentials;
    }
  };
  var DefaultConfig = new Configuration();
  var _BaseAPI = class _BaseAPI {
    constructor(configuration = DefaultConfig) {
      this.configuration = configuration;
      __publicField(this, "middleware");
      __publicField(this, "fetchApi", async (url, init) => {
        let fetchParams = { url, init };
        for (const middleware of this.middleware) {
          if (middleware.pre) {
            fetchParams = await middleware.pre(__spreadValues({
              fetch: this.fetchApi
            }, fetchParams)) || fetchParams;
          }
        }
        let response = void 0;
        try {
          response = await (this.configuration.fetchApi || fetch)(fetchParams.url, fetchParams.init);
        } catch (e) {
          for (const middleware of this.middleware) {
            if (middleware.onError) {
              response = await middleware.onError({
                fetch: this.fetchApi,
                url: fetchParams.url,
                init: fetchParams.init,
                error: e,
                response: response ? response.clone() : void 0
              }) || response;
            }
          }
          if (response === void 0) {
            if (e instanceof Error) {
              throw new FetchError(e, "The request failed and the interceptors did not return an alternative response");
            } else {
              throw e;
            }
          }
        }
        for (const middleware of this.middleware) {
          if (middleware.post) {
            response = await middleware.post({
              fetch: this.fetchApi,
              url: fetchParams.url,
              init: fetchParams.init,
              response: response.clone()
            }) || response;
          }
        }
        return response;
      });
      this.middleware = configuration.middleware;
    }
    withMiddleware(...middlewares) {
      const next = this.clone();
      next.middleware = next.middleware.concat(...middlewares);
      return next;
    }
    withPreMiddleware(...preMiddlewares) {
      const middlewares = preMiddlewares.map((pre) => ({ pre }));
      return this.withMiddleware(...middlewares);
    }
    withPostMiddleware(...postMiddlewares) {
      const middlewares = postMiddlewares.map((post) => ({ post }));
      return this.withMiddleware(...middlewares);
    }
    /**
     * Check if the given MIME is a JSON MIME.
     * JSON MIME examples:
     *   application/json
     *   application/json; charset=UTF8
     *   APPLICATION/JSON
     *   application/vnd.company+json
     * @param mime - MIME (Multipurpose Internet Mail Extensions)
     * @return True if the given MIME is JSON, false otherwise.
     */
    isJsonMime(mime) {
      if (!mime) {
        return false;
      }
      return _BaseAPI.jsonRegex.test(mime);
    }
    async request(context, initOverrides) {
      const { url, init } = await this.createFetchParams(context, initOverrides);
      const response = await this.fetchApi(url, init);
      if (response && (response.status >= 200 && response.status < 300)) {
        return response;
      }
      throw new ResponseError(response, "Response returned an error code");
    }
    async createFetchParams(context, initOverrides) {
      let url = this.configuration.basePath + context.path;
      if (context.query !== void 0 && Object.keys(context.query).length !== 0) {
        url += "?" + this.configuration.queryParamsStringify(context.query);
      }
      const headers = Object.assign({}, this.configuration.headers, context.headers);
      Object.keys(headers).forEach((key) => headers[key] === void 0 ? delete headers[key] : {});
      const initOverrideFn = typeof initOverrides === "function" ? initOverrides : async () => initOverrides;
      const initParams = {
        method: context.method,
        headers,
        body: context.body,
        credentials: this.configuration.credentials
      };
      const overriddenInit = __spreadValues(__spreadValues({}, initParams), await initOverrideFn({
        init: initParams,
        context
      }));
      let body;
      if (isFormData(overriddenInit.body) || overriddenInit.body instanceof URLSearchParams || isBlob(overriddenInit.body)) {
        body = overriddenInit.body;
      } else if (this.isJsonMime(headers["Content-Type"])) {
        body = JSON.stringify(overriddenInit.body);
      } else {
        body = overriddenInit.body;
      }
      const init = __spreadProps(__spreadValues({}, overriddenInit), {
        body
      });
      return { url, init };
    }
    /**
     * Create a shallow clone of `this` by constructing a new instance
     * and then shallow cloning data members.
     */
    clone() {
      const constructor = this.constructor;
      const next = new constructor(this.configuration);
      next.middleware = this.middleware.slice();
      return next;
    }
  };
  __publicField(_BaseAPI, "jsonRegex", new RegExp("^(:?application/json|[^;/ 	]+/[^;/ 	]+[+]json)[ 	]*(:?;.*)?$", "i"));
  var BaseAPI = _BaseAPI;
  function isBlob(value) {
    return typeof Blob !== "undefined" && value instanceof Blob;
  }
  function isFormData(value) {
    return typeof FormData !== "undefined" && value instanceof FormData;
  }
  var ResponseError = class extends Error {
    constructor(response, msg) {
      super(msg);
      this.response = response;
      __publicField(this, "name", "ResponseError");
    }
  };
  var FetchError = class extends Error {
    constructor(cause, msg) {
      super(msg);
      this.cause = cause;
      __publicField(this, "name", "FetchError");
    }
  };
  var RequiredError = class extends Error {
    constructor(field, msg) {
      super(msg);
      this.field = field;
      __publicField(this, "name", "RequiredError");
    }
  };
  function querystring(params, prefix = "") {
    return Object.keys(params).map((key) => querystringSingleKey(key, params[key], prefix)).filter((part) => part.length > 0).join("&");
  }
  function querystringSingleKey(key, value, keyPrefix = "") {
    const fullKey = keyPrefix + (keyPrefix.length ? `[${key}]` : key);
    if (value instanceof Array) {
      const multiValue = value.map((singleValue) => encodeURIComponent(String(singleValue))).join(`&${encodeURIComponent(fullKey)}=`);
      return `${encodeURIComponent(fullKey)}=${multiValue}`;
    }
    if (value instanceof Set) {
      const valueAsArray = Array.from(value);
      return querystringSingleKey(key, valueAsArray, keyPrefix);
    }
    if (value instanceof Date) {
      return `${encodeURIComponent(fullKey)}=${encodeURIComponent(value.toISOString())}`;
    }
    if (value instanceof Object) {
      return querystring(value, fullKey);
    }
    return `${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`;
  }
  function mapValues(data, fn) {
    return Object.keys(data).reduce(
      (acc, key) => __spreadProps(__spreadValues({}, acc), { [key]: fn(data[key]) }),
      {}
    );
  }
  var JSONApiResponse = class {
    constructor(raw, transformer = (jsonValue) => jsonValue) {
      this.raw = raw;
      this.transformer = transformer;
    }
    async value() {
      return this.transformer(await this.raw.json());
    }
  };
  var VoidApiResponse = class {
    constructor(raw) {
      this.raw = raw;
    }
    async value() {
      return void 0;
    }
  };
  var BlobApiResponse = class {
    constructor(raw) {
      this.raw = raw;
    }
    async value() {
      return await this.raw.blob();
    }
  };

  // api/sdk/build/gen/models/index.ts
  var models_exports = {};
  __export(models_exports, {
    BaselineConfigFromJSON: () => BaselineConfigFromJSON,
    BaselineConfigFromJSONTyped: () => BaselineConfigFromJSONTyped,
    BaselineConfigToJSON: () => BaselineConfigToJSON,
    BaselineConfigToJSONTyped: () => BaselineConfigToJSONTyped,
    ConfigFromJSON: () => ConfigFromJSON,
    ConfigFromJSONTyped: () => ConfigFromJSONTyped,
    ConfigToJSON: () => ConfigToJSON,
    ConfigToJSONTyped: () => ConfigToJSONTyped,
    CustomListenerFromJSON: () => CustomListenerFromJSON,
    CustomListenerFromJSONTyped: () => CustomListenerFromJSONTyped,
    CustomListenerToJSON: () => CustomListenerToJSON,
    CustomListenerToJSONTyped: () => CustomListenerToJSONTyped,
    DefaultConfigConcurrentExecutionsValueFromJSON: () => DefaultConfigConcurrentExecutionsValueFromJSON,
    DefaultConfigConcurrentExecutionsValueFromJSONTyped: () => DefaultConfigConcurrentExecutionsValueFromJSONTyped,
    DefaultConfigConcurrentExecutionsValueToJSON: () => DefaultConfigConcurrentExecutionsValueToJSON,
    DefaultConfigConcurrentExecutionsValueToJSONTyped: () => DefaultConfigConcurrentExecutionsValueToJSONTyped,
    DefaultConfigDetectorsFromJSON: () => DefaultConfigDetectorsFromJSON,
    DefaultConfigDetectorsFromJSONTyped: () => DefaultConfigDetectorsFromJSONTyped,
    DefaultConfigDetectorsToJSON: () => DefaultConfigDetectorsToJSON,
    DefaultConfigDetectorsToJSONTyped: () => DefaultConfigDetectorsToJSONTyped,
    DefaultConfigFromJSON: () => DefaultConfigFromJSON,
    DefaultConfigFromJSONTyped: () => DefaultConfigFromJSONTyped,
    DefaultConfigToJSON: () => DefaultConfigToJSON,
    DefaultConfigToJSONTyped: () => DefaultConfigToJSONTyped,
    DetectionModelFromJSON: () => DetectionModelFromJSON,
    DetectionModelFromJSONTyped: () => DetectionModelFromJSONTyped,
    DetectionModelToJSON: () => DetectionModelToJSON,
    DetectionModelToJSONTyped: () => DetectionModelToJSONTyped,
    DetectorFromJSON: () => DetectorFromJSON,
    DetectorFromJSONTyped: () => DetectorFromJSONTyped,
    DetectorToJSON: () => DetectorToJSON,
    DetectorToJSONTyped: () => DetectorToJSONTyped,
    DetectorType: () => DetectorType,
    DetectorTypeFromJSON: () => DetectorTypeFromJSON,
    DetectorTypeFromJSONTyped: () => DetectorTypeFromJSONTyped,
    DetectorTypeToJSON: () => DetectorTypeToJSON,
    DetectorTypeToJSONTyped: () => DetectorTypeToJSONTyped,
    DiagnosticsFromJSON: () => DiagnosticsFromJSON,
    DiagnosticsFromJSONTyped: () => DiagnosticsFromJSONTyped,
    DiagnosticsToJSON: () => DiagnosticsToJSON,
    DiagnosticsToJSONTyped: () => DiagnosticsToJSONTyped,
    GenerationParamsFromJSON: () => GenerationParamsFromJSON,
    GenerationParamsFromJSONTyped: () => GenerationParamsFromJSONTyped,
    GenerationParamsToJSON: () => GenerationParamsToJSON,
    GenerationParamsToJSONTyped: () => GenerationParamsToJSONTyped,
    GridFromJSON: () => GridFromJSON,
    GridFromJSONTyped: () => GridFromJSONTyped,
    GridToJSON: () => GridToJSON,
    GridToJSONTyped: () => GridToJSONTyped,
    HostStatsFromJSON: () => HostStatsFromJSON,
    HostStatsFromJSONTyped: () => HostStatsFromJSONTyped,
    HostStatsGpuFromJSON: () => HostStatsGpuFromJSON,
    HostStatsGpuFromJSONTyped: () => HostStatsGpuFromJSONTyped,
    HostStatsGpuToJSON: () => HostStatsGpuToJSON,
    HostStatsGpuToJSONTyped: () => HostStatsGpuToJSONTyped,
    HostStatsToJSON: () => HostStatsToJSON,
    HostStatsToJSONTyped: () => HostStatsToJSONTyped,
    Id3ListenerFromJSON: () => Id3ListenerFromJSON,
    Id3ListenerFromJSONTyped: () => Id3ListenerFromJSONTyped,
    Id3ListenerToJSON: () => Id3ListenerToJSON,
    Id3ListenerToJSONTyped: () => Id3ListenerToJSONTyped,
    ListenerFromJSON: () => ListenerFromJSON,
    ListenerFromJSONTyped: () => ListenerFromJSONTyped,
    ListenerToJSON: () => ListenerToJSON,
    ListenerToJSONTyped: () => ListenerToJSONTyped,
    ListenerTriggerEnum: () => ListenerTriggerEnum,
    ListenerTypeEnum: () => ListenerTypeEnum,
    ListenerTypeFromJSON: () => ListenerTypeFromJSON,
    ListenerTypeFromJSONTyped: () => ListenerTypeFromJSONTyped,
    ListenerTypeToJSON: () => ListenerTypeToJSON,
    ListenerTypeToJSONTyped: () => ListenerTypeToJSONTyped,
    LogListenerFromJSON: () => LogListenerFromJSON,
    LogListenerFromJSONTyped: () => LogListenerFromJSONTyped,
    LogListenerToJSON: () => LogListenerToJSON,
    LogListenerToJSONTyped: () => LogListenerToJSONTyped,
    ModelCatalogFromJSON: () => ModelCatalogFromJSON,
    ModelCatalogFromJSONTyped: () => ModelCatalogFromJSONTyped,
    ModelCatalogToJSON: () => ModelCatalogToJSON,
    ModelCatalogToJSONTyped: () => ModelCatalogToJSONTyped,
    ObjectDetectorFromJSON: () => ObjectDetectorFromJSON,
    ObjectDetectorFromJSONTyped: () => ObjectDetectorFromJSONTyped,
    ObjectDetectorModelEnum: () => ObjectDetectorModelEnum,
    ObjectDetectorToJSON: () => ObjectDetectorToJSON,
    ObjectDetectorToJSONTyped: () => ObjectDetectorToJSONTyped,
    OverlayListenerFromJSON: () => OverlayListenerFromJSON,
    OverlayListenerFromJSONTyped: () => OverlayListenerFromJSONTyped,
    OverlayListenerToJSON: () => OverlayListenerToJSON,
    OverlayListenerToJSONTyped: () => OverlayListenerToJSONTyped,
    PerformanceFromJSON: () => PerformanceFromJSON,
    PerformanceFromJSONTyped: () => PerformanceFromJSONTyped,
    PerformanceToJSON: () => PerformanceToJSON,
    PerformanceToJSONTyped: () => PerformanceToJSONTyped,
    ProblemFromJSON: () => ProblemFromJSON,
    ProblemFromJSONTyped: () => ProblemFromJSONTyped,
    ProblemToJSON: () => ProblemToJSON,
    ProblemToJSONTyped: () => ProblemToJSONTyped,
    ProcessingCatchUpFromJSON: () => ProcessingCatchUpFromJSON,
    ProcessingCatchUpFromJSONTyped: () => ProcessingCatchUpFromJSONTyped,
    ProcessingCatchUpToJSON: () => ProcessingCatchUpToJSON,
    ProcessingCatchUpToJSONTyped: () => ProcessingCatchUpToJSONTyped,
    ProcessingFrameSourceEnum: () => ProcessingFrameSourceEnum,
    ProcessingFromJSON: () => ProcessingFromJSON,
    ProcessingFromJSONTyped: () => ProcessingFromJSONTyped,
    ProcessingToJSON: () => ProcessingToJSON,
    ProcessingToJSONTyped: () => ProcessingToJSONTyped,
    PromptFromJSON: () => PromptFromJSON,
    PromptFromJSONTyped: () => PromptFromJSONTyped,
    PromptToJSON: () => PromptToJSON,
    PromptToJSONTyped: () => PromptToJSONTyped,
    SceneBaselineFromJSON: () => SceneBaselineFromJSON,
    SceneBaselineFromJSONTyped: () => SceneBaselineFromJSONTyped,
    SceneBaselineSetEnum: () => SceneBaselineSetEnum,
    SceneBaselineToJSON: () => SceneBaselineToJSON,
    SceneBaselineToJSONTyped: () => SceneBaselineToJSONTyped,
    SceneDetectorFromJSON: () => SceneDetectorFromJSON,
    SceneDetectorFromJSONTyped: () => SceneDetectorFromJSONTyped,
    SceneDetectorToJSON: () => SceneDetectorToJSON,
    SceneDetectorToJSONTyped: () => SceneDetectorToJSONTyped,
    SecretsFromJSON: () => SecretsFromJSON,
    SecretsFromJSONTyped: () => SecretsFromJSONTyped,
    SecretsToJSON: () => SecretsToJSON,
    SecretsToJSONTyped: () => SecretsToJSONTyped,
    ServerStatusFromJSON: () => ServerStatusFromJSON,
    ServerStatusFromJSONTyped: () => ServerStatusFromJSONTyped,
    ServerStatusToJSON: () => ServerStatusToJSON,
    ServerStatusToJSONTyped: () => ServerStatusToJSONTyped,
    ServiceBindingFromJSON: () => ServiceBindingFromJSON,
    ServiceBindingFromJSONTyped: () => ServiceBindingFromJSONTyped,
    ServiceBindingToJSON: () => ServiceBindingToJSON,
    ServiceBindingToJSONTyped: () => ServiceBindingToJSONTyped,
    StreamConfigOverrideFromJSON: () => StreamConfigOverrideFromJSON,
    StreamConfigOverrideFromJSONTyped: () => StreamConfigOverrideFromJSONTyped,
    StreamConfigOverrideToJSON: () => StreamConfigOverrideToJSON,
    StreamConfigOverrideToJSONTyped: () => StreamConfigOverrideToJSONTyped,
    StreamFromJSON: () => StreamFromJSON,
    StreamFromJSONTyped: () => StreamFromJSONTyped,
    StreamGroupConfigFromJSON: () => StreamGroupConfigFromJSON,
    StreamGroupConfigFromJSONTyped: () => StreamGroupConfigFromJSONTyped,
    StreamGroupConfigMatchFromJSON: () => StreamGroupConfigMatchFromJSON,
    StreamGroupConfigMatchFromJSONTyped: () => StreamGroupConfigMatchFromJSONTyped,
    StreamGroupConfigMatchToJSON: () => StreamGroupConfigMatchToJSON,
    StreamGroupConfigMatchToJSONTyped: () => StreamGroupConfigMatchToJSONTyped,
    StreamGroupConfigToJSON: () => StreamGroupConfigToJSON,
    StreamGroupConfigToJSONTyped: () => StreamGroupConfigToJSONTyped,
    StreamSettingsFromJSON: () => StreamSettingsFromJSON,
    StreamSettingsFromJSONTyped: () => StreamSettingsFromJSONTyped,
    StreamSettingsToJSON: () => StreamSettingsToJSON,
    StreamSettingsToJSONTyped: () => StreamSettingsToJSONTyped,
    StreamStateFromJSON: () => StreamStateFromJSON,
    StreamStateFromJSONTyped: () => StreamStateFromJSONTyped,
    StreamStateToJSON: () => StreamStateToJSON,
    StreamStateToJSONTyped: () => StreamStateToJSONTyped,
    StreamToJSON: () => StreamToJSON,
    StreamToJSONTyped: () => StreamToJSONTyped,
    SvdEndpointFromJSON: () => SvdEndpointFromJSON,
    SvdEndpointFromJSONTyped: () => SvdEndpointFromJSONTyped,
    SvdEndpointTlsFromJSON: () => SvdEndpointTlsFromJSON,
    SvdEndpointTlsFromJSONTyped: () => SvdEndpointTlsFromJSONTyped,
    SvdEndpointTlsToJSON: () => SvdEndpointTlsToJSON,
    SvdEndpointTlsToJSONTyped: () => SvdEndpointTlsToJSONTyped,
    SvdEndpointToJSON: () => SvdEndpointToJSON,
    SvdEndpointToJSONTyped: () => SvdEndpointToJSONTyped,
    SyntheticDetectorFromJSON: () => SyntheticDetectorFromJSON,
    SyntheticDetectorFromJSONTyped: () => SyntheticDetectorFromJSONTyped,
    SyntheticDetectorToJSON: () => SyntheticDetectorToJSON,
    SyntheticDetectorToJSONTyped: () => SyntheticDetectorToJSONTyped,
    TilingFromJSON: () => TilingFromJSON,
    TilingFromJSONTyped: () => TilingFromJSONTyped,
    TilingModeEnum: () => TilingModeEnum,
    TilingToJSON: () => TilingToJSON,
    TilingToJSONTyped: () => TilingToJSONTyped,
    TrackingFromJSON: () => TrackingFromJSON,
    TrackingFromJSONTyped: () => TrackingFromJSONTyped,
    TrackingMethodEnum: () => TrackingMethodEnum,
    TrackingToJSON: () => TrackingToJSON,
    TrackingToJSONTyped: () => TrackingToJSONTyped,
    VideoInfoFromJSON: () => VideoInfoFromJSON,
    VideoInfoFromJSONTyped: () => VideoInfoFromJSONTyped,
    VideoInfoToJSON: () => VideoInfoToJSON,
    VideoInfoToJSONTyped: () => VideoInfoToJSONTyped,
    VisInstanceStatusFromJSON: () => VisInstanceStatusFromJSON,
    VisInstanceStatusFromJSONTyped: () => VisInstanceStatusFromJSONTyped,
    VisInstanceStatusGpusInnerFromJSON: () => VisInstanceStatusGpusInnerFromJSON,
    VisInstanceStatusGpusInnerFromJSONTyped: () => VisInstanceStatusGpusInnerFromJSONTyped,
    VisInstanceStatusGpusInnerToJSON: () => VisInstanceStatusGpusInnerToJSON,
    VisInstanceStatusGpusInnerToJSONTyped: () => VisInstanceStatusGpusInnerToJSONTyped,
    VisInstanceStatusToJSON: () => VisInstanceStatusToJSON,
    VisInstanceStatusToJSONTyped: () => VisInstanceStatusToJSONTyped,
    VlmCustomSettingsFromJSON: () => VlmCustomSettingsFromJSON,
    VlmCustomSettingsFromJSONTyped: () => VlmCustomSettingsFromJSONTyped,
    VlmCustomSettingsToJSON: () => VlmCustomSettingsToJSON,
    VlmCustomSettingsToJSONTyped: () => VlmCustomSettingsToJSONTyped,
    VlmDetectSettingsFromJSON: () => VlmDetectSettingsFromJSON,
    VlmDetectSettingsFromJSONTyped: () => VlmDetectSettingsFromJSONTyped,
    VlmDetectSettingsReasoningLevelEnum: () => VlmDetectSettingsReasoningLevelEnum,
    VlmDetectSettingsToJSON: () => VlmDetectSettingsToJSON,
    VlmDetectSettingsToJSONTyped: () => VlmDetectSettingsToJSONTyped,
    VlmDetectorFromJSON: () => VlmDetectorFromJSON,
    VlmDetectorFromJSONTyped: () => VlmDetectorFromJSONTyped,
    VlmDetectorModeEnum: () => VlmDetectorModeEnum,
    VlmDetectorToJSON: () => VlmDetectorToJSON,
    VlmDetectorToJSONTyped: () => VlmDetectorToJSONTyped,
    VlmEndpointFromJSON: () => VlmEndpointFromJSON,
    VlmEndpointFromJSONTyped: () => VlmEndpointFromJSONTyped,
    VlmEndpointProbeRequestFromJSON: () => VlmEndpointProbeRequestFromJSON,
    VlmEndpointProbeRequestFromJSONTyped: () => VlmEndpointProbeRequestFromJSONTyped,
    VlmEndpointProbeRequestToJSON: () => VlmEndpointProbeRequestToJSON,
    VlmEndpointProbeRequestToJSONTyped: () => VlmEndpointProbeRequestToJSONTyped,
    VlmEndpointProbeResultFromJSON: () => VlmEndpointProbeResultFromJSON,
    VlmEndpointProbeResultFromJSONTyped: () => VlmEndpointProbeResultFromJSONTyped,
    VlmEndpointProbeResultToJSON: () => VlmEndpointProbeResultToJSON,
    VlmEndpointProbeResultToJSONTyped: () => VlmEndpointProbeResultToJSONTyped,
    VlmEndpointToJSON: () => VlmEndpointToJSON,
    VlmEndpointToJSONTyped: () => VlmEndpointToJSONTyped,
    VodFailureCause: () => VodFailureCause,
    VodFailureCauseFromJSON: () => VodFailureCauseFromJSON,
    VodFailureCauseFromJSONTyped: () => VodFailureCauseFromJSONTyped,
    VodFailureCauseToJSON: () => VodFailureCauseToJSON,
    VodFailureCauseToJSONTyped: () => VodFailureCauseToJSONTyped,
    VodFileFromJSON: () => VodFileFromJSON,
    VodFileFromJSONTyped: () => VodFileFromJSONTyped,
    VodFileListFromJSON: () => VodFileListFromJSON,
    VodFileListFromJSONTyped: () => VodFileListFromJSONTyped,
    VodFileListToJSON: () => VodFileListToJSON,
    VodFileListToJSONTyped: () => VodFileListToJSONTyped,
    VodFileToJSON: () => VodFileToJSON,
    VodFileToJSONTyped: () => VodFileToJSONTyped,
    VodJobFromJSON: () => VodJobFromJSON,
    VodJobFromJSONTyped: () => VodJobFromJSONTyped,
    VodJobPageFromJSON: () => VodJobPageFromJSON,
    VodJobPageFromJSONTyped: () => VodJobPageFromJSONTyped,
    VodJobPageToJSON: () => VodJobPageToJSON,
    VodJobPageToJSONTyped: () => VodJobPageToJSONTyped,
    VodJobRequestFromJSON: () => VodJobRequestFromJSON,
    VodJobRequestFromJSONTyped: () => VodJobRequestFromJSONTyped,
    VodJobRequestToJSON: () => VodJobRequestToJSON,
    VodJobRequestToJSONTyped: () => VodJobRequestToJSONTyped,
    VodJobResumeRequestFromJSON: () => VodJobResumeRequestFromJSON,
    VodJobResumeRequestFromJSONTyped: () => VodJobResumeRequestFromJSONTyped,
    VodJobResumeRequestToJSON: () => VodJobResumeRequestToJSON,
    VodJobResumeRequestToJSONTyped: () => VodJobResumeRequestToJSONTyped,
    VodJobState: () => VodJobState,
    VodJobStateFromJSON: () => VodJobStateFromJSON,
    VodJobStateFromJSONTyped: () => VodJobStateFromJSONTyped,
    VodJobStateToJSON: () => VodJobStateToJSON,
    VodJobStateToJSONTyped: () => VodJobStateToJSONTyped,
    VodJobToJSON: () => VodJobToJSON,
    VodJobToJSONTyped: () => VodJobToJSONTyped,
    VodResultsPageFromJSON: () => VodResultsPageFromJSON,
    VodResultsPageFromJSONTyped: () => VodResultsPageFromJSONTyped,
    VodResultsPageToJSON: () => VodResultsPageToJSON,
    VodResultsPageToJSONTyped: () => VodResultsPageToJSONTyped,
    VodSettingsFromJSON: () => VodSettingsFromJSON,
    VodSettingsFromJSONTyped: () => VodSettingsFromJSONTyped,
    VodSettingsToJSON: () => VodSettingsToJSON,
    VodSettingsToJSONTyped: () => VodSettingsToJSONTyped,
    WebhookListenerFromJSON: () => WebhookListenerFromJSON,
    WebhookListenerFromJSONTyped: () => WebhookListenerFromJSONTyped,
    WebhookListenerToJSON: () => WebhookListenerToJSON,
    WebhookListenerToJSONTyped: () => WebhookListenerToJSONTyped,
    instanceOfBaselineConfig: () => instanceOfBaselineConfig,
    instanceOfConfig: () => instanceOfConfig,
    instanceOfCustomListener: () => instanceOfCustomListener,
    instanceOfDefaultConfig: () => instanceOfDefaultConfig,
    instanceOfDefaultConfigConcurrentExecutionsValue: () => instanceOfDefaultConfigConcurrentExecutionsValue,
    instanceOfDefaultConfigDetectors: () => instanceOfDefaultConfigDetectors,
    instanceOfDetectionModel: () => instanceOfDetectionModel,
    instanceOfDetector: () => instanceOfDetector,
    instanceOfDetectorType: () => instanceOfDetectorType,
    instanceOfDiagnostics: () => instanceOfDiagnostics,
    instanceOfGenerationParams: () => instanceOfGenerationParams,
    instanceOfGrid: () => instanceOfGrid,
    instanceOfHostStats: () => instanceOfHostStats,
    instanceOfHostStatsGpu: () => instanceOfHostStatsGpu,
    instanceOfId3Listener: () => instanceOfId3Listener,
    instanceOfListener: () => instanceOfListener,
    instanceOfListenerType: () => instanceOfListenerType,
    instanceOfLogListener: () => instanceOfLogListener,
    instanceOfModelCatalog: () => instanceOfModelCatalog,
    instanceOfObjectDetector: () => instanceOfObjectDetector,
    instanceOfOverlayListener: () => instanceOfOverlayListener,
    instanceOfPerformance: () => instanceOfPerformance,
    instanceOfProblem: () => instanceOfProblem,
    instanceOfProcessing: () => instanceOfProcessing,
    instanceOfProcessingCatchUp: () => instanceOfProcessingCatchUp,
    instanceOfPrompt: () => instanceOfPrompt,
    instanceOfSceneBaseline: () => instanceOfSceneBaseline,
    instanceOfSceneDetector: () => instanceOfSceneDetector,
    instanceOfSecrets: () => instanceOfSecrets,
    instanceOfServerStatus: () => instanceOfServerStatus,
    instanceOfServiceBinding: () => instanceOfServiceBinding,
    instanceOfStream: () => instanceOfStream,
    instanceOfStreamConfigOverride: () => instanceOfStreamConfigOverride,
    instanceOfStreamGroupConfig: () => instanceOfStreamGroupConfig,
    instanceOfStreamGroupConfigMatch: () => instanceOfStreamGroupConfigMatch,
    instanceOfStreamSettings: () => instanceOfStreamSettings,
    instanceOfStreamState: () => instanceOfStreamState,
    instanceOfSvdEndpoint: () => instanceOfSvdEndpoint,
    instanceOfSvdEndpointTls: () => instanceOfSvdEndpointTls,
    instanceOfSyntheticDetector: () => instanceOfSyntheticDetector,
    instanceOfTiling: () => instanceOfTiling,
    instanceOfTracking: () => instanceOfTracking,
    instanceOfVideoInfo: () => instanceOfVideoInfo,
    instanceOfVisInstanceStatus: () => instanceOfVisInstanceStatus,
    instanceOfVisInstanceStatusGpusInner: () => instanceOfVisInstanceStatusGpusInner,
    instanceOfVlmCustomSettings: () => instanceOfVlmCustomSettings,
    instanceOfVlmDetectSettings: () => instanceOfVlmDetectSettings,
    instanceOfVlmDetector: () => instanceOfVlmDetector,
    instanceOfVlmEndpoint: () => instanceOfVlmEndpoint,
    instanceOfVlmEndpointProbeRequest: () => instanceOfVlmEndpointProbeRequest,
    instanceOfVlmEndpointProbeResult: () => instanceOfVlmEndpointProbeResult,
    instanceOfVodFailureCause: () => instanceOfVodFailureCause,
    instanceOfVodFile: () => instanceOfVodFile,
    instanceOfVodFileList: () => instanceOfVodFileList,
    instanceOfVodJob: () => instanceOfVodJob,
    instanceOfVodJobPage: () => instanceOfVodJobPage,
    instanceOfVodJobRequest: () => instanceOfVodJobRequest,
    instanceOfVodJobResumeRequest: () => instanceOfVodJobResumeRequest,
    instanceOfVodJobState: () => instanceOfVodJobState,
    instanceOfVodResultsPage: () => instanceOfVodResultsPage,
    instanceOfVodSettings: () => instanceOfVodSettings,
    instanceOfWebhookListener: () => instanceOfWebhookListener
  });

  // api/sdk/build/gen/models/ServiceBinding.ts
  function instanceOfServiceBinding(value) {
    return true;
  }
  function ServiceBindingFromJSON(json) {
    return ServiceBindingFromJSONTyped(json, false);
  }
  function ServiceBindingFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "url": json["url"] == null ? void 0 : json["url"],
      "apiKey": json["api_key"] == null ? void 0 : json["api_key"],
      "modelIdleTimeoutSeconds": json["model_idle_timeout_seconds"] == null ? void 0 : json["model_idle_timeout_seconds"]
    };
  }
  function ServiceBindingToJSON(json) {
    return ServiceBindingToJSONTyped(json, false);
  }
  function ServiceBindingToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "url": value["url"],
      "api_key": value["apiKey"],
      "model_idle_timeout_seconds": value["modelIdleTimeoutSeconds"]
    };
  }

  // api/sdk/build/gen/models/CustomListener.ts
  function instanceOfCustomListener(value) {
    if (!("className" in value) || value["className"] === void 0) return false;
    return true;
  }
  function CustomListenerFromJSON(json) {
    return CustomListenerFromJSONTyped(json, false);
  }
  function CustomListenerFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, ListenerFromJSONTyped(json, true)), {
      "className": json["class_name"],
      "properties": json["properties"] == null ? void 0 : json["properties"]
    });
  }
  function CustomListenerToJSON(json) {
    return CustomListenerToJSONTyped(json, false);
  }
  function CustomListenerToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, ListenerToJSONTyped(value, true)), {
      "class_name": value["className"],
      "properties": value["properties"]
    });
  }

  // api/sdk/build/gen/models/Id3Listener.ts
  function instanceOfId3Listener(value) {
    return true;
  }
  function Id3ListenerFromJSON(json) {
    return Id3ListenerFromJSONTyped(json, false);
  }
  function Id3ListenerFromJSONTyped(json, ignoreDiscriminator) {
    return ListenerFromJSONTyped(json, true);
  }
  function Id3ListenerToJSON(json) {
    return Id3ListenerToJSONTyped(json, false);
  }
  function Id3ListenerToJSONTyped(value, ignoreDiscriminator = false) {
    return ListenerToJSONTyped(value, true);
  }

  // api/sdk/build/gen/models/LogListener.ts
  function instanceOfLogListener(value) {
    return true;
  }
  function LogListenerFromJSON(json) {
    return LogListenerFromJSONTyped(json, false);
  }
  function LogListenerFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, ListenerFromJSONTyped(json, true)), {
      "fileName": json["file_name"] == null ? void 0 : json["file_name"],
      "filePath": json["file_path"] == null ? void 0 : json["file_path"]
    });
  }
  function LogListenerToJSON(json) {
    return LogListenerToJSONTyped(json, false);
  }
  function LogListenerToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, ListenerToJSONTyped(value, true)), {
      "file_name": value["fileName"],
      "file_path": value["filePath"]
    });
  }

  // api/sdk/build/gen/models/OverlayListener.ts
  function instanceOfOverlayListener(value) {
    return true;
  }
  function OverlayListenerFromJSON(json) {
    return OverlayListenerFromJSONTyped(json, false);
  }
  function OverlayListenerFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, ListenerFromJSONTyped(json, true)), {
      "width": json["width"] == null ? void 0 : json["width"],
      "height": json["height"] == null ? void 0 : json["height"],
      "frameRate": json["frame_rate"] == null ? void 0 : json["frame_rate"],
      "overlayDelay": json["overlay_delay"] == null ? void 0 : json["overlay_delay"],
      "fadeStep": json["fade_step"] == null ? void 0 : json["fade_step"],
      "jitter": json["jitter"] == null ? void 0 : json["jitter"],
      "replaceVideo": json["replace_video"] == null ? void 0 : json["replace_video"],
      "showStats": json["show_stats"] == null ? void 0 : json["show_stats"],
      "debugString": json["debug_string"] == null ? void 0 : json["debug_string"]
    });
  }
  function OverlayListenerToJSON(json) {
    return OverlayListenerToJSONTyped(json, false);
  }
  function OverlayListenerToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, ListenerToJSONTyped(value, true)), {
      "width": value["width"],
      "height": value["height"],
      "frame_rate": value["frameRate"],
      "overlay_delay": value["overlayDelay"],
      "fade_step": value["fadeStep"],
      "jitter": value["jitter"],
      "replace_video": value["replaceVideo"],
      "show_stats": value["showStats"],
      "debug_string": value["debugString"]
    });
  }

  // api/sdk/build/gen/models/WebhookListener.ts
  function instanceOfWebhookListener(value) {
    return true;
  }
  function WebhookListenerFromJSON(json) {
    return WebhookListenerFromJSONTyped(json, false);
  }
  function WebhookListenerFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, ListenerFromJSONTyped(json, true)), {
      "url": json["url"] == null ? void 0 : json["url"]
    });
  }
  function WebhookListenerToJSON(json) {
    return WebhookListenerToJSONTyped(json, false);
  }
  function WebhookListenerToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, ListenerToJSONTyped(value, true)), {
      "url": value["url"]
    });
  }

  // api/sdk/build/gen/models/Listener.ts
  var ListenerTypeEnum = {
    Overlay: "overlay",
    Webhook: "webhook",
    Id3: "id3",
    Log: "log",
    Custom: "custom"
  };
  var ListenerTriggerEnum = {
    Immediate: "immediate",
    Batch: "batch",
    Rollup: "rollup"
  };
  function instanceOfListener(value) {
    if (!("type" in value) || value["type"] === void 0) return false;
    return true;
  }
  function ListenerFromJSON(json) {
    return ListenerFromJSONTyped(json, false);
  }
  function ListenerFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    if (!ignoreDiscriminator) {
      if (json["type"] === "custom") {
        return CustomListenerFromJSONTyped(json, ignoreDiscriminator);
      }
      if (json["type"] === "id3") {
        return Id3ListenerFromJSONTyped(json, ignoreDiscriminator);
      }
      if (json["type"] === "log") {
        return LogListenerFromJSONTyped(json, ignoreDiscriminator);
      }
      if (json["type"] === "overlay") {
        return OverlayListenerFromJSONTyped(json, ignoreDiscriminator);
      }
      if (json["type"] === "webhook") {
        return WebhookListenerFromJSONTyped(json, ignoreDiscriminator);
      }
    }
    return {
      "type": json["type"],
      "name": json["name"] == null ? void 0 : json["name"],
      "enabled": json["enabled"] == null ? void 0 : json["enabled"],
      "trigger": json["trigger"] == null ? void 0 : json["trigger"],
      "minConfidence": json["min_confidence"] == null ? void 0 : json["min_confidence"],
      "suppressEmpty": json["suppress_empty"] == null ? void 0 : json["suppress_empty"],
      "etag": json["etag"] == null ? void 0 : json["etag"]
    };
  }
  function ListenerToJSON(json) {
    return ListenerToJSONTyped(json, false);
  }
  function ListenerToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    if (!ignoreDiscriminator) {
      switch (value["type"]) {
        case "custom":
          return CustomListenerToJSONTyped(value, ignoreDiscriminator);
        case "id3":
          return Id3ListenerToJSONTyped(value, ignoreDiscriminator);
        case "log":
          return LogListenerToJSONTyped(value, ignoreDiscriminator);
        case "overlay":
          return OverlayListenerToJSONTyped(value, ignoreDiscriminator);
        case "webhook":
          return WebhookListenerToJSONTyped(value, ignoreDiscriminator);
        default:
          throw new Error(`No variant of Listener exists with 'type=${value["type"]}'`);
      }
    }
    return {
      "type": value["type"],
      "name": value["name"],
      "enabled": value["enabled"],
      "trigger": value["trigger"],
      "min_confidence": value["minConfidence"],
      "suppress_empty": value["suppressEmpty"],
      "etag": value["etag"]
    };
  }

  // api/sdk/build/gen/models/Diagnostics.ts
  function instanceOfDiagnostics(value) {
    return true;
  }
  function DiagnosticsFromJSON(json) {
    return DiagnosticsFromJSONTyped(json, false);
  }
  function DiagnosticsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "saveImages": json["save_images"] == null ? void 0 : json["save_images"],
      "timingLogSeconds": json["timing_log_seconds"] == null ? void 0 : json["timing_log_seconds"],
      "maxLoggedMessages": json["max_logged_messages"] == null ? void 0 : json["max_logged_messages"]
    };
  }
  function DiagnosticsToJSON(json) {
    return DiagnosticsToJSONTyped(json, false);
  }
  function DiagnosticsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "save_images": value["saveImages"],
      "timing_log_seconds": value["timingLogSeconds"],
      "max_logged_messages": value["maxLoggedMessages"]
    };
  }

  // api/sdk/build/gen/models/ProcessingCatchUp.ts
  function instanceOfProcessingCatchUp(value) {
    return true;
  }
  function ProcessingCatchUpFromJSON(json) {
    return ProcessingCatchUpFromJSONTyped(json, false);
  }
  function ProcessingCatchUpFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "enabled": json["enabled"] == null ? void 0 : json["enabled"],
      "maxBehindSeconds": json["max_behind_seconds"] == null ? void 0 : json["max_behind_seconds"]
    };
  }
  function ProcessingCatchUpToJSON(json) {
    return ProcessingCatchUpToJSONTyped(json, false);
  }
  function ProcessingCatchUpToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "enabled": value["enabled"],
      "max_behind_seconds": value["maxBehindSeconds"]
    };
  }

  // api/sdk/build/gen/models/Processing.ts
  var ProcessingFrameSourceEnum = {
    Transcoder: "transcoder",
    Grab: "grab"
  };
  function instanceOfProcessing(value) {
    return true;
  }
  function ProcessingFromJSON(json) {
    return ProcessingFromJSONTyped(json, false);
  }
  function ProcessingFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "inferenceFps": json["inference_fps"] == null ? void 0 : json["inference_fps"],
      "windowSeconds": json["window_seconds"] == null ? void 0 : json["window_seconds"],
      "videoHeight": json["video_height"] == null ? void 0 : json["video_height"],
      "grayscale": json["grayscale"] == null ? void 0 : json["grayscale"],
      "frameSource": json["frame_source"] == null ? void 0 : json["frame_source"],
      "grabIntervalSeconds": json["grab_interval_seconds"] == null ? void 0 : json["grab_interval_seconds"],
      "bufferFrames": json["buffer_frames"] == null ? void 0 : json["buffer_frames"],
      "autoThrottle": json["auto_throttle"] == null ? void 0 : json["auto_throttle"],
      "catchUp": json["catch_up"] == null ? void 0 : ProcessingCatchUpFromJSON(json["catch_up"]),
      "rollupIntervalSeconds": json["rollup_interval_seconds"] == null ? void 0 : json["rollup_interval_seconds"],
      "gpuIds": json["gpu_ids"] == null ? void 0 : json["gpu_ids"]
    };
  }
  function ProcessingToJSON(json) {
    return ProcessingToJSONTyped(json, false);
  }
  function ProcessingToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "inference_fps": value["inferenceFps"],
      "window_seconds": value["windowSeconds"],
      "video_height": value["videoHeight"],
      "grayscale": value["grayscale"],
      "frame_source": value["frameSource"],
      "grab_interval_seconds": value["grabIntervalSeconds"],
      "buffer_frames": value["bufferFrames"],
      "auto_throttle": value["autoThrottle"],
      "catch_up": ProcessingCatchUpToJSON(value["catchUp"]),
      "rollup_interval_seconds": value["rollupIntervalSeconds"],
      "gpu_ids": value["gpuIds"]
    };
  }

  // api/sdk/build/gen/models/BaselineConfig.ts
  function instanceOfBaselineConfig(value) {
    return true;
  }
  function BaselineConfigFromJSON(json) {
    return BaselineConfigFromJSONTyped(json, false);
  }
  function BaselineConfigFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "active": json["active"] == null ? void 0 : json["active"],
      "listeners": json["listeners"] == null ? void 0 : mapValues(json["listeners"], ListenerFromJSON),
      "processing": json["processing"] == null ? void 0 : ProcessingFromJSON(json["processing"]),
      "service": json["service"] == null ? void 0 : ServiceBindingFromJSON(json["service"]),
      "diagnostics": json["diagnostics"] == null ? void 0 : DiagnosticsFromJSON(json["diagnostics"])
    };
  }
  function BaselineConfigToJSON(json) {
    return BaselineConfigToJSONTyped(json, false);
  }
  function BaselineConfigToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "active": value["active"],
      "listeners": value["listeners"] == null ? void 0 : mapValues(value["listeners"], ListenerToJSON),
      "processing": ProcessingToJSON(value["processing"]),
      "service": ServiceBindingToJSON(value["service"]),
      "diagnostics": DiagnosticsToJSON(value["diagnostics"])
    };
  }

  // api/sdk/build/gen/models/DetectorType.ts
  var DetectorType = {
    Scene: "scene",
    Object: "object",
    Vlm: "vlm",
    Synthetic: "synthetic"
  };
  function instanceOfDetectorType(value) {
    for (const key in DetectorType) {
      if (Object.prototype.hasOwnProperty.call(DetectorType, key)) {
        if (DetectorType[key] === value) {
          return true;
        }
      }
    }
    return false;
  }
  function DetectorTypeFromJSON(json) {
    return DetectorTypeFromJSONTyped(json, false);
  }
  function DetectorTypeFromJSONTyped(json, ignoreDiscriminator) {
    return json;
  }
  function DetectorTypeToJSON(value) {
    return value;
  }
  function DetectorTypeToJSONTyped(value, ignoreDiscriminator) {
    return value;
  }

  // api/sdk/build/gen/models/Tracking.ts
  var TrackingMethodEnum = {
    ByteTrack: "byte-track",
    None: "none"
  };
  function instanceOfTracking(value) {
    if (!("method" in value) || value["method"] === void 0) return false;
    return true;
  }
  function TrackingFromJSON(json) {
    return TrackingFromJSONTyped(json, false);
  }
  function TrackingFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "method": json["method"],
      "minConfidenceToCreate": json["min_confidence_to_create"] == null ? void 0 : json["min_confidence_to_create"],
      "minConsecutiveFrames": json["min_consecutive_frames"] == null ? void 0 : json["min_consecutive_frames"],
      "minOverlap": json["min_overlap"] == null ? void 0 : json["min_overlap"],
      "maxLostFrames": json["max_lost_frames"] == null ? void 0 : json["max_lost_frames"],
      "ignoreUntracked": json["ignore_untracked"] == null ? void 0 : json["ignore_untracked"]
    };
  }
  function TrackingToJSON(json) {
    return TrackingToJSONTyped(json, false);
  }
  function TrackingToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "method": value["method"],
      "min_confidence_to_create": value["minConfidenceToCreate"],
      "min_consecutive_frames": value["minConsecutiveFrames"],
      "min_overlap": value["minOverlap"],
      "max_lost_frames": value["maxLostFrames"],
      "ignore_untracked": value["ignoreUntracked"]
    };
  }

  // api/sdk/build/gen/models/Grid.ts
  function instanceOfGrid(value) {
    if (!("rows" in value) || value["rows"] === void 0) return false;
    if (!("cols" in value) || value["cols"] === void 0) return false;
    return true;
  }
  function GridFromJSON(json) {
    return GridFromJSONTyped(json, false);
  }
  function GridFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "rows": json["rows"],
      "cols": json["cols"]
    };
  }
  function GridToJSON(json) {
    return GridToJSONTyped(json, false);
  }
  function GridToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "rows": value["rows"],
      "cols": value["cols"]
    };
  }

  // api/sdk/build/gen/models/Tiling.ts
  var TilingModeEnum = {
    None: "none",
    Fixed: "fixed",
    Gated: "gated"
  };
  function instanceOfTiling(value) {
    if (!("mode" in value) || value["mode"] === void 0) return false;
    return true;
  }
  function TilingFromJSON(json) {
    return TilingFromJSONTyped(json, false);
  }
  function TilingFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "mode": json["mode"],
      "minGrid": json["min_grid"] == null ? void 0 : GridFromJSON(json["min_grid"]),
      "maxGrid": json["max_grid"] == null ? void 0 : GridFromJSON(json["max_grid"]),
      "tileCoverageCutoff": json["tile_coverage_cutoff"] == null ? void 0 : json["tile_coverage_cutoff"],
      "fullFramePass": json["full_frame_pass"] == null ? void 0 : json["full_frame_pass"],
      "clusterSuppressionMinChildren": json["cluster_suppression_min_children"] == null ? void 0 : json["cluster_suppression_min_children"]
    };
  }
  function TilingToJSON(json) {
    return TilingToJSONTyped(json, false);
  }
  function TilingToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "mode": value["mode"],
      "min_grid": GridToJSON(value["minGrid"]),
      "max_grid": GridToJSON(value["maxGrid"]),
      "tile_coverage_cutoff": value["tileCoverageCutoff"],
      "full_frame_pass": value["fullFramePass"],
      "cluster_suppression_min_children": value["clusterSuppressionMinChildren"]
    };
  }

  // api/sdk/build/gen/models/ObjectDetector.ts
  var ObjectDetectorModelEnum = {
    Nano: "nano",
    Small: "small",
    Medium: "medium",
    Large: "large"
  };
  function instanceOfObjectDetector(value) {
    return true;
  }
  function ObjectDetectorFromJSON(json) {
    return ObjectDetectorFromJSONTyped(json, false);
  }
  function ObjectDetectorFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, DetectorFromJSONTyped(json, true)), {
      "classes": json["classes"] == null ? void 0 : json["classes"],
      "model": json["model"] == null ? void 0 : json["model"],
      "checkpointPath": json["checkpoint_path"] == null ? void 0 : json["checkpoint_path"],
      "minConfidence": json["min_confidence"] == null ? void 0 : json["min_confidence"],
      "tracking": json["tracking"] == null ? void 0 : TrackingFromJSON(json["tracking"]),
      "tiling": json["tiling"] == null ? void 0 : TilingFromJSON(json["tiling"])
    });
  }
  function ObjectDetectorToJSON(json) {
    return ObjectDetectorToJSONTyped(json, false);
  }
  function ObjectDetectorToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, DetectorToJSONTyped(value, true)), {
      "classes": value["classes"],
      "model": value["model"],
      "checkpoint_path": value["checkpointPath"],
      "min_confidence": value["minConfidence"],
      "tracking": TrackingToJSON(value["tracking"]),
      "tiling": TilingToJSON(value["tiling"])
    });
  }

  // api/sdk/build/gen/models/SceneBaseline.ts
  var SceneBaselineSetEnum = {
    Default: "DEFAULT",
    Traffic: "TRAFFIC"
  };
  function instanceOfSceneBaseline(value) {
    return true;
  }
  function SceneBaselineFromJSON(json) {
    return SceneBaselineFromJSONTyped(json, false);
  }
  function SceneBaselineFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "set": json["set"] == null ? void 0 : json["set"],
      "customClasses": json["custom_classes"] == null ? void 0 : json["custom_classes"]
    };
  }
  function SceneBaselineToJSON(json) {
    return SceneBaselineToJSONTyped(json, false);
  }
  function SceneBaselineToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "set": value["set"],
      "custom_classes": value["customClasses"]
    };
  }

  // api/sdk/build/gen/models/SceneDetector.ts
  function instanceOfSceneDetector(value) {
    return true;
  }
  function SceneDetectorFromJSON(json) {
    return SceneDetectorFromJSONTyped(json, false);
  }
  function SceneDetectorFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, DetectorFromJSONTyped(json, true)), {
      "classes": json["classes"] == null ? void 0 : json["classes"],
      "sensitivity": json["sensitivity"] == null ? void 0 : json["sensitivity"],
      "classSensitivity": json["class_sensitivity"] == null ? void 0 : json["class_sensitivity"],
      "minConfidence": json["min_confidence"] == null ? void 0 : json["min_confidence"],
      "baseline": json["baseline"] == null ? void 0 : SceneBaselineFromJSON(json["baseline"])
    });
  }
  function SceneDetectorToJSON(json) {
    return SceneDetectorToJSONTyped(json, false);
  }
  function SceneDetectorToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, DetectorToJSONTyped(value, true)), {
      "classes": value["classes"],
      "sensitivity": value["sensitivity"],
      "class_sensitivity": value["classSensitivity"],
      "min_confidence": value["minConfidence"],
      "baseline": SceneBaselineToJSON(value["baseline"])
    });
  }

  // api/sdk/build/gen/models/SvdEndpointTls.ts
  function instanceOfSvdEndpointTls(value) {
    return true;
  }
  function SvdEndpointTlsFromJSON(json) {
    return SvdEndpointTlsFromJSONTyped(json, false);
  }
  function SvdEndpointTlsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "enabled": json["enabled"] == null ? void 0 : json["enabled"],
      "caCert": json["ca_cert"] == null ? void 0 : json["ca_cert"],
      "clientCert": json["client_cert"] == null ? void 0 : json["client_cert"],
      "clientKey": json["client_key"] == null ? void 0 : json["client_key"]
    };
  }
  function SvdEndpointTlsToJSON(json) {
    return SvdEndpointTlsToJSONTyped(json, false);
  }
  function SvdEndpointTlsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "enabled": value["enabled"],
      "ca_cert": value["caCert"],
      "client_cert": value["clientCert"],
      "client_key": value["clientKey"]
    };
  }

  // api/sdk/build/gen/models/SvdEndpoint.ts
  function instanceOfSvdEndpoint(value) {
    return true;
  }
  function SvdEndpointFromJSON(json) {
    return SvdEndpointFromJSONTyped(json, false);
  }
  function SvdEndpointFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "address": json["address"] == null ? void 0 : json["address"],
      "tls": json["tls"] == null ? void 0 : SvdEndpointTlsFromJSON(json["tls"]),
      "apiKey": json["api_key"] == null ? void 0 : json["api_key"],
      "functionId": json["function_id"] == null ? void 0 : json["function_id"],
      "timeoutSeconds": json["timeout_seconds"] == null ? void 0 : json["timeout_seconds"],
      "maxConcurrentRequests": json["max_concurrent_requests"] == null ? void 0 : json["max_concurrent_requests"]
    };
  }
  function SvdEndpointToJSON(json) {
    return SvdEndpointToJSONTyped(json, false);
  }
  function SvdEndpointToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "address": value["address"],
      "tls": SvdEndpointTlsToJSON(value["tls"]),
      "api_key": value["apiKey"],
      "function_id": value["functionId"],
      "timeout_seconds": value["timeoutSeconds"],
      "max_concurrent_requests": value["maxConcurrentRequests"]
    };
  }

  // api/sdk/build/gen/models/SyntheticDetector.ts
  function instanceOfSyntheticDetector(value) {
    return true;
  }
  function SyntheticDetectorFromJSON(json) {
    return SyntheticDetectorFromJSONTyped(json, false);
  }
  function SyntheticDetectorFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, DetectorFromJSONTyped(json, true)), {
      "endpoint": json["endpoint"] == null ? void 0 : SvdEndpointFromJSON(json["endpoint"]),
      "classificationThreshold": json["classification_threshold"] == null ? void 0 : json["classification_threshold"]
    });
  }
  function SyntheticDetectorToJSON(json) {
    return SyntheticDetectorToJSONTyped(json, false);
  }
  function SyntheticDetectorToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, DetectorToJSONTyped(value, true)), {
      "endpoint": SvdEndpointToJSON(value["endpoint"]),
      "classification_threshold": value["classificationThreshold"]
    });
  }

  // api/sdk/build/gen/models/GenerationParams.ts
  function instanceOfGenerationParams(value) {
    return true;
  }
  function GenerationParamsFromJSON(json) {
    return GenerationParamsFromJSONTyped(json, false);
  }
  function GenerationParamsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "temperature": json["temperature"] == null ? void 0 : json["temperature"],
      "maxTokens": json["max_tokens"] == null ? void 0 : json["max_tokens"]
    };
  }
  function GenerationParamsToJSON(json) {
    return GenerationParamsToJSONTyped(json, false);
  }
  function GenerationParamsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "temperature": value["temperature"],
      "max_tokens": value["maxTokens"]
    };
  }

  // api/sdk/build/gen/models/Prompt.ts
  function instanceOfPrompt(value) {
    return true;
  }
  function PromptFromJSON(json) {
    return PromptFromJSONTyped(json, false);
  }
  function PromptFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "system": json["system"] == null ? void 0 : json["system"],
      "user": json["user"] == null ? void 0 : json["user"]
    };
  }
  function PromptToJSON(json) {
    return PromptToJSONTyped(json, false);
  }
  function PromptToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "system": value["system"],
      "user": value["user"]
    };
  }

  // api/sdk/build/gen/models/VlmCustomSettings.ts
  function instanceOfVlmCustomSettings(value) {
    return true;
  }
  function VlmCustomSettingsFromJSON(json) {
    return VlmCustomSettingsFromJSONTyped(json, false);
  }
  function VlmCustomSettingsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "prompt": json["prompt"] == null ? void 0 : PromptFromJSON(json["prompt"]),
      "responseSchema": json["response_schema"] == null ? void 0 : json["response_schema"],
      "classes": json["classes"] == null ? void 0 : json["classes"],
      "classHints": json["class_hints"] == null ? void 0 : json["class_hints"]
    };
  }
  function VlmCustomSettingsToJSON(json) {
    return VlmCustomSettingsToJSONTyped(json, false);
  }
  function VlmCustomSettingsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "prompt": PromptToJSON(value["prompt"]),
      "response_schema": value["responseSchema"],
      "classes": value["classes"],
      "class_hints": value["classHints"]
    };
  }

  // api/sdk/build/gen/models/VlmEndpoint.ts
  function instanceOfVlmEndpoint(value) {
    return true;
  }
  function VlmEndpointFromJSON(json) {
    return VlmEndpointFromJSONTyped(json, false);
  }
  function VlmEndpointFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "url": json["url"] == null ? void 0 : json["url"],
      "model": json["model"] == null ? void 0 : json["model"],
      "apiKey": json["api_key"] == null ? void 0 : json["api_key"],
      "timeoutSeconds": json["timeout_seconds"] == null ? void 0 : json["timeout_seconds"],
      "maxConcurrentRequests": json["max_concurrent_requests"] == null ? void 0 : json["max_concurrent_requests"]
    };
  }
  function VlmEndpointToJSON(json) {
    return VlmEndpointToJSONTyped(json, false);
  }
  function VlmEndpointToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "url": value["url"],
      "model": value["model"],
      "api_key": value["apiKey"],
      "timeout_seconds": value["timeoutSeconds"],
      "max_concurrent_requests": value["maxConcurrentRequests"]
    };
  }

  // api/sdk/build/gen/models/VlmDetectSettings.ts
  var VlmDetectSettingsReasoningLevelEnum = {
    Low: "low",
    Medium: "medium",
    High: "high"
  };
  function instanceOfVlmDetectSettings(value) {
    if (!("classes" in value) || value["classes"] === void 0) return false;
    return true;
  }
  function VlmDetectSettingsFromJSON(json) {
    return VlmDetectSettingsFromJSONTyped(json, false);
  }
  function VlmDetectSettingsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "classes": json["classes"],
      "classHints": json["class_hints"] == null ? void 0 : json["class_hints"],
      "reasoningLevel": json["reasoning_level"] == null ? void 0 : json["reasoning_level"]
    };
  }
  function VlmDetectSettingsToJSON(json) {
    return VlmDetectSettingsToJSONTyped(json, false);
  }
  function VlmDetectSettingsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "classes": value["classes"],
      "class_hints": value["classHints"],
      "reasoning_level": value["reasoningLevel"]
    };
  }

  // api/sdk/build/gen/models/VlmDetector.ts
  var VlmDetectorModeEnum = {
    Detect: "detect",
    Describe: "describe",
    Custom: "custom"
  };
  function instanceOfVlmDetector(value) {
    if (!("mode" in value) || value["mode"] === void 0) return false;
    return true;
  }
  function VlmDetectorFromJSON(json) {
    return VlmDetectorFromJSONTyped(json, false);
  }
  function VlmDetectorFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, DetectorFromJSONTyped(json, true)), {
      "endpoint": json["endpoint"] == null ? void 0 : VlmEndpointFromJSON(json["endpoint"]),
      "mode": json["mode"],
      "detect": json["detect"] == null ? void 0 : VlmDetectSettingsFromJSON(json["detect"]),
      "custom": json["custom"] == null ? void 0 : VlmCustomSettingsFromJSON(json["custom"]),
      "generation": json["generation"] == null ? void 0 : GenerationParamsFromJSON(json["generation"])
    });
  }
  function VlmDetectorToJSON(json) {
    return VlmDetectorToJSONTyped(json, false);
  }
  function VlmDetectorToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, DetectorToJSONTyped(value, true)), {
      "endpoint": VlmEndpointToJSON(value["endpoint"]),
      "mode": value["mode"],
      "detect": VlmDetectSettingsToJSON(value["detect"]),
      "custom": VlmCustomSettingsToJSON(value["custom"]),
      "generation": GenerationParamsToJSON(value["generation"])
    });
  }

  // api/sdk/build/gen/models/Detector.ts
  function instanceOfDetector(value) {
    if (!("type" in value) || value["type"] === void 0) return false;
    return true;
  }
  function DetectorFromJSON(json) {
    return DetectorFromJSONTyped(json, false);
  }
  function DetectorFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    if (!ignoreDiscriminator) {
      if (json["type"] === "object") {
        return ObjectDetectorFromJSONTyped(json, ignoreDiscriminator);
      }
      if (json["type"] === "scene") {
        return SceneDetectorFromJSONTyped(json, ignoreDiscriminator);
      }
      if (json["type"] === "synthetic") {
        return SyntheticDetectorFromJSONTyped(json, ignoreDiscriminator);
      }
      if (json["type"] === "vlm") {
        return VlmDetectorFromJSONTyped(json, ignoreDiscriminator);
      }
    }
    return {
      "type": DetectorTypeFromJSON(json["type"])
    };
  }
  function DetectorToJSON(json) {
    return DetectorToJSONTyped(json, false);
  }
  function DetectorToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    if (!ignoreDiscriminator) {
      switch (value["type"]) {
        case "object":
          return ObjectDetectorToJSONTyped(value, ignoreDiscriminator);
        case "scene":
          return SceneDetectorToJSONTyped(value, ignoreDiscriminator);
        case "synthetic":
          return SyntheticDetectorToJSONTyped(value, ignoreDiscriminator);
        case "vlm":
          return VlmDetectorToJSONTyped(value, ignoreDiscriminator);
        default:
          throw new Error(`No variant of Detector exists with 'type=${value["type"]}'`);
      }
    }
    return {
      "type": DetectorTypeToJSON(value["type"])
    };
  }

  // api/sdk/build/gen/models/Config.ts
  function instanceOfConfig(value) {
    return true;
  }
  function ConfigFromJSON(json) {
    return ConfigFromJSONTyped(json, false);
  }
  function ConfigFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "active": json["active"] == null ? void 0 : json["active"],
      "detector": json["detector"] == null ? void 0 : DetectorFromJSON(json["detector"]),
      "listeners": json["listeners"] == null ? void 0 : mapValues(json["listeners"], ListenerFromJSON),
      "processing": json["processing"] == null ? void 0 : ProcessingFromJSON(json["processing"]),
      "service": json["service"] == null ? void 0 : ServiceBindingFromJSON(json["service"]),
      "diagnostics": json["diagnostics"] == null ? void 0 : DiagnosticsFromJSON(json["diagnostics"])
    };
  }
  function ConfigToJSON(json) {
    return ConfigToJSONTyped(json, false);
  }
  function ConfigToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "active": value["active"],
      "detector": DetectorToJSON(value["detector"]),
      "listeners": value["listeners"] == null ? void 0 : mapValues(value["listeners"], ListenerToJSON),
      "processing": ProcessingToJSON(value["processing"]),
      "service": ServiceBindingToJSON(value["service"]),
      "diagnostics": DiagnosticsToJSON(value["diagnostics"])
    };
  }

  // api/sdk/build/gen/models/DefaultConfigConcurrentExecutionsValue.ts
  function instanceOfDefaultConfigConcurrentExecutionsValue(value) {
    return true;
  }
  function DefaultConfigConcurrentExecutionsValueFromJSON(json) {
    return DefaultConfigConcurrentExecutionsValueFromJSONTyped(json, false);
  }
  function DefaultConfigConcurrentExecutionsValueFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return __spreadProps(__spreadValues({}, json), {
      "_default": json["default"] == null ? void 0 : json["default"]
    });
  }
  function DefaultConfigConcurrentExecutionsValueToJSON(json) {
    return DefaultConfigConcurrentExecutionsValueToJSONTyped(json, false);
  }
  function DefaultConfigConcurrentExecutionsValueToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return __spreadProps(__spreadValues({}, value), {
      "default": value["_default"]
    });
  }

  // api/sdk/build/gen/models/DefaultConfigDetectors.ts
  function instanceOfDefaultConfigDetectors(value) {
    return true;
  }
  function DefaultConfigDetectorsFromJSON(json) {
    return DefaultConfigDetectorsFromJSONTyped(json, false);
  }
  function DefaultConfigDetectorsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "scene": json["scene"] == null ? void 0 : SceneDetectorFromJSON(json["scene"]),
      "object": json["object"] == null ? void 0 : ObjectDetectorFromJSON(json["object"]),
      "vlm": json["vlm"] == null ? void 0 : VlmDetectorFromJSON(json["vlm"]),
      "synthetic": json["synthetic"] == null ? void 0 : SyntheticDetectorFromJSON(json["synthetic"])
    };
  }
  function DefaultConfigDetectorsToJSON(json) {
    return DefaultConfigDetectorsToJSONTyped(json, false);
  }
  function DefaultConfigDetectorsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "scene": SceneDetectorToJSON(value["scene"]),
      "object": ObjectDetectorToJSON(value["object"]),
      "vlm": VlmDetectorToJSON(value["vlm"]),
      "synthetic": SyntheticDetectorToJSON(value["synthetic"])
    };
  }

  // api/sdk/build/gen/models/DefaultConfig.ts
  function instanceOfDefaultConfig(value) {
    return true;
  }
  function DefaultConfigFromJSON(json) {
    return DefaultConfigFromJSONTyped(json, false);
  }
  function DefaultConfigFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "config": json["config"] == null ? void 0 : BaselineConfigFromJSON(json["config"]),
      "detectors": json["detectors"] == null ? void 0 : DefaultConfigDetectorsFromJSON(json["detectors"]),
      "etag": json["etag"] == null ? void 0 : json["etag"],
      "concurrentExecutions": json["concurrent_executions"] == null ? void 0 : mapValues(json["concurrent_executions"], DefaultConfigConcurrentExecutionsValueFromJSON)
    };
  }
  function DefaultConfigToJSON(json) {
    return DefaultConfigToJSONTyped(json, false);
  }
  function DefaultConfigToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "config": BaselineConfigToJSON(value["config"]),
      "detectors": DefaultConfigDetectorsToJSON(value["detectors"]),
      "etag": value["etag"],
      "concurrent_executions": value["concurrentExecutions"] == null ? void 0 : mapValues(value["concurrentExecutions"], DefaultConfigConcurrentExecutionsValueToJSON)
    };
  }

  // api/sdk/build/gen/models/DetectionModel.ts
  function instanceOfDetectionModel(value) {
    if (!("name" in value) || value["name"] === void 0) return false;
    if (!("type" in value) || value["type"] === void 0) return false;
    return true;
  }
  function DetectionModelFromJSON(json) {
    return DetectionModelFromJSONTyped(json, false);
  }
  function DetectionModelFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "name": json["name"],
      "type": DetectorTypeFromJSON(json["type"]),
      "custom": json["custom"] == null ? void 0 : json["custom"],
      "checkpointPath": json["checkpoint_path"] == null ? void 0 : json["checkpoint_path"],
      "classSet": json["class_set"] == null ? void 0 : json["class_set"],
      "classes": json["classes"] == null ? void 0 : json["classes"]
    };
  }
  function DetectionModelToJSON(json) {
    return DetectionModelToJSONTyped(json, false);
  }
  function DetectionModelToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "name": value["name"],
      "type": DetectorTypeToJSON(value["type"]),
      "custom": value["custom"],
      "checkpoint_path": value["checkpointPath"],
      "class_set": value["classSet"],
      "classes": value["classes"]
    };
  }

  // api/sdk/build/gen/models/HostStatsGpu.ts
  function instanceOfHostStatsGpu(value) {
    return true;
  }
  function HostStatsGpuFromJSON(json) {
    return HostStatsGpuFromJSONTyped(json, false);
  }
  function HostStatsGpuFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "model": json["model"] == null ? void 0 : json["model"],
      "driverVersion": json["driver_version"] == null ? void 0 : json["driver_version"],
      "cudaVersion": json["cuda_version"] == null ? void 0 : json["cuda_version"],
      "utilizationAvg": json["utilization_avg"] == null ? void 0 : json["utilization_avg"],
      "memoryAvg": json["memory_avg"] == null ? void 0 : json["memory_avg"],
      "encodeAvg": json["encode_avg"] == null ? void 0 : json["encode_avg"],
      "decodeAvg": json["decode_avg"] == null ? void 0 : json["decode_avg"]
    };
  }
  function HostStatsGpuToJSON(json) {
    return HostStatsGpuToJSONTyped(json, false);
  }
  function HostStatsGpuToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "model": value["model"],
      "driver_version": value["driverVersion"],
      "cuda_version": value["cudaVersion"],
      "utilization_avg": value["utilizationAvg"],
      "memory_avg": value["memoryAvg"],
      "encode_avg": value["encodeAvg"],
      "decode_avg": value["decodeAvg"]
    };
  }

  // api/sdk/build/gen/models/HostStats.ts
  function instanceOfHostStats(value) {
    return true;
  }
  function HostStatsFromJSON(json) {
    return HostStatsFromJSONTyped(json, false);
  }
  function HostStatsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "wseVersion": json["wse_version"] == null ? void 0 : json["wse_version"],
      "vifModuleVersion": json["vif_module_version"] == null ? void 0 : json["vif_module_version"],
      "cpuAvg": json["cpu_avg"] == null ? void 0 : json["cpu_avg"],
      "gpu": json["gpu"] == null ? void 0 : HostStatsGpuFromJSON(json["gpu"])
    };
  }
  function HostStatsToJSON(json) {
    return HostStatsToJSONTyped(json, false);
  }
  function HostStatsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "wse_version": value["wseVersion"],
      "vif_module_version": value["vifModuleVersion"],
      "cpu_avg": value["cpuAvg"],
      "gpu": HostStatsGpuToJSON(value["gpu"])
    };
  }

  // api/sdk/build/gen/models/ListenerType.ts
  function instanceOfListenerType(value) {
    if (!("name" in value) || value["name"] === void 0) return false;
    return true;
  }
  function ListenerTypeFromJSON(json) {
    return ListenerTypeFromJSONTyped(json, false);
  }
  function ListenerTypeFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "name": json["name"],
      "version": json["version"] == null ? void 0 : json["version"]
    };
  }
  function ListenerTypeToJSON(json) {
    return ListenerTypeToJSONTyped(json, false);
  }
  function ListenerTypeToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "name": value["name"],
      "version": value["version"]
    };
  }

  // api/sdk/build/gen/models/ModelCatalog.ts
  function instanceOfModelCatalog(value) {
    if (!("models" in value) || value["models"] === void 0) return false;
    return true;
  }
  function ModelCatalogFromJSON(json) {
    return ModelCatalogFromJSONTyped(json, false);
  }
  function ModelCatalogFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "models": json["models"].map(DetectionModelFromJSON),
      "vlmDefaults": json["vlm_defaults"] == null ? void 0 : json["vlm_defaults"]
    };
  }
  function ModelCatalogToJSON(json) {
    return ModelCatalogToJSONTyped(json, false);
  }
  function ModelCatalogToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "models": value["models"].map(DetectionModelToJSON),
      "vlm_defaults": value["vlmDefaults"]
    };
  }

  // api/sdk/build/gen/models/Performance.ts
  function instanceOfPerformance(value) {
    return true;
  }
  function PerformanceFromJSON(json) {
    return PerformanceFromJSONTyped(json, false);
  }
  function PerformanceFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "pingRttAvg": json["ping_rtt_avg"] == null ? void 0 : json["ping_rtt_avg"],
      "preprocessTimeAvg": json["preprocess_time_avg"] == null ? void 0 : json["preprocess_time_avg"],
      "inferenceTimeAvg": json["inference_time_avg"] == null ? void 0 : json["inference_time_avg"],
      "postprocessTimeAvg": json["postprocess_time_avg"] == null ? void 0 : json["postprocess_time_avg"],
      "totalProcessingTimeAvg": json["total_processing_time_avg"] == null ? void 0 : json["total_processing_time_avg"],
      "frameDetectTimeAvg": json["frame_detect_time_avg"] == null ? void 0 : json["frame_detect_time_avg"],
      "frameWindow": json["frame_window"] == null ? void 0 : json["frame_window"],
      "videoFramesTotal": json["video_frames_total"] == null ? void 0 : json["video_frames_total"],
      "framesDetected": json["frames_detected"] == null ? void 0 : json["frames_detected"]
    };
  }
  function PerformanceToJSON(json) {
    return PerformanceToJSONTyped(json, false);
  }
  function PerformanceToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "ping_rtt_avg": value["pingRttAvg"],
      "preprocess_time_avg": value["preprocessTimeAvg"],
      "inference_time_avg": value["inferenceTimeAvg"],
      "postprocess_time_avg": value["postprocessTimeAvg"],
      "total_processing_time_avg": value["totalProcessingTimeAvg"],
      "frame_detect_time_avg": value["frameDetectTimeAvg"],
      "frame_window": value["frameWindow"],
      "video_frames_total": value["videoFramesTotal"],
      "frames_detected": value["framesDetected"]
    };
  }

  // api/sdk/build/gen/models/Problem.ts
  function instanceOfProblem(value) {
    if (!("title" in value) || value["title"] === void 0) return false;
    if (!("status" in value) || value["status"] === void 0) return false;
    return true;
  }
  function ProblemFromJSON(json) {
    return ProblemFromJSONTyped(json, false);
  }
  function ProblemFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "type": json["type"] == null ? void 0 : json["type"],
      "title": json["title"],
      "status": json["status"],
      "detail": json["detail"] == null ? void 0 : json["detail"],
      "instance": json["instance"] == null ? void 0 : json["instance"]
    };
  }
  function ProblemToJSON(json) {
    return ProblemToJSONTyped(json, false);
  }
  function ProblemToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "type": value["type"],
      "title": value["title"],
      "status": value["status"],
      "detail": value["detail"],
      "instance": value["instance"]
    };
  }

  // api/sdk/build/gen/models/Secrets.ts
  function instanceOfSecrets(value) {
    return true;
  }
  function SecretsFromJSON(json) {
    return SecretsFromJSONTyped(json, false);
  }
  function SecretsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "names": json["names"] == null ? void 0 : json["names"],
      "values": json["values"] == null ? void 0 : json["values"],
      "etag": json["etag"] == null ? void 0 : json["etag"]
    };
  }
  function SecretsToJSON(json) {
    return SecretsToJSONTyped(json, false);
  }
  function SecretsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "names": value["names"],
      "values": value["values"],
      "etag": value["etag"]
    };
  }

  // api/sdk/build/gen/models/VisInstanceStatusGpusInner.ts
  function instanceOfVisInstanceStatusGpusInner(value) {
    return true;
  }
  function VisInstanceStatusGpusInnerFromJSON(json) {
    return VisInstanceStatusGpusInnerFromJSONTyped(json, false);
  }
  function VisInstanceStatusGpusInnerFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "id": json["id"] == null ? void 0 : json["id"],
      "name": json["name"] == null ? void 0 : json["name"],
      "utilizationPct": json["utilization_pct"] == null ? void 0 : json["utilization_pct"],
      "memoryUsedMb": json["memory_used_mb"] == null ? void 0 : json["memory_used_mb"],
      "memoryTotalMb": json["memory_total_mb"] == null ? void 0 : json["memory_total_mb"]
    };
  }
  function VisInstanceStatusGpusInnerToJSON(json) {
    return VisInstanceStatusGpusInnerToJSONTyped(json, false);
  }
  function VisInstanceStatusGpusInnerToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "id": value["id"],
      "name": value["name"],
      "utilization_pct": value["utilizationPct"],
      "memory_used_mb": value["memoryUsedMb"],
      "memory_total_mb": value["memoryTotalMb"]
    };
  }

  // api/sdk/build/gen/models/VisInstanceStatus.ts
  function instanceOfVisInstanceStatus(value) {
    if (!("host" in value) || value["host"] === void 0) return false;
    if (!("url" in value) || value["url"] === void 0) return false;
    if (!("reachable" in value) || value["reachable"] === void 0) return false;
    return true;
  }
  function VisInstanceStatusFromJSON(json) {
    return VisInstanceStatusFromJSONTyped(json, false);
  }
  function VisInstanceStatusFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "host": json["host"],
      "url": json["url"],
      "version": json["version"] == null ? void 0 : json["version"],
      "reachable": json["reachable"],
      "ageSeconds": json["age_seconds"] == null ? void 0 : json["age_seconds"],
      "cpuPct": json["cpu_pct"] == null ? void 0 : json["cpu_pct"],
      "streams": json["streams"] == null ? void 0 : json["streams"],
      "streamNames": json["stream_names"] == null ? void 0 : json["stream_names"],
      "gpus": json["gpus"] == null ? void 0 : json["gpus"].map(VisInstanceStatusGpusInnerFromJSON)
    };
  }
  function VisInstanceStatusToJSON(json) {
    return VisInstanceStatusToJSONTyped(json, false);
  }
  function VisInstanceStatusToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "host": value["host"],
      "url": value["url"],
      "version": value["version"],
      "reachable": value["reachable"],
      "age_seconds": value["ageSeconds"],
      "cpu_pct": value["cpuPct"],
      "streams": value["streams"],
      "stream_names": value["streamNames"],
      "gpus": value["gpus"] == null ? void 0 : value["gpus"].map(VisInstanceStatusGpusInnerToJSON)
    };
  }

  // api/sdk/build/gen/models/StreamState.ts
  function instanceOfStreamState(value) {
    if (!("connection" in value) || value["connection"] === void 0) return false;
    return true;
  }
  function StreamStateFromJSON(json) {
    return StreamStateFromJSONTyped(json, false);
  }
  function StreamStateFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "connection": json["connection"],
      "endpointDegraded": json["endpoint_degraded"] == null ? void 0 : json["endpoint_degraded"],
      "reason": json["reason"] == null ? void 0 : json["reason"],
      "serviceVersion": json["service_version"] == null ? void 0 : json["service_version"],
      "performance": json["performance"] == null ? void 0 : PerformanceFromJSON(json["performance"])
    };
  }
  function StreamStateToJSON(json) {
    return StreamStateToJSONTyped(json, false);
  }
  function StreamStateToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "connection": value["connection"],
      "endpoint_degraded": value["endpointDegraded"],
      "reason": value["reason"],
      "service_version": value["serviceVersion"],
      "performance": PerformanceToJSON(value["performance"])
    };
  }

  // api/sdk/build/gen/models/VideoInfo.ts
  function instanceOfVideoInfo(value) {
    return true;
  }
  function VideoInfoFromJSON(json) {
    return VideoInfoFromJSONTyped(json, false);
  }
  function VideoInfoFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "width": json["width"] == null ? void 0 : json["width"],
      "height": json["height"] == null ? void 0 : json["height"],
      "frameRate": json["frame_rate"] == null ? void 0 : json["frame_rate"],
      "gopSize": json["gop_size"] == null ? void 0 : json["gop_size"]
    };
  }
  function VideoInfoToJSON(json) {
    return VideoInfoToJSONTyped(json, false);
  }
  function VideoInfoToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "width": value["width"],
      "height": value["height"],
      "frame_rate": value["frameRate"],
      "gop_size": value["gopSize"]
    };
  }

  // api/sdk/build/gen/models/Stream.ts
  function instanceOfStream(value) {
    if (!("application" in value) || value["application"] === void 0) return false;
    if (!("name" in value) || value["name"] === void 0) return false;
    if (!("state" in value) || value["state"] === void 0) return false;
    if (!("config" in value) || value["config"] === void 0) return false;
    return true;
  }
  function StreamFromJSON(json) {
    return StreamFromJSONTyped(json, false);
  }
  function StreamFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "application": json["application"],
      "name": json["name"],
      "vhost": json["vhost"] == null ? void 0 : json["vhost"],
      "instance": json["instance"] == null ? void 0 : json["instance"],
      "state": StreamStateFromJSON(json["state"]),
      "video": json["video"] == null ? void 0 : VideoInfoFromJSON(json["video"]),
      "config": ConfigFromJSON(json["config"]),
      "ephemeralChanges": json["ephemeral_changes"] == null ? void 0 : json["ephemeral_changes"],
      "etag": json["etag"] == null ? void 0 : json["etag"]
    };
  }
  function StreamToJSON(json) {
    return StreamToJSONTyped(json, false);
  }
  function StreamToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "application": value["application"],
      "name": value["name"],
      "vhost": value["vhost"],
      "instance": value["instance"],
      "state": StreamStateToJSON(value["state"]),
      "video": VideoInfoToJSON(value["video"]),
      "config": ConfigToJSON(value["config"]),
      "etag": value["etag"]
    };
  }

  // api/sdk/build/gen/models/ServerStatus.ts
  function instanceOfServerStatus(value) {
    if (!("host" in value) || value["host"] === void 0) return false;
    if (!("streams" in value) || value["streams"] === void 0) return false;
    if (!("visInstances" in value) || value["visInstances"] === void 0) return false;
    return true;
  }
  function ServerStatusFromJSON(json) {
    return ServerStatusFromJSONTyped(json, false);
  }
  function ServerStatusFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "host": HostStatsFromJSON(json["host"]),
      "streams": json["streams"].map(StreamFromJSON),
      "visInstances": json["vis_instances"].map(VisInstanceStatusFromJSON)
    };
  }
  function ServerStatusToJSON(json) {
    return ServerStatusToJSONTyped(json, false);
  }
  function ServerStatusToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "host": HostStatsToJSON(value["host"]),
      "streams": value["streams"].map(StreamToJSON),
      "vis_instances": value["visInstances"].map(VisInstanceStatusToJSON)
    };
  }

  // api/sdk/build/gen/models/StreamConfigOverride.ts
  function instanceOfStreamConfigOverride(value) {
    return true;
  }
  function StreamConfigOverrideFromJSON(json) {
    return StreamConfigOverrideFromJSONTyped(json, false);
  }
  function StreamConfigOverrideFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "config": json["config"] == null ? void 0 : ConfigFromJSON(json["config"]),
      "application": json["application"] == null ? void 0 : json["application"],
      "stream": json["stream"] == null ? void 0 : json["stream"],
      "etag": json["etag"] == null ? void 0 : json["etag"]
    };
  }
  function StreamConfigOverrideToJSON(json) {
    return StreamConfigOverrideToJSONTyped(json, false);
  }
  function StreamConfigOverrideToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "config": ConfigToJSON(value["config"]),
      "application": value["application"],
      "stream": value["stream"],
      "etag": value["etag"]
    };
  }

  // api/sdk/build/gen/models/StreamGroupConfigMatch.ts
  function instanceOfStreamGroupConfigMatch(value) {
    if (!("application" in value) || value["application"] === void 0) return false;
    if (!("streamPattern" in value) || value["streamPattern"] === void 0) return false;
    return true;
  }
  function StreamGroupConfigMatchFromJSON(json) {
    return StreamGroupConfigMatchFromJSONTyped(json, false);
  }
  function StreamGroupConfigMatchFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "application": json["application"],
      "streamPattern": json["stream_pattern"],
      "priority": json["priority"] == null ? void 0 : json["priority"]
    };
  }
  function StreamGroupConfigMatchToJSON(json) {
    return StreamGroupConfigMatchToJSONTyped(json, false);
  }
  function StreamGroupConfigMatchToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "application": value["application"],
      "stream_pattern": value["streamPattern"],
      "priority": value["priority"]
    };
  }

  // api/sdk/build/gen/models/StreamGroupConfig.ts
  function instanceOfStreamGroupConfig(value) {
    if (!("name" in value) || value["name"] === void 0) return false;
    if (!("match" in value) || value["match"] === void 0) return false;
    return true;
  }
  function StreamGroupConfigFromJSON(json) {
    return StreamGroupConfigFromJSONTyped(json, false);
  }
  function StreamGroupConfigFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "name": json["name"],
      "match": StreamGroupConfigMatchFromJSON(json["match"]),
      "config": json["config"] == null ? void 0 : ConfigFromJSON(json["config"]),
      "etag": json["etag"] == null ? void 0 : json["etag"]
    };
  }
  function StreamGroupConfigToJSON(json) {
    return StreamGroupConfigToJSONTyped(json, false);
  }
  function StreamGroupConfigToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "name": value["name"],
      "match": StreamGroupConfigMatchToJSON(value["match"]),
      "config": ConfigToJSON(value["config"]),
      "etag": value["etag"]
    };
  }

  // api/sdk/build/gen/models/StreamSettings.ts
  function instanceOfStreamSettings(value) {
    return true;
  }
  function StreamSettingsFromJSON(json) {
    return StreamSettingsFromJSONTyped(json, false);
  }
  function StreamSettingsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "config": json["config"] == null ? void 0 : ConfigFromJSON(json["config"])
    };
  }
  function StreamSettingsToJSON(json) {
    return StreamSettingsToJSONTyped(json, false);
  }
  function StreamSettingsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "config": ConfigToJSON(value["config"])
    };
  }

  // api/sdk/build/gen/models/VlmEndpointProbeRequest.ts
  function instanceOfVlmEndpointProbeRequest(value) {
    return true;
  }
  function VlmEndpointProbeRequestFromJSON(json) {
    return VlmEndpointProbeRequestFromJSONTyped(json, false);
  }
  function VlmEndpointProbeRequestFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "url": json["url"] == null ? void 0 : json["url"],
      "apiKey": json["api_key"] == null ? void 0 : json["api_key"],
      "streamGroupConfig": json["stream_group_config"] == null ? void 0 : json["stream_group_config"],
      "application": json["application"] == null ? void 0 : json["application"],
      "stream": json["stream"] == null ? void 0 : json["stream"]
    };
  }
  function VlmEndpointProbeRequestToJSON(json) {
    return VlmEndpointProbeRequestToJSONTyped(json, false);
  }
  function VlmEndpointProbeRequestToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "url": value["url"],
      "api_key": value["apiKey"],
      "stream_group_config": value["streamGroupConfig"],
      "application": value["application"],
      "stream": value["stream"]
    };
  }

  // api/sdk/build/gen/models/VlmEndpointProbeResult.ts
  function instanceOfVlmEndpointProbeResult(value) {
    if (!("reachable" in value) || value["reachable"] === void 0) return false;
    return true;
  }
  function VlmEndpointProbeResultFromJSON(json) {
    return VlmEndpointProbeResultFromJSONTyped(json, false);
  }
  function VlmEndpointProbeResultFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "reachable": json["reachable"],
      "models": json["models"] == null ? void 0 : json["models"],
      "error": json["error"] == null ? void 0 : json["error"]
    };
  }
  function VlmEndpointProbeResultToJSON(json) {
    return VlmEndpointProbeResultToJSONTyped(json, false);
  }
  function VlmEndpointProbeResultToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "reachable": value["reachable"],
      "models": value["models"],
      "error": value["error"]
    };
  }

  // api/sdk/build/gen/models/VodFailureCause.ts
  var VodFailureCause = {
    ResponseTimeout: "response_timeout",
    Disconnected: "disconnected",
    DetectorRestarted: "detector_restarted",
    SendFailed: "send_failed",
    EndpointDegraded: "endpoint_degraded",
    NotConnected: "not_connected",
    ConnectFailed: "connect_failed",
    DetectorError: "detector_error",
    ConfigDrift: "config_drift",
    CoverageShortfall: "coverage_shortfall",
    SourceError: "source_error",
    StoreError: "store_error",
    EngineRestart: "engine_restart"
  };
  function instanceOfVodFailureCause(value) {
    for (const key in VodFailureCause) {
      if (Object.prototype.hasOwnProperty.call(VodFailureCause, key)) {
        if (VodFailureCause[key] === value) {
          return true;
        }
      }
    }
    return false;
  }
  function VodFailureCauseFromJSON(json) {
    return VodFailureCauseFromJSONTyped(json, false);
  }
  function VodFailureCauseFromJSONTyped(json, ignoreDiscriminator) {
    return json;
  }
  function VodFailureCauseToJSON(value) {
    return value;
  }
  function VodFailureCauseToJSONTyped(value, ignoreDiscriminator) {
    return value;
  }

  // api/sdk/build/gen/models/VodFile.ts
  function instanceOfVodFile(value) {
    if (!("file" in value) || value["file"] === void 0) return false;
    if (!("sizeBytes" in value) || value["sizeBytes"] === void 0) return false;
    if (!("modifiedAt" in value) || value["modifiedAt"] === void 0) return false;
    return true;
  }
  function VodFileFromJSON(json) {
    return VodFileFromJSONTyped(json, false);
  }
  function VodFileFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "file": json["file"],
      "sizeBytes": json["size_bytes"],
      "modifiedAt": new Date(json["modified_at"])
    };
  }
  function VodFileToJSON(json) {
    return VodFileToJSONTyped(json, false);
  }
  function VodFileToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "file": value["file"],
      "size_bytes": value["sizeBytes"],
      "modified_at": value["modifiedAt"].toISOString()
    };
  }

  // api/sdk/build/gen/models/VodFileList.ts
  function instanceOfVodFileList(value) {
    if (!("files" in value) || value["files"] === void 0) return false;
    if (!("truncated" in value) || value["truncated"] === void 0) return false;
    return true;
  }
  function VodFileListFromJSON(json) {
    return VodFileListFromJSONTyped(json, false);
  }
  function VodFileListFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "files": json["files"].map(VodFileFromJSON),
      "truncated": json["truncated"]
    };
  }
  function VodFileListToJSON(json) {
    return VodFileListToJSONTyped(json, false);
  }
  function VodFileListToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "files": value["files"].map(VodFileToJSON),
      "truncated": value["truncated"]
    };
  }

  // api/sdk/build/gen/models/VodJobState.ts
  var VodJobState = {
    Pending: "pending",
    Connecting: "connecting",
    Running: "running",
    Completed: "completed",
    Failed: "failed",
    Cancelled: "cancelled"
  };
  function instanceOfVodJobState(value) {
    for (const key in VodJobState) {
      if (Object.prototype.hasOwnProperty.call(VodJobState, key)) {
        if (VodJobState[key] === value) {
          return true;
        }
      }
    }
    return false;
  }
  function VodJobStateFromJSON(json) {
    return VodJobStateFromJSONTyped(json, false);
  }
  function VodJobStateFromJSONTyped(json, ignoreDiscriminator) {
    return json;
  }
  function VodJobStateToJSON(value) {
    return value;
  }
  function VodJobStateToJSONTyped(value, ignoreDiscriminator) {
    return value;
  }

  // api/sdk/build/gen/models/VodJob.ts
  function instanceOfVodJob(value) {
    if (!("jobId" in value) || value["jobId"] === void 0) return false;
    if (!("file" in value) || value["file"] === void 0) return false;
    if (!("storeResults" in value) || value["storeResults"] === void 0) return false;
    if (!("resultsTruncated" in value) || value["resultsTruncated"] === void 0) return false;
    if (!("state" in value) || value["state"] === void 0) return false;
    if (!("requestsSent" in value) || value["requestsSent"] === void 0) return false;
    if (!("requestsTotal" in value) || value["requestsTotal"] === void 0) return false;
    if (!("mediaTimeMs" in value) || value["mediaTimeMs"] === void 0) return false;
    if (!("queuedAt" in value) || value["queuedAt"] === void 0) return false;
    if (!("resumes" in value) || value["resumes"] === void 0) return false;
    return true;
  }
  function VodJobFromJSON(json) {
    return VodJobFromJSONTyped(json, false);
  }
  function VodJobFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "jobId": json["job_id"],
      "file": json["file"],
      "tag": json["tag"] == null ? void 0 : json["tag"],
      "detectorType": json["detector_type"] == null ? void 0 : DetectorTypeFromJSON(json["detector_type"]),
      "streamGroupConfig": json["stream_group_config"] == null ? void 0 : json["stream_group_config"],
      "listenerWarning": json["listener_warning"] == null ? void 0 : json["listener_warning"],
      "storeResults": json["store_results"],
      "resultsTruncated": json["results_truncated"],
      "state": VodJobStateFromJSON(json["state"]),
      "error": json["error"] == null ? void 0 : json["error"],
      "errorCause": json["error_cause"] == null ? void 0 : VodFailureCauseFromJSON(json["error_cause"]),
      "requestsSent": json["requests_sent"],
      "requestsTotal": json["requests_total"],
      "mediaTimeMs": json["media_time_ms"],
      "sourceDurationMs": json["source_duration_ms"] == null ? void 0 : json["source_duration_ms"],
      "queuedAt": new Date(json["queued_at"]),
      "startedAt": json["started_at"] == null ? void 0 : new Date(json["started_at"]),
      "endedAt": json["ended_at"] == null ? void 0 : new Date(json["ended_at"]),
      "resumes": json["resumes"],
      "config": json["config"] == null ? void 0 : ConfigFromJSON(json["config"]),
      "effectiveConfig": json["effective_config"] == null ? void 0 : ConfigFromJSON(json["effective_config"])
    };
  }
  function VodJobToJSON(json) {
    return VodJobToJSONTyped(json, false);
  }
  function VodJobToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "job_id": value["jobId"],
      "file": value["file"],
      "tag": value["tag"],
      "detector_type": DetectorTypeToJSON(value["detectorType"]),
      "stream_group_config": value["streamGroupConfig"],
      "listener_warning": value["listenerWarning"],
      "store_results": value["storeResults"],
      "results_truncated": value["resultsTruncated"],
      "state": VodJobStateToJSON(value["state"]),
      "error": value["error"],
      "error_cause": VodFailureCauseToJSON(value["errorCause"]),
      "requests_sent": value["requestsSent"],
      "requests_total": value["requestsTotal"],
      "media_time_ms": value["mediaTimeMs"],
      "source_duration_ms": value["sourceDurationMs"],
      "queued_at": value["queuedAt"].toISOString(),
      "started_at": value["startedAt"] == null ? void 0 : value["startedAt"].toISOString(),
      "ended_at": value["endedAt"] == null ? void 0 : value["endedAt"].toISOString(),
      "resumes": value["resumes"],
      "config": ConfigToJSON(value["config"]),
      "effective_config": ConfigToJSON(value["effectiveConfig"])
    };
  }

  // api/sdk/build/gen/models/VodJobPage.ts
  function instanceOfVodJobPage(value) {
    if (!("offset" in value) || value["offset"] === void 0) return false;
    if (!("limit" in value) || value["limit"] === void 0) return false;
    if (!("count" in value) || value["count"] === void 0) return false;
    if (!("total" in value) || value["total"] === void 0) return false;
    if (!("jobs" in value) || value["jobs"] === void 0) return false;
    return true;
  }
  function VodJobPageFromJSON(json) {
    return VodJobPageFromJSONTyped(json, false);
  }
  function VodJobPageFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "offset": json["offset"],
      "limit": json["limit"],
      "count": json["count"],
      "total": json["total"],
      "jobs": json["jobs"].map(VodJobFromJSON)
    };
  }
  function VodJobPageToJSON(json) {
    return VodJobPageToJSONTyped(json, false);
  }
  function VodJobPageToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "offset": value["offset"],
      "limit": value["limit"],
      "count": value["count"],
      "total": value["total"],
      "jobs": value["jobs"].map(VodJobToJSON)
    };
  }

  // api/sdk/build/gen/models/VodJobRequest.ts
  function instanceOfVodJobRequest(value) {
    if (!("file" in value) || value["file"] === void 0) return false;
    return true;
  }
  function VodJobRequestFromJSON(json) {
    return VodJobRequestFromJSONTyped(json, false);
  }
  function VodJobRequestFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "file": json["file"],
      "streamGroupConfig": json["stream_group_config"] == null ? void 0 : json["stream_group_config"],
      "config": json["config"] == null ? void 0 : ConfigFromJSON(json["config"]),
      "storeResults": json["store_results"] == null ? void 0 : json["store_results"],
      "tag": json["tag"] == null ? void 0 : json["tag"],
      "lifecycleWebhook": json["lifecycle_webhook"] == null ? void 0 : json["lifecycle_webhook"],
      "lifecycleWebhookSecret": json["lifecycle_webhook_secret"] == null ? void 0 : json["lifecycle_webhook_secret"],
      "autoResume": json["auto_resume"] == null ? void 0 : json["auto_resume"]
    };
  }
  function VodJobRequestToJSON(json) {
    return VodJobRequestToJSONTyped(json, false);
  }
  function VodJobRequestToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "file": value["file"],
      "stream_group_config": value["streamGroupConfig"],
      "config": ConfigToJSON(value["config"]),
      "store_results": value["storeResults"],
      "tag": value["tag"],
      "lifecycle_webhook": value["lifecycleWebhook"],
      "lifecycle_webhook_secret": value["lifecycleWebhookSecret"],
      "auto_resume": value["autoResume"]
    };
  }

  // api/sdk/build/gen/models/VodJobResumeRequest.ts
  function instanceOfVodJobResumeRequest(value) {
    return true;
  }
  function VodJobResumeRequestFromJSON(json) {
    return VodJobResumeRequestFromJSONTyped(json, false);
  }
  function VodJobResumeRequestFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "config": json["config"] == null ? void 0 : ConfigFromJSON(json["config"])
    };
  }
  function VodJobResumeRequestToJSON(json) {
    return VodJobResumeRequestToJSONTyped(json, false);
  }
  function VodJobResumeRequestToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "config": ConfigToJSON(value["config"])
    };
  }

  // api/sdk/build/gen/models/VodResultsPage.ts
  function instanceOfVodResultsPage(value) {
    if (!("jobId" in value) || value["jobId"] === void 0) return false;
    if (!("offset" in value) || value["offset"] === void 0) return false;
    if (!("limit" in value) || value["limit"] === void 0) return false;
    if (!("count" in value) || value["count"] === void 0) return false;
    if (!("total" in value) || value["total"] === void 0) return false;
    if (!("results" in value) || value["results"] === void 0) return false;
    return true;
  }
  function VodResultsPageFromJSON(json) {
    return VodResultsPageFromJSONTyped(json, false);
  }
  function VodResultsPageFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "jobId": json["job_id"],
      "offset": json["offset"],
      "limit": json["limit"],
      "count": json["count"],
      "total": json["total"],
      "results": json["results"]
    };
  }
  function VodResultsPageToJSON(json) {
    return VodResultsPageToJSONTyped(json, false);
  }
  function VodResultsPageToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "job_id": value["jobId"],
      "offset": value["offset"],
      "limit": value["limit"],
      "count": value["count"],
      "total": value["total"],
      "results": value["results"]
    };
  }

  // api/sdk/build/gen/models/VodSettings.ts
  function instanceOfVodSettings(value) {
    return true;
  }
  function VodSettingsFromJSON(json) {
    return VodSettingsFromJSONTyped(json, false);
  }
  function VodSettingsFromJSONTyped(json, ignoreDiscriminator) {
    if (json == null) {
      return json;
    }
    return {
      "maxConcurrentJobs": json["max_concurrent_jobs"] == null ? void 0 : json["max_concurrent_jobs"],
      "maxJobs": json["max_jobs"] == null ? void 0 : json["max_jobs"],
      "jobTtlSeconds": json["job_ttl_seconds"] == null ? void 0 : json["job_ttl_seconds"],
      "contentDir": json["content_dir"] == null ? void 0 : json["content_dir"],
      "jobsDir": json["jobs_dir"] == null ? void 0 : json["jobs_dir"],
      "lifecycleWebhook": json["lifecycle_webhook"] == null ? void 0 : json["lifecycle_webhook"],
      "lifecycleWebhookSecret": json["lifecycle_webhook_secret"] == null ? void 0 : json["lifecycle_webhook_secret"],
      "autoResume": json["auto_resume"] == null ? void 0 : json["auto_resume"],
      "maxUploadBytes": json["max_upload_bytes"] == null ? void 0 : json["max_upload_bytes"],
      "etag": json["etag"] == null ? void 0 : json["etag"]
    };
  }
  function VodSettingsToJSON(json) {
    return VodSettingsToJSONTyped(json, false);
  }
  function VodSettingsToJSONTyped(value, ignoreDiscriminator = false) {
    if (value == null) {
      return value;
    }
    return {
      "max_concurrent_jobs": value["maxConcurrentJobs"],
      "max_jobs": value["maxJobs"],
      "job_ttl_seconds": value["jobTtlSeconds"],
      "content_dir": value["contentDir"],
      "jobs_dir": value["jobsDir"],
      "lifecycle_webhook": value["lifecycleWebhook"],
      "lifecycle_webhook_secret": value["lifecycleWebhookSecret"],
      "auto_resume": value["autoResume"],
      "max_upload_bytes": value["maxUploadBytes"],
      "etag": value["etag"]
    };
  }

  // api/sdk/build/gen/apis/PersistApi.ts
  var PersistApi = class extends BaseAPI {
    /**
     * The listener\'s name travels in the body\'s `name` member, required here (`400` without it). `409` when a listener with that name already exists. Creates the override when the stream has none. 
     * Create a saved listener (and apply if running)
     */
    async createPersistedListenerRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling createPersistedListener().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling createPersistedListener().'
        );
      }
      if (requestParameters["listener"] == null) {
        throw new RequiredError(
          "listener",
          'Required parameter "listener" was null or undefined when calling createPersistedListener().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/json";
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}/listeners`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "POST",
        headers: headerParameters,
        query: queryParameters,
        body: ListenerToJSON(requestParameters["listener"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => ListenerFromJSON(jsonValue));
    }
    /**
     * The listener\'s name travels in the body\'s `name` member, required here (`400` without it). `409` when a listener with that name already exists. Creates the override when the stream has none. 
     * Create a saved listener (and apply if running)
     */
    async createPersistedListener(app, stream, listener, initOverrides) {
      const response = await this.createPersistedListenerRaw({ app, stream, listener }, initOverrides);
      return await response.value();
    }
    /**
     * Creates the override document and applies it if the stream is running; `409` when the stream already has one. Works for streams that are not running — the override takes effect when the stream starts. Edits go through PATCH. 
     * Create the stream\'s override
     */
    async createStreamConfigOverrideRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling createStreamConfigOverride().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling createStreamConfigOverride().'
        );
      }
      if (requestParameters["streamConfigOverride"] == null) {
        throw new RequiredError(
          "streamConfigOverride",
          'Required parameter "streamConfigOverride" was null or undefined when calling createStreamConfigOverride().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/json";
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "POST",
        headers: headerParameters,
        query: queryParameters,
        body: StreamConfigOverrideToJSON(requestParameters["streamConfigOverride"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamConfigOverrideFromJSON(jsonValue));
    }
    /**
     * Creates the override document and applies it if the stream is running; `409` when the stream already has one. Works for streams that are not running — the override takes effect when the stream starts. Edits go through PATCH. 
     * Create the stream\'s override
     */
    async createStreamConfigOverride(app, stream, streamConfigOverride, initOverrides) {
      const response = await this.createStreamConfigOverrideRaw({ app, stream, streamConfigOverride }, initOverrides);
      return await response.value();
    }
    /**
     * `name`, `match.application` and `match.stream_pattern` are required (`400` without them). `409` when a stream group config already answers to that name, and for the reserved name `default`. 
     * Create a stream group config
     */
    async createStreamGroupConfigRaw(requestParameters, initOverrides) {
      if (requestParameters["streamGroupConfig"] == null) {
        throw new RequiredError(
          "streamGroupConfig",
          'Required parameter "streamGroupConfig" was null or undefined when calling createStreamGroupConfig().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/json";
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/stream-group-configs`,
        method: "POST",
        headers: headerParameters,
        query: queryParameters,
        body: StreamGroupConfigToJSON(requestParameters["streamGroupConfig"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamGroupConfigFromJSON(jsonValue));
    }
    /**
     * `name`, `match.application` and `match.stream_pattern` are required (`400` without them). `409` when a stream group config already answers to that name, and for the reserved name `default`. 
     * Create a stream group config
     */
    async createStreamGroupConfig(streamGroupConfig, initOverrides) {
      const response = await this.createStreamGroupConfigRaw({ streamGroupConfig }, initOverrides);
      return await response.value();
    }
    /**
     * Remove the detector from the override (inherit the group\'s)
     */
    async deletePersistedDetectorRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling deletePersistedDetector().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling deletePersistedDetector().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling deletePersistedDetector().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}/detector`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "DELETE",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new VoidApiResponse(response);
    }
    /**
     * Remove the detector from the override (inherit the group\'s)
     */
    async deletePersistedDetector(app, stream, ifMatch, initOverrides) {
      await this.deletePersistedDetectorRaw({ app, stream, ifMatch }, initOverrides);
    }
    /**
     * Remove a saved listener
     */
    async deletePersistedListenerRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling deletePersistedListener().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling deletePersistedListener().'
        );
      }
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling deletePersistedListener().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling deletePersistedListener().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}/listeners/{name}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))).replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "DELETE",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new VoidApiResponse(response);
    }
    /**
     * Remove a saved listener
     */
    async deletePersistedListener(app, stream, name, ifMatch, initOverrides) {
      await this.deletePersistedListenerRaw({ app, stream, name, ifMatch }, initOverrides);
    }
    /**
     * Delete the stream\'s override (fall back to its stream group config)
     */
    async deleteStreamConfigOverrideRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling deleteStreamConfigOverride().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling deleteStreamConfigOverride().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling deleteStreamConfigOverride().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "DELETE",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new VoidApiResponse(response);
    }
    /**
     * Delete the stream\'s override (fall back to its stream group config)
     */
    async deleteStreamConfigOverride(app, stream, ifMatch, initOverrides) {
      await this.deleteStreamConfigOverrideRaw({ app, stream, ifMatch }, initOverrides);
    }
    /**
     * The streams it governs fall back to what the remaining layers resolve to, without republishing. `409` for the reserved `default` config, which cannot be deleted.
     * Delete a stream group config
     */
    async deleteStreamGroupConfigRaw(requestParameters, initOverrides) {
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling deleteStreamGroupConfig().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling deleteStreamGroupConfig().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/stream-group-configs/{name}`.replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "DELETE",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new VoidApiResponse(response);
    }
    /**
     * The streams it governs fall back to what the remaining layers resolve to, without republishing. `409` for the reserved `default` config, which cannot be deleted.
     * Delete a stream group config
     */
    async deleteStreamGroupConfig(name, ifMatch, initOverrides) {
      await this.deleteStreamGroupConfigRaw({ name, ifMatch }, initOverrides);
    }
    /**
     * The default config (baseline settings every stream inherits)
     */
    async getDefaultConfigRaw(initOverrides) {
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/configs/default`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => DefaultConfigFromJSON(jsonValue));
    }
    /**
     * The default config (baseline settings every stream inherits)
     */
    async getDefaultConfig(initOverrides) {
      const response = await this.getDefaultConfigRaw(initOverrides);
      return await response.value();
    }
    /**
     * `404` means the override does not set a detector — its stream group config\'s applies.
     * The detector saved in the stream\'s override
     */
    async getPersistedDetectorRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling getPersistedDetector().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling getPersistedDetector().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}/detector`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => DetectorFromJSON(jsonValue));
    }
    /**
     * `404` means the override does not set a detector — its stream group config\'s applies.
     * The detector saved in the stream\'s override
     */
    async getPersistedDetector(app, stream, initOverrides) {
      const response = await this.getPersistedDetectorRaw({ app, stream }, initOverrides);
      return await response.value();
    }
    /**
     * One saved listener
     */
    async getPersistedListenerRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling getPersistedListener().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling getPersistedListener().'
        );
      }
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling getPersistedListener().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}/listeners/{name}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))).replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => ListenerFromJSON(jsonValue));
    }
    /**
     * One saved listener
     */
    async getPersistedListener(app, stream, name, initOverrides) {
      const response = await this.getPersistedListenerRaw({ app, stream, name }, initOverrides);
      return await response.value();
    }
    /**
     * The credentials a job\'s lifecycle webhook may be authorized with, by name only — a value never leaves the Engine. Stored in `conf.modules/vif/vod/secrets.json`.
     * The names of the configured secrets
     */
    async getSecretsRaw(initOverrides) {
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/secrets`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => SecretsFromJSON(jsonValue));
    }
    /**
     * The credentials a job\'s lifecycle webhook may be authorized with, by name only — a value never leaves the Engine. Stored in `conf.modules/vif/vod/secrets.json`.
     * The names of the configured secrets
     */
    async getSecrets(initOverrides) {
      const response = await this.getSecretsRaw(initOverrides);
      return await response.value();
    }
    /**
     * `404` means the stream has no override — it follows its stream group config entirely.
     * The stream\'s saved override document
     */
    async getStreamConfigOverrideRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling getStreamConfigOverride().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling getStreamConfigOverride().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamConfigOverrideFromJSON(jsonValue));
    }
    /**
     * `404` means the stream has no override — it follows its stream group config entirely.
     * The stream\'s saved override document
     */
    async getStreamConfigOverride(app, stream, initOverrides) {
      const response = await this.getStreamConfigOverrideRaw({ app, stream }, initOverrides);
      return await response.value();
    }
    /**
     * One stream group config
     */
    async getStreamGroupConfigRaw(requestParameters, initOverrides) {
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling getStreamGroupConfig().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/stream-group-configs/{name}`.replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamGroupConfigFromJSON(jsonValue));
    }
    /**
     * One stream group config
     */
    async getStreamGroupConfig(name, initOverrides) {
      const response = await this.getStreamGroupConfigRaw({ name }, initOverrides);
      return await response.value();
    }
    /**
     * How this Engine runs on-demand analysis: how many jobs run at once and how many are kept, how long a finished job stays, where the content and the job records live, the default lifecycle webhook and its credential, whether jobs resume on their own, and the upload cap. Stored in its own file, `conf.modules/vif/vod/settings.json`, beside the stream configuration and never part of it.
     * The VOD settings document
     */
    async getVodSettingsRaw(initOverrides) {
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/vod-settings`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodSettingsFromJSON(jsonValue));
    }
    /**
     * How this Engine runs on-demand analysis: how many jobs run at once and how many are kept, how long a finished job stays, where the content and the job records live, the default lifecycle webhook and its credential, whether jobs resume on their own, and the upload cap. Stored in its own file, `conf.modules/vif/vod/settings.json`, beside the stream configuration and never part of it.
     * The VOD settings document
     */
    async getVodSettings(initOverrides) {
      const response = await this.getVodSettingsRaw(initOverrides);
      return await response.value();
    }
    /**
     * `404` when the stream has no override, like its sibling aspects.
     * The listeners saved in the stream\'s override, keyed by name
     */
    async listPersistedListenersRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling listPersistedListeners().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling listPersistedListeners().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}/listeners`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => mapValues(jsonValue, ListenerFromJSON));
    }
    /**
     * `404` when the stream has no override, like its sibling aspects.
     * The listeners saved in the stream\'s override, keyed by name
     */
    async listPersistedListeners(app, stream, initOverrides) {
      const response = await this.listPersistedListenersRaw({ app, stream }, initOverrides);
      return await response.value();
    }
    /**
     * Every stored override at once, so a client can enumerate saved configuration without knowing the stream names in advance. Each entry carries its stream\'s identity in `application` and `stream` and its own `etag`; the documents themselves are read and written one at a time under `/persist/apps/{app}/streams/{stream}`.
     * List the saved per-stream overrides
     */
    async listStreamConfigOverridesRaw(requestParameters, initOverrides) {
      const queryParameters = {};
      if (requestParameters["application"] != null) {
        queryParameters["application"] = requestParameters["application"];
      }
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/stream-config-overrides`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => jsonValue.map(StreamConfigOverrideFromJSON));
    }
    /**
     * Every stored override at once, so a client can enumerate saved configuration without knowing the stream names in advance. Each entry carries its stream\'s identity in `application` and `stream` and its own `etag`; the documents themselves are read and written one at a time under `/persist/apps/{app}/streams/{stream}`.
     * List the saved per-stream overrides
     */
    async listStreamConfigOverrides(application, initOverrides) {
      const response = await this.listStreamConfigOverridesRaw({ application }, initOverrides);
      return await response.value();
    }
    /**
     * List stream group configs (saved configurations applied to matching streams)
     */
    async listStreamGroupConfigsRaw(requestParameters, initOverrides) {
      const queryParameters = {};
      if (requestParameters["application"] != null) {
        queryParameters["application"] = requestParameters["application"];
      }
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/stream-group-configs`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => jsonValue.map(StreamGroupConfigFromJSON));
    }
    /**
     * List stream group configs (saved configurations applied to matching streams)
     */
    async listStreamGroupConfigs(application, initOverrides) {
      const response = await this.listStreamGroupConfigsRaw({ application }, initOverrides);
      return await response.value();
    }
    /**
     * Update fields of the default config
     */
    async updateDefaultConfigRaw(requestParameters, initOverrides) {
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updateDefaultConfig().'
        );
      }
      if (requestParameters["defaultConfig"] == null) {
        throw new RequiredError(
          "defaultConfig",
          'Required parameter "defaultConfig" was null or undefined when calling updateDefaultConfig().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/configs/default`,
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: DefaultConfigToJSON(requestParameters["defaultConfig"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => DefaultConfigFromJSON(jsonValue));
    }
    /**
     * Update fields of the default config
     */
    async updateDefaultConfig(ifMatch, defaultConfig, initOverrides) {
      const response = await this.updateDefaultConfigRaw({ ifMatch, defaultConfig }, initOverrides);
      return await response.value();
    }
    /**
     * JSON Merge Patch within the saved detector. A patch that changes `type` replaces the whole detector section. `404` when the override sets no detector — add one by patching the override document with `{\"config\": {\"detector\": {...}}}`. 
     * Update saved detector fields
     */
    async updatePersistedDetectorRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling updatePersistedDetector().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling updatePersistedDetector().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updatePersistedDetector().'
        );
      }
      if (requestParameters["detector"] == null) {
        throw new RequiredError(
          "detector",
          'Required parameter "detector" was null or undefined when calling updatePersistedDetector().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}/detector`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: DetectorToJSON(requestParameters["detector"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => DetectorFromJSON(jsonValue));
    }
    /**
     * JSON Merge Patch within the saved detector. A patch that changes `type` replaces the whole detector section. `404` when the override sets no detector — add one by patching the override document with `{\"config\": {\"detector\": {...}}}`. 
     * Update saved detector fields
     */
    async updatePersistedDetector(app, stream, ifMatch, detector, initOverrides) {
      const response = await this.updatePersistedDetectorRaw({ app, stream, ifMatch, detector }, initOverrides);
      return await response.value();
    }
    /**
     * Update saved listener fields
     */
    async updatePersistedListenerRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling updatePersistedListener().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling updatePersistedListener().'
        );
      }
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling updatePersistedListener().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updatePersistedListener().'
        );
      }
      if (requestParameters["listener"] == null) {
        throw new RequiredError(
          "listener",
          'Required parameter "listener" was null or undefined when calling updatePersistedListener().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}/listeners/{name}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))).replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: ListenerToJSON(requestParameters["listener"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => ListenerFromJSON(jsonValue));
    }
    /**
     * Update saved listener fields
     */
    async updatePersistedListener(app, stream, name, ifMatch, listener, initOverrides) {
      const response = await this.updatePersistedListenerRaw({ app, stream, name, ifMatch, listener }, initOverrides);
      return await response.value();
    }
    /**
     * A merge patch over `values`: a string sets or rotates the named secret, `null` removes it, a name not mentioned is kept. The revision covers the values, so a rotation changes the `ETag` even though the answer shows names only. `400` when a removal would leave the VOD settings\' `lifecycle_webhook_secret` naming nothing.
     * Set, rotate or remove secrets
     */
    async updateSecretsRaw(requestParameters, initOverrides) {
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updateSecrets().'
        );
      }
      if (requestParameters["secrets"] == null) {
        throw new RequiredError(
          "secrets",
          'Required parameter "secrets" was null or undefined when calling updateSecrets().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/secrets`,
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: SecretsToJSON(requestParameters["secrets"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => SecretsFromJSON(jsonValue));
    }
    /**
     * A merge patch over `values`: a string sets or rotates the named secret, `null` removes it, a name not mentioned is kept. The revision covers the values, so a rotation changes the `ETag` even though the answer shows names only. `400` when a removal would leave the VOD settings\' `lifecycle_webhook_secret` naming nothing.
     * Set, rotate or remove secrets
     */
    async updateSecrets(ifMatch, secrets, initOverrides) {
      const response = await this.updateSecretsRaw({ ifMatch, secrets }, initOverrides);
      return await response.value();
    }
    /**
     * Update fields of the stream\'s override
     */
    async updateStreamConfigOverrideRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling updateStreamConfigOverride().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling updateStreamConfigOverride().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updateStreamConfigOverride().'
        );
      }
      if (requestParameters["streamConfigOverride"] == null) {
        throw new RequiredError(
          "streamConfigOverride",
          'Required parameter "streamConfigOverride" was null or undefined when calling updateStreamConfigOverride().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/apps/{app}/streams/{stream}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: StreamConfigOverrideToJSON(requestParameters["streamConfigOverride"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamConfigOverrideFromJSON(jsonValue));
    }
    /**
     * Update fields of the stream\'s override
     */
    async updateStreamConfigOverride(app, stream, ifMatch, streamConfigOverride, initOverrides) {
      const response = await this.updateStreamConfigOverrideRaw({ app, stream, ifMatch, streamConfigOverride }, initOverrides);
      return await response.value();
    }
    /**
     * The match rule can be rewritten freely; the name cannot, because it is the group\'s identity — a patch that changes it is a `409`. A patch that leaves the group without `match.application` or `match.stream_pattern` is a `400`. 
     * Update fields of a stream group config
     */
    async updateStreamGroupConfigRaw(requestParameters, initOverrides) {
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling updateStreamGroupConfig().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updateStreamGroupConfig().'
        );
      }
      if (requestParameters["streamGroupConfig"] == null) {
        throw new RequiredError(
          "streamGroupConfig",
          'Required parameter "streamGroupConfig" was null or undefined when calling updateStreamGroupConfig().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/stream-group-configs/{name}`.replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: StreamGroupConfigToJSON(requestParameters["streamGroupConfig"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamGroupConfigFromJSON(jsonValue));
    }
    /**
     * The match rule can be rewritten freely; the name cannot, because it is the group\'s identity — a patch that changes it is a `409`. A patch that leaves the group without `match.application` or `match.stream_pattern` is a `400`. 
     * Update fields of a stream group config
     */
    async updateStreamGroupConfig(name, ifMatch, streamGroupConfig, initOverrides) {
      const response = await this.updateStreamGroupConfigRaw({ name, ifMatch, streamGroupConfig }, initOverrides);
      return await response.value();
    }
    /**
     * A merge patch, applied to the running registry at once — a smaller `max_jobs` evicts, a new `job_ttl_seconds` reschedules retention, a new webhook or default takes effect for the next job. `content_dir` and `jobs_dir` are read at Engine start and apply at the next one. `400` for a bound violation or a `lifecycle_webhook_secret` naming no configured secret.
     * Edit the VOD settings
     */
    async updateVodSettingsRaw(requestParameters, initOverrides) {
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updateVodSettings().'
        );
      }
      if (requestParameters["vodSettings"] == null) {
        throw new RequiredError(
          "vodSettings",
          'Required parameter "vodSettings" was null or undefined when calling updateVodSettings().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/persist/vod-settings`,
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: VodSettingsToJSON(requestParameters["vodSettings"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodSettingsFromJSON(jsonValue));
    }
    /**
     * A merge patch, applied to the running registry at once — a smaller `max_jobs` evicts, a new `job_ttl_seconds` reschedules retention, a new webhook or default takes effect for the next job. `content_dir` and `jobs_dir` are read at Engine start and apply at the next one. `400` for a bound violation or a `lifecycle_webhook_secret` naming no configured secret.
     * Edit the VOD settings
     */
    async updateVodSettings(ifMatch, vodSettings, initOverrides) {
      const response = await this.updateVodSettingsRaw({ ifMatch, vodSettings }, initOverrides);
      return await response.value();
    }
  };

  // api/sdk/build/gen/apis/ProbesApi.ts
  var ProbesApi = class extends BaseAPI {
    /**
     * Check connectivity to an OpenAI-compatible VLM endpoint
     */
    async probeVlmEndpointRaw(requestParameters, initOverrides) {
      if (requestParameters["vlmEndpointProbeRequest"] == null) {
        throw new RequiredError(
          "vlmEndpointProbeRequest",
          'Required parameter "vlmEndpointProbeRequest" was null or undefined when calling probeVlmEndpoint().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/json";
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/probes/vlm-endpoint`,
        method: "POST",
        headers: headerParameters,
        query: queryParameters,
        body: VlmEndpointProbeRequestToJSON(requestParameters["vlmEndpointProbeRequest"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VlmEndpointProbeResultFromJSON(jsonValue));
    }
    /**
     * Check connectivity to an OpenAI-compatible VLM endpoint
     */
    async probeVlmEndpoint(vlmEndpointProbeRequest, initOverrides) {
      const response = await this.probeVlmEndpointRaw({ vlmEndpointProbeRequest }, initOverrides);
      return await response.value();
    }
  };

  // api/sdk/build/gen/apis/RuntimeApi.ts
  var RuntimeApi = class extends BaseAPI {
    /**
     * The listener\'s name travels in the body\'s `name` member, required here (`400` without it). `409` when a listener with that name already exists. 
     * Add a listener to the running instance only (ephemeral)
     */
    async createRuntimeListenerRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling createRuntimeListener().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling createRuntimeListener().'
        );
      }
      if (requestParameters["listener"] == null) {
        throw new RequiredError(
          "listener",
          'Required parameter "listener" was null or undefined when calling createRuntimeListener().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/json";
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/listeners`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "POST",
        headers: headerParameters,
        query: queryParameters,
        body: ListenerToJSON(requestParameters["listener"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => ListenerFromJSON(jsonValue));
    }
    /**
     * The listener\'s name travels in the body\'s `name` member, required here (`400` without it). `409` when a listener with that name already exists. 
     * Add a listener to the running instance only (ephemeral)
     */
    async createRuntimeListener(app, stream, listener, initOverrides) {
      const response = await this.createRuntimeListenerRaw({ app, stream, listener }, initOverrides);
      return await response.value();
    }
    /**
     * Remove a listener from the running instance only (ephemeral)
     */
    async deleteRuntimeListenerRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling deleteRuntimeListener().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling deleteRuntimeListener().'
        );
      }
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling deleteRuntimeListener().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling deleteRuntimeListener().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/listeners/{name}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))).replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "DELETE",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new VoidApiResponse(response);
    }
    /**
     * Remove a listener from the running instance only (ephemeral)
     */
    async deleteRuntimeListener(app, stream, name, ifMatch, initOverrides) {
      await this.deleteRuntimeListenerRaw({ app, stream, name, ifMatch }, initOverrides);
    }
    /**
     * The running stream\'s effective detector
     */
    async getRuntimeDetectorRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling getRuntimeDetector().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling getRuntimeDetector().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/detector`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => DetectorFromJSON(jsonValue));
    }
    /**
     * The running stream\'s effective detector
     */
    async getRuntimeDetector(app, stream, initOverrides) {
      const response = await this.getRuntimeDetectorRaw({ app, stream }, initOverrides);
      return await response.value();
    }
    /**
     * One effective listener
     */
    async getRuntimeListenerRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling getRuntimeListener().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling getRuntimeListener().'
        );
      }
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling getRuntimeListener().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/listeners/{name}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))).replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => ListenerFromJSON(jsonValue));
    }
    /**
     * One effective listener
     */
    async getRuntimeListener(app, stream, name, initOverrides) {
      const response = await this.getRuntimeListenerRaw({ app, stream, name }, initOverrides);
      return await response.value();
    }
    /**
     * One running stream — effective config, health and performance
     */
    async getRuntimeStreamRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling getRuntimeStream().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling getRuntimeStream().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamFromJSON(jsonValue));
    }
    /**
     * One running stream — effective config, health and performance
     */
    async getRuntimeStream(app, stream, initOverrides) {
      const response = await this.getRuntimeStreamRaw({ app, stream }, initOverrides);
      return await response.value();
    }
    /**
     * The latest decoded frame, or a given one. `404` when the stream is not running or has produced no frame yet.
     * Thumbnail image of the running stream
     */
    async getThumbnailRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling getThumbnail().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling getThumbnail().'
        );
      }
      const queryParameters = {};
      if (requestParameters["width"] != null) {
        queryParameters["width"] = requestParameters["width"];
      }
      if (requestParameters["height"] != null) {
        queryParameters["height"] = requestParameters["height"];
      }
      if (requestParameters["fit"] != null) {
        queryParameters["fit"] = requestParameters["fit"];
      }
      if (requestParameters["format"] != null) {
        queryParameters["format"] = requestParameters["format"];
      }
      if (requestParameters["frameId"] != null) {
        queryParameters["frame_id"] = requestParameters["frameId"];
      }
      if (requestParameters["overlay"] != null) {
        queryParameters["overlay"] = requestParameters["overlay"];
      }
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/thumbnail`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new BlobApiResponse(response);
    }
    /**
     * The latest decoded frame, or a given one. `404` when the stream is not running or has produced no frame yet.
     * Thumbnail image of the running stream
     */
    async getThumbnail(app, stream, width, height, fit, format, frameId, overlay, initOverrides) {
      const response = await this.getThumbnailRaw({ app, stream, width, height, fit, format, frameId, overlay }, initOverrides);
      return await response.value();
    }
    /**
     * The running stream\'s effective listeners
     */
    async listRuntimeListenersRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling listRuntimeListeners().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling listRuntimeListeners().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/listeners`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => mapValues(jsonValue, ListenerFromJSON));
    }
    /**
     * The running stream\'s effective listeners
     */
    async listRuntimeListeners(app, stream, initOverrides) {
      const response = await this.listRuntimeListenersRaw({ app, stream }, initOverrides);
      return await response.value();
    }
    /**
     * List running streams
     */
    async listRuntimeStreamsRaw(requestParameters, initOverrides) {
      const queryParameters = {};
      if (requestParameters["application"] != null) {
        queryParameters["application"] = requestParameters["application"];
      }
      if (requestParameters["detector"] != null) {
        queryParameters["detector"] = requestParameters["detector"];
      }
      if (requestParameters["active"] != null) {
        queryParameters["active"] = requestParameters["active"];
      }
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/streams`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => jsonValue.map(StreamFromJSON));
    }
    /**
     * List running streams
     */
    async listRuntimeStreams(application, detector, active, initOverrides) {
      const response = await this.listRuntimeStreamsRaw({ application, detector, active }, initOverrides);
      return await response.value();
    }
    /**
     * Action endpoint: reverts the running instance to its persisted configuration (stream group config plus override) and applies it live, immediately — restarting the detector session when the change calls for it, never the stream itself. Returns the resulting stream — fresh state and `ETag`, so the client needs no follow-up GET. Idempotent — succeeds whether or not ephemeral changes exist. No `If-Match`: this is an action, not a conditional edit. 
     * Discard the stream\'s ephemeral changes
     */
    async resetRuntimeStreamRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling resetRuntimeStream().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling resetRuntimeStream().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/reset`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "POST",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamFromJSON(jsonValue));
    }
    /**
     * Action endpoint: reverts the running instance to its persisted configuration (stream group config plus override) and applies it live, immediately — restarting the detector session when the change calls for it, never the stream itself. Returns the resulting stream — fresh state and `ETag`, so the client needs no follow-up GET. Idempotent — succeeds whether or not ephemeral changes exist. No `If-Match`: this is an action, not a conditional edit. 
     * Discard the stream\'s ephemeral changes
     */
    async resetRuntimeStream(app, stream, initOverrides) {
      const response = await this.resetRuntimeStreamRaw({ app, stream }, initOverrides);
      return await response.value();
    }
    /**
     * JSON Merge Patch within the detector, memory only. A patch that changes `type` replaces the whole detector section. `404` when the stream is not running or runs no detector. 
     * Change detector fields on the running instance only (ephemeral)
     */
    async updateRuntimeDetectorRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling updateRuntimeDetector().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling updateRuntimeDetector().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updateRuntimeDetector().'
        );
      }
      if (requestParameters["detector"] == null) {
        throw new RequiredError(
          "detector",
          'Required parameter "detector" was null or undefined when calling updateRuntimeDetector().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/detector`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: DetectorToJSON(requestParameters["detector"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => DetectorFromJSON(jsonValue));
    }
    /**
     * JSON Merge Patch within the detector, memory only. A patch that changes `type` replaces the whole detector section. `404` when the stream is not running or runs no detector. 
     * Change detector fields on the running instance only (ephemeral)
     */
    async updateRuntimeDetector(app, stream, ifMatch, detector, initOverrides) {
      const response = await this.updateRuntimeDetectorRaw({ app, stream, ifMatch, detector }, initOverrides);
      return await response.value();
    }
    /**
     * Change listener fields on the running instance only (ephemeral)
     */
    async updateRuntimeListenerRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling updateRuntimeListener().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling updateRuntimeListener().'
        );
      }
      if (requestParameters["name"] == null) {
        throw new RequiredError(
          "name",
          'Required parameter "name" was null or undefined when calling updateRuntimeListener().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updateRuntimeListener().'
        );
      }
      if (requestParameters["listener"] == null) {
        throw new RequiredError(
          "listener",
          'Required parameter "listener" was null or undefined when calling updateRuntimeListener().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}/listeners/{name}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))).replace(`{${"name"}}`, encodeURIComponent(String(requestParameters["name"]))),
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: ListenerToJSON(requestParameters["listener"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => ListenerFromJSON(jsonValue));
    }
    /**
     * Change listener fields on the running instance only (ephemeral)
     */
    async updateRuntimeListener(app, stream, name, ifMatch, listener, initOverrides) {
      const response = await this.updateRuntimeListenerRaw({ app, stream, name, ifMatch, listener }, initOverrides);
      return await response.value();
    }
    /**
     * JSON Merge Patch over the stream\'s config, applied to the running instance and never saved: a stream or Engine restart reverts it. The body is `{\"config\": {…}}`; a member at the top level other than `config` (and the `etag` a listed document carries, which is ignored) is a `400`. `config.detector` and `config.listeners` have their own subresources; naming either one here is a `409`. 
     * Change stream settings on the running instance only (ephemeral)
     */
    async updateRuntimeStreamRaw(requestParameters, initOverrides) {
      if (requestParameters["app"] == null) {
        throw new RequiredError(
          "app",
          'Required parameter "app" was null or undefined when calling updateRuntimeStream().'
        );
      }
      if (requestParameters["stream"] == null) {
        throw new RequiredError(
          "stream",
          'Required parameter "stream" was null or undefined when calling updateRuntimeStream().'
        );
      }
      if (requestParameters["ifMatch"] == null) {
        throw new RequiredError(
          "ifMatch",
          'Required parameter "ifMatch" was null or undefined when calling updateRuntimeStream().'
        );
      }
      if (requestParameters["streamSettings"] == null) {
        throw new RequiredError(
          "streamSettings",
          'Required parameter "streamSettings" was null or undefined when calling updateRuntimeStream().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/merge-patch+json";
      if (requestParameters["ifMatch"] != null) {
        headerParameters["If-Match"] = String(requestParameters["ifMatch"]);
      }
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/runtime/apps/{app}/streams/{stream}`.replace(`{${"app"}}`, encodeURIComponent(String(requestParameters["app"]))).replace(`{${"stream"}}`, encodeURIComponent(String(requestParameters["stream"]))),
        method: "PATCH",
        headers: headerParameters,
        query: queryParameters,
        body: StreamSettingsToJSON(requestParameters["streamSettings"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => StreamFromJSON(jsonValue));
    }
    /**
     * JSON Merge Patch over the stream\'s config, applied to the running instance and never saved: a stream or Engine restart reverts it. The body is `{\"config\": {…}}`; a member at the top level other than `config` (and the `etag` a listed document carries, which is ignored) is a `400`. `config.detector` and `config.listeners` have their own subresources; naming either one here is a `409`. 
     * Change stream settings on the running instance only (ephemeral)
     */
    async updateRuntimeStream(app, stream, ifMatch, streamSettings, initOverrides) {
      const response = await this.updateRuntimeStreamRaw({ app, stream, ifMatch, streamSettings }, initOverrides);
      return await response.value();
    }
  };

  // api/sdk/build/gen/apis/ServerApi.ts
  var ServerApi = class extends BaseAPI {
    /**
     * Detection models available on the connected VIS instances
     */
    async getModelCatalogRaw(initOverrides) {
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/models`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => ModelCatalogFromJSON(jsonValue));
    }
    /**
     * Detection models available on the connected VIS instances
     */
    async getModelCatalog(initOverrides) {
      const response = await this.getModelCatalogRaw(initOverrides);
      return await response.value();
    }
    /**
     * Framework status — host, running streams, connected VIS instances
     */
    async getServerStatusRaw(initOverrides) {
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/status`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => ServerStatusFromJSON(jsonValue));
    }
    /**
     * Framework status — host, running streams, connected VIS instances
     */
    async getServerStatus(initOverrides) {
      const response = await this.getServerStatusRaw(initOverrides);
      return await response.value();
    }
    /**
     * The listener implementations discovered on this Engine — what a config UI offers as the choices for a custom listener\'s `class_name`. Advisory, not a gate: discovery scans the Engine\'s own lib path, and a class it misses can still run.
     * Listener implementations discovered on this Engine
     */
    async listListenerTypesRaw(initOverrides) {
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/listener-types`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => jsonValue.map(ListenerTypeFromJSON));
    }
    /**
     * The listener implementations discovered on this Engine — what a config UI offers as the choices for a custom listener\'s `class_name`. Advisory, not a gate: discovery scans the Engine\'s own lib path, and a class it misses can still run.
     * Listener implementations discovered on this Engine
     */
    async listListenerTypes(initOverrides) {
      const response = await this.listListenerTypesRaw(initOverrides);
      return await response.value();
    }
  };

  // api/sdk/build/gen/apis/VodApi.ts
  var VodApi = class extends BaseAPI {
    /**
     * The job settles to `cancelled` off this request and keeps its record and stored rows; removing those is what `DELETE` is for. `409` for a job already in a terminal state — a cancel that raced completion says the job completed rather than pretend it stopped anything.
     * Stop a queued or running job
     */
    async cancelVodJobRaw(requestParameters, initOverrides) {
      if (requestParameters["jobId"] == null) {
        throw new RequiredError(
          "jobId",
          'Required parameter "jobId" was null or undefined when calling cancelVodJob().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs/{jobId}/cancel`.replace(`{${"jobId"}}`, encodeURIComponent(String(requestParameters["jobId"]))),
        method: "POST",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodJobFromJSON(jsonValue));
    }
    /**
     * The job settles to `cancelled` off this request and keeps its record and stored rows; removing those is what `DELETE` is for. `409` for a job already in a terminal state — a cancel that raced completion says the job completed rather than pretend it stopped anything.
     * Stop a queued or running job
     */
    async cancelVodJob(jobId, initOverrides) {
      const response = await this.cancelVodJobRaw({ jobId }, initOverrides);
      return await response.value();
    }
    /**
     * The request body is the file itself; the target name rides the query string because names carry subdirectory slashes. The bytes are written beside the target and renamed into place, so a partial upload is never visible under an analysable name, and the file is in the listing — and submittable — the moment this answers.  Uploads never overwrite: `409` when the name is taken. `400` for no name, an absolute or escaping path, a non-analysable extension, or a path segment a file already occupies. `413` for an upload larger than the VOD settings\' `max_upload_bytes`. 
     * Upload a source file into the content directory
     */
    async createVodFileRaw(requestParameters, initOverrides) {
      if (requestParameters["file"] == null) {
        throw new RequiredError(
          "file",
          'Required parameter "file" was null or undefined when calling createVodFile().'
        );
      }
      if (requestParameters["body"] == null) {
        throw new RequiredError(
          "body",
          'Required parameter "body" was null or undefined when calling createVodFile().'
        );
      }
      const queryParameters = {};
      if (requestParameters["file"] != null) {
        queryParameters["file"] = requestParameters["file"];
      }
      const headerParameters = {};
      headerParameters["Content-Type"] = "video/mp4";
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/files`,
        method: "POST",
        headers: headerParameters,
        query: queryParameters,
        body: requestParameters["body"]
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodFileFromJSON(jsonValue));
    }
    /**
     * The request body is the file itself; the target name rides the query string because names carry subdirectory slashes. The bytes are written beside the target and renamed into place, so a partial upload is never visible under an analysable name, and the file is in the listing — and submittable — the moment this answers.  Uploads never overwrite: `409` when the name is taken. `400` for no name, an absolute or escaping path, a non-analysable extension, or a path segment a file already occupies. `413` for an upload larger than the VOD settings\' `max_upload_bytes`. 
     * Upload a source file into the content directory
     */
    async createVodFile(file, body, initOverrides) {
      const response = await this.createVodFileRaw({ file, body }, initOverrides);
      return await response.value();
    }
    /**
     * Queues an offline analysis of `file`, a path under the content directory as `GET /vod/files` lists it, and answers as soon as the job is queued; progress is polled from the job. The job\'s configuration is resolved when it is submitted, in the same layers a stream\'s is: `default config < stream_group_config < config`. `stream_group_config` names a stream group config (its match rule plays no part — the job uses its config); `config` is an inline config layered over it, or over the default config alone. At least one of the two is required; both are allowed. The layering rules are the contract\'s: a `detector` declared at a layer replaces the whole detector below it, `listeners` layer per entry, everything else field by field. What the job resolved to is recorded on it (`effective_config` on the single-job view) and a later edit of the group never touches a job already submitted.  `400` for anything wrong with the body: a missing or unsupported `file`, an unknown `stream_group_config`, neither configuration member, a configuration that selects no detector or is inactive, no runnable listener together with `store_results: false`, an unusable `lifecycle_webhook` URL, a `lifecycle_webhook_secret` naming no configured secret. `503` when VOD is unavailable on this Engine. 
     * Submit a file for analysis
     */
    async createVodJobRaw(requestParameters, initOverrides) {
      if (requestParameters["vodJobRequest"] == null) {
        throw new RequiredError(
          "vodJobRequest",
          'Required parameter "vodJobRequest" was null or undefined when calling createVodJob().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/json";
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs`,
        method: "POST",
        headers: headerParameters,
        query: queryParameters,
        body: VodJobRequestToJSON(requestParameters["vodJobRequest"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodJobFromJSON(jsonValue));
    }
    /**
     * Queues an offline analysis of `file`, a path under the content directory as `GET /vod/files` lists it, and answers as soon as the job is queued; progress is polled from the job. The job\'s configuration is resolved when it is submitted, in the same layers a stream\'s is: `default config < stream_group_config < config`. `stream_group_config` names a stream group config (its match rule plays no part — the job uses its config); `config` is an inline config layered over it, or over the default config alone. At least one of the two is required; both are allowed. The layering rules are the contract\'s: a `detector` declared at a layer replaces the whole detector below it, `listeners` layer per entry, everything else field by field. What the job resolved to is recorded on it (`effective_config` on the single-job view) and a later edit of the group never touches a job already submitted.  `400` for anything wrong with the body: a missing or unsupported `file`, an unknown `stream_group_config`, neither configuration member, a configuration that selects no detector or is inactive, no runnable listener together with `store_results: false`, an unusable `lifecycle_webhook` URL, a `lifecycle_webhook_secret` naming no configured secret. `503` when VOD is unavailable on this Engine. 
     * Submit a file for analysis
     */
    async createVodJob(vodJobRequest, initOverrides) {
      const response = await this.createVodJobRaw({ vodJobRequest }, initOverrides);
      return await response.value();
    }
    /**
     * The opposite of the upload: the file `?file=` names, exactly as the listing spells it, is removed. Nothing else goes with it — no job record, stored rows or thumbnail, an emptied subdirectory stays, and a symbolic link is removed as the link, never what it points at.  Files are not owned by jobs. A finished job keeps its record and results without its source; a failed or cancelled job on a removed file can no longer be resumed — the resume answers `409` saying the source cannot be resolved, and automatic resume stands down. `409` while a queued or running job is using the file, naming the job: cancel it first, then delete. `404` when no such file is there. `400` for no name, an absolute or escaping path, or a non-analysable extension — the content directory is the Engine\'s playback directory, and this removes only what the listing could show. 
     * Remove a source file from the content directory
     */
    async deleteVodFileRaw(requestParameters, initOverrides) {
      if (requestParameters["file"] == null) {
        throw new RequiredError(
          "file",
          'Required parameter "file" was null or undefined when calling deleteVodFile().'
        );
      }
      const queryParameters = {};
      if (requestParameters["file"] != null) {
        queryParameters["file"] = requestParameters["file"];
      }
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/files`,
        method: "DELETE",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new VoidApiResponse(response);
    }
    /**
     * The opposite of the upload: the file `?file=` names, exactly as the listing spells it, is removed. Nothing else goes with it — no job record, stored rows or thumbnail, an emptied subdirectory stays, and a symbolic link is removed as the link, never what it points at.  Files are not owned by jobs. A finished job keeps its record and results without its source; a failed or cancelled job on a removed file can no longer be resumed — the resume answers `409` saying the source cannot be resolved, and automatic resume stands down. `409` while a queued or running job is using the file, naming the job: cancel it first, then delete. `404` when no such file is there. `400` for no name, an absolute or escaping path, or a non-analysable extension — the content directory is the Engine\'s playback directory, and this removes only what the listing could show. 
     * Remove a source file from the content directory
     */
    async deleteVodFile(file, initOverrides) {
      await this.deleteVodFileRaw({ file }, initOverrides);
    }
    /**
     * Only a job in a terminal state can be removed: `409` for one still queued or running (cancel it first), for one that has just ended and is still writing its record (try again), and for one that was resumed while the removal waited. A removal is never reported that did not happen.
     * Remove a finished job — its record, stored rows and thumbnail
     */
    async deleteVodJobRaw(requestParameters, initOverrides) {
      if (requestParameters["jobId"] == null) {
        throw new RequiredError(
          "jobId",
          'Required parameter "jobId" was null or undefined when calling deleteVodJob().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs/{jobId}`.replace(`{${"jobId"}}`, encodeURIComponent(String(requestParameters["jobId"]))),
        method: "DELETE",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new VoidApiResponse(response);
    }
    /**
     * Only a job in a terminal state can be removed: `409` for one still queued or running (cancel it first), for one that has just ended and is still writing its record (try again), and for one that was resumed while the removal waited. A removal is never reported that did not happen.
     * Remove a finished job — its record, stored rows and thumbnail
     */
    async deleteVodJob(jobId, initOverrides) {
      await this.deleteVodJobRaw({ jobId }, initOverrides);
    }
    /**
     * One job, with the configuration it was given and the one it ran with
     */
    async getVodJobRaw(requestParameters, initOverrides) {
      if (requestParameters["jobId"] == null) {
        throw new RequiredError(
          "jobId",
          'Required parameter "jobId" was null or undefined when calling getVodJob().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs/{jobId}`.replace(`{${"jobId"}}`, encodeURIComponent(String(requestParameters["jobId"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodJobFromJSON(jsonValue));
    }
    /**
     * One job, with the configuration it was given and the one it ran with
     */
    async getVodJob(jobId, initOverrides) {
      const response = await this.getVodJobRaw({ jobId }, initOverrides);
      return await response.value();
    }
    /**
     * The results file itself, one JSON object per line, as an attachment named `<jobId>.jsonl`. A job whose results were compressed at rest is served verbatim under `Content-Encoding: gzip` to a client that accepts it, and decompressed to one that does not; either way what arrives is the same lines. `404` as for the paged results.
     * The job\'s stored detections as one newline-delimited JSON file
     */
    async getVodJobResultsFileRaw(requestParameters, initOverrides) {
      if (requestParameters["jobId"] == null) {
        throw new RequiredError(
          "jobId",
          'Required parameter "jobId" was null or undefined when calling getVodJobResultsFile().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs/{jobId}/results/file`.replace(`{${"jobId"}}`, encodeURIComponent(String(requestParameters["jobId"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new BlobApiResponse(response);
    }
    /**
     * The results file itself, one JSON object per line, as an attachment named `<jobId>.jsonl`. A job whose results were compressed at rest is served verbatim under `Content-Encoding: gzip` to a client that accepts it, and decompressed to one that does not; either way what arrives is the same lines. `404` as for the paged results.
     * The job\'s stored detections as one newline-delimited JSON file
     */
    async getVodJobResultsFile(jobId, initOverrides) {
      const response = await this.getVodJobResultsFileRaw({ jobId }, initOverrides);
      return await response.value();
    }
    /**
     * The job\'s own decoded frame — the size, scaling and encoding the detector was given — so it shows what was analyzed rather than a re-render of the source. `404` when the job is unknown or has no frame to show, which is every job on the clip path (a synthetic detector relays encoded video and never decodes a picture).
     * The frame the job is analyzing, or the one it is represented by once done
     */
    async getVodJobThumbnailRaw(requestParameters, initOverrides) {
      if (requestParameters["jobId"] == null) {
        throw new RequiredError(
          "jobId",
          'Required parameter "jobId" was null or undefined when calling getVodJobThumbnail().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs/{jobId}/thumbnail`.replace(`{${"jobId"}}`, encodeURIComponent(String(requestParameters["jobId"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new BlobApiResponse(response);
    }
    /**
     * The job\'s own decoded frame — the size, scaling and encoding the detector was given — so it shows what was analyzed rather than a re-render of the source. `404` when the job is unknown or has no frame to show, which is every job on the clip path (a synthetic detector relays encoded video and never decodes a picture).
     * The frame the job is analyzing, or the one it is represented by once done
     */
    async getVodJobThumbnail(jobId, initOverrides) {
      const response = await this.getVodJobThumbnailRaw({ jobId }, initOverrides);
      return await response.value();
    }
    /**
     * Every analysable container under the Engine\'s content directory, as the relative paths a job names its `file` by, newest first. At most 500 entries are listed; `truncated: true` marks a listing that was cut off, and the newest files are the ones kept. A listing is not a probe: a file here can still turn out to carry no H.264 track, which the job reports when it runs.
     * List the files a VOD job can analyze
     */
    async listVodFilesRaw(initOverrides) {
      const queryParameters = {};
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/files`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodFileListFromJSON(jsonValue));
    }
    /**
     * Every analysable container under the Engine\'s content directory, as the relative paths a job names its `file` by, newest first. At most 500 entries are listed; `truncated: true` marks a listing that was cut off, and the newest files are the ones kept. A listing is not a probe: a file here can still turn out to carry no H.264 track, which the job reports when it runs.
     * List the files a VOD job can analyze
     */
    async listVodFiles(initOverrides) {
      const response = await this.listVodFilesRaw(initOverrides);
      return await response.value();
    }
    /**
     * Every response the analysis service returned for the job, as the job stored it — media-time stamped and unfiltered by any listener\'s gating — verbatim rows, never reshaped. A job still running serves what it has answered so far. `?from_ms&to_ms` narrow the page to a half-open stretch of the source. `404` when the job is unknown, when it was submitted with `store_results: false`, or when it has not stored a row yet; the `detail` says which.
     * The job\'s stored detections, one page at a time
     */
    async listVodJobResultsRaw(requestParameters, initOverrides) {
      if (requestParameters["jobId"] == null) {
        throw new RequiredError(
          "jobId",
          'Required parameter "jobId" was null or undefined when calling listVodJobResults().'
        );
      }
      const queryParameters = {};
      if (requestParameters["offset"] != null) {
        queryParameters["offset"] = requestParameters["offset"];
      }
      if (requestParameters["limit"] != null) {
        queryParameters["limit"] = requestParameters["limit"];
      }
      if (requestParameters["fromMs"] != null) {
        queryParameters["from_ms"] = requestParameters["fromMs"];
      }
      if (requestParameters["toMs"] != null) {
        queryParameters["to_ms"] = requestParameters["toMs"];
      }
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs/{jobId}/results`.replace(`{${"jobId"}}`, encodeURIComponent(String(requestParameters["jobId"]))),
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodResultsPageFromJSON(jsonValue));
    }
    /**
     * Every response the analysis service returned for the job, as the job stored it — media-time stamped and unfiltered by any listener\'s gating — verbatim rows, never reshaped. A job still running serves what it has answered so far. `?from_ms&to_ms` narrow the page to a half-open stretch of the source. `404` when the job is unknown, when it was submitted with `store_results: false`, or when it has not stored a row yet; the `detail` says which.
     * The job\'s stored detections, one page at a time
     */
    async listVodJobResults(jobId, offset, limit, fromMs, toMs, initOverrides) {
      const response = await this.listVodJobResultsRaw({ jobId, offset, limit, fromMs, toMs }, initOverrides);
      return await response.value();
    }
    /**
     * Newest first, one page at a time. The `tag` and `state` filters are applied before the page is taken, so `total` is what they selected and `?state=pending&limit=1` is a queue depth. A listing is a reading, not a subscription: a job can leave the state it was selected for before the answer is read. Finished jobs stay listed until the retention settings evict them or a `DELETE` removes them.
     * List the jobs this Engine knows about
     */
    async listVodJobsRaw(requestParameters, initOverrides) {
      const queryParameters = {};
      if (requestParameters["tag"] != null) {
        queryParameters["tag"] = requestParameters["tag"];
      }
      if (requestParameters["state"] != null) {
        queryParameters["state"] = requestParameters["state"];
      }
      if (requestParameters["offset"] != null) {
        queryParameters["offset"] = requestParameters["offset"];
      }
      if (requestParameters["limit"] != null) {
        queryParameters["limit"] = requestParameters["limit"];
      }
      const headerParameters = {};
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs`,
        method: "GET",
        headers: headerParameters,
        query: queryParameters
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodJobPageFromJSON(jsonValue));
    }
    /**
     * Newest first, one page at a time. The `tag` and `state` filters are applied before the page is taken, so `total` is what they selected and `?state=pending&limit=1` is a queue depth. A listing is a reading, not a subscription: a job can leave the state it was selected for before the answer is read. Finished jobs stay listed until the retention settings evict them or a `DELETE` removes them.
     * List the jobs this Engine knows about
     */
    async listVodJobs(tag, state, offset, limit, initOverrides) {
      const response = await this.listVodJobsRaw({ tag, state, offset, limit }, initOverrides);
      return await response.value();
    }
    /**
     * The same job id runs again from where its stored results stop, appending to the same results file rather than analyzing the source afresh; `resumes` counts the runs. A job submitted with a `stream_group_config` reloads that group by name and re-layers the inline `config` it was submitted with — the group must still resolve to the same analysis, or the resume is refused. An inline-only job whose credentials were redacted out of its record takes them from the body: `config` must be the same analysis as submitted, and only its credentials are taken. A body on a group-built job is refused.  `400` for a body this API cannot read. `409` for every other refusal, each saying which: a job still queued or running, a completed job with nothing to fill in, a job that kept no results, a source file that changed since the job ran, a configuration that no longer matches, credentials the record does not hold and the body did not supply, a resume point this file cannot open a window on, a job still writing its record (try again). 
     * Continue a failed or cancelled job from the last window its stored results answered
     */
    async resumeVodJobRaw(requestParameters, initOverrides) {
      if (requestParameters["jobId"] == null) {
        throw new RequiredError(
          "jobId",
          'Required parameter "jobId" was null or undefined when calling resumeVodJob().'
        );
      }
      const queryParameters = {};
      const headerParameters = {};
      headerParameters["Content-Type"] = "application/json";
      if (this.configuration && (this.configuration.username !== void 0 || this.configuration.password !== void 0)) {
        headerParameters["Authorization"] = "Basic " + btoa(this.configuration.username + ":" + this.configuration.password);
      }
      const response = await this.request({
        path: `/vod/jobs/{jobId}/resume`.replace(`{${"jobId"}}`, encodeURIComponent(String(requestParameters["jobId"]))),
        method: "POST",
        headers: headerParameters,
        query: queryParameters,
        body: VodJobResumeRequestToJSON(requestParameters["vodJobResumeRequest"])
      }, initOverrides);
      return new JSONApiResponse(response, (jsonValue) => VodJobFromJSON(jsonValue));
    }
    /**
     * The same job id runs again from where its stored results stop, appending to the same results file rather than analyzing the source afresh; `resumes` counts the runs. A job submitted with a `stream_group_config` reloads that group by name and re-layers the inline `config` it was submitted with — the group must still resolve to the same analysis, or the resume is refused. An inline-only job whose credentials were redacted out of its record takes them from the body: `config` must be the same analysis as submitted, and only its credentials are taken. A body on a group-built job is refused.  `400` for a body this API cannot read. `409` for every other refusal, each saying which: a job still queued or running, a completed job with nothing to fill in, a job that kept no results, a source file that changed since the job ran, a configuration that no longer matches, credentials the record does not hold and the body did not supply, a resume point this file cannot open a window on, a job still writing its record (try again). 
     * Continue a failed or cancelled job from the last window its stored results answered
     */
    async resumeVodJob(jobId, vodJobResumeRequest, initOverrides) {
      const response = await this.resumeVodJobRaw({ jobId, vodJobResumeRequest }, initOverrides);
      return await response.value();
    }
  };

  // api/sdk/entry.ts
  var root = globalThis;
  root.VIF = root.VIF || {};
  root.VIF.api = {
    Configuration,
    FetchError,
    RequiredError,
    ResponseError,
    PersistApi,
    ProbesApi,
    RuntimeApi,
    ServerApi,
    VodApi,
    models: models_exports
  };
})();
