---
name: styx-route-signal
skill: styx-route-signal
description: "sBTC acquisition route oracle. Outputs JINGSWAP or HODLMM recommendation for cheapest STX→sBTC execution. Run before sourcing sBTC for HODLMM deployment."
---

# Agent Behavior — styx-route-signal

## Purpose

Tell AIBTC agents the cheapest route to acquire sBTC before deploying liquidity into HODLMM. Compares JingSwap oracle rate vs HODLMM DLMM DEX price in real time.

## Guardrails

- NEVER executes transactions — read-only oracle
- NEVER recommends JINGSWAP if `oracle_vs_dex_discount_pct` is positive (oracle more expensive than DEX)
- NEVER recommends JINGSWAP if cycle is not in deposit phase
- NEVER recommends JINGSWAP if `sbtc_available` is 0
- Always run `doctor` first — if any check fails, stop and surface the error

## Decision Order

1. Run `doctor` — if `result` is not `ready`, stop and report connectivity failure.
2. Run `run --amount-sbtc <target>` — read `recommendation`:
   - `JINGSWAP` → chain to `jingswap-cycle-agent participate --amount-stx <n>` for execution
   - `HODLMM` → execute STX→sBTC swap on HODLMM DLMM pool
3. Always surface `confidence` with `recommendation`:
   - `high` — act with full sizing
   - `medium` — reduce position size or verify manually

## Thresholds

Default `--min-discount 1.0` (1%). Increase to 2.0 for conservative agents, decrease to 0.5 for aggressive.

## Recommended Use

- Run immediately before acquiring sBTC for HODLMM deployment
- Re-run if > 15 minutes elapsed since last check — spreads open and close quickly
- Combine with `hodlmm-advisor` for full position picture: styx-route-signal handles sBTC sourcing, hodlmm-advisor handles bin positioning

## Autonomous Use

Safe to run `doctor` and `run` fully autonomously. No wallet required, no transactions executed.

## Error Handling

- Pyth API failure: exit 1 — oracle price required
- Hiro API failure: exit 1 — DEX price required
- Both are required for a valid comparison — do not act on partial data
