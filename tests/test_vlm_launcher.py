"""
Tests for vif-vlm-launcher.py: flag resolution from both sources, and the pool
duties (load lock, self-sleep, supervision) against a stand-in engine.

No GPU and no vLLM: the duty tests run `fake_vllm.py` instead. Sleep MODE
itself still cannot be tested here -- it needs a real engine on a UVA-capable
host -- but everything the launcher does around it can.

Run them where the launcher runs, the pinned engine image:

    docker run --rm -v "$PWD:/repo" -w /repo --entrypoint python3 \
      vllm/vllm-openai:v0.26.0 -m pytest tests/test_vlm_launcher.py -q

They also pass on any Python 3.12 with pytest.
"""

import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import types

from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

REPO: Path = Path(__file__).resolve().parent.parent
LAUNCHER: Path = REPO / "vif-vlm-launcher.py"
FAKE_VLLM: Path = Path(__file__).resolve().parent / "fake_vllm.py"
VLM_ENV: Path = REPO / "vlm-env"

XGRAMMAR: list[str] = [
    "--structured-outputs-config",
    '{"backend":"xgrammar","disable_any_whitespace":true}',
]


def load_launcher() -> Any:
    spec = importlib.util.spec_from_file_location("vif_vlm_launcher", LAUNCHER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher: Any = load_launcher()


def profile_env(name: str) -> dict[str, str]:
    """The VLM_* variables compose would load from vlm-env/<name>.env."""
    env: dict[str, str] = {}
    for line in (VLM_ENV / f"{name}.env").read_text(encoding="utf-8").splitlines():
        stripped: str = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        env[key.strip()] = value
    # Pin the dtype so flag resolution never depends on the host's GPU.
    env.setdefault("VLM_KV_CACHE_DTYPE", "fp8")
    return env


class TestLegacyFlagResolution:
    def test_qwen_profile(self) -> None:
        plan: Any = launcher.plan_from_env(profile_env("qwen"))
        assert plan.argv == [
            "vllm",
            "serve",
            "Qwen/Qwen3-VL-4B-Instruct-FP8",
            "--port=8000",
            "--served-model-name=Qwen/Qwen3-VL-4B-Instruct-FP8",
            "--max-model-len=16384",
            "--gpu-memory-utilization=0.80",
            "--max-num-batched-tokens=8192",
            "--tensor-parallel-size=1",
            "--kv-cache-dtype=fp8",
            "--no-enable-prefix-caching",
            "--mm-processor-cache-gb=0",
            '--limit-mm-per-prompt={"image": 8, "video": 0}',
            '--mm-processor-kwargs={"min_pixels": 3136, "max_pixels": 401408}',
            "--max-cudagraph-capture-size=64",
            *XGRAMMAR,
        ]
        assert plan.env == {}
        assert plan.needs_supervision is False

    def test_nemotron_profile_has_no_processor_kwargs(self) -> None:
        plan: Any = launcher.plan_from_env(profile_env("nemotron"))
        assert plan.argv == [
            "vllm",
            "serve",
            "nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8",
            "--port=8000",
            "--served-model-name=nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-FP8",
            "--max-model-len=8192",
            "--gpu-memory-utilization=0.80",
            "--max-num-batched-tokens=8192",
            "--tensor-parallel-size=1",
            "--kv-cache-dtype=fp8",
            "--no-enable-prefix-caching",
            "--mm-processor-cache-gb=0",
            '--limit-mm-per-prompt={"image": 8, "video": 0}',
            "--quantization",
            "modelopt",
            "--trust-remote-code",
            "--enforce-eager",
            "--max-cudagraph-capture-size=64",
            *XGRAMMAR,
        ]

    def test_cosmos_edge_profile(self) -> None:
        plan: Any = launcher.plan_from_env(profile_env("cosmos-edge"))
        assert plan.args[-9:] == [
            "--quantization",
            "fp8",
            "--allowed-local-media-path",
            "/",
            "--max-cudagraph-capture-size=64",
            "--default-chat-template-kwargs",
            '{"enable_thinking":false}',
            *XGRAMMAR,
        ]
        assert (
            '--mm-processor-kwargs={"min_pixels": 4096, "max_pixels": 1003520}'
            in plan.args
        )

    def test_cosmos_nano_pins_max_num_seqs(self) -> None:
        plan: Any = launcher.plan_from_env(profile_env("cosmos-nano"))
        assert "--max-num-seqs=1" in plan.args
        assert "--gpu-memory-utilization=0.87" in plan.args

    def test_gemma_profile(self) -> None:
        plan: Any = launcher.plan_from_env(profile_env("gemma"))
        assert "--max-model-len=32768" in plan.args
        assert plan.args[-5:] == [
            "--trust-remote-code",
            "--mm-processor-kwargs={}",
            "--max-cudagraph-capture-size=64",
            *XGRAMMAR,
        ]

    def test_defaults_without_any_profile(self) -> None:
        plan: Any = launcher.plan_from_env({"VLM_KV_CACHE_DTYPE": "auto"})
        assert plan.argv == [
            "vllm",
            "serve",
            "Qwen/Qwen3-VL-4B-Instruct-FP8",
            "--port=8000",
            "--served-model-name=Qwen/Qwen3-VL-4B-Instruct-FP8",
            "--max-model-len=16384",
            "--gpu-memory-utilization=0.90",
            "--max-num-batched-tokens=8192",
            "--tensor-parallel-size=1",
            "--kv-cache-dtype=auto",
            "--no-enable-prefix-caching",
            "--mm-processor-cache-gb=0",
            '--limit-mm-per-prompt={"image": 8, "video": 0}',
        ]

    def test_served_model_name_is_passed_offline_too(self) -> None:
        """F2: HF_HUB_OFFLINE must not change the served id."""
        env: dict[str, str] = profile_env("qwen")
        env["HF_HUB_OFFLINE"] = "1"
        plan: Any = launcher.plan_from_env(env)
        assert "--served-model-name=Qwen/Qwen3-VL-4B-Instruct-FP8" in plan.args
        # Early enough that VLM_EXTRA_ARGS can still override it.
        assert plan.args.index("--served-model-name=Qwen/Qwen3-VL-4B-Instruct-FP8") == 1

    def test_extra_args_come_last(self) -> None:
        env: dict[str, str] = profile_env("qwen")
        env["VLM_EXTRA_ARGS"] = "--seed 7"
        plan: Any = launcher.plan_from_env(env)
        assert plan.args[-2:] == ["--seed", "7"]

    def test_the_deployment_middleware_comes_before_the_extra_args(self) -> None:
        env: dict[str, str] = profile_env("qwen")
        env["VIF_ENGINE_MIDDLEWARE"] = "vif_auth.VifAuthMiddleware"
        plan: Any = launcher.plan_from_env(env)
        assert plan.args[-5:] == [
            "--middleware",
            "vif_auth.VifAuthMiddleware",
            "--max-cudagraph-capture-size=64",
            *XGRAMMAR,
        ]

    def test_sleep_mode_adds_the_flag_and_the_dev_mode_env(self) -> None:
        env: dict[str, str] = profile_env("qwen")
        env["VLM_SLEEP_MODE"] = "1"
        plan: Any = launcher.plan_from_env(env)
        assert "--enable-sleep-mode" in plan.args
        assert plan.env["VLLM_SERVER_DEV_MODE"] == "1"
        # Still before the profile's own extra args.
        assert plan.args.index("--enable-sleep-mode") < plan.args.index(
            "--max-cudagraph-capture-size=64"
        )

    def test_gpu_pinning(self) -> None:
        env: dict[str, str] = profile_env("qwen")
        env["VLM_GPU_IDS"] = "1,2"
        plan: Any = launcher.plan_from_env(env)
        assert plan.env == {
            "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
            "CUDA_VISIBLE_DEVICES": "1,2",
        }


class TestKvCacheProbe:
    def _with_fake_pynvml(
        self, monkeypatch: pytest.MonkeyPatch, capability: tuple[int, int]
    ) -> None:
        memory: types.SimpleNamespace = types.SimpleNamespace(
            total=24 * 1024 * 1024 * 1024
        )
        functions: dict[str, Any] = {
            "nvmlInit": lambda: None,
            "nvmlShutdown": lambda: None,
            "nvmlDeviceGetCount": lambda: 1,
            "nvmlDeviceGetHandleByIndex": lambda index: index,
            "nvmlDeviceGetName": lambda handle: "Fake GPU",
            "nvmlDeviceGetMemoryInfo": lambda handle: memory,
            "nvmlDeviceGetCudaComputeCapability": lambda handle: capability,
        }
        module: types.ModuleType = types.ModuleType("pynvml")
        for name, function in functions.items():
            setattr(module, name, function)
        monkeypatch.setitem(sys.modules, "pynvml", module)

    def test_ada_and_newer_get_fp8(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._with_fake_pynvml(monkeypatch, (8, 9))
        plan: Any = launcher.plan_from_env({})
        assert "--kv-cache-dtype=fp8" in plan.args

    def test_ampere_falls_back_to_auto(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._with_fake_pynvml(monkeypatch, (8, 6))
        plan: Any = launcher.plan_from_env({})
        assert "--kv-cache-dtype=auto" in plan.args

    def test_no_pynvml_falls_back_to_auto(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setitem(sys.modules, "pynvml", None)
        plan: Any = launcher.plan_from_env({})
        assert "--kv-cache-dtype=auto" in plan.args

    def test_an_explicit_dtype_skips_the_probe(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._with_fake_pynvml(monkeypatch, (9, 0))
        plan: Any = launcher.plan_from_env({"VLM_KV_CACHE_DTYPE": "auto"})
        assert "--kv-cache-dtype=auto" in plan.args


def write_spec(directory: Path, **overrides: Any) -> Path:
    document: dict[str, Any] = {
        "spec_version": 1,
        "catalog_id": "Qwen/Qwen3-VL-4B-Instruct-FP8",
        "model": "Qwen/Qwen3-VL-4B-Instruct-FP8",
        "served_model_name": "Qwen/Qwen3-VL-4B-Instruct-FP8",
        "port": 8000,
        "args": ["--port=8000", "--served-model-name=Qwen/Qwen3-VL-4B-Instruct-FP8"],
        "env": {"VLLM_SERVER_DEV_MODE": "1"},
        "sleep_mode": True,
        "sleep_level": 1,
        "active": True,
        "gpu_ids": None,
        "tensor_parallel_size": 1,
        "tuning_tier": "compact",
        "load_lock_file": None,
        "health_timeout_seconds": 1800,
        "generated_by": "VIS 1.1.0",
        "generated_at": "2026-09-21T18:00:00Z",
    }
    document.update(overrides)
    path: Path = directory / "engines" / "qwen-qwen3-vl-4b-instruct-fp8.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return path


class TestSpecPath:
    def test_the_spec_is_run_verbatim(self, tmp_path: Path) -> None:
        path: Path = write_spec(
            tmp_path,
            args=["--port=9000", "--served-model-name=x", "--enable-sleep-mode"],
            port=9000,
        )
        plan: Any = launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})
        assert plan.source == "spec"
        assert plan.argv == [
            "vllm",
            "serve",
            "Qwen/Qwen3-VL-4B-Instruct-FP8",
            "--port=9000",
            "--served-model-name=x",
            "--enable-sleep-mode",
        ]
        assert plan.env == {"VLLM_SERVER_DEV_MODE": "1"}
        assert plan.port == 9000

    def test_the_deployment_middleware_is_appended(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path, args=["--port=8000"])
        plan: Any = launcher.build_plan(
            {
                "VIF_ENGINE_SPEC_FILE": str(path),
                "VIF_ENGINE_MIDDLEWARE": "vif_auth.VifAuthMiddleware, extra.Guard",
            }
        )
        assert plan.args == [
            "--port=8000",
            "--middleware",
            "vif_auth.VifAuthMiddleware",
            "--middleware",
            "extra.Guard",
        ]

    def test_a_middleware_the_spec_names_is_not_added_twice(
        self, tmp_path: Path
    ) -> None:
        path: Path = write_spec(
            tmp_path,
            args=["--port=8000", "--middleware", "vif_auth.VifAuthMiddleware"],
        )
        plan: Any = launcher.build_plan(
            {
                "VIF_ENGINE_SPEC_FILE": str(path),
                "VIF_ENGINE_MIDDLEWARE": "vif_auth.VifAuthMiddleware",
            }
        )
        assert plan.args == [
            "--port=8000",
            "--middleware",
            "vif_auth.VifAuthMiddleware",
        ]

    def test_the_path_can_be_derived_from_the_state_dir(self, tmp_path: Path) -> None:
        write_spec(tmp_path)
        plan: Any = launcher.build_plan(
            {
                "VIF_STATE_DIR": str(tmp_path),
                "VLM_MODEL": "Qwen/Qwen3-VL-4B-Instruct-FP8",
            }
        )
        assert plan.source == "spec"

    def test_engine_key_matches_the_vis_side(self) -> None:
        assert launcher.engine_key("nvidia/Cosmos3-Edge") == "nvidia-cosmos3-edge"
        assert (
            launcher.engine_key("Qwen/Qwen3-VL-4B-Instruct-FP8")
            == "qwen-qwen3-vl-4b-instruct-fp8"
        )

    def test_an_active_engine_is_awake(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path, active=True)
        plan: Any = launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})
        assert plan.desired_state == "awake"
        # A spec is watched for as long as the engine runs, so even the active
        # engine is supervised: VIS can stand it down without a restart.
        assert plan.watches is True
        assert plan.needs_supervision is True

    def test_an_inactive_engine_sleeps(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path, active=False, sleep_level=2)
        plan: Any = launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})
        assert plan.desired_state == "asleep"
        assert plan.sleep_level == 2

    def test_desired_state_wins_over_active(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path, active=True, desired_state="parked")
        plan: Any = launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})
        assert plan.desired_state == "parked"

    def test_an_unknown_desired_state_is_refused(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path, desired_state="hibernating")
        with pytest.raises(
            launcher.ConfigError,
            match="desired_state 'hibernating' is not one of awake, asleep, parked",
        ):
            launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})

    def test_the_state_volume_is_derived_from_the_spec_path(
        self, tmp_path: Path
    ) -> None:
        path: Path = write_spec(tmp_path)
        plan: Any = launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})
        assert plan.state_file == str(tmp_path / "active-model")
        assert plan.ready_file == str(
            tmp_path / "ready" / "qwen-qwen3-vl-4b-instruct-fp8"
        )
        assert plan.log_file == str(
            tmp_path / "logs" / "qwen-qwen3-vl-4b-instruct-fp8.log"
        )

    def test_the_spec_pins_the_gpus(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path, gpu_ids="3")
        plan: Any = launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})
        assert plan.env["CUDA_VISIBLE_DEVICES"] == "3"

    def test_a_future_spec_version_is_refused(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path, spec_version=2)
        with pytest.raises(
            launcher.ConfigError, match="spec version 2 is not supported"
        ):
            launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})

    def test_a_spec_missing_a_field_is_refused(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path)
        document: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        del document["args"]
        path.write_text(json.dumps(document), encoding="utf-8")
        with pytest.raises(launcher.ConfigError, match="missing 'args'"):
            launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})

    def test_an_engine_that_cannot_sleep_is_parked_instead_of_refused(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """Capability beats configuration: never a dead state, never a refusal."""
        path: Path = write_spec(tmp_path, active=False, sleep_mode=False)
        plan: Any = launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})
        assert plan.desired_state == "parked"
        assert "parking it instead" in capsys.readouterr().err

    @pytest.mark.parametrize(
        ("name", "value"),
        [("port", "abc"), ("sleep_level", "deep"), ("health_timeout_seconds", None)],
    )
    def test_a_malformed_number_is_a_config_error_naming_the_field(
        self, tmp_path: Path, name: str, value: Any
    ) -> None:
        path: Path = write_spec(tmp_path, **{name: value})
        with pytest.raises(launcher.ConfigError) as caught:
            launcher.build_plan({"VIF_ENGINE_SPEC_FILE": str(path)})
        assert str(caught.value) == f"engine spec {name}={value!r} is not an integer."

    def test_a_malformed_spec_number_exits_78(self, tmp_path: Path) -> None:
        path: Path = write_spec(tmp_path, port="abc")
        result: subprocess.CompletedProcess[str] = run_launcher(
            {"VIF_LAUNCHER_DRY_RUN": "1", "VIF_ENGINE_SPEC_FILE": str(path)}
        )
        assert result.returncode == 78
        assert "engine spec port='abc' is not an integer." in result.stderr
        assert "Traceback" not in result.stderr

    def test_a_spec_that_never_arrives_times_out(self, tmp_path: Path) -> None:
        with pytest.raises(launcher.ConfigError, match="no usable engine spec"):
            launcher.build_plan(
                {
                    "VIF_ENGINE_SPEC_FILE": str(tmp_path / "absent.json"),
                    "VIF_SPEC_TIMEOUT_SECONDS": "1",
                }
            )


