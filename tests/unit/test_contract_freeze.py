"""Schema-drift guard for the frozen §2 contracts."""

from __future__ import annotations

from pydantic import create_model

from backend.contracts.freeze import _hash_contract_types, contract_hash


# Deliberately pinned. Any intentional §2 contract change must be reviewed and
# this value updated in the same change; an accidental change fails immediately.
FROZEN_CONTRACT_HASH = (
    "5dfe85dd898eca5b90bf392179e3cb903df0f39026f20a8d3c660ee3b1da2de2"
)


def test_contract_hash_matches_the_reviewed_frozen_schema():
    assert contract_hash() == FROZEN_CONTRACT_HASH


def test_contract_hash_is_deterministic_sha256():
    first = contract_hash()
    second = contract_hash()

    assert first == second
    assert len(first) == 64
    assert set(first) <= set("0123456789abcdef")


def test_field_type_drift_changes_the_hash():
    before = create_model(
        "DriftProbe",
        quantity=(int, ...),
        __module__="tests.contract_hash_probe",
    )
    after = create_model(
        "DriftProbe",
        quantity=(str, ...),
        __module__="tests.contract_hash_probe",
    )

    assert _hash_contract_types((before,)) != _hash_contract_types((after,))


def test_field_reordering_changes_the_hash():
    before = create_model(
        "OrderProbe",
        first=(int, ...),
        second=(str, ...),
        __module__="tests.contract_hash_probe",
    )
    after = create_model(
        "OrderProbe",
        second=(str, ...),
        first=(int, ...),
        __module__="tests.contract_hash_probe",
    )

    assert _hash_contract_types((before,)) != _hash_contract_types((after,))
