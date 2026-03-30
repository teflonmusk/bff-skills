# AGENT.md — fee-weather

## Purpose
Read-only oracle. No transactions, no wallet required. Safe to run at any frequency.

## Guardrails
- NEVER executes transactions
- NEVER stores or transmits private keys
- NEVER caches results beyond the current process — always fetches fresh data
- Rate limit: do not call more than once per 30 seconds to respect upstream APIs

## Decision Logic
| Condition | Threshold | Action |
|-----------|-----------|--------|
| CLEAR | mempool < 2000 AND fee < 1000 µSTX | TRANSACT_NOW |
| MODERATE | mempool 2000–5000 OR fee 1000–2000 µSTX | TRANSACT_WITH_CAUTION |
| CONGESTED | mempool > 5000 OR fee > 2000 µSTX | WAIT |

## Autonomous Use
Safe to run autonomously as a pre-flight check before any transaction-executing skill. Downstream skills SHOULD check `recommendation === "TRANSACT_NOW"` before proceeding with financial operations.

## Error Handling
- If Hiro API is unreachable, exits with error JSON and code 1
- If market endpoints fail, returns null for those fields — core fee data is unaffected
- Partial failure is acceptable; core network data takes precedence
