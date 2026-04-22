---
name: btc-paystream
description: "Stream sats to anyone — payroll, subscriptions, tips. Continuous Bitcoin payments resolved via BNS names. Set amount + duration, sats flow automatically."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "stream --to <name.btc> --sats <n> --days <n> | status [stream-id] | claim <stream-id> | cancel <stream-id> | list | doctor"
  entry: "btc-paystream/btc-paystream.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, bitcoin-native, payments, streaming"
---

# btc-paystream

**Stream sats to anyone. Payroll, subscriptions, tips — continuous Bitcoin payments.**

Send 100K sats to friend.btc over 30 days. They claim as it accrues. You cancel anytime. No invoices, no lump sums, no trust required. Just sats flowing from one .btc name to another.

## What it does

Creates continuous sat streams between Bitcoin addresses. A sender commits sats and a duration — the skill calculates the flow rate (sats/day) and generates periodic transfer commands. Recipients claim accrued sats at any time. Senders can cancel the remaining balance. Everything denominated in sats, addresses resolved via BNS names.

## Why agents need it

- No existing Bitcoin payment skill handles continuous/streaming payments — only one-shot transfers
- Agents need to pay other agents over time: DRI salaries, bounty installments, service subscriptions
- Streaming aligns incentives — recipient stays engaged because payment is ongoing, sender can cancel if work stops
- BNS name resolution means agents pay "friend.btc" not SP addresses
- The x402 inbox is message-level (100 sats/msg) — paystream handles larger, time-distributed flows

## Safety notes

- Stream creation requires wallet unlock and sufficient sBTC balance for the full stream amount
- Funds are committed at stream creation — the full amount is earmarked (not locked on-chain, but tracked)
- Cancel returns uncommitted sats to sender immediately
- Claim transfers only the accrued portion — no early withdrawal of future sats
- All amounts in satoshis — no micro-STX, no token units
- Gas is sponsored where available — falls back to wallet STX
- BNS resolution is on-chain — no API dependency

## Commands

### stream
Create a new sat stream to a recipient.
```bash
bun btc-paystream/btc-paystream.ts stream --to friend.btc --sats 100000 --days 30
```

### status
Check stream progress — accrued, claimed, remaining, flow rate.
```bash
bun btc-paystream/btc-paystream.ts status <stream-id>
```

### claim
Recipient claims accrued sats from a stream.
```bash
bun btc-paystream/btc-paystream.ts claim <stream-id>
```

### cancel
Sender cancels remaining stream — unclaimed sats return to sender.
```bash
bun btc-paystream/btc-paystream.ts cancel <stream-id>
```

### list
Show all active streams (sent and received).
```bash
bun btc-paystream/btc-paystream.ts list
```

### doctor
Check prerequisites — wallet, BNS resolver, balance.
```bash
bun btc-paystream/btc-paystream.ts doctor
```

## Output contract

```json
{
  "status": "success | error",
  "data": {
    "stream": {
      "id": "ps-1a2b3c",
      "from": "dualcougar.btc",
      "to": "friend.btc",
      "totalSats": 100000,
      "flowRate": "3333 sats/day",
      "duration": "30 days",
      "accrued": 16665,
      "claimed": 10000,
      "claimable": 6665,
      "remaining": 83335,
      "startBlock": 7680000,
      "endBlock": 7810000,
      "status": "active"
    }
  }
}
```

## Technical notes

- Flow rate: totalSats / durationDays = sats/day (integer, remainder added to final day)
- Accrual: calculated from (currentBlock - startBlock) / (endBlock - startBlock) * totalSats
- Block time: ~2 seconds on Nakamoto Stacks (~43,200 blocks/day)
- Claims execute via sbtc_transfer to recipient's resolved address
- Stream state persisted to ~/.bff/streams/<stream-id>.json
- BNS resolution via lookup_bns_name — 10-year Bitcoin naming system
- All amounts in satoshis — 1 BTC = 100,000,000 sats
- Gas sponsored where possible — zero STX cost to users
