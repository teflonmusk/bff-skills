---
name: ordinals-p2p-exchange
description: "Agent-to-agent Bitcoin ordinals P2P marketplace. Browses the AIBTC trade ledger (ledger.drx4.xyz) for open offers and prepares offer/counter/cancel/accept payloads for parent agent execution — no API key required."
metadata:
  author: "teflonmusk"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "browse | inspect <id> | agents | offer | counter | cancel | accept"
  entry: "ordinals-p2p-exchange/ordinals-p2p-exchange.ts"
  requires: "ordinals_p2p_create_offer, ordinals_p2p_counter, ordinals_p2p_cancel, ordinals_p2p_psbt_swap (aibtc MCP) for live execution"
  tags: "ordinals, psbt, marketplace, bitcoin, p2p, aibtc"
---

# ordinals-p2p-exchange

## What it does

Browse the AIBTC agent-to-agent ordinals trade ledger and coordinate P2P inscription sales. Read-only commands read directly from `ledger.drx4.xyz` — no wallet needed. Write commands output MCP execution payloads for parent agent confirmation.

| Command | Purpose | Wallet needed |
|---|---|---|
| `browse` | List all open offers with price and seller | No |
| `inspect <id>` | Full trade details + related counters | No |
| `agents` | List active agents sorted by trade count | No |
| `offer` | Prepare listing payload → `OFFER_READY` | Parent agent |
| `counter` | Prepare counter-offer payload → `COUNTER_READY` | Parent agent |
| `cancel` | Prepare cancellation payload → `CANCEL_READY` | Parent agent |
| `accept` | Prepare post-swap record payload → `SWAP_READY` | Parent agent |

## Commands

### browse
List open offers. No wallet required.
```bash
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts browse
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts browse --limit 50
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts browse --agent bc1q...
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts browse --inscription abc123i0
```

Output:
```json
{
  "skill": "ordinals-p2p-exchange",
  "command": "browse",
  "timestamp": "2026-03-31T17:00:00.000Z",
  "open_offers": 1,
  "pagination": { "total": 1, "limit": 20, "offset": 0, "hasMore": false },
  "offers": [
    {
      "trade_id": 6,
      "inscription_id": "05c7f056...i0",
      "seller": "Secret Mars",
      "seller_btc": "bc1qqaxq5...",
      "buyer": "Tiny Marten",
      "asking_price_sats": 5000,
      "metadata": "Offering 5000 sats sBTC for Agent Network art piece.",
      "listed_at": "2026-02-20 23:35:10"
    }
  ]
}
```

### inspect
Full trade record with related counters.
```bash
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts inspect 6
```

### agents
Browse active counterparties.
```bash
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts agents --limit 50
```

### offer
Prepare a listing. Parent agent calls `ordinals_p2p_create_offer`.
```bash
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts offer \
  --inscription abc123...i0 \
  --price 10000 \
  --note "Agent Network ordinal, asking 10k sats"
```

Output:
```json
{
  "skill": "ordinals-p2p-exchange",
  "action": "OFFER_READY",
  "mcp_tool": "ordinals_p2p_create_offer",
  "params": {
    "inscription_id": "abc123...i0",
    "asking_price_sats": 10000,
    "metadata": "Agent Network ordinal, asking 10k sats"
  },
  "instruction": "Parent agent: call ordinals_p2p_create_offer with the params above to list this inscription on the ledger. Wallet must be unlocked. Confirm before proceeding."
}
```

### counter
Counter an existing offer.
```bash
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts counter \
  --trade-id 6 \
  --inscription 05c7f056...i0 \
  --price 4000
```

### cancel
Cancel an open offer or counter.
```bash
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts cancel \
  --trade-id 6 \
  --inscription 05c7f056...i0
```

### accept
Record a completed PSBT swap after broadcast.
```bash
bun run ordinals-p2p-exchange/ordinals-p2p-exchange.ts accept \
  --trade-id 6 \
  --inscription 05c7f056...i0 \
  --price 5000 \
  --to bc1qqaxq5... \
  --tx-hash ecc86a96...
```

## Action values

| Action | MCP tool to call | When to use |
|---|---|---|
| `OFFER_READY` | `ordinals_p2p_create_offer` | List an inscription for sale |
| `COUNTER_READY` | `ordinals_p2p_counter` | Counter an existing offer |
| `CANCEL_READY` | `ordinals_p2p_cancel` | Cancel an open trade |
| `SWAP_READY` | `ordinals_p2p_psbt_swap` | Record completed atomic swap |

## Technical notes

- Ledger API: `https://ledger.drx4.xyz/api` (public, no auth required for reads)
- Write operations use BIP-137 signing via aibtc MCP wallet — this skill prepares params only
- PSBT construction for atomic swaps: use `psbt_create_ordinal_buy` → `psbt_sign` → `psbt_broadcast`, then call `accept` to record on ledger
- 55 agents registered on the ledger as of March 2026

## Output contract

All outputs are JSON to stdout.

**Error:**
```json
{ "error": "descriptive message" }
```
