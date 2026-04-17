---
name: jingswap-cycle-maker
description: "Automated market making on JingSwap sBTC batch auctions. Scans for imbalanced cycles, deposits on the thin side, closes deposits, settles with fresh oracle prices, and repeats. Full lifecycle execution for both sbtc-stx and sbtc-usdcx markets."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "scan | deposit --side <sbtc|stx> --amount <n> | close | settle | auto --side <sbtc|stx> --amount <n> | history | doctor"
  entry: "jingswap-cycle-maker/jingswap-cycle-maker.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, jingswap, market-making, sbtc"
---

# jingswap-cycle-maker

**Be the liquidity that unsticks JingSwap cycles.**

Automated market making on JingSwap batch auctions. JingSwap cycles stall when one side has zero deposits — cycle 13 sat with 7.1 STX demand and zero sBTC for 60,000+ blocks. This skill fills the gap: scan for imbalanced cycles, deposit on the thin side at oracle price, close when both sides meet minimums, settle with fresh Pyth prices.

## What it does

Orchestrates the full JingSwap auction lifecycle. Given a side (sBTC or STX) and amount, it generates the exact MCP tool calls to: (1) scan the current cycle for opportunities, (2) deposit on the specified side, (3) close deposits when both sides meet minimums, (4) settle with fresh oracle prices, and (5) verify settlement results. The `auto` command chains all steps into a single execution plan the parent agent follows sequentially.

## Why agents need it

- JingSwap cycles stall for days when one side has zero deposits — no existing skill automates filling the gap
- The existing `jingswap-cycle-agent` handles basic cycle state but doesn't execute deposits or settlements
- Market makers earn the spread between oracle price and their target entry — passive income for providing liquidity
- Agents with idle sBTC or STX can deploy capital into auction cycles instead of letting it sit in wallets
- Two markets available (sbtc-stx and sbtc-usdcx) — diversification across trading pairs

## Safety notes

- Scan and doctor are read-only — no wallet interaction
- Deposit locks funds until settlement or cancellation — understand this before executing
- Cancellation is available during deposit phase only (jingswap_cancel_sbtc / jingswap_cancel_stx)
- Settlement price is set by Pyth oracle — depositors do not control the clearing price
- Auto command outputs the plan but requires parent agent confirmation at each step
- If settlement fails after 500 blocks, the cancel safety valve (jingswap_cancel_cycle) activates
- Maximum 2% oracle-vs-DEX price divergence recommended — abort if exceeded

## Commands

### scan
Analyze the current cycle for market-making opportunities.

```bash
bun jingswap-cycle-maker/jingswap-cycle-maker.ts scan [--market sbtc-stx]
```

### deposit
Place sBTC or STX into the current auction cycle.

```bash
bun jingswap-cycle-maker/jingswap-cycle-maker.ts deposit --side sbtc --amount 5000 [--market sbtc-stx]
```

### close
Close the deposit phase when both sides meet minimums.

```bash
bun jingswap-cycle-maker/jingswap-cycle-maker.ts close [--market sbtc-stx]
```

### settle
Settle the cycle with fresh Pyth oracle prices.

```bash
bun jingswap-cycle-maker/jingswap-cycle-maker.ts settle [--market sbtc-stx]
```

### auto
Full lifecycle plan — scan → deposit → close → settle → verify → next cycle.

```bash
bun jingswap-cycle-maker/jingswap-cycle-maker.ts auto --side sbtc --amount 5000 [--market sbtc-stx]
```

### history
Analyze past cycle performance — clearing prices, fill rates, volume trends.

```bash
bun jingswap-cycle-maker/jingswap-cycle-maker.ts history [--market sbtc-stx] [--cycles 5]
```

### doctor
Check prerequisites.

```bash
bun jingswap-cycle-maker/jingswap-cycle-maker.ts doctor
```

## Output contract

All commands return JSON to stdout:

```json
{
  "status": "success | error",
  "data": {
    "action": "scan | deposit | close | settle | auto",
    "market": "sbtc-stx",
    "execute": {
      "tool": "jingswap_deposit_sbtc",
      "params": { "amount": 5000, "market": "sbtc-stx" },
      "description": "Deposit 5000 sats sBTC into cycle"
    },
    "lifecycle": [
      { "step": 1, "action": "scan", "tool": "...", "decision": "..." }
    ]
  },
  "error": { "code": "string", "message": "string" }
}
```

## Technical notes

- JingSwap uses Pyth oracle for settlement pricing — not order book or AMM curves
- Cycle phases: 0=deposit (min 150 blocks), 1=buffer (30 blocks), 2=settle
- Use `jingswap_settle_with_refresh` over `jingswap_settle` — stored prices are almost always stale
- Minimum deposits: sBTC 1,000 sats, STX 1,000,000 micro-STX (1 STX)
- Cancel threshold: 500 blocks after deposits closed if settlement fails
- Two markets: sbtc-stx (primary, active volume) and sbtc-usdcx (secondary)
- Stacks blocks average ~2 seconds on Nakamoto
