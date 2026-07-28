"""Approved Stage 2 detector-profile loading.

The caller touches ``config/*.yaml`` once. Modules receive an immutable
``ModuleProfile`` and remain pure functions of their bar window and
``SymbolSpec``.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from ..core.config import Config


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


@dataclass(frozen=True)
class ModuleProfile:
    """Immutable common and per-module parameters."""

    module_id: int
    common: Mapping[str, Any]
    parameters: Mapping[str, Any]

    def value(self, key: str) -> Any:
        if key in self.parameters:
            return self.parameters[key]
        if key in self.common:
            return self.common[key]
        raise KeyError(f"module {self.module_id} missing approved parameter {key!r}")

    def number(
        self,
        key: str,
        *,
        integer: bool = False,
        positive: bool = False,
        non_negative: bool = False,
    ) -> int | float:
        value = self.value(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(f"module {self.module_id} parameter {key!r} must be numeric")
        if not math.isfinite(float(value)):
            raise ValueError(f"module {self.module_id} parameter {key!r} must be finite")
        if integer and not isinstance(value, int):
            raise TypeError(f"module {self.module_id} parameter {key!r} must be int")
        if positive and value <= 0:
            raise ValueError(f"module {self.module_id} parameter {key!r} must be positive")
        if non_negative and value < 0:
            raise ValueError(
                f"module {self.module_id} parameter {key!r} must be non-negative"
            )
        return value

    def integer(self, key: str, *, positive: bool = False) -> int:
        return int(self.number(key, integer=True, positive=positive))

    def text(self, key: str) -> str:
        value = self.value(key)
        if not isinstance(value, str) or not value:
            raise TypeError(
                f"module {self.module_id} parameter {key!r} must be non-empty text"
            )
        return value

    def texts(self, key: str) -> tuple[str, ...]:
        value = self.value(key)
        if not isinstance(value, tuple) or any(
            not isinstance(item, str) or not item for item in value
        ):
            raise TypeError(
                f"module {self.module_id} parameter {key!r} must be a text list"
            )
        return value


def load_module_profile(config: Config, module_id: int) -> ModuleProfile:
    if isinstance(module_id, bool) or not isinstance(module_id, int):
        raise TypeError("module_id must be an integer")
    if not 1 <= module_id <= 28:
        raise ValueError("module_id must be in the approved range 1..28")
    common = _freeze(config.section("strategies.common"))
    parameters = _freeze(config.section(f"strategies.modules.m{module_id:02d}"))
    return ModuleProfile(
        module_id=module_id,
        common=common,
        parameters=parameters,
    )


def validate_strategy_config(config: Config) -> None:
    schema = config.get("strategies.schema_version")
    if schema != 1:
        raise ValueError("strategies.schema_version must be the approved value 1")
    for module_id in range(1, 29):
        load_module_profile(config, module_id)
    if config.get("strategies.co_firing.apply_proposal_to_config") is not False:
        raise ValueError("Stage 2 measured proposals must not auto-apply to config")


__all__ = ["ModuleProfile", "load_module_profile", "validate_strategy_config"]
