---
name: btc-eic-autoreviewer-agent
skill: btc-eic-autoreviewer
description: "Automated EIC signal triage. Gates, ranks, batches — EIC signs."
---

# btc-eic-autoreviewer — Agent Instructions

## Daily workflow

1. **15:00 UTC:** Run `auto-review --dry-run` to preview the day's triage
2. **Review the output:** Check approvals make sense, rejections have correct gates
3. **Execute:** Parent agent signs and submits each approval/rejection via API
4. **Brief handoff:** Approved signal set goes to publisher

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
