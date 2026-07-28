"""Config loading — spec §0 rule "all weights, thresholds and policies live in
config files, never in code".

Two properties matter more than convenience here:

1. **No silent defaults.** `get()` raises `ConfigError` on a missing key. A
   missing key means the operator has not yet made a decision Appendix B
   reserves for them; substituting a plausible number is precisely the
   "confident guess that compiles" CLAUDE.md warns about.

2. **A stable version stamp.** `Config.version` is content-addressed over the
   loaded files, so the `config_version` written onto a `Signal` at lock and
   onto an `OutcomeRecord` at resolution genuinely identifies the parameter set
   that produced it (§2, §12.4).
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml

from .errors import ConfigError

_MISSING = object()

# Written into a YAML file where the spec reserves the value for the operator
# (Appendix B) or is silent on it. Reading such a key raises rather than
# returning the string, so an undecided parameter fails at startup instead of
# propagating into a backtest as a plausible-looking number.
OPERATOR_DECISION = "<OPERATOR DECISION>"


class Config:
    """Read-only view over `config/*.yaml`.

    Keys are dotted paths across the merged namespace, where the top level is
    the filename stem:

        cfg.get("backtest.slippage_points")   -> config/backtest.yaml
        cfg.get("costs.commission_per_lot")   -> config/costs.yaml
    """

    def __init__(self, data: dict[str, Any], version: str, source_dir: Path):
        self._data = data
        self._version = version
        self._source_dir = source_dir

    # ---------------------------------------------------------------- loading

    @classmethod
    def load(cls, config_dir: str | Path) -> Config:
        directory = Path(config_dir)
        if not directory.is_dir():
            raise ConfigError(f"config directory not found: {directory}")

        files = sorted(directory.glob("*.yaml"))
        if not files:
            raise ConfigError(f"no *.yaml files in config directory: {directory}")

        data: dict[str, Any] = {}
        hasher = hashlib.sha256()
        for path in files:
            raw = path.read_bytes()
            hasher.update(path.name.encode("utf-8"))
            hasher.update(raw)
            parsed = yaml.safe_load(raw.decode("utf-8"))
            if parsed is None:
                parsed = {}
            if not isinstance(parsed, dict):
                raise ConfigError(f"{path.name}: top level must be a mapping")
            if path.stem in data:
                raise ConfigError(f"duplicate config namespace: {path.stem}")
            data[path.stem] = parsed

        return cls(data, hasher.hexdigest()[:12], directory)

    # ---------------------------------------------------------------- access

    @property
    def version(self) -> str:
        """Content hash of the loaded config set. Stamped onto signals."""
        return self._version

    @property
    def source_dir(self) -> Path:
        return self._source_dir

    def get(self, path: str, default: Any = _MISSING) -> Any:
        """Fetch a dotted key.

        Raises `ConfigError` when the key is absent and no explicit default was
        passed. Passing a default is allowed but should be rare and deliberate —
        it is not a place to invent an Appendix B value.
        """
        node: Any = self._data
        walked: list[str] = []
        for part in path.split("."):
            walked.append(part)
            if not isinstance(node, dict) or part not in node:
                if default is _MISSING:
                    raise ConfigError(
                        f"missing config key '{path}' "
                        f"(resolved as far as '{'.'.join(walked[:-1]) or '<root>'}'). "
                        f"This is an operator decision — see spec Appendix B. "
                        f"Do not substitute a default."
                    )
                return default
            node = node[part]

        if node == OPERATOR_DECISION:
            raise ConfigError(
                f"config key '{path}' is an unresolved operator decision. "
                f"The spec reserves this value (Appendix B) or is silent on it. "
                f"Set it in {self._source_dir.name}/ before running. "
                f"The engine will not guess it."
            )
        return node

    def section(self, path: str) -> dict[str, Any]:
        """Fetch a dotted key that must resolve to a mapping."""
        value = self.get(path)
        if not isinstance(value, dict):
            raise ConfigError(f"config key '{path}' is not a mapping")
        return value

    def require_all(self, paths: list[str]) -> None:
        """Assert a set of keys exists. Used at startup so a missing operator
        decision surfaces before the engine does any work, not mid-backtest."""
        missing = []
        for path in paths:
            try:
                self.get(path)
            except ConfigError:
                missing.append(path)
        if missing:
            raise ConfigError(
                "missing required config keys: "
                + ", ".join(missing)
                + ". These are operator decisions (spec Appendix B); "
                "the engine will not guess them."
            )

    def as_dict(self) -> dict[str, Any]:
        """Deep-ish copy for logging. Not for mutation."""
        import copy

        return copy.deepcopy(self._data)


__all__ = ["Config"]
