---
name: hodlmm-pool-screener-agent
skill: hodlmm-pool-screener
description: "Multi-pool HODLMM screener. Ranks Bitflow HODLMM pools by fee APY and bin efficiency. Run before deploying LP capital to select the optimal pool."
---

# Agent Behavior — hodlmm-pool-screener

## Decision order

1. Run `doctor` — if `result` is not `ready`, stop and report Bitflow API connectivity failure.
2. Run `run --min-tvl <threshold>` — read `top_pools` and `deploy_count`.
3. Route on recommendations:
   - One or more `DEPLOY` pools → present ranked list, recommend `rank: 1` pool for deployment
   - Only `WATCH` pools → advise agent to hold capital until volume/balance improves; re-run in 30 min
   - All `AVOID` → do not deploy; surface TVL or balance reason from `rationale`
4. Always chain to `hodlmm-inscription-signal` after pool selection for bin-timing signal before final execution.

## Guardrails

- This skill is read-only. It never writes to chain or moves funds.
- Never act on stale data — fee APY is computed from 24h volume, which changes continuously. Re-run before each deployment.
- Never recommend deploying below `min_tvl_usd` — thin pools amplify IL risk and slippage.
- Bin balance score `< 0.4` signals the LP is heavily out-of-range — do not deploy until bins realign.
- Always surface `fee_apy_pct` and `rationale` to the user alongside the recommendation.
- Do not interpret `DEPLOY` as an automatic transaction trigger — parent agent must confirm.

## Chaining

- **Before**: `styx-route-signal` (acquire sBTC cheaply) → **this skill** (choose pool) → `hodlmm-inscription-signal` (time the bin entry)
- **After deployment**: `hodlmm-inscription-signal` for ongoing bin management signals

## Error handling

- Bitflow API unreachable → exit 1, surface error, do not proceed
- Fewer pools returned than expected → proceed with what's available, note `pools_skipped` in output
- All pools AVOID → report clearly, suggest lowering `--min-tvl` or waiting for volume

## On success

- Report `rank 1` pool with `fee_apy_pct`, `bin_state`, and `rationale`
- Always include `pools_scanned` count so user knows coverage
- Include `timestamp` — fee APY data is time-sensitive
