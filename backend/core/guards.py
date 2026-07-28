"""§10.3 live-account guard — rule 5.

"No test connects to a live account. A module-level guard raises unless the
account is demo, overridable only by a deliberately-set environment variable."

The override variable is named so it cannot be set by accident and cannot be
mistaken for a convenience flag. It is checked, never cached, so a process that
started in demo cannot drift into live by having read the value once.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .errors import LiveAccountError

# Deliberately verbose. Rule 7's AUTO override is a *different* variable
# (MDTALPHAFX_ALLOW_LIVE_AUTO) and the two must never be conflated: this one
# permits connecting to a live account at all; that one permits unattended
# execution on it.
LIVE_ACCOUNT_OVERRIDE_ENV = "MDTALPHAFX_ALLOW_LIVE_ACCOUNT"

# MT5 account trade modes. Resolved from the terminal, never assumed.
ACCOUNT_TRADE_MODE_DEMO = 0
ACCOUNT_TRADE_MODE_CONTEST = 1
ACCOUNT_TRADE_MODE_REAL = 2


@dataclass(frozen=True)
class AccountIdentity:
    """The minimum needed to decide whether this account may be touched."""

    login: int
    server: str
    trade_mode: int
    currency: str

    @property
    def is_demo(self) -> bool:
        return self.trade_mode == ACCOUNT_TRADE_MODE_DEMO

    @property
    def trade_mode_name(self) -> str:
        return {
            ACCOUNT_TRADE_MODE_DEMO: "DEMO",
            ACCOUNT_TRADE_MODE_CONTEST: "CONTEST",
            ACCOUNT_TRADE_MODE_REAL: "REAL",
        }.get(self.trade_mode, f"UNKNOWN({self.trade_mode})")


def live_override_enabled() -> bool:
    """True only when the override env var is set to exactly "1"."""
    return os.environ.get(LIVE_ACCOUNT_OVERRIDE_ENV) == "1"


def assert_demo_account(account: AccountIdentity) -> None:
    """Raise unless the account is demo, or the override is deliberately set.

    Called by the MT5 connector immediately after login resolves, before any
    other call. Rule 5.
    """
    if account.is_demo:
        return
    if live_override_enabled():
        return
    raise LiveAccountError(
        f"refusing to operate on a {account.trade_mode_name} account "
        f"(login {account.login} @ {account.server}). Rule 5: no test connects "
        f"to a live account. Set {LIVE_ACCOUNT_OVERRIDE_ENV}=1 deliberately if "
        f"this is intended."
    )


def _running_under_pytest() -> bool:
    """Detect pytest without importing it into normal runtime processes."""
    import sys

    return "pytest" in sys.modules or "PYTEST_CURRENT_TEST" in os.environ


def assert_no_network_in_tests(
    *, mt5_module_injected: bool | None = None
) -> None:
    """Guard for the test suite — §10.3, "no test touches the network".

    Tests import this at collection time with no MT5 context, where it rejects
    the live-account override. The connector calls it again with
    ``mt5_module_injected`` stated explicitly, before importing MetaTrader5 or
    calling ``initialize()``:

    - ``True`` means a caller supplied the test double seam, so no real terminal
      is opened.
    - ``False`` means the connector would load and initialise MetaTrader5, which
      is forbidden under pytest even when the logged-in account is demo.
    - ``None`` is the collection-time check, before a connector exists.

    Outside pytest this function is deliberately inert. Runtime account safety
    remains the separate ``assert_demo_account`` check.
    """
    if not _running_under_pytest():
        return
    if live_override_enabled():
        raise LiveAccountError(
            f"{LIVE_ACCOUNT_OVERRIDE_ENV}=1 while running under pytest. "
            f"§10.3: no test touches the network. Unset it before running tests."
        )
    if mt5_module_injected is False:
        raise LiveAccountError(
            "refusing to initialise MetaTrader5 while running under pytest. "
            "§10.3: no test touches the network. Inject an MT5 module double "
            "instead."
        )


__all__ = [
    "LIVE_ACCOUNT_OVERRIDE_ENV",
    "ACCOUNT_TRADE_MODE_DEMO",
    "ACCOUNT_TRADE_MODE_CONTEST",
    "ACCOUNT_TRADE_MODE_REAL",
    "AccountIdentity",
    "live_override_enabled",
    "assert_demo_account",
    "assert_no_network_in_tests",
]
