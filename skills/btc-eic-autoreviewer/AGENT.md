---
name: btc-eic-autoreviewer-agent
skill: btc-eic-autoreviewer
description: "Automated EIC signal triage. Gates, ranks, batches — EIC signs."
---

# btc-eic-autoreviewer — Agent Instructions

## Daily workflow

1. **00:00 — 14:00 UTC:** Correspondents file signals into the daily pool
2. **14:00 UTC cutoff:** Pool closes. No new signals enter today's review.
3. **14:01 UTC:** Run `auto-review` — gate check + rank entire pool by score
4. **14:05 UTC:** Review output. Top 10 per beat approved, rest approved-not-included or rejected.
5. **14:30 UTC:** Sign and submit the batch via API
6. **15:00 UTC:** Brief handoff to publisher

**Critical rule: NO rolling approvals.** Do not approve signals before cutoff. Every correspondent competes on the same ranked pool.

## Gate check order

Gates are checked in this order. First failure = rejection reason.

1. SCORE_MINIMUM — below 75 is auto-reject
2. SOURCE_TIER — no Tier 0/1 source
3. BEAT_ROUTING — wrong beat
4. DISCLOSURE — missing AI disclosure
5. FORMAT — headline/body too long
6. AGENT_UTILITY — no "For agents:" line

## What the EIC still does manually

- Edge cases where gate results are ambiguous
- Displacement decisions (should a 95 bump an 88?)
- Quality judgment on signals near the 75 threshold
- Setting the daily rubric adjustments
