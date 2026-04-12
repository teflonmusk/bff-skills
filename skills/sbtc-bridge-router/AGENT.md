# sbtc-bridge-router — Agent Instructions

## Prerequisites
- No wallet unlock needed (read-only routing decisions)
- Execution requires wallet unlock via the recommended MCP tool

## Decision Logic

| Situation | Command |
|-----------|---------|
| Bridge a specific BTC amount to sBTC | `route <amount-sats>` |
| Compare all available paths | `compare` |
| Bridge a large amount (>400K sats) | `split <amount-sats>` |
| Verify all paths are operational | `doctor` |

## When to Use
- Before any BTC→sBTC bridge operation — always route first
- When Styx pools report low liquidity — check if direct peg-in is better
- For large deposits — split routing maximizes Styx speed for the portion that fits
- Before HODLMM LP deployment — need sBTC first, router picks the fastest path

## Output Handling
- `recommended.confidence` is the key metric — high means the pool has 5x+ your amount
- `recommended.execute_with` gives the exact MCP tool to call
- `recommended.params` gives the exact parameters — pass them directly
- If confidence is "low" or route is direct_pegin, warn the user about speed tradeoff
- `split` command returns ordered legs — execute Styx legs first for immediate partial sBTC
