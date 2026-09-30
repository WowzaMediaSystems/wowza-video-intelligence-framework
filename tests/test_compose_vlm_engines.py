"""
Static checks of the managed VLM engine services in docker-compose.yaml.

They read the compose files as YAML and never start anything, so they need
neither Docker nor a GPU -- only PyYAML, which the pinned engine image ships:

    docker run --rm -v "$PWD:/repo" -w /repo --entrypoint python3 \
      vllm/vllm-openai:v0.26.0 -m pytest tests/test_compose_vlm_engines.py -q

`docker compose config` is the check for what these do not cover: that the
files render at all, with every profile and override.
"""

import importlib.util

from pathlib import Path
from typing import Any

import pytest

yaml: Any = pytest.importorskip("yaml")

REPO: Path = Path(__file__).resolve().parent.parent
COMPOSE: Path = REPO / "docker-compose.yaml"
LAUNCHER: Path = REPO / "vif-vlm-launcher.py"
VIF_AUTH: Path = REPO / "vlm-patches" / "vif_auth.py"

VIS: str = "video-intelligence-service-gpu"
VIS_INIT: str = "vis-init"
ENGINE_NETWORK: str = "vif-engines"
EGRESS_NETWORK: str = "vif-engines-egress"
STATE_DIR: str = "/vif-state"
STATE_SOURCE: str = "./vis/vlm-state"
SITE_PACKAGES: str = "/usr/local/lib/python3.12/dist-packages"

# The Video Intelligence Service's shipped catalog: every entry is resident,
# so every one needs a service. A model added to the catalog is added here
# and to docker-compose.yaml together.
CATALOG_MODEL_IDS: list[str] = [
    "Qwen/Qwen3-VL-4B-Instruct-FP8",
    "nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8",
    "google/gemma-3-4b-it",
    "nvidia/Cosmos3-Edge",
    "nvidia/Cosmos3-Nano",
]


