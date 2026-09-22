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

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
import types

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
        self.process: subprocess.Popen[str] | None = None
        self.extra_env: dict[str, str] = {}

    @property
    def ready_marker(self) -> Path:
        return self.state_dir / "ready" / engine_key(self.model)

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
        assert until(lambda: not engine.ready_marker.exists())
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

    def test_parked_to_asleep(self, engine: ManagedEngine) -> None:
        engine.spec(desired_state="parked", active=False)
        engine.start()
        assert until(lambda: http_get(engine.port, "/vif/parked")[0] == 200)

        engine.spec(desired_state="asleep", active=False)
        assert until(lambda: engine.events() == ["start", "sleep"])
        assert not engine.ready_marker.exists()

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


class TestLoadLockPriority:
    """The engine that should be serving loads first, whoever asked first."""

    @pytest.fixture()
    def engines(self, tmp_path: Path, stub_path: Path, state_dir: Path) -> Any:
        (state_dir / "active-model").write_text("acme/model-a\n", encoding="utf-8")
        lock: Path = state_dir / "load.lock"
        active: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, "acme/model-a"
        )
        other: ManagedEngine = ManagedEngine(
            tmp_path, stub_path, state_dir, "acme/model-b"
        )
        for engine in (active, other):
            engine.extra_env["FAKE_VLLM_READY_AFTER"] = "2"
        active.spec(desired_state="awake", load_lock_file=str(lock))
        other.spec(desired_state="asleep", active=False, load_lock_file=str(lock))
        yield active, other
        for engine in (active, other):
            if engine.process is not None:
                engine.stop()

    def test_a_non_active_engine_waits_for_the_active_one(
        self, engines: tuple[ManagedEngine, ManagedEngine]
    ) -> None:
        active, other = engines
        # The neighbour asks first and still loads second: flock alone would
        # have handed it the lock two seconds before the active engine asked.
        other.start()
        time.sleep(2)
        active.start()

        assert until(lambda: other.events() == ["start", "sleep"], timeout=60)
        assert active.started_at() < other.started_at()
        assert active.ready_marker.exists()

    def test_the_active_engine_never_waits(
        self, engines: tuple[ManagedEngine, ManagedEngine]
    ) -> None:
        active, _ = engines
        # Nothing has published a readiness marker, and the active engine is
        # not supposed to care: it is the one everyone else waits for.
        launched: float = time.time()
        active.start()
        assert until(lambda: active.events() == ["start"], timeout=30)
        assert active.started_at() - launched < 5
