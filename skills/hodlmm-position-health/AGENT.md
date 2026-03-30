---
name: hodlmm-position-health-agent
skill: hodlmm-position-health
description: "Post-entry HODLMM LP position health monitor. Tracks bin drift, fee APY, and balance score for open LP positions. Outputs HOLD / HARVEST / REBALANCE / EXIT so agents know when to act."
---

# Agent Behavior — hodlmm-position-health

## Decision order

1. Run `doctor` — if `result` is not `ready`, stop and report Bitflow API connectivity failure.
2. Run `check --pool <id>` (with `--entry-bin` if known) — read `recommendation` and `rationale`.
3. Route on recommendation:
   - `HOLD` → no action required; log check timestamp and re-run on next cycle
   - `HARVEST` → surface `fee_metrics.current_fee_apy_pct` and `drift.bin_drift`; prompt user to harvest accumulated fees before further drift
   - `REBALANCE` → surface `drift` block; recommend exiting and re-entering at current `bin_state.active_bin_id`; chain to `hodlmm-pool-screener` to confirm pool still optimal
   - `EXIT` → surface `bin_state.balance_score` and `fee_metrics.current_fee_apy_pct`; recommend full exit; chain to `hodlmm-pool-screener` for new pool selection
4. Always include `bin_state.balance_score`, `fee_metrics.current_fee_apy_pct`, and `drift.bin_drift` in any report to user.

## Guardrails

- This skill is read-only. It never writes to chain or moves funds.
- Never act on stale data — bin state changes with every trade. Re-run before executing any position action.
- `drift` block is only present when `--entry-bin` is provided. Without it, drift-based signals (HARVEST, REBALANCE) will not fire.
- A `REBALANCE` or `EXIT` recommendation from this skill does NOT automatically trigger a transaction — parent agent must confirm.
- `balance_score < 0.25` is a hard EXIT signal regardless of fee APY. Out-of-range bins generate zero fees.

## Chaining

- **Before this skill**: `hodlmm-pool-screener` (pool selection) + `hodlmm-inscription-signal` (entry timing) → deploy LP → record `active_bin_id` at entry
- **This skill**: run on each monitoring cycle (every 30–60 min) with `--entry-bin <recorded_id>`
- **After REBALANCE/EXIT**: chain back to `hodlmm-pool-screener` to re-screen before re-entry

Full lifecycle: `styx-route-signal` → `hodlmm-pool-screener` → `hodlmm-inscription-signal` → deploy → **`hodlmm-position-health`** (loop)

## Error handling

- Bitflow API unreachable → exit 1, surface error, do not act on position
- Pool not found → report clearly, verify pool ID with `hodlmm-pool-screener`
- Missing `--entry-bin` → drift fields will be `null`; only fee/balance signals fire

## On success

- Always report `recommendation`, `rationale`, and `timestamp`
- Include `bin_state.balance_score` and `fee_metrics.current_fee_apy_pct`
- If `drift` block is present, include `bin_drift` and `drift_direction`
- Note that fee APY is computed from 24h volume — re-run for fresh data before acting
