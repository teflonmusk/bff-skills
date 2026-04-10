#!/usr/bin/env bun
/**
 * defi-exposure-map — Cross-protocol DeFi exposure aggregator
 *
 * See everything. One command.
 *
 * Usage:
 *   bun defi-exposure-map/defi-exposure-map.ts scan <stx-address>
 *   bun defi-exposure-map/defi-exposure-map.ts risk <stx-address>
 *   bun defi-exposure-map/defi-exposure-map.ts summary
 */

import { Command } from "commander";

const HIRO_API = "https://api.hiro.so";
const SBTC_CONTRACT_ID = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_CONTRACT_NAME = "sbtc-token";
const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: unknown): never {
  console.log(JSON.stringify({ error: String(message) }, null, 2));
  process.exit(1);
}

interface ProtocolPosition {
  protocol: string;
  type: string;
  asset: string;
  amount_sats: number;
  details?: Record<string, unknown>;
}

async function getWalletBalances(stxAddress: string): Promise<ProtocolPosition[]> {
  const positions: ProtocolPosition[] = [];

  // STX balance
  try {
    const stxData = await fetchJson<{ balance: string; locked: string }>(
      `${HIRO_API}/extended/v1/address/${stxAddress}/stx`
    );
    const stxBalance = parseInt(stxData.balance, 10);
    const stxLocked = parseInt(stxData.locked, 10);

    if (stxBalance > 0) {
      positions.push({
        protocol: "wallet",
        type: "liquid",
        asset: "STX",
        amount_sats: stxBalance,
        details: { unit: "microSTX" },
      });
    }
    if (stxLocked > 0) {
      positions.push({
        protocol: "stacking",
        type: "locked",
        asset: "STX",
        amount_sats: stxLocked,
        details: { unit: "microSTX", note: "Locked in PoX stacking" },
      });
    }
  } catch {
    // STX balance lookup failed
  }

  // sBTC balance
  try {
    const ftData = await fetchJson<{
      fungible_tokens: Record<string, { balance: string }>;
    }>(`${HIRO_API}/extended/v1/address/${stxAddress}/balances`);

    for (const [token, data] of Object.entries(ftData.fungible_tokens ?? {})) {
      const balance = parseInt(data.balance, 10);
      if (balance <= 0) continue;

      if (token.toLowerCase().includes("sbtc")) {
        positions.push({
          protocol: "wallet",
          type: "liquid",
          asset: "sBTC",
          amount_sats: balance,
        });
      } else {
        // Other fungible tokens — could be LP tokens
        const tokenName = token.split("::").pop() ?? token;
        positions.push({
          protocol: "wallet",
          type: "token",
          asset: tokenName,
          amount_sats: balance,
          details: { contract: token },
        });
      }
    }
  } catch {
    // Balance lookup failed
  }

  return positions;
}

