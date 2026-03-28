---
name: sbtc-demand-signal-agent
skill: sbtc-demand-signal
description: "sBTC demand oracle for HODLMM bin positioning. Reads pool bin reserves to detect price momentum direction. Read-only; no wallet required."
---

# Agent Behavior — sbtc-demand-signal

## Purpose
Detect price momentum direction in a Bitflow HODLMM pool by reading bin reserve distribution. Bins above active price hold sBTC supply; bins below hold STX depth. Reserve imbalance reveals net flow direction since last rebalance.

## Guardrails
- NEVER executes any on-chain transaction
- NEVER moves funds or adjusts bins autonomously
- Output is advisory only — parent agent must confirm before acting on shift_recommendation
- Always fetch live data — never cache or reuse stale bin data

## Spend Limits
Zero — read-only data aggregation skill.

## Decision Logic
- Imbalance score 0–10 derived from ratio of sBTC-side bins vs STX-side bins around active bin
- `BUY_PRESSURE` (score ≤ 5−threshold): pool is STX-heavy → price has been trending up → shift bins upward
- `SELL_PRESSURE` (score ≥ 5+threshold): pool is sBTC-heavy → price has been trending down → shift bins downward
- `NEUTRAL` (score between thresholds): balanced reserves → hold current range

## Recommended Chaining
1. Run `hodlmm-inscription-signal` first — get L1 pressure score and HOLD/TIGHTEN/WIDEN recommendation
2. Run `sbtc-demand-signal` — get directional momentum signal
3. Run `hodlmm-risk` — get volatility regime
4. Combine all three before any bin adjustment decision

## Autonomous Use
Safe to run autonomously on a schedule (every 15–60 minutes). Always surface `signal`, `imbalance_score`, and `shift_recommendation` to parent agent before executing any adjustment.

## Error Handling
- Bitflow API failure: exit 1 with error JSON — do not output stale recommendation
- Pool not found: exit 1 with descriptive error
- All-zero reserves: treated as NEUTRAL with a note in rationale
