# Stage 1 tests-only handoff

> **Historical handoff — superseded on 2026-07-27.** The operator approved
> `APPROVE PROFILE + DELEGATE STAGE 1`; the ambiguities below were resolved by
> `docs/PROPOSED-SHIPPING-PROFILE.md`, the implementation is complete, and the
> full suite is green. Current status is in `docs/STAGE1-STATUS.md`. This file is
> retained as the audit trail for the questions the approved profile settled.

Stage 1 implementation remains deliberately untouched. `CLAUDE.md` assigns the
regime thresholds, hysteresis, cluster weights, scoring calibration, level
policy, and lifecycle implementation to the operator by hand. The agent task is
the red test harness only.

The repository had stopped after `tests/stage1/test_level_derivation.py`.
`tests/stage1/test_signal_lifecycle.py` now completes the test surface that can
be expressed through the existing stubs: forward-only movement, lock stamping,
deep immutability, multi-bar persistence, expiry, both `TOO_LATE` causes,
monitoring-only behavior, and per-timeframe independence.

## Do not implement through these open questions

### STAGE1-A01 · counter-trend denominator · spec conflict

§5.2 and §5.3.1 state that TRENDING counter-trend signals use only D₂ and F,
with denominator 22. The `enabled_in` pseudocode in §5.2 returns `True` for
ordinary `ENABLED` clusters in either direction, which makes the same
denominator 90. The difference changes the best counter-trend score after the
0.6 penalty from 57 to about 28.2.

Candidate readings:

- Counter-trend scoring uses D₂ and F only; amend the pseudocode/config prose.
- Ordinary `ENABLED` clusters remain available; regenerate the working
  denominator and calibration statements.

Tests that require either reading must remain skipped until the operator settles
this. The conclusion that counter-trend cannot auto-execute holds under both.

### STAGE1-A02 · ADX dead band versus immediate TRANSITIONAL · spec conflict

§3.3 says a TRENDING regime exits only below ADX 22 and a RANGING regime exits
only above 25. It also says TRANSITIONAL takes effect immediately. Inside either
dead band, §3.2 returns TRANSITIONAL, so literal immediate transition makes the
dead band ineffective.

Candidate readings:

- Exit bands gate ADX-driven TRANSITIONAL results; the exemption skips only the
  confirmation counter after the exit threshold is crossed.
- Every TRANSITIONAL result is immediate; rewrite or remove the exit-band claim.

The uncontested confirmation tests remain active. The overlapping dead-band
cases must remain skipped.

### STAGE1-A03 · the first two §5.4 rows are not distinguishable · spec/API gap

“HTF agrees, LTF disagrees” routes to Radar; “HTF disagrees, LTF agrees” takes a
0.6 penalty. With one bias direction and one entry direction, both describe the
same opposing pair. `combine_timeframes(states, config)` receives no candidate
direction or routing context that can make the rows different.

The unambiguous policies are tested: H4/H1 conflict suppresses; a candidate
opposing the bias receives §3.5’s penalty; timeframe values are never averaged.
The Radar-versus-penalty split needs a clarified input/definition before it can
be tested.

### STAGE1-A04 · `Signal.expires_at` before lock · frozen-contract conflict

§2 makes `Signal.expires_at` a required `datetime`. §6.1 says it is stamped on
entering `LOCKED`, which implies no resolved value exists at
`AWAITING_VALIDATION`. Test fixtures use `created_at` as an explicit placeholder
and require the value to change at lock; this is scaffolding, not a spec reading.

Candidate readings:

- Change the frozen field to `datetime | None`.
- Define the required pre-lock sentinel/value and its meaning.
- Split candidate and locked records into different models.

### STAGE1-A05 · TRANSITIONAL “4 of 5 at 80” is a table error

At quality 90, three four-cluster subsets weigh 46/57 and score about 80.85,
while two weigh 45/57 and score about 79.97. The §5.3.1 table says simply “4 of
5,” but the exact §5.2 formula operates on weighted breadth and supplies no
rounding step. Eligibility therefore uses the full-precision score and the
table must be amended to say that the result depends on cluster membership.
Displayed rounding must not change eligibility.

### STAGE1-A06 · rejected threshold 88 prose is a math error

§5.3 says threshold 88 would require all six clusters at quality at least 95.
At full breadth the score equals quality, so six clusters at quality 88 already
meet an inclusive threshold of 88. Tests retain the unambiguous claim that five
clusters at quality 95 score about 87.7 and miss 88; they do not encode the
incorrect full-breadth sentence. This needs a prose correction, not a policy
choice.

