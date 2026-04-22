---
name: btc-paystream-agent
skill: btc-paystream
description: "Stream sats continuously to any .btc name. Payroll, subscriptions, tips — Bitcoin's answer to recurring payments."
---

# btc-paystream — Agent Instructions

## Prerequisites
- Wallet unlock needed for stream, claim, cancel
- Status, list, doctor are read-only
- BNS name resolution works without wallet
- Sender needs sufficient sBTC balance for full stream amount at creation

## Decision order

| Situation | Command |
|-----------|---------|
| Pay someone over time | `stream --to friend.btc --sats 100000 --days 30` |
| Check how a stream is going | `status <stream-id>` |
| Collect sats owed to you | `claim <stream-id>` |
| Stop paying — get remaining sats back | `cancel <stream-id>` |
| See all active streams | `list` |
| First time setup | `doctor` |

### Speaking the Bitcoiner's language

- Everything in **sats** — "you're streaming 3,333 sats/day" not "transferring 0.00003333 sBTC daily"
- Use **BNS names** — "streaming to friend.btc" not "to SP2XYZ..."
- Say "sats flowing" not "sBTC transfers executing on Stacks L2"
- If they ask about gas: "Sponsored — zero cost"
- If they ask how it works: "Sats accrue every block. Recipient claims whenever they want. You cancel anytime."

### Stream sizing guide

| Use case | Amount | Duration | Flow rate |
|----------|--------|----------|-----------|
| Coffee tip | 5K sats | 1 day | 5,000 sats/day |
| Weekly contractor | 50K sats | 7 days | 7,143 sats/day |
| Monthly salary | 500K sats | 30 days | 16,667 sats/day |
| Quarterly retainer | 1.5M sats | 90 days | 16,667 sats/day |
| Annual subscription | 1.2M sats | 365 days | 3,288 sats/day |

### Claim frequency

- Recipients can claim accrued sats at any time — no minimum
- Each claim is an on-chain transfer (gas cost ~3K micro-STX)
- Recommend claiming weekly for regular streams, daily for high-flow streams
- Unclaimed sats keep accruing — nothing is lost by waiting

## Guardrails

- Never create a stream larger than sender's current sBTC balance (advisory — parent agent must verify)
- Warn if flow rate is less than 100 sats/day — gas costs may exceed value
- Warn if duration exceeds 365 days — long streams have higher cancellation risk
- Cancel returns sats immediately — no delay, no penalty
- If recipient's BNS name doesn't resolve, fail with helpful error — don't fall back to raw addresses
- Streams are 1-to-1: one sender, one recipient. For multi-recipient payroll, create multiple streams
- Stream state is local (persisted to disk) — if state file is lost, stream parameters must be reconstructed from creation output
