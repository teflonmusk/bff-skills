---
name: jingswap-cycle-maker-agent
skill: jingswap-cycle-maker
description: "Automated market making on JingSwap sBTC batch auctions. Orchestrates the full lifecycle: scan, deposit, close, settle, repeat."
---

# jingswap-cycle-maker — Agent Instructions

## Prerequisites
- Wallet unlock needed for deposit, close, and settle
- Requires sBTC balance (for sbtc side) or STX balance (for stx side)
- Minimum deposit: 1,000 sats sBTC or 1 STX

## Decision order

| Situation | Command |
|-----------|---------|
| Looking for market-making opportunities | `scan` |
| Ready to provide liquidity | `deposit --side sbtc --amount 5000` |
| Both sides have deposits, ready to advance | `close` |
| Deposits closed, buffer complete | `settle` |
| Want full automation plan | `auto --side sbtc --amount 5000` |
| Analyzing past performance | `history --cycles 10` |
| First time setup | `doctor` |

### Which side to deposit

- **Deposit sBTC** when the cycle shows STX demand but 0 sBTC (most common stall condition)
- **Deposit STX** when the cycle shows sBTC supply but 0 STX demand
- **Check prices first** — compare oracle vs DEX. If oracle price is significantly different from your target, wait for convergence
- **Default to sBTC side** — historically more scarce, faster cycle completion

### When to close deposits

- Phase must be 0 (deposit)
- At least 150 blocks elapsed since cycle start
- **Both sides** must meet minimums (sBTC >= 1000 sats AND STX >= 1,000,000 micro-STX)
- Anyone can close — you don't need to be a depositor

### When to settle

- Phase must be 1 (buffer complete) or 2 (settle)
- Always use `jingswap_settle_with_refresh` — stored oracle prices are stale
- If settlement fails 3 times, wait 100 blocks and retry
- After 500 blocks post-close with no settlement, use cancel safety valve

## Guardrails

- Never deposit more than 10% of wallet balance into a single cycle (advisory — parent agent must enforce)
- Check oracle vs DEX price divergence before depositing — abort if >2%
- Do not force-close deposits if only one side meets minimums — the cycle will fail
- Always verify settlement results with `jingswap_get_settlement` after settling
- If a cycle has been in deposit phase >50,000 blocks with one side at 0, it's unlikely to fill — monitor but don't commit large amounts
- The cancel safety valve (jingswap_cancel_cycle) rolls deposits into the next cycle — it does NOT refund immediately
- For sbtc-usdcx market: volume is much lower than sbtc-stx. Expect longer cycle times.
