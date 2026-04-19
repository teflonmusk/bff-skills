---
name: bitflow-btc-onramp
description: "Bitcoin-native front door to Bitflow DeFi. Send BTC, earn yield, withdraw BTC — no Stacks knowledge required. Bridges BTC to sBTC, routes into HODLMM pools, tracks everything in sats, and resolves BNS names for human-readable transfers."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "deposit --sats <n> | balance | yield | withdraw --sats <n> [--to-btc] | send <name.btc> --sats <n> | pools | doctor"
  entry: "bitflow-btc-onramp/bitflow-btc-onramp.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, bitflow, sbtc, onboarding, bitcoin-native"
---

# bitflow-btc-onramp

**Send BTC, earn yield on Bitflow. No Stacks knowledge required.**

The Bitcoin-native front door to Bitflow DeFi. Bitcoiners shouldn't need to know what Stacks, STX, or sBTC is to earn yield on their BTC. This skill abstracts away the bridging, gas, and L2 complexity — everything denominated in sats, addresses resolved via BNS names.

## What it does

Orchestrates the full BTC → yield pipeline: bridges BTC to sBTC via Styx (auto-selects optimal route), deploys into Bitflow HODLMM pools, tracks positions in sats, and enables withdrawal back to L1 BTC. BNS name resolution means you send to `friend.btc`, not `SP3XYZ...`. Gas is sponsored — zero STX cost.

## Why agents need it

- Bitcoiners bouncing off Bitflow because the UX requires Stacks knowledge — this removes that barrier
- No existing skill provides a single BTC-in, yield-out pipeline through Bitflow
- Agents serving Bitcoin-native users need to speak sats, not STX or micro-units
- BNS names have been resolving Bitcoin identities for 10 years — this skill uses them as the default address format
- Onboarding friction is the #1 blocker for Bitflow adoption from the Bitcoin community

## Safety notes

- Deposit generates the pipeline steps — parent agent executes each step with wallet access
- Bridge route auto-selected by amount: Styx main (<400K sats), Styx aibtc (<1M sats, 0% fee), direct peg-in (unlimited)
- All gas is sponsored via the x402 relay — users never need STX
- Withdrawal with `--to-btc` adds ~60 min for L1 peg-out (6 BTC confirmations)
- BNS resolution is on-chain — no API dependency, no centralized failure point
- sBTC is 1:1 backed BTC — withdraw anytime at par

## Commands

### deposit
Bridge BTC → sBTC → Bitflow pool in one flow.
```bash
bun bitflow-btc-onramp/bitflow-btc-onramp.ts deposit --sats 50000
```

### balance
Check all balances in sats — BTC, sBTC, LP positions.
```bash
bun bitflow-btc-onramp/bitflow-btc-onramp.ts balance --address teflonmusk.btc
```

### yield
Check yield across all Bitflow positions in sats/day.
```bash
bun bitflow-btc-onramp/bitflow-btc-onramp.ts yield
```

### withdraw
Exit pool, optionally peg-out to L1 BTC.
```bash
bun bitflow-btc-onramp/bitflow-btc-onramp.ts withdraw --sats 50000 --to-btc
```

### send
Send sats to a BNS name — address resolved on-chain.
```bash
bun bitflow-btc-onramp/bitflow-btc-onramp.ts send friend.btc --sats 10000
```

### pools
List available Bitflow HODLMM pools.
```bash
bun bitflow-btc-onramp/bitflow-btc-onramp.ts pools
```

### doctor
Check bridge capacity, pool availability, BNS resolver.
```bash
bun bitflow-btc-onramp/bitflow-btc-onramp.ts doctor
```

## Output contract

```json
{
  "status": "success | error",
  "data": {
    "deposit": {
      "amount": "50K sats",
      "route": "styx_main",
      "pipeline": [
        { "step": 1, "action": "Bridge BTC → sBTC", "tool": "styx_deposit" },
        { "step": 2, "action": "Verify sBTC received", "tool": "sbtc_get_balance" },
        { "step": 3, "action": "Deploy to Bitflow pool", "tool": "hodlmm_add_liquidity" }
      ],
      "summary": {
        "youSend": "50K sats BTC",
        "youGet": "50K sats sBTC in Bitflow LP",
        "gasEstimate": "Sponsored — zero STX cost"
      }
    }
  }
}
```

## Technical notes

- Bridge routing: Styx main (max 400K sats), Styx aibtc (max 1M sats, 0% premium), direct peg-in (unlimited)
- BNS resolution via lookup_bns_name — 10-year-old Bitcoin naming system on Stacks
- All amounts in satoshis — 1 BTC = 100,000,000 sats, sBTC = BTC at 1:1
- Gas sponsored via x402 relay — users never touch STX
- Advisory pattern: generates pipeline steps, parent agent executes with wallet
- Integrates with DC's skill suite: sbtc-bridge-router, hodlmm-dca-deployer, hodlmm-liquidity-shield
