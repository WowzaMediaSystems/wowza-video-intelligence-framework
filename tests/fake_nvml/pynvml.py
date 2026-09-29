"""
A stand-in for pynvml, for launchers run as subprocesses by the tests: put its
directory first on PYTHONPATH and the launcher reads this card instead of the
host's.

FAKE_NVML_MEMORY names a JSON file, {"free_mib", "total_mib", "reserved_mib"},
read on every call so a test (or a fake engine holding memory) can change the
card between two loads. Without it, nvmlInit fails, as on a host without a
driver.
"""

import json
import os

from pathlib import Path
from types import SimpleNamespace
from typing import Any

MIB: int = 1024 * 1024
nvmlMemory_v2: int = 0x02000028


class NVMLError(Exception):
    pass


def _card() -> dict[str, int]:
    card: dict[str, int] = json.loads(
        Path(os.environ["FAKE_NVML_MEMORY"]).read_text(encoding="utf-8")
    )
    return card


def nvmlInit() -> None:
    if not os.environ.get("FAKE_NVML_MEMORY"):
        raise NVMLError("Driver Not Loaded")


def nvmlShutdown() -> None:
    return None


def nvmlDeviceGetCount() -> int:
    return 1


def nvmlDeviceGetHandleByIndex(index: int) -> int:
    return index


def nvmlDeviceGetMemoryInfo(handle: Any, version: int | None = None) -> Any:
    card: dict[str, int] = _card()
    return SimpleNamespace(
        free=card["free_mib"] * MIB,
        total=(card["total_mib"] + card["reserved_mib"]) * MIB,
        reserved=card["reserved_mib"] * MIB,
    )
