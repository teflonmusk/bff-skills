---
name: bitcoin-furnace
description: "Throw sats in, get more sats out. Fully automated BTC yield — bridges, deploys, rebalances, compounds, and withdraws back to L1. You never see sBTC, STX, or pools. Just sats in, more sats out."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "stoke --sats <n> | heat | tap [--to-btc] | cool | auto --on|--off | doctor"
  entry: "bitcoin-furnace/bitcoin-furnace.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, bitflow, sbtc, yield, bitcoin-native, automated"
---

# bitcoin-furnace

**Throw sats in, get more sats out. Don't ask how.**

The fully automated BTC yield engine. Bitcoiners send sats, the furnace handles everything — bridging, pool selection, range optimization, rebalancing, fee compounding, and withdrawal back to L1 BTC. You never interact with sBTC, STX, Stacks, or liquidity pools directly. The furnace burns hot so you don't have to think.

## What it does

Orchestrates the complete BTC yield lifecycle autonomously: bridges BTC to sBTC via Styx (route auto-selected), deploys into the highest-yielding Bitflow HODLMM pool, monitors price drift, rebalances when out of range, compounds earned fees back into the position, and sweeps profits to your L1 BTC address on demand. All decisions made internally — no user input needed after initial deposit.

## Why agents need it

- Bitcoiners want yield but won't learn Stacks, manage LP ranges, or monitor IL — the furnace does it all
- No existing skill provides fully automated BTC → yield → BTC with zero ongoing management
- Agents serving Bitcoin-native users need a "set and forget" yield product, not a toolkit
- The DCA deployer handles entry, the liquidity shield handles protection — but nothing handles the FULL loop autonomously
- Bitflow adoption from Bitcoiners requires zero-touch UX — the furnace is that UX

## Safety notes

- All deposits go through Styx bridge (amount-based route selection) — no manual bridging
- Rebalancing only triggers when price exits position range AND projected IL exceeds fee accrual
- Auto-mode requires explicit activation (`auto --on`) — not enabled by default
- Withdrawal with `cool` always offers `--to-btc` for L1 peg-out (adds ~60 min for 6 confirmations)
- Maximum single deposit: 1M sats via Styx aibtc pool (0% fee), unlimited via direct peg-in
- Gas is sponsored — users never need STX
- sBTC is 1:1 backed BTC — withdraw at par anytime

## Commands

### stoke
Feed the furnace — deposit BTC and auto-deploy to yield.
```bash
bun bitcoin-furnace/bitcoin-furnace.ts stoke --sats 500000
```

### heat
Check furnace temperature — yield rate, total value, position health.
```bash
bun bitcoin-furnace/bitcoin-furnace.ts heat
```

### tap
Harvest earned yield — optionally sweep to L1 BTC.
```bash
bun bitcoin-furnace/bitcoin-furnace.ts tap --to-btc
```

### cool
Shut down the furnace — withdraw everything back to BTC.
```bash
bun bitcoin-furnace/bitcoin-furnace.ts cool
```

### auto
Enable/disable autopilot — rebalance, compound, rotate pools.
```bash
bun bitcoin-furnace/bitcoin-furnace.ts auto --on
```

### doctor
Furnace diagnostics — bridge health, pool status, position range.
```bash
bun bitcoin-furnace/bitcoin-furnace.ts doctor
```

## Output contract

```json
{
  "status": "success | error",
  "data": {
    "furnace": {
      "temperature": "hot | warm | cold",
      "deposited": "500K sats",
      "currentValue": "502,341 sats",
      "earned": "2,341 sats",
      "yieldRate": "58 sats/day",
      "daysRunning": 40,
      "pool": "sBTC-STX main",
      "rangeStatus": "in-range | drifting | out-of-range",
      "autoMode": true,
      "lastRebalance": "2026-04-18T12:00:00Z"
    }
  }
}
```

## Technical notes

- Bridge routing: Styx main (<400K sats), Styx aibtc (<1M sats, 0% fee), direct peg-in (unlimited)
- Pool selection: ranks all HODLMM pools by 7-day fee APR / IL ratio, picks highest risk-adjusted yield
- Rebalance trigger: price exits 80% of position range AND projected 24h IL > 24h fee income
- Compound threshold: accrued fees > 10K sats (below this, gas cost exceeds benefit)
- Auto-rotation: if current pool yield drops below 50% of best available pool for 48h, migrates
- All amounts in satoshis — 1 BTC = 100,000,000 sats
- Gas sponsored via x402 relay — zero STX cost
- Integrates with: sbtc-bridge-router, hodlmm-dca-deployer, hodlmm-liquidity-shield, hodlmm-position-tracker