def load_launcher() -> Any:
    spec = importlib.util.spec_from_file_location("vif_vlm_launcher", LAUNCHER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher: Any = load_launcher()


def load(path: Path) -> dict[str, Any]:
    document: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8"))
    return document


def environment(service: dict[str, Any]) -> dict[str, str | None]:
    """A service's environment as a mapping; a bare `- NAME` maps to None."""
    raw: Any = service.get("environment") or {}
    if isinstance(raw, dict):
        return {str(key): value for key, value in raw.items()}
    parsed: dict[str, str | None] = {}
    for item in raw:
        key, separator, value = str(item).partition("=")
        parsed[key] = value if separator else None
    return parsed


def mounts(service: dict[str, Any]) -> dict[str, str]:
    """A service's short-syntax bind mounts, as {target: source}."""
    found: dict[str, str] = {}
    for volume in service.get("volumes") or []:
        source, target, *_ = str(volume).split(":")
        found[target] = source
    return found


def networks(service: dict[str, Any]) -> set[str]:
    raw: Any = service.get("networks")
    if raw is None:
        return {"default"}
    return set(raw)


def hostname_for(model_id: str) -> str:
    return f"vif-model-{launcher.engine_key(model_id)}"


@pytest.fixture(scope="module")
def compose() -> dict[str, Any]:
    return load(COMPOSE)


@pytest.fixture(scope="module")
def services(compose: dict[str, Any]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = compose["services"]
    return found


SLOTS: list[str] = ["vif-model-slot-1", "vif-model-slot-2"]


@pytest.fixture(scope="module")
def engines(services: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The fixed model services: one per shipped model."""
    return {
        name: service
        for name, service in services.items()
        if name.startswith("vif-model-") and name not in SLOTS
    }


@pytest.fixture(scope="module")
def slots(services: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {name: services[name] for name in SLOTS}


class TestOneServicePerModel:
    def test_every_catalog_model_has_exactly_one_service(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        assert sorted(engines) == sorted(hostname_for(m) for m in CATALOG_MODEL_IDS)

    @pytest.mark.parametrize("model_id", CATALOG_MODEL_IDS)
    def test_the_service_serves_its_model_under_its_hostname(
        self, engines: dict[str, dict[str, Any]], model_id: str
    ) -> None:
        name: str = hostname_for(model_id)
        engine: dict[str, Any] = engines[name]
        assert engine["hostname"] == name
        assert environment(engine)["VLM_MODEL"] == model_id

    def test_the_single_sidecar_is_gone(
        self, services: dict[str, dict[str, Any]]
    ) -> None:
        assert "vlm" not in services
        assert [
            name
            for name, service in services.items()
            if service.get("hostname") == "vlm.docker"
        ] == []

    def test_every_engine_runs_the_launcher_on_the_pinned_image(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        for engine in engines.values():
            assert engine["image"] == "vllm/vllm-openai:v0.26.0"
            assert engine["entrypoint"] == ["python3", "/vif-vlm-launcher.py"]
            assert mounts(engine)["/vif-vlm-launcher.py"] == "./vif-vlm-launcher.py"
            assert engine["profiles"] == ["vlm"]

    def test_the_launcher_finds_its_spec_on_the_state_volume(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        for engine in engines.values():
            model_id: str = str(environment(engine)["VLM_MODEL"])
            env: dict[str, str] = {
                key: value
                for key, value in environment(engine).items()
                if value is not None
            }
            expected: str = f"{STATE_DIR}/engines/{launcher.engine_key(model_id)}.json"
            assert launcher.spec_path_from_env(env) == expected


class TestNetwork:
    def test_no_engine_port_is_published(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        assert [name for name, engine in engines.items() if "ports" in engine] == []

    def test_the_engine_network_is_internal(self, compose: dict[str, Any]) -> None:
        assert compose["networks"][ENGINE_NETWORK] == {"internal": True}

    def test_engines_are_on_the_engine_networks_only(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        for engine in engines.values():
            assert networks(engine) == {ENGINE_NETWORK, EGRESS_NETWORK}

    def test_vis_joins_the_engine_network_and_stays_on_the_default_one(
        self, services: dict[str, dict[str, Any]]
    ) -> None:
        assert networks(services[VIS]) == {"default", ENGINE_NETWORK}
        assert "ports" not in services[VIS]

    def test_nothing_else_joins_an_engine_network(
        self, services: dict[str, dict[str, Any]]
    ) -> None:
        on_engine_network: list[str] = sorted(
            name
            for name, service in services.items()
            if ENGINE_NETWORK in networks(service)
        )
        on_egress: list[str] = sorted(
            name
            for name, service in services.items()
            if EGRESS_NETWORK in networks(service)
        )
        engine_names: list[str] = sorted(
            [*(hostname_for(m) for m in CATALOG_MODEL_IDS), *SLOTS]
        )
        assert on_engine_network == sorted([VIS, *engine_names])
        assert on_egress == engine_names


class TestStateVolume:
    def test_vis_has_the_state_dir_and_its_volume(
        self, services: dict[str, dict[str, Any]]
    ) -> None:
        assert environment(services[VIS])["VIF_STATE_DIR"] == STATE_DIR
        assert mounts(services[VIS])[STATE_DIR] == STATE_SOURCE

    def test_every_engine_mounts_the_same_state_volume_at_the_same_path(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        for engine in engines.values():
            assert environment(engine)["VIF_STATE_DIR"] == STATE_DIR
            assert mounts(engine)[STATE_DIR] == STATE_SOURCE

    def test_every_engine_shares_the_weights_and_the_compile_cache(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        for engine in engines.values():
            assert mounts(engine)["/root/.cache/huggingface"] == "./vis/vlm-models"
            assert mounts(engine)["/root/.cache/vllm"] == "./vis/vlm-cache"

    def test_vis_reads_the_engines_weights_read_only(
        self, services: dict[str, dict[str, Any]]
    ) -> None:
        weights: list[str] = [
            str(volume)
            for volume in services[VIS].get("volumes") or []
            if str(volume).split(":")[1] == "/vif-weights"
        ]
        assert weights == ["./vis/vlm-models:/vif-weights:ro"]

    def test_vis_init_hands_the_state_volume_to_vis(
        self, services: dict[str, dict[str, Any]]
    ) -> None:
        init: dict[str, Any] = services[VIS_INIT]
        assert init["entrypoint"][:3] == ["chown", "-R", "1001:1001"]
        assert STATE_DIR in init["entrypoint"]
        assert mounts(init)[STATE_DIR] == STATE_SOURCE
        assert services[VIS]["depends_on"][VIS_INIT] == {
            "condition": "service_completed_successfully"
        }

    def test_engines_start_after_vis(
        self, engines: dict[str, dict[str, Any]], services: dict[str, dict[str, Any]]
    ) -> None:
        assert "vlm" in services[VIS]["profiles"]
        for engine in engines.values():
            assert engine["depends_on"] == {VIS: {"condition": "service_healthy"}}


class TestAuth:
    def test_the_api_key_is_passed_through_and_never_defaulted(
        self, engines: dict[str, dict[str, Any]], services: dict[str, dict[str, Any]]
    ) -> None:
        for service in [services[VIS], *engines.values()]:
            assert environment(service)["VLLM_API_KEY"] is None

    def test_every_engine_mounts_the_guard_middleware(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        assert "class VifAuthMiddleware" in VIF_AUTH.read_text(encoding="utf-8")
        for engine in engines.values():
            assert mounts(engine)[f"{SITE_PACKAGES}/vif_auth.py"] == (
                "./vlm-patches/vif_auth.py"
            )
            assert environment(engine)["VIF_ENGINE_MIDDLEWARE"] == (
                "vif_auth.VifAuthMiddleware"
            )

    def test_the_cosmos3_edge_patch_is_mounted_as_before(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        target: str = f"{SITE_PACKAGES}/vllm/model_executor/models/cosmos3_edge.py"
        for engine in engines.values():
            assert mounts(engine)[target] == "./vlm-patches/cosmos3_edge.py"


# The slowest measured engine stop: vLLM exiting on SIGTERM, CUDA teardown
# included, for the largest shipped model.
SLOWEST_MEASURED_STOP_SECONDS: float = 10.7
# How long the launcher waits for the child's output to drain once it exits.
TEE_DRAIN_SECONDS: int = 10
STOP_GRACE: str = "30s"


class TestStopGrace:
    def test_every_engine_gets_the_time_a_clean_shutdown_takes(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        source: str = LAUNCHER.read_text(encoding="utf-8")
        assert f"self._tee.join(timeout={TEE_DRAIN_SECONDS})" in source
        grace: int = int(STOP_GRACE.removesuffix("s"))
        assert grace > SLOWEST_MEASURED_STOP_SECONDS + TEE_DRAIN_SECONDS
        assert {
            name: engine.get("stop_grace_period") for name, engine in engines.items()
        } == {name: STOP_GRACE for name in engines}


class TestHealthcheck:
    def test_a_cold_start_is_covered_by_the_launcher_s_starting_file(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        """The file the healthcheck accepts is the one the launcher writes, and
        it lives in the container, not on the shared state volume."""
        for engine in engines.values():
            assert environment(engine)["VIF_STARTING_FILE"] == (
                launcher.DEFAULT_STARTING_FILE
            )
            assert not launcher.DEFAULT_STARTING_FILE.startswith(STATE_DIR + "/")

    def test_the_grace_covers_every_resident_loading_in_turn(
        self, engines: dict[str, dict[str, Any]]
    ) -> None:
        per_load: int = launcher.LaunchPlan(
            source="spec", model="m", args=[]
        ).health_timeout_seconds
        for engine in engines.values():
            healthcheck: dict[str, Any] = engine["healthcheck"]
            assert healthcheck["test"] == [
                "CMD-SHELL",
                'curl -fsS http://localhost:8000/health || test -e "$${VIF_STARTING_FILE}"',
            ]
            assert healthcheck["start_period"] == "10200s"
            # The serving engine loads last: the whole wait for the rest of
            # the pool, then its own load, after waiting for its spec.
            assert 10200 >= (
                launcher.DEFAULT_SPEC_TIMEOUT_SECONDS
                + launcher.DEFAULT_POOL_LOAD_TIMEOUT_SECONDS
                + per_load
            )
            assert 10200 >= len(CATALOG_MODEL_IDS) * per_load


class TestSlots:
    """The generic services a model the catalog overlay adds runs in."""

    @pytest.mark.parametrize("number", [1, 2])
    def test_each_slot_is_named_by_env_and_behind_its_own_profile(
        self, slots: dict[str, dict[str, Any]], number: int
    ) -> None:
        name: str = f"vif-model-slot-{number}"
        slot: dict[str, Any] = slots[name]
        env: dict[str, str | None] = environment(slot)
        assert (slot["hostname"], slot["profiles"]) == (name, [f"vlm-slot-{number}"])
        assert (env["VIF_SLOT"], env["VLM_MODEL"]) == (
            name,
            f"${{VIF_SLOT_{number}_MODEL:-}}",
        )

    def test_a_slot_is_a_fixed_engine_but_for_its_name_and_profile(
        self,
        slots: dict[str, dict[str, Any]],
        engines: dict[str, dict[str, Any]],
    ) -> None:
        fixed: dict[str, Any] = engines[hostname_for(CATALOG_MODEL_IDS[0])]
        own: set[str] = {"hostname", "profiles", "environment"}
        for slot in slots.values():
            assert {k: v for k, v in slot.items() if k not in own} == {
                k: v for k, v in fixed.items() if k not in own
            }
            shared: dict[str, str | None] = environment(fixed)
            del shared["VLM_MODEL"]
            env: dict[str, str | None] = environment(slot)
            assert {k: v for k, v in env.items() if k in shared} == shared

    def test_no_slot_starts_with_the_vlm_profile_alone(
        self, slots: dict[str, dict[str, Any]]
    ) -> None:
        assert [name for name, slot in slots.items() if "vlm" in slot["profiles"]] == []
