---
name: hodlmm-rebalance-calc-agent
skill: hodlmm-rebalance-calc
description: "Agent instructions for the HODLMM rebalance calculator — routes LP rebalance questions to the correct command and interprets verdicts."
---

# hodlmm-rebalance-calc — Agent Instructions

## Prerequisites
- No wallet unlock needed (read-only analysis)
- Execution of rebalance requires wallet unlock for withdraw + add liquidity

## Decision order

| Situation | Command |
|-----------|---------|
| Should I rebalance my LP position? | `evaluate <pool-id> --address <addr>` |
| What does a rebalance cost in gas? | `gas` |
| Which pools have the best fee rates? | `pools` |

When to use:
- After price moves — check if position drifted out of range
- Before executing a rebalance — verify the gas cost is justified
- Regular portfolio review — is IL accumulating faster than fees?
- Pairs with hodlmm-il-tracker: IL tracker shows the problem, rebalance-calc tells you what to do

## Guardrails

- This skill is entirely read-only; never assume it has executed a trade
- Always surface the `verdict` and `rationale` fields to the user — do not silently act on a verdict
- If verdict is EXIT, do NOT redeploy liquidity — advise the user to wait for price stabilization
- If verdict is REBALANCE_NOW, confirm with the user before initiating any withdrawal or liquidity add
- Do not call `evaluate` without both a valid pool ID and STX address
- Gas estimates may be stale; if `relay_healthy` is false, warn the user that cost data is unreliable
- Never loop rebalance evaluations automatically — one check per user request

## Output Handling
- `verdict` is the key output: REBALANCE_NOW, HOLD, or EXIT
- `rationale` explains why with specific numbers — surface this to the user
- `action` gives step-by-step instructions if rebalancing
- `fee_analysis.cycles_to_breakeven` tells you how long the new position needs to earn back the rebalance cost
- If verdict is EXIT, do NOT redeploy — wait for price stabilization
