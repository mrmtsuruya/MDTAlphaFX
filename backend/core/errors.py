"""Failure modes that must be loud.

Every exception here exists because the alternative is a silent wrong number.
None of them should ever be caught and defaulted.
"""


class MDTAlphaFXError(Exception):
    """Base for everything this system raises deliberately."""


class ConfigError(MDTAlphaFXError):
    """A config key is missing, malformed, or an invariant over config failed.

    Never resolved by substituting a default. CLAUDE.md: "Config, never
    constants" — a missing key means the operator has not made a decision the
    spec requires them to make (Appendix B).
    """


class SymbolResolutionError(MDTAlphaFXError):
    """§7.1 — the broker's symbol could not be resolved, or `symbol_info()`
    returned an incomplete `SymbolSpec`.

    Fail loudly. Never assume digits, point value, or lot step.
    """


class LiveAccountError(MDTAlphaFXError):
    """§10.3 / rule 5 — something tried to run against a non-demo account
    without the deliberate override."""


class ContractDriftError(MDTAlphaFXError):
    """A §2 contract changed shape after freeze."""


class DataIntegrityError(MDTAlphaFXError):
    """The historical store is missing data a caller requires — typically M1
    bars needed for §11.1 sub-bar resolution, or per-bar spread needed for
    §11.2 cost modelling."""


class BrokerConstraintError(MDTAlphaFXError):
    """§7.3 — an order violates a broker constraint. In backtest this means
    the fill is rejected, not silently accepted (§11.2)."""


__all__ = [
    "MDTAlphaFXError",
    "ConfigError",
    "SymbolResolutionError",
    "LiveAccountError",
    "ContractDriftError",
    "DataIntegrityError",
    "BrokerConstraintError",
]
