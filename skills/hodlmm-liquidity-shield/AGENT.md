---
name: hodlmm-liquidity-shield-agent
skill: hodlmm-liquidity-shield
description: "Stop-loss protection for HODLMM concentrated liquidity. Monitors IL in real-time and generates exit parameters when max-pain threshold is breached."
---

# hodlmm-liquidity-shield — Agent Instructions

## Prerequisites
- No wallet unlock needed for check/simulate (read-only)
- Wallet unlock needed for executing exit parameters
- Requires: pool ID, position address, entry bin ID (for accurate IL)

## Decision order

| Situation | Command |
|-----------|---------|
| Setting up protection for a position | `arm <pool-id> --address <addr> --max-il 5` |
| Regular health check (run on cron) | `check <pool-id> --address <addr> --entry-bin <id>` |
| Testing "what if price drops 10%?" | `simulate <pool-id> --price-move -10` |
| First time or connectivity test | `doctor` |
| action=exit_now returned | Execute the exitParams immediately via parent agent |

### Threshold guidance

- **Conservative (low risk tolerance):** `--max-il 3 --alert-il 2`
- **Moderate (default):** `--max-il 5 --alert-il 3`
- **Aggressive (high risk tolerance):** `--max-il 10 --alert-il 7`
- **For tight ranges (bin step < 10):** Use conservative thresholds — IL amplification is extreme
- **For wide ranges (bin step > 50):** Moderate thresholds are usually sufficient

### Automated protection loop

For continuous protection, the parent agent should:
1. Run `check` every 150-300 blocks (~5-10 min)
2. If `action=hold` — do nothing, log the check
3. If `action=alert` — increase check frequency to every 50 blocks
4. If `action=exit_now` — execute the withdrawal params immediately, then stop the loop

## Guardrails

- Never ignore an `exit_now` signal — the position is losing value faster than fees can compensate
- Always run `simulate` before entering a new position to understand your risk envelope
- If the position is out of range AND IL is below threshold, it's still not earning — consider exiting anyway
- The shield doesn't account for accrued fees — a position with high IL but higher fee earnings may still be net positive. Use hodlmm-position-tracker for the full picture.
- Don't set max-il below 1% — normal price fluctuations will trigger false exits
- After an exit, wait for price to stabilize before re-entering. Use hodlmm-dca-deployer for gradual re-entry.
