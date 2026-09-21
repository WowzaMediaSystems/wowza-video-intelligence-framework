"""Unit tests for vlm-patches/vif_auth.py, against a dummy ASGI app.

These need no GPU and no vLLM: they pin the middleware's own decisions (which
paths it guards, which it lets through, and that it is inert without a key).
The 401/200 matrix against a real engine is `05-auth-middleware-matrix.sh`.

    pip install pytest starlette httpx
    pytest spike/vif-model-manager/test_vif_auth.py
"""

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

KEY: str = "spike-key"
PATCH_PATH: Path = Path(__file__).resolve().parents[2] / "vlm-patches" / "vif_auth.py"


def _load_vif_auth() -> ModuleType:
    spec = importlib.util.spec_from_file_location("vif_auth", PATCH_PATH)
    assert spec is not None and spec.loader is not None
    module: ModuleType = importlib.util.module_from_spec(spec)
    sys.modules["vif_auth"] = module
    spec.loader.exec_module(module)
    return module


vif_auth: ModuleType = _load_vif_auth()

# Every path the engine serves that the middleware has an opinion about.
PATHS: tuple[str, ...] = (
    "/health",
    "/ping",
    "/metrics",
    "/version",
    "/is_sleeping",
    "/sleep",
    "/wake_up",
    "/collective_rpc",
    "/v1/models",
    "/v1/chat/completions",
    "/v2/anything",
    "/inference",
    "/load_lora_adapter",
)


async def _ok(request: Request) -> PlainTextResponse:
    return PlainTextResponse("served")


def _client(monkeypatch: pytest.MonkeyPatch, key: str | None) -> Iterator[TestClient]:
    if key is None:
        monkeypatch.delenv("VLLM_API_KEY", raising=False)
    else:
        monkeypatch.setenv("VLLM_API_KEY", key)
    routes: list[Route] = [
        Route(path, _ok, methods=["GET", "POST", "OPTIONS"]) for path in PATHS
    ]
    app: Starlette = Starlette(routes=routes)
    app.add_middleware(vif_auth.VifAuthMiddleware)
    return TestClient(app)


@pytest.fixture
def keyed(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    return _client(monkeypatch, KEY)


@pytest.fixture
def keyless(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    return _client(monkeypatch, None)


@pytest.mark.parametrize("path", ["/health", "/ping", "/metrics", "/version"])
def test_open_paths_need_no_key(keyed: TestClient, path: str) -> None:
    response = keyed.get(path)
    assert response.status_code == 200
    assert response.text == "served"


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/is_sleeping"),
        ("POST", "/sleep"),
        ("POST", "/wake_up"),
        ("POST", "/collective_rpc"),
        ("POST", "/load_lora_adapter"),
    ],
)
def test_dev_surface_without_a_key_is_401(
    keyed: TestClient, method: str, path: str
) -> None:
    response = keyed.request(method, path)
    assert response.status_code == 401
    assert response.json() == {"error": "Unauthorized"}


@pytest.mark.parametrize(
    "method,path",
    [("GET", "/is_sleeping"), ("POST", "/sleep"), ("POST", "/collective_rpc")],
)
def test_dev_surface_with_the_key_is_served(
    keyed: TestClient, method: str, path: str
) -> None:
    response = keyed.request(method, path, headers={"Authorization": f"Bearer {KEY}"})
    assert response.status_code == 200
    assert response.text == "served"


@pytest.mark.parametrize("path", ["/v1/models", "/v1/chat/completions", "/v2/anything", "/inference"])
def test_upstream_guarded_prefixes_are_not_double_guarded(
    keyed: TestClient, path: str
) -> None:
    response = keyed.get(path)
    assert response.status_code == 200
    assert response.text == "served"


@pytest.mark.parametrize("path", PATHS)
def test_without_a_key_the_middleware_is_inert(keyless: TestClient, path: str) -> None:
    response = keyless.get(path)
    assert response.status_code == 200
    assert response.text == "served"


def test_empty_key_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    client: TestClient = _client(monkeypatch, "")
    assert client.get("/is_sleeping").status_code == 200


@pytest.mark.parametrize(
    "header",
    ["", "Bearer wrong-key", f"Basic {KEY}", KEY, "Bearer", f"bearer {KEY}x"],
)
def test_wrong_credentials_are_401(keyed: TestClient, header: str) -> None:
    headers: dict[str, str] = {"Authorization": header} if header else {}
    assert keyed.get("/is_sleeping", headers=headers).status_code == 401


def test_bearer_scheme_is_case_insensitive(keyed: TestClient) -> None:
    response = keyed.get("/is_sleeping", headers={"Authorization": f"bearer {KEY}"})
    assert response.status_code == 200


def test_metrics_children_stay_open(keyed: TestClient) -> None:
    app: Starlette = Starlette(routes=[Route("/metrics/detail", _ok)])
    app.add_middleware(vif_auth.VifAuthMiddleware)
    assert TestClient(app).get("/metrics/detail").status_code == 200


def test_a_path_merely_prefixed_metrics_is_still_guarded(keyed: TestClient) -> None:
    app: Starlette = Starlette(routes=[Route("/metricsdump", _ok)])
    app.add_middleware(vif_auth.VifAuthMiddleware)
    assert TestClient(app).get("/metricsdump").status_code == 401


def test_options_preflight_is_never_challenged(keyed: TestClient) -> None:
    assert keyed.options("/is_sleeping").status_code == 200


def test_root_path_is_stripped_before_matching(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VLLM_API_KEY", KEY)
    app: Starlette = Starlette(routes=[Route("/health", _ok), Route("/sleep", _ok, methods=["POST"])])
    app.add_middleware(vif_auth.VifAuthMiddleware)
    client: TestClient = TestClient(app, root_path="/engine")
    assert client.get("/health").status_code == 200
    assert client.post("/sleep").status_code == 401
