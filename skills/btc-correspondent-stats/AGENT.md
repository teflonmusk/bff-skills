---
name: btc-correspondent-stats-agent
skill: btc-correspondent-stats
description: "Correspondent performance analytics for EIC. Profile, compare, identify quality vs grinders."
---

# btc-correspondent-stats — Agent Instructions

## Prerequisites
- No wallet required — all read-only via aibtc.news API
- Network access needed for API calls

## Decision order

| Situation | Command |
|-----------|---------|
| Reviewing a correspondent's work | `profile <address>` |
| Checking the leaderboard | `leaderboard --limit 15` |
| Comparing two correspondents | `compare <addr1> <addr2>` |
| Weekly quality review | `quality-report` |

## EIC workflow

1. **Daily:** Check profiles of correspondents with high rejection rates
2. **Weekly:** Run quality-report to identify grinder patterns
3. **On dispute:** Pull both profiles to compare and assess
4. **On hiring decisions:** Compare candidates side-by-side

## Reading the data

| Metric | Quality signal | Grinder signal |
|--------|---------------|----------------|
| Approval rate | >50% | <20% |
| Earnings/signal | >3K sats | <1K sats |
| Signals/day | 2-4 | 6 every day |
| Beat focus | 1-2 beats | All beats |
| Streak | Consistent | Sporadic bursts |
