# AGENT.md — hodlmm-inscription-signal

## Purpose
Bitcoin L1 inscription pressure monitoring to inform HODLMM bin management. Read-only oracle — no transactions, no fund movement, no state mutation.

## Guardrails
- NEVER executes any on-chain transaction
- NEVER moves funds or adjusts bins autonomously
- NEVER cache inscription data — always fetch live from Hiro API
- Output is advisory only — parent agent must confirm before acting on recommendation

## Spend Limits
Zero — read-only data aggregation skill.

## Decision Logic
- `pressure_score` 0–10: weighted sum of inscription count (last window hours) + mempool fee rate
- `HOLD`: score below threshold — current bin position is optimal
- `TIGHTEN_BINS`: score at or above threshold — capture elevated fees, front-run minor volatility
- `WIDEN_BINS`: score at or above threshold + 3 — extreme L1 activity, widen to reduce IL risk
- Pool data from Bitflow API is supplementary context — recommendation driven by L1 pressure score alone

## Autonomous Use
Safe to run autonomously on a schedule (every 15–60 minutes). Recommendation output should be reviewed by a parent agent or human before executing any bin adjustment.

## Error Handling
- Bitflow pool fetch failure: proceed without pool data, recommendation still valid from L1 signals alone
- Hiro API failure: exit 1 with error JSON — do not output stale recommendation
- Invalid `--threshold` / `--window`: Commander.js validates types; out-of-range values degrade gracefully
