---
name: hodlmm-dca-deployer
description: "DCA into Bitflow HODLMM concentrated liquidity positions. Splits deposits into timed tranches, checks pool health before each entry, tracks blended entry price and cumulative IL across the deployment."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "plan <pool-id> --amount <sats> --tranches <n> --interval <blocks> | execute <pool-id> --amount <sats> [--bin-id <id>] [--dry-run] | doctor"
  entry: "hodlmm-dca-deployer/hodlmm-dca-deployer.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, hodlmm, dca, bitflow"
---

# hodlmm-dca-deployer

**Stop timing the market. DCA into LP positions instead.**

Dollar-cost average into Bitflow HODLMM concentrated liquidity. Instead of deploying all capital at once (timing risk + IL spike if price moves immediately), split deposits into tranches that enter at different price points — building a position with a blended entry that smooths out volatility.

## What it does

Calculates optimal DCA schedules for HODLMM pool entry. Given a total amount, number of tranches, and interval, it generates a deployment plan with per-tranche amounts, target blocks, and pool health checks. Each tranche enters at the current active bin price, building a blended position over time. The skill monitors pool conditions before each tranche and skips entries when the pool is unhealthy (>90% reserve imbalance).

## Why agents need it

- Entering a concentrated LP position at a single price point is high-risk — if price moves 2% immediately, you're underwater on IL
- DCA spreads entry across multiple price points, reducing the impact of any single bad entry
- HODLMM bin dynamics mean entry timing matters more than in standard AMMs — bin step amplifies price sensitivity
- No existing skill automates timed multi-tranche LP deployment with per-tranche health checks
- Agents deploying sBTC into yield need a systematic entry strategy, not a one-shot gamble

## Safety notes

- Plan command is read-only — generates schedule without executing
- Execute outputs MCP tool parameters for the parent agent — does not hold wallet keys
- Each tranche checks pool health before entry — skips if reserve imbalance >90%
- Minimum 10,000 sats per tranche (Styx pool minimum)
- Maximum 20 tranches per plan to prevent gas cost accumulation
- Dry-run mode available for simulation without deposits

## Commands

### plan

Create a DCA deployment schedule for a specific HODLMM pool.

```bash
bun hodlmm-dca-deployer/hodlmm-dca-deployer.ts plan <pool-id> --amount <sats> --tranches <n> --interval <blocks>
```

Output includes:
- Per-tranche amounts and target block heights
- Current pool conditions (active bin, price, fee rate, reserve balance)
- Estimated completion time
- Execution parameters for the first tranche (MCP tool + params)

### execute

Execute a single tranche — deploy sats into a pool at the current or specified bin.

```bash
bun hodlmm-dca-deployer/hodlmm-dca-deployer.ts execute <pool-id> --amount <sats> [--bin-id <id>] [--dry-run]
```

Checks pool health, then outputs the `hodlmm_add_liquidity` MCP call descriptor for the parent agent to execute with wallet access. Skips if pool is unhealthy. Parent agent tracks plan state between calls.

### doctor

Check prerequisites before creating a plan.

```bash
bun hodlmm-dca-deployer/hodlmm-dca-deployer.ts doctor
```

## Output contract

All commands return JSON to stdout:

```json
{
  "status": "success | error",
  "data": {
    "plan": {
      "id": "dca-xxxxx-xxxx",
      "poolId": "string",
      "totalSats": 100000,
      "trancheCount": 5,
      "perTranche": 20000,
      "intervalBlocks": 150
    },
    "poolConditions": {
      "activeBinId": 8388700,
      "currentPrice": 1.023,
      "isHealthy": true
    },
    "schedule": [
      { "tranche": 1, "amount": "20000 sats", "targetBlock": 945600, "status": "pending" }
    ],
    "execution": {
      "nextTranche": { "amount": 20000, "poolId": "...", "tool": "hodlmm_add_liquidity" }
    }
  },
  "error": { "code": "string", "message": "string" }
}
```

## Technical notes

- Bitflow HODLMM API (`bff.bitflowapis.finance`) for pool state and bin data
- Hiro Stacks API for block height tracking
- Bin price formula: `(1 + binStep/10000) ^ (binId - 8388608)`
- Blended entry price: weighted average of entry prices across executed tranches
- Advisory skill pattern: calculates optimal parameters, parent agent executes via MCP tools
- Interval in Stacks blocks (~2 seconds each on Nakamoto)
