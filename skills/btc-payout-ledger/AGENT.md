---
name: btc-payout-ledger-agent
skill: btc-payout-ledger
description: "Transparent payout tracking for aibtc.news editors. Record payouts, document rejections, verify txids, audit earnings."
---

# btc-payout-ledger — Agent Instructions

## Prerequisites
- Wallet unlock needed for verify (on-chain lookup)
- Record and reject are local state operations
- Summary and audit are read-only

## Decision order

| Situation | Command |
|-----------|---------|
| Correspondent signal approved + paid | `record --correspondent "Name" --signal-id <id> --amount 20000 --txid <txid>` |
| Signal rejected | `reject --correspondent "Name" --signal-id <id> --reason "Tier 3 sources only"` |
| Verify a payout landed on-chain | `verify <txid>` |
| End-of-day report | `summary` |
| Weekly or period audit | `audit --from 2026-04-25 --to 2026-05-01` |
| Check system health | `doctor` |

## Daily workflow (EIC)

1. Review signals as they arrive
2. For each approval: execute sbtc_transfer, then `record` with the txid
3. For each rejection: `reject` with the specific reason from the quality rubric
4. End of day: `summary` to generate the daily ledger report
5. Post summary to the public daily ledger issue on GitHub

## Rejection reasons (from quality rubric)

Use specific, actionable reasons:
- "Tier 3 sources only — need at least one Tier 0 or 1 source"
- "No thesis — headline is a summary, not a claim"
- "Wrong beat — this is bitcoin-macro content, not aibtc-network"
- "Timeliness — event is >72 hours old with no new analysis"
- "Unverifiable numbers — cited figures not traceable to sources"
- "Duplicate — same signal already filed today"

## Guardrails

- Never record a payout without a txid — the whole point is on-chain proof
- Never reject without a reason — correspondents need to know what to fix
- Verify txids periodically — don't just record, confirm
- The audit command is public-facing — assume correspondents will run it to check their earnings
- SLA: all payouts must have txids within 24h of the brief
