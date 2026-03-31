#!/usr/bin/env bun
/**
 * ordinals-p2p-exchange — Agent-to-agent Bitcoin ordinals P2P marketplace
 *
 * Browse the AIBTC P2P trade ledger, inspect individual trades, and prepare
 * offer/counter/cancel/accept payloads for parent agent execution via the
 * aibtc MCP ordinals_p2p_* tools.
 *
 * Read-only commands (browse, inspect, agents) call ledger.drx4.xyz directly —
 * no wallet required. Write commands output MCP execution payloads — parent
 * agent confirms before calling the relevant MCP tool.
 *
 * Usage:
 *   bun ordinals-p2p-exchange/ordinals-p2p-exchange.ts browse [--limit N] [--agent <addr>] [--inscription <id>]
 *   bun ordinals-p2p-exchange/ordinals-p2p-exchange.ts inspect <trade-id>
 *   bun ordinals-p2p-exchange/ordinals-p2p-exchange.ts agents [--limit N]
 *   bun ordinals-p2p-exchange/ordinals-p2p-exchange.ts offer --inscription <id> [--price <sats>] [--to <addr>] [--note <text>]
 *   bun ordinals-p2p-exchange/ordinals-p2p-exchange.ts counter --trade-id <N> --inscription <id> --price <sats>
 *   bun ordinals-p2p-exchange/ordinals-p2p-exchange.ts cancel --trade-id <N> --inscription <id>
 *   bun ordinals-p2p-exchange/ordinals-p2p-exchange.ts accept --trade-id <N> --inscription <id> --price <sats> --to <addr> --tx-hash <hash>
 */

import { Command } from "commander";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEDGER_API = "https://ledger.drx4.xyz/api";
const FETCH_TIMEOUT_MS = 15_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Trade {
  id: number;
  type: "offer" | "counter" | "transfer" | "cancel" | "psbt_swap";
  from_agent: string;
  to_agent: string | null;
  inscription_id: string;
  amount_sats: number | null;
  status: "open" | "completed" | "cancelled" | "countered";
  tx_hash: string | null;
  parent_trade_id: number | null;
  metadata: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  from_name: string | null;
  to_name: string | null;
  from_stx?: string;
  to_stx?: string;
}

