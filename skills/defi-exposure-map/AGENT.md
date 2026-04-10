# defi-exposure-map — Agent Instructions

## Prerequisites
- No wallet unlock needed (read-only)
- Requires a Stacks address to scan

## Decision Logic

| Situation | Command |
|-----------|---------|
| See all DeFi positions at once | `scan <stx-address>` |
| Assess concentration and correlation risk | `risk <stx-address>` |
| Quick total balance check | `summary` |

## When to Use
- Before making any DeFi allocation decision
- After market moves to check total exposure
- Weekly portfolio review
- Before adding a new protocol position — check existing concentration

## Output Handling
- `total_exposure_sats` is the headline number
- `by_protocol` breaks down where capital is deployed
- `risk.concentration` flags if >50% is in one protocol
- `risk.sbtc_peg_exposure` shows total sats at risk from an sBTC depeg
