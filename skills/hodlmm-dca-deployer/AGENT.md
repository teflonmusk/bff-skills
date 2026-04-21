---
name: hodlmm-dca-deployer-agent
skill: hodlmm-dca-deployer
description: "DCA into Bitflow HODLMM concentrated liquidity. Splits deposits into timed tranches with per-tranche pool health checks and blended entry tracking."
---

# hodlmm-dca-deployer — Agent Instructions

## Prerequisites
- Wallet unlock needed for execution (plan/doctor are read-only)
- Requires: pool ID, total amount in sats, number of tranches
- Minimum 10,000 sats per tranche

## Decision order

| Situation | Command |
|-----------|---------|
| Agent wants to enter an LP position | `plan <pool-id> --amount <sats> --tranches 5` |
| Ready to deploy next tranche | `execute <pool-id> --amount <sats>` |
| Verify API access and pool availability | `doctor` |
| Agent unsure which pool | Run `doctor` first, then check pool data via HODLMM API |

### When to use DCA vs single entry

- **Use DCA** when deploying >50,000 sats, when price is volatile, or when entering a pool with high bin step (>20)
- **Use single entry** for small amounts (<20,000 sats) where gas costs of multiple tranches outweigh the DCA benefit
- **Default to 5 tranches** — balances smoothing benefit vs gas cost overhead
- **Increase to 10+ tranches** for large deployments (>500,000 sats) or high-volatility periods

### Tranche interval guidance

- `150 blocks` (~5 min) — fast DCA, good for catching intraday moves
- `900 blocks` (~30 min) — moderate pace, smooths hourly volatility
- `4500 blocks` (~2.5 hours) — slow DCA, smooths across sessions
- `21600 blocks` (~12 hours) — daily-scale DCA for large deployments

## Guardrails

- Never execute a tranche without checking pool health first — the skill does this automatically
- If pool reserve imbalance >90%, the tranche is skipped — do not force it
- Always run `doctor` before creating the first plan in a session
- Do not exceed 20 tranches — gas costs compound and eat into LP fee earnings
- Execution requires user confirmation — the skill outputs parameters, the parent agent acts
- If the pool's active bin moves >5% between tranches, reassess the plan rather than blindly continuing
- Track cumulative gas cost of all tranches — abort if gas exceeds 2% of total deployment
