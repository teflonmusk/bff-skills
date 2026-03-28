---
name: hodlmm-advisor-agent
skill: hodlmm-advisor
description: "Composite HODLMM LP action signal. Synthesises L1 pressure, reserve demand direction, and volatility regime into a single action recommendation. Read-only; no wallet required."
---

# Agent Behavior — hodlmm-advisor

## Purpose
Produce a single composite LP position recommendation for a Bitflow HODLMM pool by simultaneously evaluating Bitcoin L1 inscription pressure, sBTC/STX reserve demand direction, and pool volatility regime. Eliminates the need for parent agents to manually reconcile three separate skill outputs.

## Guardrails
- NEVER executes any on-chain transaction
- NEVER moves funds or adjusts bins autonomously
- Output is advisory only — parent agent must confirm before acting on `action`
- Always fetch live data — never cache or reuse stale bin data
- Crisis volatility ALWAYS overrides directional signals — WIDEN fires unconditionally

## Spend Limits
Zero — read-only data aggregation skill.

## Decision Order
1. Run `doctor` first. If either API fails, stop and surface the connectivity error.
2. Run `run --pool <id>` to get composite recommendation.
3. Route on `action`:
   - `WIDEN` — crisis volatility override; surface urgently, widen range immediately
   - `TIGHTEN` — high L1 pressure + elevated volatility; concentrate range now
   - `SHIFT_UP_AGGRESSIVE` — strong upward conviction; shift concentration up aggressively
   - `SHIFT_UP` — moderate upward conviction; shift up cautiously
   - `HOLD` — no dominant signal; collect fees, no position change
   - `SHIFT_DOWN` — moderate downward conviction; shift down cautiously
   - `SHIFT_DOWN_AGGRESSIVE` — strong downward conviction; shift concentration down
4. Always surface `confidence` alongside `action`:
   - `high` — multiple signals agree; act with standard sizing
   - `medium` — primary signal present but partial confirmation; reduce size
   - `low` — signals conflict or volatility elevated; minimal action or wait

## Recommended Use
This skill replaces running all three sub-signals separately. Use it as the primary HODLMM pre-flight check. If a parent agent needs the raw sub-signal breakdown for transparency, the `signals` block in the output contains all three component readings.

## Autonomous Use
Safe to run autonomously on a schedule (every 15–60 minutes). Always surface `action`, `confidence`, `rationale`, and `signals` to parent agent before executing any adjustment.

## Error Handling
- Any API failure: exit 1 with error JSON — do not output stale recommendation
- All-zero bin reserves: treated as NEUTRAL demand, calm volatility
- L1 API failure: L1 pressure defaults to 0 (conservative) — recommendation still valid from pool signals
