---
name: fee-weather
version: 1.0.0
description: Stacks network fee & congestion oracle. Returns fee estimates, mempool state, market netflow, and a plain-language timing recommendation for when to transact.
author: Dual Cougar
category: infrastructure
tags: [fees, mempool, network, stacks, oracle, timing]
chain: stacks
cost: free
output: json
command: bun skill.ts
---

# fee-weather

Real-time Stacks network conditions. Built by DC as the foundation for yield routing and any skill that needs to time transactions intelligently.

## What it does

- Fetches current Stacks fee estimates from Hiro API
- Reads mempool transaction count
- Pulls market netflow and DeFi stats from x402.biwas.xyz
- Classifies network as CLEAR / MODERATE / CONGESTED
- Returns a plain-language `recommendation`: TRANSACT_NOW, TRANSACT_WITH_CAUTION, or WAIT

## Usage

```bash
bun skill.ts
```

## Output

```json
{
  "skill": "fee-weather",
  "timestamp": "2026-03-25T14:00:00.000Z",
  "network": {
    "fee_microstacks": 400,
    "fee_stx": "0.000400",
    "mempool_tx_count": 142
  },
  "conditions": "CLEAR",
  "recommendation": "TRANSACT_NOW",
  "market": {
    "total_volume_24h": 1200000,
    "active_pairs": 48
  },
  "netflow": {
    "net_flow_usd": 45000,
    "direction": "inflow"
  },
  "summary": "Network is CLEAR. Fee: 0.000400 STX. Mempool: 142 pending txs. Recommendation: TRANSACT_NOW."
}
```

## Chaining

Feed `recommendation` into any skill that executes transactions (yield-router, stacks-dca, oracle-settlement) to gate execution on network conditions.
