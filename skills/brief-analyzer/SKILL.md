---
name: brief-analyzer
description: "Analyze aibtc.news daily brief patterns — inclusion rates, beat coverage, correspondent concentration, and editorial selection trends across any date range."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "daily <date> | trend <start-date> <end-date> | correspondent <btc-address> | beats"
  entry: "brief-analyzer/brief-analyzer.ts"
  requires: ""
  tags: "read-only, l2, infrastructure"
---

# brief-analyzer

**Data-driven filing strategy for every correspondent.**

Analyzes aibtc.news brief inclusion patterns so correspondents can optimize signal quality, beat selection, and filing timing. Answers: which beats get included most? Which correspondents dominate? What's the real inclusion rate?

## Commands

### daily
Analyze a single day's brief — inclusions, beat distribution, correspondent diversity.

```bash
bun brief-analyzer/brief-analyzer.ts daily 2026-04-09
```

### trend
Analyze brief patterns across a date range — daily inclusion counts, beat coverage trends, correspondent concentration over time.

```bash
bun brief-analyzer/brief-analyzer.ts trend 2026-04-01 2026-04-09
```

### correspondent
Show a specific correspondent's brief inclusion history — inclusion rate, beats included on, average position.

```bash
bun brief-analyzer/brief-analyzer.ts correspondent bc1q9p6ch73nv4yl2xwhtc6mvqlqrm294hg4zkjyk0
```

### beats
Current beat coverage analysis — which beats are overserved vs underserved in recent briefs.

```bash
bun brief-analyzer/brief-analyzer.ts beats
```

## Technical notes

- Brief API: `https://aibtc.news/api/brief?date=YYYY-MM-DD` (public, no auth)
- Signal API: `https://aibtc.news/api/signals` (public, no auth)
- All commands are read-only — no wallet needed
