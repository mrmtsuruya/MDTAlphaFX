"""Complete Stage 2 strategy registry and factory."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ..core.config import Config
from .base import Strategy
from .common import ProfiledStrategy
from .configuration import validate_strategy_config
from .m01_bullish_fvg_fill import BullishFVGFill
from .m02_bearish_fvg_fill import BearishFVGFill
from .m03_bullish_order_block import BullishOrderBlock
from .m04_bearish_order_block import BearishOrderBlock
from .m05_sell_side_liquidity_sweep import SellSideLiquiditySweep
from .m06_buy_side_liquidity_sweep import BuySideLiquiditySweep
from .m07_change_of_character import ChangeOfCharacter
from .m08_break_of_structure import BreakOfStructure
from .m09_breaker_block_mitigation import BreakerBlockMitigation
from .m10_liquidity_void_realign import LiquidityVoidRealignment
from .m11_quasimodo_level_reversal import QuasimodoLevelReversal
from .m12_support_resistance_flip import SupportResistanceFlip
from .m13_supply_demand_zone_retest import SupplyDemandZoneRetest
from .m14_double_bottom_top_validation import DoubleBottomTopValidation
from .m15_pinbar_hammer_exhaustion import PinbarHammerExhaustion
from .m16_engulfing_cluster import EngulfingCluster
from .m17_triple_ema_alignment import TripleEmaAlignment
from .m18_ema_dynamic_pullback import EmaDynamicPullback
from .m19_macd_zero_line_crossover import MacdZeroLineCrossover
from .m20_regular_rsi_divergence import RegularRsiDivergence
from .m21_adx_trend_acceleration import AdxTrendAcceleration
from .m22_supertrend_directional_flip import SupertrendDirectionalFlip
from .m23_bollinger_squeeze_breakout import BollingerSqueezeBreakout
from .m24_bollinger_outer_reversion import BollingerOuterReversion
from .m25_vwap_deviation_touch import VwapDeviationTouch
from .m26_keltner_channel_reversal import KeltnerChannelReversal
from .m27_atr_volatility_expansion import AtrVolatilityExpansion
from .m28_session_open_range_breakout import SessionOpenRangeBreakout


STRATEGY_TYPES: tuple[type[ProfiledStrategy], ...] = (
    BullishFVGFill,
    BearishFVGFill,
    BullishOrderBlock,
    BearishOrderBlock,
    SellSideLiquiditySweep,
    BuySideLiquiditySweep,
    ChangeOfCharacter,
    BreakOfStructure,
    BreakerBlockMitigation,
    LiquidityVoidRealignment,
    QuasimodoLevelReversal,
    SupportResistanceFlip,
    SupplyDemandZoneRetest,
    DoubleBottomTopValidation,
    PinbarHammerExhaustion,
    EngulfingCluster,
    TripleEmaAlignment,
    EmaDynamicPullback,
    MacdZeroLineCrossover,
    RegularRsiDivergence,
    AdxTrendAcceleration,
    SupertrendDirectionalFlip,
    BollingerSqueezeBreakout,
    BollingerOuterReversion,
    VwapDeviationTouch,
    KeltnerChannelReversal,
    AtrVolatilityExpansion,
    SessionOpenRangeBreakout,
)


@dataclass(frozen=True)
class RegistryReceipt:
    module_ids: tuple[int, ...]
    cluster_ids: tuple[str, ...]
    min_bars: tuple[int, ...]

    @property
    def common_window_bars(self) -> int:
        """The registry-derived approved shared evaluation window."""

        return max(self.min_bars)


def build_strategy_registry(config: Config) -> tuple[Strategy, ...]:
    validate_strategy_config(config)
    strategies = tuple(strategy_type.from_config(config) for strategy_type in STRATEGY_TYPES)
    validate_registry(strategies, config)
    return strategies


def validate_registry(
    strategies: Sequence[Strategy], config: Config
) -> RegistryReceipt:
    module_ids = tuple(strategy.module_id for strategy in strategies)
    if module_ids != tuple(range(1, 29)):
        raise ValueError(
            "Stage 2 registry must contain modules 1..28 exactly once and in order"
        )
    if any(strategy.min_bars < 1 for strategy in strategies):
        raise ValueError("every Stage 2 strategy must declare positive min_bars")
    if any(not isinstance(strategy, Strategy) for strategy in strategies):
        raise TypeError("every registered module must satisfy the frozen Strategy protocol")

    configured_clusters = config.section("clusters.clusters")
    expected_cluster: dict[int, str] = {}
    for cluster_id, raw in configured_clusters.items():
        if not isinstance(raw, dict):
            raise TypeError(f"cluster {cluster_id} must be a mapping")
        for module_id in raw["modules"]:
            expected_cluster[int(module_id)] = str(cluster_id)
    for strategy in strategies:
        actual = strategy.cluster_id
        expected = expected_cluster.get(strategy.module_id)
        if actual != expected:
            raise ValueError(
                f"module {strategy.module_id} declares cluster {actual!r}; "
                f"approved config requires {expected!r}"
            )
    return RegistryReceipt(
        module_ids=module_ids,
        cluster_ids=tuple(strategy.cluster_id for strategy in strategies),
        min_bars=tuple(strategy.min_bars for strategy in strategies),
    )


__all__ = [
    "STRATEGY_TYPES",
    "RegistryReceipt",
    "build_strategy_registry",
    "validate_registry",
]