class TestConfigRefusals:
    def test_a_non_boolean_sleep_mode(self) -> None:
        with pytest.raises(launcher.ConfigError, match="VLM_SLEEP_MODE='maybe'"):
            launcher.plan_from_env({"VLM_SLEEP_MODE": "maybe"})

    def test_a_state_file_without_sleep_mode(self) -> None:
        with pytest.raises(launcher.ConfigError, match="needs VLM_SLEEP_MODE=1"):
            launcher.plan_from_env({"VLM_STATE_FILE": "/vif-state/active-model"})


class TestBlankMeansUnset:
    """An empty value counts as unset, as ${VAR:-default} did in bash."""

    @pytest.mark.parametrize("blank", ["", "  "])
    def test_a_blank_string_flag_takes_its_default(self, blank: str) -> None:
        plan: Any = launcher.plan_from_env(
            {
                "VLM_KV_CACHE_DTYPE": "auto",
                "VLM_MODEL": blank,
                "VLM_MAX_MODEL_LEN": blank,
                "VLM_MAX_NUM_SEQS": blank,
                "VLM_MIN_PIXELS": blank,
                "VLM_EXTRA_ARGS": blank,
            }
        )
        defaults: Any = launcher.plan_from_env({"VLM_KV_CACHE_DTYPE": "auto"})
        assert plan.argv == defaults.argv
        assert plan.model == "Qwen/Qwen3-VL-4B-Instruct-FP8"
        assert "--max-model-len=16384" in plan.args
        assert [arg for arg in plan.args if arg.startswith("--max-num-seqs")] == []

    @pytest.mark.parametrize("blank", ["", "  "])
    def test_a_blank_integer_takes_its_default(self, blank: str) -> None:
        plan: Any = launcher.plan_from_env(
            {
                "VLM_KV_CACHE_DTYPE": "auto",
                "VLM_PORT": blank,
                "VLM_SLEEP_LEVEL": blank,
                "VLM_HEALTH_TIMEOUT_SECONDS": blank,
                "VLM_HEALTH_POLL_SECONDS": blank,
                "VIF_WATCH_POLL_SECONDS": blank,
                "VIF_POOL_LOAD_TIMEOUT_SECONDS": blank,
            }
        )
        assert plan.port == 8000
        assert plan.args[0] == "--port=8000"
        assert plan.sleep_level == 1
        assert plan.health_timeout_seconds == 1800
        assert plan.health_poll_seconds == 2.0
        assert plan.watch_poll_seconds == 2.0
        assert plan.pool_load_timeout_seconds == 7800

    @pytest.mark.parametrize("blank", ["", "  "])
    def test_a_blank_boolean_is_false(self, blank: str) -> None:
        plan: Any = launcher.plan_from_env(
            {"VLM_KV_CACHE_DTYPE": "auto", "VLM_SLEEP_MODE": blank}
        )
        assert plan.sleep_mode is False
        assert "--enable-sleep-mode" not in plan.args
        assert plan.env == {}

    def test_blank_knobs_on_the_spec_path_take_their_defaults(
        self, tmp_path: Path
    ) -> None:
        spec: Path = write_spec(tmp_path)
        plan: Any = launcher.plan_from_spec(
            json.loads(spec.read_text(encoding="utf-8")),
            {
                "VIF_ENGINE_SPEC_FILE": str(spec),
                "VLM_GPU_IDS": "",
                "VLM_HEALTH_POLL_SECONDS": "",
                "VIF_WATCH_POLL_SECONDS": "",
                "VIF_POOL_LOAD_TIMEOUT_SECONDS": "",
            },
        )
        assert plan.health_poll_seconds == 2.0
        assert plan.watch_poll_seconds == 2.0
        assert plan.pool_load_timeout_seconds == 7800
        assert "CUDA_VISIBLE_DEVICES" not in plan.env

    @pytest.mark.parametrize(
        "name",
        ["VLM_PORT", "VLM_SLEEP_LEVEL", "VLM_HEALTH_TIMEOUT_SECONDS"],
    )
    def test_an_invalid_integer_is_a_config_error_naming_the_knob(
        self, name: str
    ) -> None:
        with pytest.raises(launcher.ConfigError) as caught:
            launcher.plan_from_env({"VLM_KV_CACHE_DTYPE": "auto", name: "abc"})
        assert str(caught.value) == f"{name}='abc' is not an integer."

    def test_an_invalid_number_is_a_config_error_naming_the_knob(self) -> None:
        with pytest.raises(launcher.ConfigError) as caught:
            launcher.plan_from_env(
                {"VLM_KV_CACHE_DTYPE": "auto", "VLM_HEALTH_POLL_SECONDS": "fast"}
            )
        assert str(caught.value) == "VLM_HEALTH_POLL_SECONDS='fast' is not a number."


