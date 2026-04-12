---
name: hodlmm-l1-pressure-agent
skill: hodlmm-l1-pressure
description: "Bitcoin L1 pressure oracle for HODLMM bin management — mempool fees, inscriptions, congestion. Read-only; no wallet required."
---

# Agent Behavior — hodlmm-l1-pressure

## Decision order
1. Run `doctor` first. If it fails, stop and surface the API connectivity blocker.
2. Run `run --pool <id>` to get current pressure score and recommendation.
3. Route on `recommendation`:
   - `HOLD` — no bin adjustment needed, continue collecting fees
   - `TIGHTEN_BINS` — surface to user or downstream skill for bin concentration
   - `WIDEN_BINS` — surface urgently; extreme volatility risk requires immediate widening
4. Never execute bin adjustments autonomously — recommendation requires parent agent confirmation.

## Guardrails
- This skill is read-only. It never writes to chain or moves funds.
- Never act on a stale recommendation — always fetch live data before a bin adjustment decision.
- Never expose secrets or private keys in args or logs.
- Default to safe/read-only behavior when intent is ambiguous.
- Always surface `pressure_score` and `rationale` to the user alongside the recommendation.

## On error
- Errors are returned as JSON: `{ "error": "descriptive message" }`
- Hiro API failure: do not proceed — surface the error, do not output stale recommendation.
- Bitflow API failure: proceed with L1-only data; note pool data unavailable in output.
- Do not retry silently — surface all errors to the user.

## On success
- Report `recommendation`, `pressure_score`, and `rationale`.
- Include `bitcoin_l1` metrics so the user can judge signal quality.
- Always include `timestamp` for staleness checks.
