"""Deterministic schema fingerprint for the frozen §2 contracts.

The contract package is frozen before strategy work begins. ``contract_hash``
turns the public Pydantic-model and enum surface into a canonical manifest and
returns its SHA-256 digest. Pinning that digest in a test makes a field add,
remove, rename, reorder, retype, required/default change, enum change, or public
contract addition fail loudly.

Comments and docstrings are deliberately excluded: they can improve without
changing the wire contract.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import types
from enum import Enum
from typing import Any, Iterable, Union, get_args, get_origin

from pydantic import BaseModel


def _qualified_name(value: type[Any]) -> str:
    return f"{value.__module__}.{value.__qualname__}"


def _type_manifest(annotation: Any) -> Any:
    """Return a JSON-serialisable, order-preserving annotation description."""
    if annotation is None or annotation is type(None):
        return {"type": "none"}

    origin = get_origin(annotation)
    if origin is None:
        if isinstance(annotation, type):
            return {"type": _qualified_name(annotation)}
        return {"type": repr(annotation)}

    if origin in (Union, types.UnionType):
        origin_name = "union"
    elif isinstance(origin, type):
        origin_name = _qualified_name(origin)
    else:
        origin_name = repr(origin)

    return {
        "origin": origin_name,
        "args": [_type_manifest(argument) for argument in get_args(annotation)],
    }


def _default_manifest(value: Any) -> Any:
    """Normalise the primitive defaults used by the frozen contracts."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Enum):
        return {
            "enum": _qualified_name(type(value)),
            "member": value.name,
            "value": value.value,
        }
    raise TypeError(
        "contract_hash cannot canonicalise default "
        f"{value!r} ({type(value).__module__}.{type(value).__qualname__})"
    )


def _model_manifest(model: type[BaseModel]) -> dict[str, Any]:
    fields: list[dict[str, Any]] = []
    for name, field in model.model_fields.items():
        item: dict[str, Any] = {
            "name": name,
            "annotation": _type_manifest(field.annotation),
            "required": field.is_required(),
        }
        if field.alias is not None:
            item["alias"] = field.alias
        if field.default_factory is not None:
            item["default_factory"] = _qualified_name(field.default_factory)
        elif not field.is_required():
            item["default"] = _default_manifest(field.default)
        fields.append(item)

    return {
        "kind": "pydantic_model",
        "name": _qualified_name(model),
        # A list is intentional: field order is part of the frozen contract.
        "fields": fields,
    }


def _enum_manifest(enum_type: type[Enum]) -> dict[str, Any]:
    return {
        "kind": "enum",
        "name": _qualified_name(enum_type),
        # Declaration order is intentional and frozen.
        "members": [
            {"name": member.name, "value": member.value} for member in enum_type
        ],
    }


def _public_contract_types() -> tuple[type[Any], ...]:
    package = importlib.import_module("backend.contracts")
    contract_types: list[type[Any]] = []
    for export_name in package.__all__:
        exported = getattr(package, export_name)
        if not isinstance(exported, type) or not (
            issubclass(exported, BaseModel) or issubclass(exported, Enum)
        ):
            raise TypeError(
                "backend.contracts.__all__ contains a non-contract export: "
                f"{export_name}"
            )
        contract_types.append(exported)
    return tuple(contract_types)


def _schema_manifest(
    contract_types: Iterable[type[Any]] | None = None,
) -> dict[str, Any]:
    selected = (
        tuple(contract_types)
        if contract_types is not None
        else _public_contract_types()
    )
    entries: list[dict[str, Any]] = []
    for contract_type in sorted(selected, key=_qualified_name):
        if issubclass(contract_type, BaseModel):
            entries.append(_model_manifest(contract_type))
        elif issubclass(contract_type, Enum):
            entries.append(_enum_manifest(contract_type))
        else:
            raise TypeError(
                f"{_qualified_name(contract_type)} is not a Pydantic model or enum"
            )
    return {"format": 1, "contracts": entries}


def _hash_contract_types(contract_types: Iterable[type[Any]]) -> str:
    payload = json.dumps(
        _schema_manifest(contract_types),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def contract_hash() -> str:
    """Return the SHA-256 fingerprint of every public frozen §2 contract."""
    return _hash_contract_types(_public_contract_types())


__all__ = ["contract_hash"]