def run_launcher(
    env: dict[str, str], *, timeout: float = 60.0, path_prefix: Path | None = None
) -> subprocess.CompletedProcess[str]:
    child: dict[str, str] = dict(os.environ)
    child.update(env)
    if path_prefix is not None:
        child["PATH"] = f"{path_prefix}:{child['PATH']}"
    return subprocess.run(
        [sys.executable, str(LAUNCHER)],
        env=child,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


class TestDryRun:
    def test_it_prints_the_plan_as_json_and_exits(self) -> None:
        env: dict[str, str] = profile_env("qwen")
        env["VIF_LAUNCHER_DRY_RUN"] = "1"
        result: subprocess.CompletedProcess[str] = run_launcher(env)
        assert result.returncode == 0
        plan: dict[str, Any] = json.loads(result.stdout)
        assert plan["source"] == "env"
        assert plan["argv"][:3] == ["vllm", "serve", "Qwen/Qwen3-VL-4B-Instruct-FP8"]
        assert plan["duties"]["supervised"] is False

    def test_a_config_error_exits_78(self) -> None:
        result: subprocess.CompletedProcess[str] = run_launcher(
            {"VIF_LAUNCHER_DRY_RUN": "1", "VLM_SLEEP_MODE": "maybe"}
        )
        assert result.returncode == 78
        assert "is not a boolean" in result.stderr

    def test_a_blank_port_launches_on_the_default(self) -> None:
        result: subprocess.CompletedProcess[str] = run_launcher(
            {"VIF_LAUNCHER_DRY_RUN": "1", "VLM_KV_CACHE_DTYPE": "auto", "VLM_PORT": ""}
        )
        assert result.returncode == 0
        plan: dict[str, Any] = json.loads(result.stdout)
        assert plan["duties"]["port"] == 8000
        assert plan["argv"][3] == "--port=8000"

    def test_an_invalid_port_exits_78_naming_it(self) -> None:
        result: subprocess.CompletedProcess[str] = run_launcher(
            {
                "VIF_LAUNCHER_DRY_RUN": "1",
                "VLM_KV_CACHE_DTYPE": "auto",
                "VLM_PORT": "abc",
            }
        )
        assert result.returncode == 78
        assert "VLM_PORT='abc' is not an integer." in result.stderr
        assert "Traceback" not in result.stderr


@pytest.fixture()
def stub_path(tmp_path: Path) -> Path:
    """A directory whose `vllm` is the stand-in engine."""
    directory: Path = tmp_path / "bin"
    directory.mkdir()
    shim: Path = directory / "vllm"
    shim.write_text(
        f'#!/usr/bin/env bash\nexec "{sys.executable}" "{FAKE_VLLM}" "$@"\n',
        encoding="utf-8",
    )
    shim.chmod(0o755)
    return directory


def events(log: Path) -> list[dict[str, Any]]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]


_HANDED_OUT: set[int] = set()


def free_port() -> int:
    """
    A port nothing is listening on. Never the same one twice in a session:
    the kernel is free to hand a closed ephemeral port straight back, and two
    engines on one port make for a very confusing failure.
    """
    import socket

    while True:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port: int = int(sock.getsockname()[1])
        if port not in _HANDED_OUT:
            _HANDED_OUT.add(port)
            return port