### STAGE1-A07 · target and zone geometry underspecified

§5.5 does not define:

- what makes structure “support” TP2;
- how far “just inside” an opposing level is;
- which side receives extra width when a hairline entry zone is widened.

Tests assert only invariant behavior: no TP2 without supporting structure,
snapping can only reduce a target, and widening contains the original zone.

### STAGE1-A08 · untyped dict schemas

Stage 1 stubs accept bare `config: dict`; `combine_timeframes` returns a bare
`dict`; `StrategyResult.evidence` is also a bare `dict`. Their nesting and key
schemas are not specified. Test helpers expose both top-level and YAML-shaped
config keys and inspect MTF output values without inventing a layout.

Before implementation, pin typed config/input/output models or explicitly bless
the existing YAML shapes.

### STAGE1-A09 · cluster-resolution seam is missing

§5.1 specifies ANY-member firing, majority direction, tie-to-`NONE`, and maximum
agreeing-member score. No production stub accepts module results and returns a
resolved cluster, so ANY/majority/MAX cannot be tested without inventing an API.
Downstream tests cover only the invariant that an already-tied cluster is inert.

### STAGE1-A10 · lifecycle events and queue ownership are missing

§6.1 requires one active locked signal per `(symbol, timeframe)` and queues a
second candidate. It also requires external operator/AUTO decisions to choose
`TAKEN` or `IGNORED`. `advance(signal, context, config)` accepts neither a
candidate queue nor a decision event, so these rules have no testable seam.

The diagram also leaves `IGNORED` without an outgoing edge while §12.1 requires
untaken signals to resolve to `CLOSED_TP`, `CLOSED_SL`, `TOO_LATE`, or `EXPIRED`.
Define the queue owner and lifecycle event model, and clarify the `IGNORED`
resolution path.

### STAGE1-A11 · policy whose owner is later-stage integration

These policies are sufficiently specified but do not belong inside the current
small helper APIs:

- upstream EMA computation must fold both ordering and slope into
  `ema_stack_aligned`, because §3.2 consumes that exact input;
- the TRANSITIONAL 0.5 position-size multiplier belongs to sizing/pipeline
  integration;
- forcing suppressed strategy members to `fired=False` belongs to the
  Tier-1-to-Tier-2 pipeline;
- the more specific §5.3 rule applies the +5 uplift to `display_threshold`
  only, not to `auto_execute_threshold`;
- pipeline composition must require `GateOutcome.passed` before assigning
  displayed, takeable, or AUTO status, including for a score-99 signal.

Keep integration tests for these rules with their owning stages rather than
widening the Stage 1 helper signatures artificially.

### STAGE1-A12 · empty vote tally has no leading contributor

§5.2.1 calls `max(buy + sell)` while the frozen
`VoteTally.leading_contributor` is a required string. Define whether an empty
tally is outside the function precondition or specify the stable journal value
for `leading_contributor`.

### STAGE1-A13 · FLAT compatibility formula is incomplete

“Weights every module equally” does not define whether FLAT is an average
confidence, a firing fraction multiplied by quality, or another mapping.
`flat_score(module_results, direction)` also receives no regime-enabled
denominator. Pin the exact formula and denominator before implementing it.

### STAGE1-A14 · confidence decay curve is unspecified

§3.3 requires `regime_confidence` to decay toward zero while a different regime
is pending but supplies no curve or terminal value. The current tests assert
only monotonic bounded decay. Choose a configured linear, exponential, or other
exact rule before calibration.

## Existing blockers outside Stage 1

Stage 0 code is runnable but the stage is not closed. `docs/AMBIGUITY.md`
records the operator decisions that still prevent a real-history gate,
especially fixture windows (014), mandatory cost values (003), swap unit and
schedule (B03/B04), and cluster identifiers (001). Stage 2 and Stage 2b remain blocked by
Stage 0; no strategy or pattern modules should begin yet.

The frozen contract boundary also currently accepts naive or non-UTC datetimes
even though SPEC section 10.1 requires UTC. Changing the frozen Pydantic models
would be a contract change, so the operator must choose the validation boundary
before this is repaired.

## Operator sequence

1. Resolve Stage 0’s real-fixture/cost decisions and rerun
   `scripts/run_gate.py` against recorded history.
2. Resolve cluster identifiers and swap plumbing.
3. Settle STAGE1-A01 through A14 in the spec or an operator decision record.
4. Adjust the explicitly skipped/shape-neutral tests to those decisions.
5. Implement the Stage 1 stubs by hand until the red suite turns green.
6. Run the one-year visual regime and score-distribution gate before advancing
   the stage marker.
