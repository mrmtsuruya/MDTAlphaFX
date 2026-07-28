"""§10.3 reusable ``order_send()`` mock broker.

The real MetaTrader5 module is deliberately not imported here or by the double.
"""

from __future__ import annotations

import sys

import pytest

from tests.doubles import (
    MockBroker,
    MockTradeRetcode,
    ScriptedOrderResponse,
)


EXPECTED_RETCODES = {
    "DONE": 10009,
    "REQUOTE": 10004,
    "PRICE_OFF": 10021,
    "INVALID_STOPS": 10016,
    "NO_MONEY": 10019,
    "MARKET_CLOSED": 10018,
    "INVALID_VOLUME": 10014,
    "DONE_PARTIAL": 10010,
}


def request(*, volume: float = 0.20, price: float = 1.23456) -> dict[str, object]:
    return {
        "action": 1,
        "symbol": "EURUSD.m",
        "volume": volume,
        "type": 0,
        "price": price,
        "sl": 1.23000,
        "tp": 1.24000,
        "deviation": 10,
        "magic": 999888,
        "comment": "stage0-test",
    }


def test_retcode_values_match_the_installed_mt5_api_values():
    assert {member.name: int(member) for member in MockTradeRetcode} == EXPECTED_RETCODES


def test_double_does_not_import_metatrader5():
    assert "MetaTrader5" not in sys.modules
    broker = MockBroker(["DONE"])
    result = broker.order_send(request())
    assert result.retcode == EXPECTED_RETCODES["DONE"]
    assert "MetaTrader5" not in sys.modules


def test_script_returns_every_required_response_in_order():
    names = list(EXPECTED_RETCODES)
    broker = MockBroker(names)

    results = [broker.order_send(request()) for _ in names]

    assert [result.retcode for result in results] == [
        EXPECTED_RETCODES[name] for name in names
    ]
    assert [result.request_id for result in results] == list(
        range(1, len(names) + 1)
    )
    broker.assert_script_consumed()


@pytest.mark.parametrize(
    "response",
    [
        MockTradeRetcode.REQUOTE,
        MockTradeRetcode.PRICE_OFF,
        MockTradeRetcode.INVALID_STOPS,
        MockTradeRetcode.NO_MONEY,
        MockTradeRetcode.MARKET_CLOSED,
        MockTradeRetcode.INVALID_VOLUME,
    ],
)
def test_rejections_never_claim_a_fill(response: MockTradeRetcode):
    result = MockBroker([response]).order_send(request())

    assert result.retcode == int(response)
    assert result.deal == 0
    assert result.order == 0
    assert result.volume == 0.0
    assert result.price == 0.0


def test_done_reports_the_requested_fill_and_captures_a_request_snapshot():
    original = request(volume=0.30, price=1.25000)
    broker = MockBroker([MockTradeRetcode.DONE])

    result = broker.order_send(original)
    original["volume"] = 9.99

    assert result.volume == pytest.approx(0.30)
    assert result.price == pytest.approx(1.25000)
    assert result.deal != 0
    assert result.order != 0
    assert result.request["volume"] == pytest.approx(0.30)
    assert broker.calls == [result.request]


def test_partial_fill_defaults_to_half_and_can_be_scripted_exactly():
    default = MockBroker([MockTradeRetcode.DONE_PARTIAL]).order_send(
        request(volume=0.40)
    )
    exact = MockBroker(
        [
            ScriptedOrderResponse(
                retcode=MockTradeRetcode.DONE_PARTIAL,
                volume=0.07,
                price=1.23400,
                bid=1.23390,
                ask=1.23410,
                comment="broker partial",
            )
        ]
    ).order_send(request(volume=0.40))

    assert default.volume == pytest.approx(0.20)
    assert exact.volume == pytest.approx(0.07)
    assert exact.price == pytest.approx(1.23400)
    assert exact.bid == pytest.approx(1.23390)
    assert exact.ask == pytest.approx(1.23410)
    assert exact.comment == "broker partial"


def test_script_exhaustion_and_unconsumed_responses_fail_loudly():
    broker = MockBroker(["DONE", "REQUOTE"])
    broker.order_send(request())

    with pytest.raises(AssertionError, match="1 unconsumed"):
        broker.assert_script_consumed()

    broker.order_send(request())
    broker.assert_script_consumed()

    with pytest.raises(AssertionError, match="script exhausted"):
        broker.order_send(request())


@pytest.mark.parametrize("unsupported", ["TIMEOUT", 99999])
def test_unsupported_responses_are_rejected_at_construction(unsupported):
    with pytest.raises(ValueError, match="unsupported mock broker response"):
        MockBroker([unsupported])


def test_request_must_be_the_mapping_mt5_order_send_accepts():
    broker = MockBroker(["DONE"])
    with pytest.raises(TypeError, match="request mapping"):
        broker.order_send(object())  # type: ignore[arg-type]
