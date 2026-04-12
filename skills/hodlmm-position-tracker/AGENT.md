# hodlmm-position-tracker — Agent Instructions

## Prerequisites
- No wallet unlock needed (read-only)
- Requires a Stacks address and HODLMM pool ID

## Decision Logic

| Situation | Command |
|-----------|---------|
| Check current IL on a position | `check <pool-id> --address <addr>` |
| Compare LP vs HODL performance | `compare <pool-id> --address <addr>` |
| Find available pools | `pools` |

## When to Use
- Before rebalancing a HODLMM position — check if IL justifies the gas cost
- After price moves to assess position health
- When deciding whether to exit a pool — compare LP vs HODL
- Regular portfolio review — is the LP position net positive after fees?

## Output Handling
- `impermanent_loss.concentrated_il_pct` is the key metric — includes range amplification
- `position.in_range` tells you if you're still earning fees
- `risk_level` gives a quick read: low/medium/high
- `fee_context.breakeven_hint` estimates how long until fees cover the IL
- If `in_range` is false, the position is not earning — rebalance or exit
