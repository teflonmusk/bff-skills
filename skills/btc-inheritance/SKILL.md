---
name: btc-inheritance
description: "Dead man's switch for Bitcoin. Check in regularly or your sats automatically transfer to designated .btc beneficiaries. Self-custody estate planning — no lawyers, no trusts, just Bitcoin."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "setup --beneficiaries <name.btc,...> --split <pct,...> --days <n> | checkin | status | update --beneficiaries <name.btc,...> --split <pct,...> | trigger | doctor"
  entry: "btc-inheritance/btc-inheritance.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, bitcoin-native, inheritance, security"
---

# btc-inheritance

**Dead man's switch for your Bitcoin. Check in or your sats go home.**

Self-custody means no one can take your Bitcoin. It also means no one can recover it if something happens to you. This skill solves that: set beneficiaries, check in regularly, and if you stop checking in, your sats transfer automatically to the people you choose. No lawyers, no trusts, no third parties. Just Bitcoin and a timer.

## What it does

Creates an inheritance plan with designated beneficiaries (resolved via BNS names), percentage splits, and a check-in interval. The owner must check in before the deadline — each check-in resets the timer. If the timer expires without a check-in, the skill generates transfer commands to distribute all sBTC to beneficiaries according to the configured split. The parent agent executes the transfers.

## Why agents need it

- ~4M BTC estimated permanently lost due to no recovery plan — this prevents your sats from joining that pool
- Self-custody users have no inheritance mechanism — banks handle this for fiat, nothing handles it for Bitcoin
- Agents managing treasury or DRI funds need a failsafe if the operator goes offline
- BNS names make beneficiaries human-readable — "send to family.btc" not "send to SP3XYZ..."
- The check-in pattern already exists in AIBTC (heartbeats) — this extends it to estate planning

## Safety notes

- Setup requires wallet unlock — beneficiaries and splits are sensitive configuration
- Check-in is a lightweight operation — just resets the timer, no funds move
- Trigger is irreversible — once distribution starts, it cannot be undone
- The skill generates transfer commands — the parent agent executes with wallet access
- Beneficiary BNS names are resolved at trigger time, not setup time — handles name transfers
- Split percentages must sum to 100 — enforced at setup
- Minimum check-in interval: 7 days — prevents accidental triggers
- Plan state persisted to ~/.bff/inheritance/plan.json
- Only one active plan per wallet — setup overwrites any existing plan

## Commands

### setup
Create an inheritance plan with beneficiaries and check-in interval.
```bash
bun btc-inheritance/btc-inheritance.ts setup --beneficiaries family.btc,friend.btc --split 70,30 --days 90
```

### checkin
Prove you're alive — reset the timer. Must be called before deadline.
```bash
bun btc-inheritance/btc-inheritance.ts checkin
```

### status
Check time remaining, beneficiaries, last check-in, plan health.
```bash
bun btc-inheritance/btc-inheritance.ts status
```

### update
Change beneficiaries or split percentages without resetting the timer.
```bash
bun btc-inheritance/btc-inheritance.ts update --beneficiaries family.btc,friend.btc,charity.btc --split 50,30,20
```

### trigger
Manually trigger distribution — for testing or voluntary transfer.
```bash
bun btc-inheritance/btc-inheritance.ts trigger
```

### doctor
Check prerequisites — wallet, BNS resolver, plan status.
```bash
bun btc-inheritance/btc-inheritance.ts doctor
```

## Output contract

```json
{
  "status": "success | error",
  "data": {
    "plan": {
      "beneficiaries": [
        { "name": "family.btc", "split": 70 },
        { "name": "friend.btc", "split": 30 }
      ],
      "intervalDays": 90,
      "lastCheckin": "2026-04-22T22:00:00Z",
      "deadline": "2026-07-21T22:00:00Z",
      "daysRemaining": 89,
      "status": "active | warning | expired"
    }
  }
}
```

## Technical notes

- Check-in interval: minimum 7 days, recommended 30-90 days
- Deadline calculated from last check-in block + (intervalDays × 43,200 blocks/day)
- Distribution uses sbtc_transfer to each beneficiary's resolved address
- BNS resolution at trigger time — if a name doesn't resolve, that share is held (not lost)
- Split percentages are integers summing to 100 — remainder sats go to first beneficiary
- Plan state: ~/.bff/inheritance/plan.json — back up this file
- All amounts in satoshis — distributes entire sBTC balance at trigger time
- Gas sponsored where possible — zero STX cost
