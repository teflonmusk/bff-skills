---
name: styx-route-signal
description: "sBTC acquisition route oracle. Compares JingSwap oracle settlement rate vs HODLMM DLMM DEX price in real time, outputs cheapest route for STX→sBTC execution. Also references Styx BTC peg-in bridge for BTC holders. Uses Pyth Hermes + Hiro JingSwap contract reads — no API key required."
metadata:
  author: "teflonmusk"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "doctor | run"
  entry: "styx-route-signal/styx-route-signal.ts"
  tags: "sbtc, stx, jingswap, hodlmm, styx, routing, defi, oracle, mainnet-only, stacks"
---

# styx-route-signal

## What it does

Compares three routes for acquiring sBTC and outputs the cheapest execution path for AIBTC agents deploying liquidity into HODLMM:

| Route | Mechanism | Best when |
|---|---|---|
| **JINGSWAP** | Deposit STX at Pyth oracle settlement rate | Oracle < DEX by ≥ threshold |
| **HODLMM** | Swap STX → sBTC on live DLMM DEX | Oracle at premium or cycle closed |
| **STYX** | Peg BTC → sBTC at ~1:1 parity | BTC holders only (reference) |

JingSwap settles at the Pyth oracle rate — when oracle < DEX, depositing STX acquires sBTC cheaper than buying on-market. This skill quantifies that spread and tells agents exactly which route to take.

## Why agents need it

HODLMM LPs need sBTC to deploy liquidity. Where they source it determines their entry cost. The JingSwap vs HODLMM spread fluctuates throughout the day — a 1–3% discount means thousands of STX saved at scale. This skill makes that decision instant and deterministic.

## Data sources

| Source | Data | API |
|---|---|---|
| Pyth Hermes | BTC/USD + STX/USD live prices | `hermes.pyth.network` |
| Hiro contract read | JingSwap DLMM + XYK DEX prices | `api.hiro.so` (public, no key) |
| Hiro contract read | JingSwap cycle state (phase, sBTC available) | `api.hiro.so` (public, no key) |
| Static reference | Styx pool BTC addresses + deposit limits | Hardcoded from contract metadata |

## Commands

### doctor

```bash
bun run styx-route-signal/styx-route-signal.ts doctor
```

```json
{
  "result": "ready",
  "checks": {
    "pyth_hermes_api": "ok",
    "hiro_jingswap_contract": "ok"
  },
  "contract": "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jing-v2",
  "styx_pools": {
    "main": { "btc_address": "bc1qlh3zk77...", "max_deposit_sats": 300000 },
    "aibtc": { "btc_address": "bc1qex5rfz...", "max_deposit_sats": 1000000 }
  }
}
```

### run

```bash
bun run styx-route-signal/styx-route-signal.ts run
bun run styx-route-signal/styx-route-signal.ts run --amount-sbtc 0.01 --min-discount 2.0
```

Options:
- `--amount-sbtc <n>` (default: `0.001`) — target sBTC amount for cost comparison
- `--min-discount <pct>` (default: `1.0`) — minimum oracle discount vs DEX to prefer JingSwap

```json
{
  "skill": "styx-route-signal",
  "timestamp": "2026-03-30T14:20:25.939Z",
  "input": { "amount_sbtc": 0.001, "min_discount_pct": 1 },
  "prices": {
    "btc_usd": "67435.95",
    "stx_usd": "0.222267",
    "implied_stx_per_sbtc": "303401",
    "dlmm_stx_per_sbtc": "303186",
    "xyk_stx_per_sbtc": "303290",
    "best_dex_stx_per_sbtc": "303186",
    "oracle_vs_dex_discount_pct": "0.071"
  },
  "routes": {
    "jingswap": {
      "status": "OPEN",
      "cycle_id": 9,
      "phase": "deposit",
      "oracle_stx_per_sbtc": "303401",
      "oracle_vs_dex_discount_pct": "0.071",
      "sbtc_available": "0.01927711",
      "stx_deposited": "0.000000",
      "stx_cost_for_target": "303",
      "vs_hodlmm": "costs 0 STX more than HODLMM"
    },
    "hodlmm": {
      "status": "AVAILABLE",
      "venue": "DLMM",
      "stx_per_sbtc": "303186",
      "stx_cost_for_target": "303",
      "settlement": "instant"
    },
    "styx": {
      "status": "REFERENCE",
      "description": "BTC → sBTC peg-in bridge. Requires BTC on-hand. ~1:1 parity minus Bitcoin miner fee.",
      "main_pool": { "btc_address": "bc1qlh3zk77...", "max_deposit_sats": 300000 },
      "aibtc_pool": { "btc_address": "bc1qex5rfz...", "max_deposit_sats": 1000000 }
    }
  },
  "recommendation": "HODLMM",
  "confidence": "high",
  "rationale": "JingSwap oracle 0.071% MORE expensive than DLMM DEX. Use HODLMM for cheaper instant acquisition.",
  "summary": "HODLMM (high) — oracle 0.071% more expensive than DEX."
}
```

## Recommendation values

| Recommendation | Meaning |
|---|---|
| `JINGSWAP` | Oracle ≥ min-discount cheaper than DEX — deposit STX in active cycle |
| `HODLMM` | Buy on DEX directly — oracle at premium, below threshold, or cycle closed |

Confidence:
- `high` — oracle ≥ 2% discount or clearly at premium
- `medium` — borderline threshold

## Chaining

- Run before sourcing sBTC to deploy in HODLMM
- Feed `recommendation` into jingswap-cycle-agent `participate` or HODLMM swap execution
- Combine with `fee-weather` for Stacks network conditions before transacting
- Combine with `hodlmm-advisor` for full position management: route-signal handles acquisition, hodlmm-advisor handles bin positioning

## Technical notes

- Contract: `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jing-v2`
- DLMM price formula: `STX/sBTC = 1e10 / dlmmRaw`
- XYK price formula: `STX/sBTC = xykRaw / 1e8`
- Oracle price: Pyth `BTC/USD ÷ STX/USD`
- Styx is a BTC→sBTC peg-in bridge, not an on-chain DEX — no live Styx API call needed

## Output contract

All outputs are JSON to stdout.

**Error:**
```json
{ "skill": "styx-route-signal", "error": "descriptive message", "timestamp": "..." }
```