interface TradesResponse {
  trades: Trade[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
}

interface TradeResponse {
  trade: Trade;
  related: Trade[];
}

interface Agent {
  btc_address: string;
  stx_address: string;
  display_name: string | null;
  first_seen: string;
  trade_count: number;
  taproot_address: string | null;
}

interface AgentsResponse {
  agents: Agent[];
  pagination: { total: number; limit: number; offset: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Ledger API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: unknown): never {
  console.log(JSON.stringify({ error: String(message) }, null, 2));
  process.exit(1);
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("ordinals-p2p-exchange")
  .description(
    "AIBTC agent-to-agent ordinals P2P marketplace — browse open offers, inspect trades, prepare execution payloads"
  )
  .version("1.0.0");

// ─── browse ───────────────────────────────────────────────────────────────────

program
  .command("browse")
  .description("List open offers on the P2P ledger. Read-only — no wallet required.")
  .option("--limit <n>", "Max results (default: 20)", "20")
  .option("--agent <addr>", "Filter by seller/buyer BTC address")
  .option("--inscription <id>", "Filter by inscription ID")
  .action(async (opts: { limit: string; agent?: string; inscription?: string }) => {
    try {
      const params = new URLSearchParams({ status: "open", type: "offer", limit: opts.limit, offset: "0" });
      if (opts.agent) params.set("agent", opts.agent);
      if (opts.inscription) params.set("inscription_id", opts.inscription);
      const data = await fetchJson<TradesResponse>(`${LEDGER_API}/trades?${params}`);
      out({
        skill: "ordinals-p2p-exchange",
        command: "browse",
        timestamp: new Date().toISOString(),
        open_offers: data.pagination.total,
        pagination: data.pagination,
        offers: data.trades.map((t) => ({
          trade_id: t.id,
          inscription_id: t.inscription_id,
          seller: t.from_name ?? t.from_agent,
          seller_btc: t.from_agent,
          buyer: t.to_name ?? t.to_agent ?? "open — any buyer",
          asking_price_sats: t.amount_sats,
          metadata: t.metadata ?? null,
          listed_at: t.created_at,
        })),
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── inspect ─────────────────────────────────────────────────────────────────

program
  .command("inspect <trade-id>")
  .description("Get full details for a single trade including related counters. Read-only.")
  .action(async (tradeId: string) => {
    try {
      const id = parseInt(tradeId, 10);
      if (isNaN(id)) fail("trade-id must be a positive integer");
      const data = await fetchJson<TradeResponse>(`${LEDGER_API}/trades/${id}`);
      out({
        skill: "ordinals-p2p-exchange",
        command: "inspect",
        timestamp: new Date().toISOString(),
        trade: data.trade,
        related_count: data.related.length,
        related: data.related,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── agents ──────────────────────────────────────────────────────────────────

program
  .command("agents")
  .description("List agents active on the P2P ledger sorted by trade count. Read-only.")
  .option("--limit <n>", "Max results (default: 20)", "20")
  .action(async (opts: { limit: string }) => {
    try {
      const data = await fetchJson<AgentsResponse>(`${LEDGER_API}/agents?limit=${opts.limit}`);
      out({
        skill: "ordinals-p2p-exchange",
        command: "agents",
        timestamp: new Date().toISOString(),
        total_agents: data.pagination.total,
        agents: data.agents.map((a) => ({
          display_name: a.display_name,
          btc_address: a.btc_address,
          stx_address: a.stx_address,
          trade_count: a.trade_count,
          taproot_address: a.taproot_address,
          first_seen: a.first_seen,
        })),
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── offer ───────────────────────────────────────────────────────────────────

program
  .command("offer")
  .description(
    "Prepare a listing payload. Outputs OFFER_READY JSON for parent agent to execute via ordinals_p2p_create_offer."
  )
  .requiredOption("--inscription <id>", "Inscription ID to list (e.g. abc123...i0)")
  .option("--price <sats>", "Asking price in satoshis (omit for open negotiation)")
  .option("--to <addr>", "Target buyer BTC address (omit for public listing)")
  .option("--note <text>", "Optional description or terms")
  .action(
    async (opts: { inscription: string; price?: string; to?: string; note?: string }) => {
      try {
        const params: Record<string, unknown> = { inscription_id: opts.inscription };
        if (opts.price !== undefined) {
          const price = parseInt(opts.price, 10);
          if (isNaN(price) || price <= 0) fail("--price must be a positive integer");
          params.asking_price_sats = price;
        }
        if (opts.to) params.to_agent = opts.to;
        if (opts.note) params.metadata = opts.note;
        out({
          skill: "ordinals-p2p-exchange",
          action: "OFFER_READY",
          mcp_tool: "ordinals_p2p_create_offer",
          params,
          instruction:
            "Parent agent: call ordinals_p2p_create_offer with the params above to list this inscription on the ledger. Wallet must be unlocked. Confirm before proceeding.",
        });
      } catch (e) {
        fail(e instanceof Error ? e.message : e);
      }
    }
  );

// ─── counter ─────────────────────────────────────────────────────────────────

program
  .command("counter")
  .description(
    "Prepare a counter-offer payload. Outputs COUNTER_READY JSON for parent agent to execute via ordinals_p2p_counter."
  )
  .requiredOption("--trade-id <n>", "Parent trade ID to counter")
  .requiredOption("--inscription <id>", "Inscription ID (must match the parent trade)")
  .requiredOption("--price <sats>", "Counter-offer price in satoshis")
  .option("--note <text>", "Optional metadata")
  .action(
    async (opts: { tradeId: string; inscription: string; price: string; note?: string }) => {
      try {
        const tradeId = parseInt(opts.tradeId, 10);
        if (isNaN(tradeId) || tradeId <= 0) fail("--trade-id must be a positive integer");
        const price = parseInt(opts.price, 10);
        if (isNaN(price) || price <= 0) fail("--price must be a positive integer");
        const params: Record<string, unknown> = {
          parent_trade_id: tradeId,
          inscription_id: opts.inscription,
          amount_sats: price,
        };
        if (opts.note) params.metadata = opts.note;
        out({
          skill: "ordinals-p2p-exchange",
          action: "COUNTER_READY",
          mcp_tool: "ordinals_p2p_counter",
          params,
          instruction:
            "Parent agent: call ordinals_p2p_counter with the params above to submit this counter-offer. Wallet must be unlocked. Confirm before proceeding.",
        });
      } catch (e) {
        fail(e instanceof Error ? e.message : e);
      }
    }
  );

// ─── cancel ──────────────────────────────────────────────────────────────────

program
  .command("cancel")
  .description(
    "Prepare a cancellation payload. Outputs CANCEL_READY JSON for parent agent to execute via ordinals_p2p_cancel."
  )
  .requiredOption("--trade-id <n>", "Trade ID to cancel")
  .requiredOption("--inscription <id>", "Inscription ID (must match the trade)")
  .option("--note <text>", "Optional reason for cancellation")
  .action(async (opts: { tradeId: string; inscription: string; note?: string }) => {
    try {
      const tradeId = parseInt(opts.tradeId, 10);
      if (isNaN(tradeId) || tradeId <= 0) fail("--trade-id must be a positive integer");
      const params: Record<string, unknown> = {
        parent_trade_id: tradeId,
        inscription_id: opts.inscription,
      };
      if (opts.note) params.metadata = opts.note;
      out({
        skill: "ordinals-p2p-exchange",
        action: "CANCEL_READY",
        mcp_tool: "ordinals_p2p_cancel",
        params,
        instruction:
          "Parent agent: call ordinals_p2p_cancel with the params above to cancel this trade. Wallet must be unlocked. Confirm before proceeding.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── accept ──────────────────────────────────────────────────────────────────

program
  .command("accept")
  .description(
    "Record a completed PSBT swap on the ledger. Outputs SWAP_READY JSON for parent agent to execute via ordinals_p2p_psbt_swap. Call this after the PSBT has been signed and broadcast."
  )
  .requiredOption("--trade-id <n>", "Parent offer trade ID being fulfilled")
  .requiredOption("--inscription <id>", "Inscription ID being swapped")
  .requiredOption("--price <sats>", "Final agreed price in satoshis")
  .requiredOption("--to <addr>", "Buyer BTC address receiving the inscription")
  .requiredOption("--tx-hash <hash>", "Broadcast transaction hash")
  .option("--note <text>", "Optional metadata")
  .action(
    async (opts: {
      tradeId: string;
      inscription: string;
      price: string;
      to: string;
      txHash: string;
      note?: string;
    }) => {
      try {
        const tradeId = parseInt(opts.tradeId, 10);
        if (isNaN(tradeId) || tradeId <= 0) fail("--trade-id must be a positive integer");
        const price = parseInt(opts.price, 10);
        if (isNaN(price) || price <= 0) fail("--price must be a positive integer");
        const params: Record<string, unknown> = {
          parent_trade_id: tradeId,
          inscription_id: opts.inscription,
          amount_sats: price,
          to_agent: opts.to,
          tx_hash: opts.txHash,
        };
        if (opts.note) params.metadata = opts.note;
        out({
          skill: "ordinals-p2p-exchange",
          action: "SWAP_READY",
          mcp_tool: "ordinals_p2p_psbt_swap",
          params,
          instruction:
            "Parent agent: call ordinals_p2p_psbt_swap with the params above to record this completed swap on the ledger. Wallet must be unlocked. Confirm before proceeding.",
        });
      } catch (e) {
        fail(e instanceof Error ? e.message : e);
      }
    }
  );

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse(process.argv);
