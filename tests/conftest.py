"""Test-session guards. §10.3: "no test touches the network."

Module-level, deliberately. Rule 5 says "a module-level guard raises unless the
account is demo" — running the check at import time means a collection error,
before a single test body executes, rather than a failure somewhere in the
middle of a run that has already opened a session.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.core.guards import assert_no_network_in_tests  # noqa: E402

assert_no_network_in_tests()
