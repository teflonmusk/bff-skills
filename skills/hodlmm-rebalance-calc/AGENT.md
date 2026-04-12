# hodlmm-rebalance-calc — Agent Instructions

## Prerequisites
- No wallet unlock needed (read-only analysis)
- Execution of rebalance requires wallet unlock for withdraw + add liquidity

## Decision Logic

| Situation | Command |
|-----------|---------|
| Should I rebalance my LP position? | `evaluate <pool-id> --address <addr>` |
| What does a rebalance cost in gas? | `gas` |
| Which pools have the best fee rates? | `pools` |

## When to Use
- After price moves — check if position drifted out of range
- Before executing a rebalance — verify the gas cost is justified
- Regular portfolio review — is IL accumulating faster than fees?
- Pairs with hodlmm-il-tracker: IL tracker shows the problem, rebalance-calc tells you what to do

## Output Handling
- `verdict` is the key output: REBALANCE_NOW, HOLD, or EXIT
- `rationale` explains why with specific numbers — surface this to the user
- `action` gives step-by-step instructions if rebalancing
- `fee_analysis.cycles_to_breakeven` tells you how long the new position needs to earn back the rebalance cost
- If verdict is EXIT, do NOT redeploy — wait for price stabilization