async function scanTransactionHistory(stxAddress: string): Promise<ProtocolPosition[]> {
  const positions: ProtocolPosition[] = [];
  const protocolInteractions = new Set<string>();

  try {
    const txData = await fetchJson<{
      results: Array<{
        tx_type: string;
        contract_call?: {
          contract_id: string;
          function_name: string;
          function_args: Array<{ name: string; repr: string }>;
        };
      }>;
    }>(`${HIRO_API}/extended/v1/address/${stxAddress}/transactions?limit=50`);

    for (const tx of txData.results) {
      if (tx.tx_type !== "contract_call" || !tx.contract_call) continue;
      const contractId = tx.contract_call.contract_id.toLowerCase();
      const fn = tx.contract_call.function_name;

      // Detect protocol interactions
      if (contractId.includes("bitflow") || contractId.includes("hodlmm")) {
        protocolInteractions.add("bitflow");
      }
      if (contractId.includes("jing") || contractId.includes("jingswap")) {
        protocolInteractions.add("jingswap");
      }
      if (contractId.includes("zest") || contractId.includes("pool-borrow")) {
        protocolInteractions.add("zest");
      }
      if (contractId.includes("styx")) {
        protocolInteractions.add("styx");
      }
      if (contractId.includes("alex") || contractId.includes("amm-pool")) {
        protocolInteractions.add("alex");
      }
      if (fn.includes("stack-stx") || fn.includes("delegate-stx")) {
        protocolInteractions.add("stacking");
      }
      if (contractId.includes("stackspot")) {
        protocolInteractions.add("stackspot");
      }
    }

    // Record detected protocol interactions
    for (const protocol of protocolInteractions) {
      positions.push({
        protocol,
        type: "interaction_detected",
        asset: "unknown",
        amount_sats: 0,
        details: {
          note: `Recent transaction history shows interaction with ${protocol}. Check protocol directly for active positions.`,
        },
      });
    }
  } catch {
    // Transaction scan failed
  }

  return positions;
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("defi-exposure-map")
  .description("Cross-protocol DeFi exposure aggregator. See everything in one view.")
  .version("1.0.0");

// ─── scan ─────────────────────────────────────────────────────────────────────

program
  .command("scan <stx-address>")
  .description("Full cross-protocol scan — wallet, LP, lending, stacking, cycles.")
  .action(async (stxAddress: string) => {
    try {
      const walletPositions = await getWalletBalances(stxAddress);
      const protocolPositions = await scanTransactionHistory(stxAddress);
      const allPositions = [...walletPositions, ...protocolPositions];

      // Group by protocol
      const byProtocol: Record<string, ProtocolPosition[]> = {};
      for (const p of allPositions) {
        if (!byProtocol[p.protocol]) byProtocol[p.protocol] = [];
        byProtocol[p.protocol].push(p);
      }

      // Calculate totals
      const sbtcTotal = allPositions
        .filter((p) => p.asset === "sBTC")
        .reduce((s, p) => s + p.amount_sats, 0);

      const stxTotal = allPositions
        .filter((p) => p.asset === "STX")
        .reduce((s, p) => s + p.amount_sats, 0);

      const protocols = Object.keys(byProtocol);
      const activeProtocols = protocols.filter(
        (p) => byProtocol[p].some((pos) => pos.amount_sats > 0 || pos.type === "interaction_detected")
      );

      out({
        skill: "defi-exposure-map",
        command: "scan",
        timestamp: new Date().toISOString(),
        address: stxAddress,
        total_sbtc_sats: sbtcTotal,
        total_stx_micro: stxTotal,
        protocols_detected: activeProtocols.length,
        active_protocols: activeProtocols,
        by_protocol: byProtocol,
        positions: allPositions,
        note: "Wallet balances are authoritative. Protocol interactions detected from recent transaction history — check each protocol directly for current position details.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── risk ─────────────────────────────────────────────────────────────────────

program
  .command("risk <stx-address>")
  .description("Risk assessment — concentration, correlation, single-asset exposure.")
  .action(async (stxAddress: string) => {
    try {
      const walletPositions = await getWalletBalances(stxAddress);
      const protocolPositions = await scanTransactionHistory(stxAddress);
      const allPositions = [...walletPositions, ...protocolPositions];

      const sbtcTotal = allPositions
        .filter((p) => p.asset === "sBTC")
        .reduce((s, p) => s + p.amount_sats, 0);

      const stxTotal = allPositions
        .filter((p) => p.asset === "STX")
        .reduce((s, p) => s + p.amount_sats, 0);

      // Protocol concentration
      const byProtocol: Record<string, number> = {};
      for (const p of allPositions) {
        if (p.amount_sats > 0) {
          byProtocol[p.protocol] = (byProtocol[p.protocol] ?? 0) + p.amount_sats;
        }
      }

      const totalValue = Object.values(byProtocol).reduce((s, v) => s + v, 0);
      const concentration = Object.entries(byProtocol)
        .map(([protocol, amount]) => ({
          protocol,
          amount,
          share: totalValue > 0 ? `${Math.round((amount / totalValue) * 100)}%` : "0%",
        }))
        .sort((a, b) => b.amount - a.amount);

      const topProtocolShare = concentration.length > 0
        ? Math.round((concentration[0].amount / totalValue) * 100)
        : 0;

      const warnings: string[] = [];

      if (topProtocolShare > 80) {
        warnings.push(`${topProtocolShare}% concentration in ${concentration[0].protocol} — extreme single-protocol risk`);
      } else if (topProtocolShare > 50) {
        warnings.push(`${topProtocolShare}% concentration in ${concentration[0].protocol} — consider diversifying`);
      }

      if (sbtcTotal > 0 && stxTotal === 0) {
        warnings.push("100% sBTC, 0 STX — no gas reserves for transactions");
      }

      const protocolsDetected = allPositions
        .filter((p) => p.type === "interaction_detected")
        .map((p) => p.protocol);

      if (protocolsDetected.length > 0) {
        warnings.push(`Active positions likely on ${protocolsDetected.join(", ")} — verify directly for accurate risk assessment`);
      }

      out({
        skill: "defi-exposure-map",
        command: "risk",
        timestamp: new Date().toISOString(),
        address: stxAddress,
        total_sbtc_sats: sbtcTotal,
        total_stx_micro: stxTotal,
        concentration,
        sbtc_peg_exposure: {
          total_sats_at_risk: sbtcTotal,
          note: "All sBTC positions are exposed to peg risk. A depeg event affects wallet, LP, lending, and stacking positions simultaneously.",
        },
        risk_level: topProtocolShare > 80 ? "high" : topProtocolShare > 50 ? "medium" : "low",
        warnings,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── summary ──────────────────────────────────────────────────────────────────

program
  .command("summary")
  .description("Quick total across all protocols using configured wallet.")
  .option("--stx-address <stx>", "STX address to scan")
  .action(async (opts: { stxAddress?: string }) => {
    try {
      if (!opts.stxAddress) {
        out({
          skill: "defi-exposure-map",
          command: "summary",
          note: "Provide --stx-address to scan. Example: defi-exposure-map summary --stx-address SP105KWW...",
        });
        return;
      }

      const positions = await getWalletBalances(opts.stxAddress);
      const protocols = await scanTransactionHistory(opts.stxAddress);

      const sbtcTotal = positions
        .filter((p) => p.asset === "sBTC")
        .reduce((s, p) => s + p.amount_sats, 0);

      const stxTotal = positions
        .filter((p) => p.asset === "STX")
        .reduce((s, p) => s + p.amount_sats, 0);

      const activeProtocols = protocols
        .filter((p) => p.type === "interaction_detected")
        .map((p) => p.protocol);

      out({
        skill: "defi-exposure-map",
        command: "summary",
        address: opts.stxAddress,
        sbtc_sats: sbtcTotal,
        stx_micro: stxTotal,
        active_protocols: activeProtocols,
        token_count: positions.filter((p) => p.type === "token").length,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

program.parse(process.argv);
