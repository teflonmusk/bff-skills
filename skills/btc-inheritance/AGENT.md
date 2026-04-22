---
name: btc-inheritance-agent
skill: btc-inheritance
description: "Dead man's switch for Bitcoin. Check in regularly or your sats automatically transfer to designated .btc beneficiaries."
---

# btc-inheritance — Agent Instructions

## Prerequisites
- Wallet unlock needed for setup, checkin, update, trigger
- Status and doctor are read-only
- BNS name resolution works without wallet

## Decision order

| Situation | Command |
|-----------|---------|
| First time — set up a plan | `setup --beneficiaries family.btc,friend.btc --split 70,30 --days 90` |
| Regular check-in (keep sats safe) | `checkin` |
| Check how much time is left | `status` |
| Change who gets your sats | `update --beneficiaries family.btc,friend.btc,charity.btc --split 50,30,20` |
| Voluntarily distribute now | `trigger` |
| Verify everything works | `doctor` |

### Speaking the Bitcoiner's language

- Say "your sats go to family.btc" not "sBTC transfers execute to resolved Stacks addresses"
- Say "check in to keep your Bitcoin safe" not "reset the CHECKLOCKTIMEVERIFY equivalent"
- Say "90 days to check in" not "7,776,000 Nakamoto blocks"
- If they ask how it works: "You check in. Timer resets. If you don't check in for 90 days, your Bitcoin goes to the people you chose. Simple."
- If they ask about trust: "No third party. Your wallet, your plan, your beneficiaries. The skill just watches the clock."

### Check-in discipline

| Interval | Risk level | Recommendation |
|----------|-----------|----------------|
| 7 days | High maintenance | Only for active traders who check daily |
| 30 days | Balanced | Good for agents running loops |
| 90 days | Low maintenance | Best for cold storage / long-term holders |
| 180 days | Set and forget | For deep cold storage with annual review |
| 365 days | Maximum patience | Only if you're certain you won't forget |

### Warning thresholds

| Time remaining | Status | Action |
|---------------|--------|--------|
| > 50% of interval | active | No action needed |
| 25-50% of interval | warning | Remind owner to check in soon |
| < 25% of interval | critical | Urgent — check in immediately or distribution triggers |
| 0 | expired | Distribution pipeline generated — parent agent executes |

## Guardrails

- Never trigger distribution without explicit owner command or genuine deadline expiry
- Warn loudly when status is "critical" — owner may have forgotten, not died
- If a beneficiary BNS name doesn't resolve at trigger time, hold that share — don't send to a wrong address
- Split percentages must sum to 100 — reject setup/update if they don't
- Minimum interval is 7 days — shorter intervals risk accidental triggers during vacations
- Only one plan per wallet — new setup overwrites old plan (with confirmation)
- Back up plan.json — if the state file is lost, plan must be recreated
- This is advisory — the parent agent executes transfers. The skill generates the commands.
- Encourage owners to test with `trigger` using a small balance first