class TestDuties:
    def _base_env(self, tmp_path: Path, port: int, log: Path) -> dict[str, str]:
        return {
            "VLM_MODEL": "acme/model-a",
            "VLM_PORT": str(port),
            "VLM_KV_CACHE_DTYPE": "auto",
            "VLM_SLEEP_MODE": "1",
            "VLM_HEALTH_POLL_SECONDS": "0.2",
            "VLM_HEALTH_TIMEOUT_SECONDS": "30",
            "FAKE_VLLM_EVENT_LOG": str(log),
        }

    def test_it_sleeps_when_the_state_file_names_another_model(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        log: Path = tmp_path / "events.jsonl"
        state: Path = tmp_path / "active-model"
        state.write_text("acme/model-b\n", encoding="utf-8")
        env: dict[str, str] = self._base_env(tmp_path, free_port(), log)
        env["VLM_STATE_FILE"] = str(state)
        env["VLM_SLEEP_LEVEL"] = "2"

        process: subprocess.Popen[str] = subprocess.Popen(
            [sys.executable, str(LAUNCHER)],
            env={**os.environ, **env, "PATH": f"{stub_path}:{os.environ['PATH']}"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            deadline: float = time.monotonic() + 30
            while time.monotonic() < deadline:
                if any(event["event"] == "sleep" for event in events(log)):
                    break
                time.sleep(0.2)
            recorded: list[dict[str, Any]] = events(log)
            assert [event["event"] for event in recorded] == ["start", "sleep"]
            assert recorded[1]["path"] == "/sleep?level=2"
        finally:
            process.terminate()
            process.wait(timeout=30)

    def test_it_stays_awake_when_the_state_file_names_it(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        log: Path = tmp_path / "events.jsonl"
        state: Path = tmp_path / "active-model"
        state.write_text("acme/model-a\n", encoding="utf-8")
        env: dict[str, str] = self._base_env(tmp_path, free_port(), log)
        env["VLM_STATE_FILE"] = str(state)

        process: subprocess.Popen[str] = subprocess.Popen(
            [sys.executable, str(LAUNCHER)],
            env={**os.environ, **env, "PATH": f"{stub_path}:{os.environ['PATH']}"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            time.sleep(4)
            assert [event["event"] for event in events(log)] == ["start"]
        finally:
            process.terminate()
            output: str = process.communicate(timeout=30)[0]
        assert "staying awake" in output
        assert [event["event"] for event in events(log)] == ["start", "sigterm"]

    def test_sigterm_reaches_the_child_and_its_exit_code_propagates(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        log: Path = tmp_path / "events.jsonl"
        state: Path = tmp_path / "active-model"
        state.write_text("acme/model-a\n", encoding="utf-8")
        env: dict[str, str] = self._base_env(tmp_path, free_port(), log)
        env["VLM_STATE_FILE"] = str(state)
        env["FAKE_VLLM_EXIT_CODE"] = "3"

        process: subprocess.Popen[str] = subprocess.Popen(
            [sys.executable, str(LAUNCHER)],
            env={**os.environ, **env, "PATH": f"{stub_path}:{os.environ['PATH']}"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline: float = time.monotonic() + 30
        while time.monotonic() < deadline and not events(log):
            time.sleep(0.2)
        time.sleep(1)
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=30) == 3
        assert [event["event"] for event in events(log)] == ["start", "sigterm"]

    def test_a_wedged_engine_releases_the_lock_and_exits_75(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        log: Path = tmp_path / "events.jsonl"
        lock: Path = tmp_path / "load.lock"
        env: dict[str, str] = self._base_env(tmp_path, free_port(), log)
        env["VLM_LOAD_LOCK_FILE"] = str(lock)
        env["VLM_HEALTH_TIMEOUT_SECONDS"] = "3"
        env["FAKE_VLLM_NEVER_READY"] = "1"

        result: subprocess.CompletedProcess[str] = run_launcher(
            env, path_prefix=stub_path, timeout=60
        )
        assert result.returncode == 75
        assert "no /health in 3s" in result.stderr
        assert "load lock released." in result.stdout
        # The lock is free again: another engine can take it immediately.
        import fcntl

        with open(lock, "a", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def test_the_load_lock_serializes_two_engines(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        log: Path = tmp_path / "events.jsonl"
        lock: Path = tmp_path / "load.lock"
        state: Path = tmp_path / "active-model"
        state.write_text("acme/model-a\n", encoding="utf-8")

        first_env: dict[str, str] = self._base_env(tmp_path, free_port(), log)
        first_env.update(
            {
                "VLM_LOAD_LOCK_FILE": str(lock),
                "VLM_STATE_FILE": str(state),
                "FAKE_VLLM_READY_AFTER": "3",
            }
        )
        second_env: dict[str, str] = self._base_env(tmp_path, free_port(), log)
        second_env.update(
            {
                "VLM_MODEL": "acme/model-b",
                "VLM_LOAD_LOCK_FILE": str(lock),
                "VLM_STATE_FILE": str(state),
            }
        )

        processes: list[subprocess.Popen[str]] = []
        try:
            processes.append(
                subprocess.Popen(
                    [sys.executable, str(LAUNCHER)],
                    env={
                        **os.environ,
                        **first_env,
                        "PATH": f"{stub_path}:{os.environ['PATH']}",
                    },
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            )
            # Let the first engine take the lock before the second asks. The
            # wait covers a Python startup, so it is generous: if the second
            # launcher won the race the test would be measuring nothing.
            assert until(lambda: lock.exists(), timeout=30)
            time.sleep(1)
            processes.append(
                subprocess.Popen(
                    [sys.executable, str(LAUNCHER)],
                    env={
                        **os.environ,
                        **second_env,
                        "PATH": f"{stub_path}:{os.environ['PATH']}",
                    },
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            )
            deadline: float = time.monotonic() + 40
            while time.monotonic() < deadline:
                names: list[str] = [
                    event.get("model", "")
                    for event in events(log)
                    if event["event"] == "start"
                ]
                if "acme/model-b" in names:
                    break
                time.sleep(0.2)
            recorded: list[dict[str, Any]] = events(log)
            starts: dict[str, float] = {
                event["model"]: event["at"]
                for event in recorded
                if event["event"] == "start"
            }
            assert set(starts) == {"acme/model-a", "acme/model-b"}
            # B only started once A was ready and released the lock: A's stub
            # needs 3s to answer /health, and B waited them out.
            assert starts["acme/model-b"] - starts["acme/model-a"] >= 3
        finally:
            for process in processes:
                process.terminate()
                process.wait(timeout=30)

    def test_without_duties_the_launcher_execs_the_engine(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        """No lock, no state file: the container is handed straight to vLLM."""
        log: Path = tmp_path / "events.jsonl"
        env: dict[str, str] = self._base_env(tmp_path, free_port(), log)
        del env["VLM_SLEEP_MODE"]
        process: subprocess.Popen[str] = subprocess.Popen(
            [sys.executable, str(LAUNCHER)],
            env={**os.environ, **env, "PATH": f"{stub_path}:{os.environ['PATH']}"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline: float = time.monotonic() + 30
            while time.monotonic() < deadline and not events(log):
                time.sleep(0.2)
            assert [event["event"] for event in events(log)] == ["start"]
            # execvp replaced the launcher, so the engine IS the container's
            # process: signalling the launcher pid signals the engine.
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=30) == 0
            assert [event["event"] for event in events(log)] == ["start", "sigterm"]
        finally:
            if process.poll() is None:
                process.kill()


def http_get(port: int, path: str) -> tuple[int, str]:
    """A plain GET against an engine's own port, status and body."""
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}{path}", timeout=5
        ) as response:
            return int(response.status), response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return int(error.code), error.read().decode("utf-8")
    except (urllib.error.URLError, OSError) as error:
        return 0, str(error)


def until(predicate: Any, timeout: float = 30.0) -> bool:
    """Poll a predicate to a deadline. False means it never came true."""
    deadline: float = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def engine_key(model: str) -> str:
    return launcher.engine_key(model)


def put_spec(state_dir: Path, model: str, **overrides: Any) -> Path:
    """Write one engine's spec the way VIS does: whole file, through a rename."""
    document: dict[str, Any] = {
        "spec_version": 1,
        "catalog_id": model,
        "model": model,
        "served_model_name": model,
        "port": overrides.pop("port", 8000),
        "args": [f"--port={overrides.get('port', 8000)}"],
        "env": {},
        "sleep_mode": True,
        "sleep_level": 1,
        "active": True,
        "desired_state": "awake",
        "gpu_ids": None,
        "tensor_parallel_size": 1,
        "tuning_tier": "compact",
        "load_lock_file": None,
        "health_timeout_seconds": 1800,
        "generated_by": "VIS 1.1.0",
        "generated_at": "2026-09-22T12:00:00Z",
    }
    document.update(overrides)
    document["args"] = [f"--port={document['port']}"]
    path: Path = state_dir / "engines" / f"{engine_key(model)}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return path


class ManagedEngine:
    """One launcher running against a state volume, driven by its spec."""

    def __init__(
        self, tmp_path: Path, stub_path: Path, state_dir: Path, model: str
    ) -> None:
        self.state_dir: Path = state_dir
        self.model: str = model
        self.port: int = free_port()
        self.log: Path = tmp_path / f"events-{engine_key(model)}.jsonl"
        self.stub_path: Path = stub_path
        self.starting_file: Path = tmp_path / f"starting-{engine_key(model)}"
        self.process: subprocess.Popen[str] | None = None
        self.extra_env: dict[str, str] = {}

    @property
    def ready_marker(self) -> Path:
        return self.state_dir / "ready" / engine_key(self.model)

    @property
    def awake_marker(self) -> Path:
        return self.state_dir / "awake" / engine_key(self.model)

    @property
    def loading_marker(self) -> Path:
        return self.state_dir / "loading" / engine_key(self.model)

    @property
    def crashed_marker(self) -> Path:
        return self.state_dir / "crashed" / engine_key(self.model)

    def spec_digest(self) -> str:
        spec: Path = self.state_dir / "engines" / f"{engine_key(self.model)}.json"
        return hashlib.sha256(spec.read_bytes()).hexdigest()

    def crash_note(self) -> dict[str, Any]:
        note: dict[str, Any] = json.loads(self.crashed_marker.read_text("utf-8"))
        return note

    @property
    def engine_log(self) -> Path:
        return self.state_dir / "logs" / f"{engine_key(self.model)}.log"

    def spec(self, **overrides: Any) -> Path:
        overrides.setdefault("port", self.port)
        return put_spec(self.state_dir, self.model, **overrides)

    def start(self) -> None:
        env: dict[str, str] = {
            "VIF_STATE_DIR": str(self.state_dir),
            "VLM_MODEL": self.model,
            "VIF_WATCH_POLL_SECONDS": "0.2",
            "VLM_HEALTH_POLL_SECONDS": "0.2",
            "VLM_HEALTH_TIMEOUT_SECONDS": "30",
            "FAKE_VLLM_EVENT_LOG": str(self.log),
            "VIF_STARTING_FILE": str(self.starting_file),
            **self.extra_env,
        }
        self.process = subprocess.Popen(
            [sys.executable, str(LAUNCHER)],
            env={**os.environ, **env, "PATH": f"{self.stub_path}:{os.environ['PATH']}"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

    def events(self) -> list[str]:
        return [event["event"] for event in events(self.log)]

    def started_at(self) -> float:
        for event in events(self.log):
            if event["event"] == "start":
                return float(event["at"])
        raise AssertionError(f"{self.model} never started an engine")

    def stop(self) -> str:
        assert self.process is not None
        if self.process.poll() is None:
            self.process.terminate()
        return self.process.communicate(timeout=30)[0]


@pytest.fixture()
def state_dir(tmp_path: Path) -> Path:
    directory: Path = tmp_path / "vif-state"
    directory.mkdir()
    return directory


class TestWatchLoop:
    """The six desired-state transitions VIS drives by rewriting a spec."""

    @pytest.fixture()
    def engine(self, tmp_path: Path, stub_path: Path, state_dir: Path) -> Any:
        managed: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, "acme/model-a"
        )
        yield managed
        if managed.process is not None:
            managed.stop()

    def test_awake_to_asleep(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: engine.ready_marker.exists())

        engine.spec(desired_state="asleep", active=False)
        assert until(lambda: "sleep" in engine.events())
        assert until(lambda: not engine.awake_marker.exists())
        # Asleep is still loaded.
        assert engine.ready_marker.exists()
        assert http_get(engine.port, "/is_sleeping") == (200, '{"is_sleeping": true}')

    def test_asleep_to_awake(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="asleep", active=False)
        engine.start()
        assert until(lambda: "sleep" in engine.events())

        engine.spec(desired_state="awake", active=True)
        assert until(lambda: "wake" in engine.events())
        assert engine.events() == ["start", "sleep", "wake"]
        assert until(lambda: engine.ready_marker.exists())
        assert http_get(engine.port, "/is_sleeping") == (200, '{"is_sleeping": false}')

    def test_awake_to_parked(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: engine.ready_marker.exists())

        engine.spec(desired_state="parked", active=False)
        assert until(lambda: "sigterm" in engine.events())
        assert engine.events() == ["start", "sigterm"]
        assert until(lambda: not engine.ready_marker.exists())
        # The container stays healthy on a stub, with no engine behind it.
        assert until(lambda: http_get(engine.port, "/health")[0] == 200)
        assert http_get(engine.port, "/vif/parked")[0] == 200
        assert http_get(engine.port, "/is_sleeping")[0] == 404

    def test_asleep_to_parked(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="asleep", active=False)
        engine.start()
        assert until(lambda: "sleep" in engine.events())

        engine.spec(desired_state="parked")
        assert until(lambda: "sigterm" in engine.events())
        assert engine.events() == ["start", "sleep", "sigterm"]
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)

    def test_parked_to_awake(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="parked", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        assert engine.events() == []

        engine.spec(desired_state="awake", active=True)
        assert until(lambda: engine.events() == ["start"])
        assert until(lambda: engine.ready_marker.exists())
        # The stub is gone: the engine owns the port again.
        assert http_get(engine.port, "/vif/parked")[0] == 404
        assert http_get(engine.port, "/health")[0] == 200

    def test_a_start_from_parked_is_marked_until_the_engine_answers(
        self, engine: ManagedEngine
    ) -> None:
        """The stub gives up the port before vLLM opens it; for that stretch the
        starting file is what keeps the container healthy."""
        engine.extra_env["FAKE_VLLM_READY_AFTER"] = "3"
        engine.spec(desired_state="parked", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        assert not engine.starting_file.exists()

        engine.spec(desired_state="awake", active=True)
        assert until(lambda: engine.events() == ["start"])
        assert engine.starting_file.read_text(encoding="utf-8") == "acme/model-a\n"
        assert until(lambda: engine.ready_marker.exists())
        assert not engine.starting_file.exists()
        assert http_get(engine.port, "/health")[0] == 200

    def test_a_boot_is_never_marked_as_starting(self, engine: ManagedEngine) -> None:
        """At boot the healthcheck's start period covers the load; marking it
        would call an engine healthy before it ever loaded."""
        engine.extra_env["FAKE_VLLM_READY_AFTER"] = "3"
        engine.starting_file.write_text("left by a launcher that died\n")
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: engine.events() == ["start"])
        assert not engine.starting_file.exists()
        assert until(lambda: engine.ready_marker.exists())
        assert not engine.starting_file.exists()

    def test_parked_to_asleep(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="parked", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)

        engine.spec(desired_state="asleep", active=False)
        assert until(lambda: engine.events() == ["start", "sleep"])
        assert until(lambda: engine.ready_marker.exists())
        assert not engine.awake_marker.exists()

    def test_a_spec_that_does_not_parse_is_ignored(self, engine: ManagedEngine) -> None:
        """A write in flight is a snapshot, not a decision."""
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: engine.ready_marker.exists())

        path: Path = engine.state_dir / "engines" / f"{engine_key(engine.model)}.json"
        path.write_text('{"spec_version": 1, "model": "acme/mo', encoding="utf-8")
        time.sleep(2)
        assert engine.events() == ["start"]
        assert engine.ready_marker.exists()

        engine.spec(desired_state="parked")
        assert until(lambda: "sigterm" in engine.events())

    def test_a_stale_ready_marker_is_cleared_at_start(
        self, engine: ManagedEngine
    ) -> None:
        """A launcher killed outright leaves its marker; the next one clears it."""
        engine.ready_marker.parent.mkdir(parents=True)
        engine.ready_marker.write_text(f"{engine.model}\n", encoding="utf-8")
        engine.spec(desired_state="parked", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        assert not engine.ready_marker.exists()

    def test_the_parked_stub_names_itself(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="parked", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        status, body = http_get(engine.port, "/vif/parked")
        assert json.loads(body) == {
            "parked": True,
            "model": "acme/model-a",
            "launcher_revision": launcher.LAUNCHER_REVISION,
        }
        assert json.loads(http_get(engine.port, "/health")[1])["parked"] is True

    def test_every_restart_runs_under_the_env_of_the_spec_in_force(
        self, engine: ManagedEngine
    ) -> None:
        """A parked engine brought back hot needs that spec's dev mode and pin."""
        engine.extra_env["FAKE_VLLM_RECORD_ENV"] = (
            "VLLM_SERVER_DEV_MODE,CUDA_VISIBLE_DEVICES,VIF_TEST_MARK"
        )
        engine.spec(desired_state="parked", active=False, sleep_mode=False, env={})
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)

        engine.spec(
            desired_state="asleep",
            active=False,
            env={"VLLM_SERVER_DEV_MODE": "1", "VIF_TEST_MARK": "first"},
            gpu_ids="1",
        )
        assert until(lambda: engine.events() == ["start", "sleep"])

        engine.spec(desired_state="parked", active=False)
        assert until(lambda: engine.events() == ["start", "sleep", "sigterm"])
        engine.spec(
            desired_state="awake",
            env={"VLLM_SERVER_DEV_MODE": "1", "VIF_TEST_MARK": "second"},
            gpu_ids="2",
        )
        assert until(lambda: engine.events() == ["start", "sleep", "sigterm", "start"])

        starts: list[dict[str, Any]] = [
            event["env"] for event in events(engine.log) if event["event"] == "start"
        ]
        assert starts == [
            {
                "VLLM_SERVER_DEV_MODE": "1",
                "CUDA_VISIBLE_DEVICES": "1",
                "VIF_TEST_MARK": "first",
            },
            {
                "VLLM_SERVER_DEV_MODE": "1",
                "CUDA_VISIBLE_DEVICES": "2",
                "VIF_TEST_MARK": "second",
            },
        ]

    def test_a_failed_wake_is_tried_once_per_spec(self, engine: ManagedEngine) -> None:
        """An engine VIS has given up on is not woken again on every poll."""
        engine.extra_env["FAKE_VLLM_WAKE_FAILS"] = "1"
        engine.spec(desired_state="asleep", active=False)
        engine.start()
        assert until(lambda: engine.events() == ["start", "sleep"])

        engine.spec(desired_state="awake", active=True)
        assert until(lambda: engine.events() == ["start", "sleep", "wake"])
        # Ten polls' worth: the spec has not changed, so neither does anything.
        time.sleep(2)
        assert engine.events() == ["start", "sleep", "wake"]
        assert not engine.awake_marker.exists()

        engine.spec(
            desired_state="awake", active=True, generated_at="2026-09-22T12:05:00Z"
        )
        assert until(lambda: engine.events() == ["start", "sleep", "wake", "wake"])
        time.sleep(2)
        assert engine.events() == ["start", "sleep", "wake", "wake"]
        assert http_get(engine.port, "/is_sleeping") == (200, '{"is_sleeping": true}')

    def test_the_child_output_is_teed_to_the_state_volume(
        self, engine: ManagedEngine
    ) -> None:
        engine.extra_env["FAKE_VLLM_STDOUT"] = "loading weights\nserving now"
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: engine.ready_marker.exists())
        assert until(lambda: "serving now" in engine.engine_log.read_text("utf-8"))
        assert engine.engine_log.read_text("utf-8").splitlines() == [
            "loading weights",
            "serving now",
        ]
        # And the container's own stdout still carries it.
        output: str = engine.stop()
        assert "loading weights" in output
        assert "serving now" in output


class TestBootOrder:
    """The engine that should be serving loads last, after the hot pool."""

    def _pool(
        self,
        tmp_path: Path,
        stub_path: Path,
        state_dir: Path,
        models: list[str],
    ) -> list[ManagedEngine]:
        engines: list[ManagedEngine] = [
            ManagedEngine(tmp_path, stub_path, state_dir, model) for model in models
        ]
        self._engines = engines
        return engines

    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Any:
        self._engines: list[ManagedEngine] = []
        yield
        for engine in self._engines:
            if engine.process is not None:
                engine.stop()

    def test_the_serving_engine_loads_after_the_rest_of_the_hot_pool(
        self, tmp_path: Path, stub_path: Path, state_dir: Path
    ) -> None:
        lock: Path = state_dir / "load.lock"
        active, *others = self._pool(
            tmp_path,
            stub_path,
            state_dir,
            ["acme/model-a", "acme/model-b", "acme/model-c", "acme/model-d"],
        )
        active.spec(desired_state="awake", load_lock_file=str(lock))
        for other in others:
            other.spec(desired_state="asleep", active=False, load_lock_file=str(lock))
        for engine in (active, *others):
            engine.extra_env["FAKE_VLLM_READY_AFTER"] = "1"
        # The serving engine asks first and still loads last.
        active.start()
        time.sleep(1)
        for other in others:
            other.start()

        assert until(lambda: active.events() == ["start"], timeout=90)
        for other in others:
            assert other.events() == ["start", "sleep"]
            assert other.ready_marker.stat().st_mtime < active.started_at()
            assert not other.awake_marker.exists()
        assert until(lambda: active.awake_marker.exists())
        assert active.ready_marker.exists()

    def test_parked_engines_are_not_waited_for(
        self, tmp_path: Path, stub_path: Path, state_dir: Path
    ) -> None:
        active, parked, sleepless = self._pool(
            tmp_path,
            stub_path,
            state_dir,
            ["acme/model-a", "acme/model-b", "acme/model-c"],
        )
        active.spec(desired_state="awake")
        parked.spec(desired_state="parked", active=False)
        # Asked to sleep without sleep mode: its launcher parks it.
        sleepless.spec(desired_state="asleep", active=False, sleep_mode=False)
        launched: float = time.time()
        active.start()
        assert until(lambda: active.events() == ["start"], timeout=30)
        assert active.started_at() - launched < 5

    def test_the_wait_gives_up_after_its_timeout(
        self, tmp_path: Path, stub_path: Path, state_dir: Path
    ) -> None:
        active, missing = self._pool(
            tmp_path, stub_path, state_dir, ["acme/model-a", "acme/model-b"]
        )
        active.spec(desired_state="awake")
        # Its spec says asleep, but its container never comes.
        missing.spec(desired_state="asleep", active=False)
        active.extra_env["VIF_POOL_LOAD_TIMEOUT_SECONDS"] = "2"
        launched: float = time.time()
        active.start()
        assert until(lambda: active.events() == ["start"], timeout=30)
        assert active.started_at() - launched >= 2
        output: str = active.stop()
        assert (
            "WARNING: the rest of the pool did not load within 2s; giving up on "
            "acme/model-b and taking the load lock anyway."
        ) in output


class TestLoadGuard:
    """An engine that should be asleep never loads beside a serving one."""

    @pytest.fixture()
    def engine(self, tmp_path: Path, stub_path: Path, state_dir: Path) -> Any:
        managed: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, "acme/model-a"
        )
        yield managed
        if managed.process is not None:
            managed.stop()

    @staticmethod
    def serving(state_dir: Path, model: str) -> Path:
        marker: Path = state_dir / "awake" / engine_key(model)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(f"{model}\n", encoding="utf-8")
        return marker

    def test_it_stays_parked_while_another_engine_is_awake(
        self, engine: ManagedEngine, state_dir: Path
    ) -> None:
        marker: Path = self.serving(state_dir, "acme/model-b")
        engine.spec(desired_state="asleep", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        assert http_get(engine.port, "/health")[0] == 200
        time.sleep(2)
        assert engine.events() == []

        marker.unlink()
        assert until(lambda: engine.events() == ["start", "sleep"])
        assert until(lambda: engine.ready_marker.exists())
        assert not engine.awake_marker.exists()

    def test_a_spec_turning_awake_loads_despite_an_awake_marker(
        self, engine: ManagedEngine, state_dir: Path
    ) -> None:
        self.serving(state_dir, "acme/model-b")
        engine.spec(desired_state="asleep", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)

        engine.spec(desired_state="awake", active=True)
        assert until(lambda: engine.events() == ["start"])
        assert until(lambda: engine.awake_marker.exists())
        assert http_get(engine.port, "/vif/parked")[0] == 404

    def test_a_stale_awake_marker_is_cleared_at_start(
        self, engine: ManagedEngine, state_dir: Path
    ) -> None:
        self.serving(state_dir, engine.model)
        engine.spec(desired_state="parked", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        assert not engine.awake_marker.exists()

    def test_the_awake_marker_follows_the_engine(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: engine.awake_marker.exists())
        assert engine.ready_marker.exists()

        engine.spec(desired_state="asleep", active=False)
        assert until(lambda: not engine.awake_marker.exists())
        assert engine.ready_marker.exists()

        engine.spec(desired_state="awake", active=True)
        assert until(lambda: engine.awake_marker.exists())
        assert engine.events() == ["start", "sleep", "wake"]

        engine.spec(desired_state="parked", active=False)
        assert until(lambda: not engine.awake_marker.exists())
        assert until(lambda: not engine.ready_marker.exists())
        assert engine.events() == ["start", "sleep", "wake", "sigterm"]


def children_of(pid: int) -> list[int]:
    """The live child processes of `pid`, read from /proc."""
    found: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields: list[str] = (
                (entry / "stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()
            )
        except OSError:
            continue
        if int(fields[1]) == pid:
            found.append(int(entry.name))
    return found


def kill_outright(engine: ManagedEngine) -> None:
    """SIGKILL a launcher and its engine, as Docker does once its grace runs out."""
    assert engine.process is not None
    children: list[int] = children_of(engine.process.pid)
    engine.process.kill()
    engine.process.wait(timeout=30)
    for child in children:
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass


class TestAStopClearsTheMarkers:
    """A stop that outlasts the container's grace period ends in a SIGKILL, so
    the markers go when the stop arrives, not when the engine has exited."""

    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Any:
        self._engines: list[ManagedEngine] = []
        yield
        for engine in self._engines:
            if engine.process is not None and engine.process.poll() is None:
                kill_outright(engine)

    def _engine(
        self, tmp_path: Path, stub_path: Path, state_dir: Path, model: str
    ) -> ManagedEngine:
        engine: ManagedEngine = ManagedEngine(tmp_path, stub_path, state_dir, model)
        self._engines.append(engine)
        return engine

    def test_the_markers_are_gone_while_the_engine_is_still_stopping(
        self, tmp_path: Path, stub_path: Path, state_dir: Path
    ) -> None:
        engine: ManagedEngine = self._engine(
            tmp_path, stub_path, state_dir, "acme/model-a"
        )
        # Deaf to SIGTERM: its launcher keeps waiting, as on a slow shutdown.
        engine.extra_env["FAKE_VLLM_IGNORE_SIGTERM"] = "1"
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: engine.awake_marker.exists())
        assert engine.ready_marker.exists()

        assert engine.process is not None
        engine.process.send_signal(signal.SIGTERM)
        assert until(lambda: not engine.ready_marker.exists(), timeout=5)
        assert not engine.awake_marker.exists()
        assert engine.process.poll() is None

        kill_outright(engine)
        assert not engine.ready_marker.exists()
        assert not engine.awake_marker.exists()

    def test_the_serving_engine_waits_for_a_neighbour_that_is_being_restarted(
        self, tmp_path: Path, stub_path: Path, state_dir: Path
    ) -> None:
        """A restart of the whole pool: the neighbour is still stopping when
        the serving engine's new launcher looks at the pool."""
        lock: Path = state_dir / "load.lock"
        active: ManagedEngine = self._engine(
            tmp_path, stub_path, state_dir, "acme/model-a"
        )
        neighbour: ManagedEngine = self._engine(
            tmp_path, stub_path, state_dir, "acme/model-b"
        )
        active.spec(desired_state="awake", load_lock_file=str(lock))
        neighbour.spec(desired_state="asleep", active=False, load_lock_file=str(lock))
        neighbour.extra_env["FAKE_VLLM_IGNORE_SIGTERM"] = "1"
        neighbour.start()
        assert until(lambda: neighbour.events() == ["start", "sleep"])
        assert until(lambda: neighbour.ready_marker.exists())

        assert neighbour.process is not None
        neighbour.process.send_signal(signal.SIGTERM)
        time.sleep(1)
        active.start()
        time.sleep(2)
        assert active.events() == []

        kill_outright(neighbour)
        neighbour.extra_env.pop("FAKE_VLLM_IGNORE_SIGTERM")
        neighbour.start()
        assert until(lambda: active.events() == ["start"], timeout=60)
        assert neighbour.ready_marker.stat().st_mtime < active.started_at()
        assert neighbour.events() == ["start", "sleep", "start", "sleep"]
        output: str = active.stop()
        assert (
            "[vlm-launcher] the serving engine loads last; waiting for "
            "acme/model-b to load first..."
        ) in output
        assert "[vlm-launcher] the rest of the pool is loaded." in output


class TestTheSpecDigest:
    """A crash marker names its load by the digest of the spec file; VIS
    computes it the same way and pins the same literal."""

    def test_the_digest_is_the_sha256_of_the_files_bytes(self, tmp_path: Path) -> None:
        spec: Path = tmp_path / "spec.json"
        spec.write_bytes(b'{"model": "x"}\n')
        assert launcher._digest_of(str(spec)) == (
            "a84625f35f4c63cdb74af89d5e2daac6df1b0da9143b676dcafaafc73d4f9a11"
        )

    def test_the_marker_directories_are_pinned(self) -> None:
        assert launcher.ENGINE_LOADING_DIRNAME == "loading"
        assert launcher.ENGINE_CRASHED_DIRNAME == "crashed"


class TestALoadThatDies:
    """A crash while loading is recorded, and is not loaded again until the
    spec is rewritten; a launcher that died mid-load is told from a clean stop."""

    CRASHING: dict[str, str] = {
        "FAKE_VLLM_NEVER_READY": "1",
        "FAKE_VLLM_CRASH_AFTER": "0.5",
    }

    @pytest.fixture()
    def engine(self, tmp_path: Path, stub_path: Path, state_dir: Path) -> Any:
        managed: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, "acme/model-a"
        )
        yield managed
        if managed.process is not None:
            managed.stop()

    def test_an_exit_during_the_load_is_recorded_with_its_code(
        self, engine: ManagedEngine
    ) -> None:
        engine.extra_env = {**self.CRASHING, "FAKE_VLLM_CRASH_CODE": "3"}
        engine.spec(desired_state="awake")
        digest: str = engine.spec_digest()
        engine.start()

        assert engine.process is not None
        assert engine.process.wait(timeout=30) == 3
        note: dict[str, Any] = engine.crash_note()
        assert abs(note.pop("at") - time.time()) < 60
        assert note == {
            "spec_digest": digest,
            "exit_code": 3,
            "signal": None,
            "reason": "vLLM exited with code 3 during its load",
        }
        assert not engine.loading_marker.exists()
        assert not engine.ready_marker.exists()

    def test_a_kill_during_the_load_is_recorded_as_its_signal(
        self, engine: ManagedEngine
    ) -> None:
        engine.extra_env = {**self.CRASHING, "FAKE_VLLM_CRASH_SIGNAL": "9"}
        engine.spec(desired_state="awake")
        digest: str = engine.spec_digest()
        engine.start()

        assert engine.process is not None
        assert engine.process.wait(timeout=30) == 137
        note: dict[str, Any] = engine.crash_note()
        assert abs(note.pop("at") - time.time()) < 60
        assert note == {
            "spec_digest": digest,
            "exit_code": None,
            "signal": 9,
            "reason": "vLLM was killed by signal 9 during its load",
        }

    def test_a_load_that_succeeds_clears_the_markers(
        self, engine: ManagedEngine
    ) -> None:
        engine.extra_env = {"FAKE_VLLM_READY_AFTER": "1.5"}
        engine.spec(desired_state="awake")
        digest: str = engine.spec_digest()
        engine.crashed_marker.parent.mkdir(parents=True)
        engine.crashed_marker.write_text(
            json.dumps({"spec_digest": "an-older-spec", "exit_code": 1}),
            encoding="utf-8",
        )
        engine.start()

        assert until(lambda: engine.loading_marker.exists())
        assert (
            json.loads(engine.loading_marker.read_text("utf-8"))["spec_digest"]
            == digest
        )
        assert not engine.ready_marker.exists()
        assert until(lambda: engine.ready_marker.exists())
        assert not engine.loading_marker.exists()
        assert not engine.crashed_marker.exists()

    def test_a_restart_with_the_same_spec_stays_parked_until_it_is_rewritten(
        self, engine: ManagedEngine
    ) -> None:
        engine.extra_env = {**self.CRASHING, "FAKE_VLLM_CRASH_CODE": "3"}
        engine.spec(desired_state="awake")
        engine.start()
        assert engine.process is not None
        assert engine.process.wait(timeout=30) == 3
        assert engine.events() == ["start", "crash"]

        # What Docker's restart policy does next.
        engine.extra_env = {}
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        time.sleep(1.5)
        assert engine.events() == ["start", "crash"]
        assert engine.crash_note()["exit_code"] == 3
        assert not engine.loading_marker.exists()

        engine.spec(desired_state="awake", generated_at="2026-09-22T12:05:00Z")
        assert until(lambda: engine.ready_marker.exists())
        assert engine.events() == ["start", "crash", "start"]
        assert not engine.crashed_marker.exists()
        output: str = engine.stop()
        assert (
            "[vlm-launcher] the last load of acme/model-a died (vLLM exited with "
            "code 3 during its load); staying parked until the desired state is "
            "rewritten."
        ) in output

    def test_a_spec_rewritten_before_the_restart_loads_normally(
        self, engine: ManagedEngine
    ) -> None:
        engine.extra_env = {**self.CRASHING, "FAKE_VLLM_CRASH_CODE": "3"}
        engine.spec(desired_state="awake")
        engine.start()
        assert engine.process is not None
        assert engine.process.wait(timeout=30) == 3

        engine.extra_env = {}
        engine.spec(desired_state="awake", generated_at="2026-09-22T12:05:00Z")
        engine.start()
        assert until(lambda: engine.ready_marker.exists())
        assert engine.events() == ["start", "crash", "start"]
        assert not engine.crashed_marker.exists()

    def _leave_loading(self, engine: ManagedEngine, digest: str) -> None:
        engine.loading_marker.parent.mkdir(parents=True)
        engine.loading_marker.write_text(
            json.dumps({"spec_digest": digest, "at": 1.0}), encoding="utf-8"
        )

    def test_a_launcher_that_died_mid_load_is_recorded_by_the_next_one(
        self, engine: ManagedEngine
    ) -> None:
        engine.spec(desired_state="awake")
        digest: str = engine.spec_digest()
        self._leave_loading(engine, digest)
        engine.start()

        assert until(engine.crashed_marker.exists)
        note: dict[str, Any] = engine.crash_note()
        assert abs(note.pop("at") - time.time()) < 60
        assert note == {
            "spec_digest": digest,
            "exit_code": None,
            "signal": None,
            "reason": (
                "the previous launcher died while this engine was loading "
                "(the container was killed or ran out of memory)"
            ),
        }
        assert not engine.loading_marker.exists()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        time.sleep(1)
        assert engine.events() == []

    def test_a_load_marker_for_another_spec_is_only_stale(
        self, engine: ManagedEngine
    ) -> None:
        engine.spec(desired_state="awake")
        self._leave_loading(engine, "an-older-spec")
        engine.start()

        assert until(lambda: engine.ready_marker.exists())
        assert engine.events() == ["start"]
        assert not engine.crashed_marker.exists()
        assert not engine.loading_marker.exists()

    def test_a_load_marker_beside_a_ready_marker_is_not_a_dead_load(
        self, engine: ManagedEngine
    ) -> None:
        engine.spec(desired_state="awake")
        self._leave_loading(engine, engine.spec_digest())
        engine.ready_marker.parent.mkdir(parents=True)
        engine.ready_marker.write_text("acme/model-a\n", encoding="utf-8")
        engine.start()

        assert until(lambda: engine.ready_marker.exists() and bool(engine.events()))
        assert until(lambda: not engine.loading_marker.exists())
        assert engine.events() == ["start"]
        assert not engine.crashed_marker.exists()

    def test_a_stop_during_the_load_is_not_a_crash(self, engine: ManagedEngine) -> None:
        engine.extra_env = {"FAKE_VLLM_NEVER_READY": "1"}
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: engine.loading_marker.exists())
        assert until(lambda: engine.events() == ["start"])

        assert engine.process is not None
        engine.process.send_signal(signal.SIGTERM)
        assert engine.process.wait(timeout=30) == 0
        assert engine.events() == ["start", "sigterm"]
        assert not engine.crashed_marker.exists()
        assert not engine.loading_marker.exists()


def launch(env: dict[str, str], output: Path, stub_path: Path) -> subprocess.Popen[str]:
    """A launcher whose output goes to a file, so a test can wait on a line."""
    return subprocess.Popen(
        [sys.executable, str(LAUNCHER)],
        env={**os.environ, **env, "PATH": f"{stub_path}:{os.environ['PATH']}"},
        stdout=output.open("w", encoding="utf-8"),
        stderr=subprocess.STDOUT,
        text=True,
    )


class TestStopSignals:
    """A stop that arrives before there is an engine still stops the container."""

    def test_sigterm_during_the_spec_wait_exits_cleanly(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        output: Path = tmp_path / "launcher.log"
        process: subprocess.Popen[str] = launch(
            {
                "VIF_ENGINE_SPEC_FILE": str(tmp_path / "engines" / "absent.json"),
                "VIF_SPEC_TIMEOUT_SECONDS": "60",
            },
            output,
            stub_path,
        )
        try:
            assert until(lambda: "waiting up to 60s" in output.read_text("utf-8"))
            stopped_at: float = time.monotonic()
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=5) == 0
            assert time.monotonic() - stopped_at < 2
        finally:
            if process.poll() is None:
                process.kill()

    def test_sigterm_before_the_child_exists_starts_no_engine(
        self, tmp_path: Path, stub_path: Path, state_dir: Path
    ) -> None:
        model: str = "acme/model-a"
        log: Path = tmp_path / "events.jsonl"
        lock: Path = state_dir / "load.lock"
        output: Path = tmp_path / "launcher.log"
        put_spec(
            state_dir,
            model,
            port=free_port(),
            desired_state="awake",
            load_lock_file=str(lock),
        )
        with lock.open("a", encoding="utf-8") as held:
            # A neighbour is loading: the launcher waits for the lock, with no
            # engine process yet, and that is when the stop arrives.
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)
            process: subprocess.Popen[str] = launch(
                {
                    "VIF_STATE_DIR": str(state_dir),
                    "VLM_MODEL": model,
                    "FAKE_VLLM_EVENT_LOG": str(log),
                },
                output,
                stub_path,
            )
            try:
                assert until(
                    lambda: "waiting for the load lock" in output.read_text("utf-8")
                )
                stopped_at: float = time.monotonic()
                process.send_signal(signal.SIGTERM)
                assert process.wait(timeout=5) == 0
                assert time.monotonic() - stopped_at < 2
            finally:
                if process.poll() is None:
                    process.kill()
        assert events(log) == []


class _FakeEngineHandler(BaseHTTPRequestHandler):
    """Stands in for vLLM on the stub's port: /vif/parked is a 404 here."""

    protocol_version: str = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        body: bytes = b'{"engine": true}'
        self.send_response(200 if self.path == "/health" else 404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class TestParkedStubConnections:
    """No connection to the stub outlives it, so no client talks to a ghost."""

    @pytest.fixture()
    def port(self) -> int:
        return free_port()

    @pytest.fixture()
    def stub(self, port: int) -> Any:
        parked: Any = launcher.ParkedStub()
        parked.start(port, "acme/model-a")
        yield parked
        parked.stop()

    @pytest.fixture()
    def fake_engine(self) -> Any:
        servers: list[HTTPServer] = []

        def start(port: int) -> HTTPServer:
            server: HTTPServer = HTTPServer(("127.0.0.1", port), _FakeEngineHandler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            servers.append(server)
            return server

        yield start
        for server in servers:
            server.shutdown()
            server.server_close()

    def test_every_answer_closes_its_connection(self, stub: Any, port: int) -> None:
        connection: http.client.HTTPConnection = http.client.HTTPConnection(
            "127.0.0.1", port, timeout=5
        )
        connection.request("GET", "/vif/parked", headers={"Connection": "keep-alive"})
        response: http.client.HTTPResponse = connection.getresponse()
        assert response.status == 200
        assert response.getheader("Connection") == "close"
        assert json.loads(response.read())["parked"] is True
        connection.close()

    def test_a_reused_connection_reaches_the_engine_after_stop(
        self, stub: Any, port: int, fake_engine: Any
    ) -> None:
        connection: http.client.HTTPConnection = http.client.HTTPConnection(
            "127.0.0.1", port, timeout=5
        )
        connection.request("GET", "/vif/parked", headers={"Connection": "keep-alive"})
        first: http.client.HTTPResponse = connection.getresponse()
        assert first.status == 200
        first.read()

        stub.stop()
        fake_engine(port)
        # The same connection object, as a pooled client would reuse it.
        connection.request("GET", "/vif/parked", headers={"Connection": "keep-alive"})
        second: http.client.HTTPResponse = connection.getresponse()
        assert second.status == 404
        assert second.read() == b'{"engine": true}'
        connection.close()

    def test_stop_closes_a_connection_still_held_open(
        self, stub: Any, port: int
    ) -> None:
        held: socket.socket = socket.create_connection(("127.0.0.1", port), timeout=5)
        # Give the stub's accept loop time to hand the connection to a handler,
        # which then waits on it for a request line.
        time.sleep(0.5)
        stub.stop()
        try:
            held.sendall(b"GET /vif/parked HTTP/1.1\r\nHost: x\r\n\r\n")
            answer: bytes = held.recv(4096)
        except OSError:
            answer = b""
        finally:
            held.close()
        assert answer == b""

    def test_a_new_request_after_stop_reaches_the_engine(
        self, stub: Any, port: int, fake_engine: Any
    ) -> None:
        stub.stop()
        fake_engine(port)
        assert http_get(port, "/vif/parked") == (404, '{"engine": true}')
        assert http_get(port, "/health") == (200, '{"engine": true}')


class TestSharedDirectories:
    def test_a_marker_directory_takes_the_owner_of_the_volume(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """VIS runs as the volume's owner and removes crash notes, so a
        directory the (root) launcher creates must be the volume owner's."""
        volume: Path = tmp_path / "vif-state"
        volume.mkdir()
        owner: os.stat_result = volume.stat()
        calls: list[tuple[str, int, int]] = []
        monkeypatch.setattr(
            launcher.os,
            "chown",
            lambda path, uid, gid: calls.append((str(path), uid, gid)),
        )
        launcher.make_shared_dir(volume / "crashed" / "nested")
        assert (volume / "crashed" / "nested").is_dir()
        assert calls == [
            (str(volume / "crashed"), owner.st_uid, owner.st_gid),
            (str(volume / "crashed" / "nested"), owner.st_uid, owner.st_gid),
        ]
        launcher.make_shared_dir(volume / "crashed")
        assert len(calls) == 2


def seed_cache(
    hf_home: Path,
    model: str,
    *,
    incomplete: int = 0,
    weights: int = 0,
    config: int = 0,
) -> None:
    """A hub cache laid out the way huggingface_hub leaves it mid-download."""
    root: Path = hf_home / "hub" / f"models--{model.replace('/', '--')}"
    (root / "blobs").mkdir(parents=True, exist_ok=True)
    (root / "snapshots" / "rev").mkdir(parents=True, exist_ok=True)
    if config:
        (root / "blobs" / "cfg").write_bytes(b"c" * config)
        (root / "snapshots" / "rev" / "config.json").symlink_to(root / "blobs" / "cfg")
    if incomplete:
        (root / "blobs" / "wts.incomplete").write_bytes(b"i" * incomplete)
    if weights:
        (root / "blobs" / "wts").write_bytes(b"w" * weights)
        (root / "snapshots" / "rev" / "model.safetensors").symlink_to(
            root / "blobs" / "wts"
        )


def finish_download(hf_home: Path, model: str) -> None:
    root: Path = hf_home / "hub" / f"models--{model.replace('/', '--')}"
    size: int = (root / "blobs" / "wts.incomplete").stat().st_size
    (root / "blobs" / "wts.incomplete").rename(root / "blobs" / "wts")
    (root / "snapshots" / "rev" / "model.safetensors").symlink_to(
        root / "blobs" / "wts"
    )
    assert size > 0


class TestWeightsCache:
    MODEL: str = "acme/model-a"

    def env(self, tmp_path: Path) -> dict[str, str]:
        return {"HF_HOME": str(tmp_path)}

    def test_an_empty_cache_has_no_weights(self, tmp_path: Path) -> None:
        assert launcher.weights_cache_state(self.env(tmp_path), self.MODEL) == (
            False,
            0,
        )

    def test_a_download_under_way_counts_its_bytes(self, tmp_path: Path) -> None:
        seed_cache(tmp_path, self.MODEL, config=100, incomplete=1000)
        assert launcher.weights_cache_state(self.env(tmp_path), self.MODEL) == (
            False,
            1100,
        )

    def test_weights_linked_and_nothing_incomplete_are_done(
        self, tmp_path: Path
    ) -> None:
        seed_cache(tmp_path, self.MODEL, config=100, weights=5000)
        assert launcher.weights_cache_state(self.env(tmp_path), self.MODEL) == (
            True,
            5100,
        )

    def test_a_second_file_still_downloading_is_not_done(self, tmp_path: Path) -> None:
        seed_cache(tmp_path, self.MODEL, weights=5000, incomplete=300)
        assert launcher.weights_cache_state(self.env(tmp_path), self.MODEL) == (
            False,
            5300,
        )

    def test_hub_cache_wins_over_home(self, tmp_path: Path) -> None:
        seed_cache(tmp_path / "elsewhere", self.MODEL, weights=10)
        environ: dict[str, str] = {
            "HF_HOME": str(tmp_path / "home"),
            "HF_HUB_CACHE": str(tmp_path / "elsewhere" / "hub"),
        }
        assert launcher.weights_cache_state(environ, self.MODEL) == (True, 10)

    def test_offline_and_local_models_never_download(self, tmp_path: Path) -> None:
        assert launcher.weights_cache_state(
            {"HF_HOME": str(tmp_path), "HF_HUB_OFFLINE": "1"}, self.MODEL
        ) == (True, 0)
        assert launcher.weights_cache_state({}, str(tmp_path)) == (True, 0)


class FakeHub:
    """A HuggingFace stand-in that answers every HEAD with one status."""

    def __init__(self, status: int) -> None:
        self.status: int = status
        self.requests: list[tuple[str, str]] = []
        hub: FakeHub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: Any) -> None:
                return

            def do_HEAD(self) -> None:
                hub.requests.append((self.path, self.headers.get("Authorization", "")))
                self.send_response(hub.status)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server: HTTPServer = HTTPServer(("127.0.0.1", free_port()), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def hub() -> Any:
    hubs: list[FakeHub] = []

    def make(status: int) -> FakeHub:
        made: FakeHub = FakeHub(status)
        hubs.append(made)
        return made

    yield make
    for made in hubs:
        made.close()


class TestGatedAccess:
    MODEL: str = "acme/gated-model"

    def environ(
        self, tmp_path: Path, hub_url: str, token: str = "hf_x"
    ) -> dict[str, str]:
        return {"HF_HOME": str(tmp_path), "HF_ENDPOINT": hub_url, "HF_TOKEN": token}

    def test_no_token_is_refused_without_asking_the_hub(
        self, tmp_path: Path, hub: Any
    ) -> None:
        fake: FakeHub = hub(200)
        problem: Any = launcher.gated_access_problem(
            self.environ(tmp_path, fake.url, token=""), self.MODEL
        )
        assert problem == launcher.AccessProblem.TOKEN_MISSING
        assert fake.requests == []

    def test_the_older_token_variable_counts(self, tmp_path: Path, hub: Any) -> None:
        fake: FakeHub = hub(200)
        environ: dict[str, str] = {
            "HF_HOME": str(tmp_path),
            "HF_ENDPOINT": fake.url,
            "HUGGING_FACE_HUB_TOKEN": "hf_old",
        }
        assert launcher.gated_access_problem(environ, self.MODEL) is None
        assert fake.requests == [
            (f"/{self.MODEL}/resolve/main/config.json", "Bearer hf_old")
        ]

    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (401, "token_rejected"),
            (403, "license_not_accepted"),
            (200, None),
            (307, None),
            (404, None),
            (500, None),
        ],
    )
    def test_the_hubs_answer_names_the_problem(
        self, tmp_path: Path, hub: Any, status: int, expected: str | None
    ) -> None:
        fake: FakeHub = hub(status)
        problem: Any = launcher.gated_access_problem(
            self.environ(tmp_path, fake.url), self.MODEL
        )
        assert problem == expected

    def test_a_hub_that_cannot_be_reached_blocks_nothing(self, tmp_path: Path) -> None:
        environ: dict[str, str] = self.environ(
            tmp_path, f"http://127.0.0.1:{free_port()}"
        )
        assert launcher.gated_access_problem(environ, self.MODEL) is None

    def test_weights_on_disk_need_no_token(self, tmp_path: Path, hub: Any) -> None:
        seed_cache(tmp_path, self.MODEL, weights=10)
        fake: FakeHub = hub(403)
        problem: Any = launcher.gated_access_problem(
            self.environ(tmp_path, fake.url, token=""), self.MODEL
        )
        assert problem is None
        assert fake.requests == []


class TestAGatedEngine:
    """A gated model that cannot be downloaded is refused before anything starts."""

    MODEL: str = "acme/model-a"

    @pytest.fixture()
    def engine(self, tmp_path: Path, stub_path: Path, state_dir: Path) -> Any:
        managed: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, self.MODEL
        )
        managed.extra_env = {"HF_HOME": str(tmp_path / "hf"), "HF_TOKEN": ""}
        yield managed
        if managed.process is not None:
            managed.stop()

    def test_without_a_token_it_stays_parked_and_says_why(
        self, engine: ManagedEngine
    ) -> None:
        engine.spec(desired_state="awake", gated=True)
        digest: str = engine.spec_digest()
        engine.start()

        assert until(engine.crashed_marker.exists)
        note: dict[str, Any] = engine.crash_note()
        assert abs(note.pop("at") - time.time()) < 60
        assert note == {
            "spec_digest": digest,
            "exit_code": None,
            "signal": None,
            "reason": (
                "acme/model-a is a gated HuggingFace model and cannot be "
                "downloaded: no HF_TOKEN is set"
            ),
            "access_problem": "token_missing",
        }
        assert engine.events() == []
        assert not engine.loading_marker.exists()
        assert http_get(engine.port, "/health")[0] == 200
        assert engine.process is not None and engine.process.poll() is None

    def test_the_parked_stub_reports_the_verdict_when_asked(
        self, engine: ManagedEngine, hub: Any
    ) -> None:
        fake: FakeHub = hub(403)
        engine.extra_env.update({"HF_ENDPOINT": fake.url, "HF_TOKEN": "hf_x"})
        engine.spec(desired_state="parked", gated=True)
        engine.start()

        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        status: int
        body: str
        status, body = http_get(engine.port, "/vif/access")
        assert status == 200
        assert json.loads(body) == {
            "model": self.MODEL,
            "gated": True,
            "ok": False,
            "access_problem": "license_not_accepted",
        }
        fake.status = 200
        assert json.loads(http_get(engine.port, "/vif/access")[1])["ok"] is True

    def test_an_ungated_engine_is_always_ok(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="parked")
        engine.start()

        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)
        report: dict[str, Any] = json.loads(http_get(engine.port, "/vif/access")[1])
        assert report["gated"] is False
        assert report["ok"] is True
        assert report["access_problem"] == ""

    def test_a_licensed_token_loads_normally(
        self, engine: ManagedEngine, hub: Any
    ) -> None:
        fake: FakeHub = hub(200)
        engine.extra_env.update({"HF_ENDPOINT": fake.url, "HF_TOKEN": "hf_x"})
        engine.spec(desired_state="awake", gated=True)
        engine.start()

        assert until(lambda: engine.events() == ["start"])
        assert until(engine.awake_marker.exists)
        assert not engine.crashed_marker.exists()

    def test_a_rewritten_spec_is_asked_again(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="awake", gated=True)
        engine.start()
        assert until(engine.crashed_marker.exists)

        engine.spec(desired_state="awake", gated=True, generated_at="later")
        digest: str = engine.spec_digest()
        assert until(lambda: engine.crash_note()["spec_digest"] == digest)
        assert engine.events() == []

    def test_a_restart_forgets_the_refusal_because_the_token_may_have_changed(
        self, tmp_path: Path, engine: ManagedEngine, hub: Any
    ) -> None:
        engine.spec(desired_state="awake", gated=True)
        engine.start()
        assert until(engine.crashed_marker.exists)
        engine.stop()

        fake: FakeHub = hub(200)
        engine.extra_env.update({"HF_ENDPOINT": fake.url, "HF_TOKEN": "hf_x"})
        engine.start()
        assert until(lambda: engine.events() == ["start"])
        assert until(engine.awake_marker.exists)
        assert not engine.crashed_marker.exists()

    def test_the_serving_engine_does_not_wait_for_a_refused_neighbour(
        self, tmp_path: Path, stub_path: Path, state_dir: Path
    ) -> None:
        active: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, "acme/model-a"
        )
        gated: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, "acme/model-b"
        )
        active.spec(desired_state="awake")
        gated.spec(desired_state="asleep", active=False, gated=True)
        gated.extra_env = {"HF_HOME": str(tmp_path / "hf"), "HF_TOKEN": ""}
        try:
            gated.start()
            assert until(gated.crashed_marker.exists)
            launched: float = time.time()
            active.start()
            assert until(lambda: active.events() == ["start"], timeout=30)
            assert active.started_at() - launched < 5
        finally:
            for managed in (active, gated):
                if managed.process is not None:
                    managed.stop()


class TestLoadPhases:
    """The phase of a load is published, in order, for VIS to follow."""

    MODEL: str = "acme/model-a"

    @pytest.fixture()
    def engine(self, tmp_path: Path, stub_path: Path, state_dir: Path) -> Any:
        managed: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, self.MODEL
        )
        managed.extra_env = {"HF_HOME": str(tmp_path / "hf")}
        yield managed
        if managed.process is not None:
            managed.stop()

    @staticmethod
    def phase_of(engine: ManagedEngine) -> dict[str, Any] | None:
        try:
            note: dict[str, Any] = json.loads(
                (engine.state_dir / "phase" / engine_key(engine.model)).read_text(
                    "utf-8"
                )
            )
        except (OSError, json.JSONDecodeError):
            return None
        return note

    def test_a_first_load_walks_downloading_loading_compiling(
        self, tmp_path: Path, engine: ManagedEngine
    ) -> None:
        hf_home: Path = tmp_path / "hf"
        seed_cache(hf_home, self.MODEL, config=100, incomplete=4000)
        # The stand-in prints vLLM's "weights are loaded" line three seconds in.
        engine.extra_env.update(
            {
                "FAKE_VLLM_READY_AFTER": "6",
                "FAKE_VLLM_LATE_AFTER": "3",
                "FAKE_VLLM_LATE_STDOUT": "INFO Loading weights took 1.20 seconds",
            }
        )
        engine.spec(desired_state="awake")
        digest: str = engine.spec_digest()
        engine.start()

        seen: list[str] = []

        def observe() -> dict[str, Any] | None:
            note: dict[str, Any] | None = self.phase_of(engine)
            if note is not None and (not seen or seen[-1] != note["phase"]):
                seen.append(note["phase"])
            return note

        assert until(
            lambda: (observe() or {}).get("phase") == "downloading"
            and observe()["downloaded_bytes"] == 4100
        )
        note: dict[str, Any] | None = observe()
        assert note is not None
        assert note["spec_digest"] == digest
        finish_download(hf_home, self.MODEL)
        assert until(lambda: (observe() or {}).get("phase") == "compiling")
        assert until(engine.ready_marker.exists)
        assert self.phase_of(engine) is None
        assert [phase for phase in seen if phase != "waiting"] == [
            "downloading",
            "loading",
            "compiling",
        ]

    def test_weights_on_disk_skip_the_download(
        self, tmp_path: Path, engine: ManagedEngine
    ) -> None:
        seed_cache(tmp_path / "hf", self.MODEL, config=100, weights=4000)
        engine.extra_env.update({"FAKE_VLLM_READY_AFTER": "4"})
        engine.spec(desired_state="awake")
        engine.start()

        assert until(lambda: (self.phase_of(engine) or {}).get("phase") == "loading")
        note: dict[str, Any] | None = self.phase_of(engine)
        assert note is not None
        assert "downloaded_bytes" not in note
        assert until(engine.ready_marker.exists)

    def test_a_phase_never_moves_backwards(
        self, tmp_path: Path, engine: ManagedEngine
    ) -> None:
        seed_cache(tmp_path / "hf", self.MODEL, weights=10)
        engine.extra_env.update(
            {
                "FAKE_VLLM_READY_AFTER": "4",
                "FAKE_VLLM_STDOUT": "Model loading took 4 GiB",
            }
        )
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: (self.phase_of(engine) or {}).get("phase") == "compiling")
        (
            tmp_path
            / "hf"
            / "hub"
            / "models--acme--model-a"
            / "blobs"
            / "late.incomplete"
        ).write_bytes(b"x")
        time.sleep(1)
        assert (self.phase_of(engine) or {}).get("phase") == "compiling"

    def test_a_load_that_dies_leaves_no_phase(
        self, tmp_path: Path, engine: ManagedEngine
    ) -> None:
        seed_cache(tmp_path / "hf", self.MODEL, weights=10)
        engine.extra_env.update(
            {"FAKE_VLLM_NEVER_READY": "1", "FAKE_VLLM_CRASH_AFTER": "1.5"}
        )
        engine.spec(desired_state="awake")
        engine.start()
        assert until(lambda: self.phase_of(engine) is not None)
        assert engine.process is not None
        engine.process.wait(timeout=30)
        assert self.phase_of(engine) is None

    def test_a_hot_move_publishes_no_phase(
        self, tmp_path: Path, engine: ManagedEngine
    ) -> None:
        seed_cache(tmp_path / "hf", self.MODEL, weights=10)
        engine.spec(desired_state="awake")
        engine.start()
        assert until(engine.awake_marker.exists)
        engine.spec(desired_state="asleep", active=False)
        assert until(lambda: engine.events() == ["start", "sleep"])
        assert self.phase_of(engine) is None
