#!/usr/bin/env bun
/**
 * sbtc-bridge-router — Optimal BTC→sBTC routing across Styx pools and direct peg-in
 *
 * Three paths. One answer. Route smart.
 *
 * Usage:
 *   bun sbtc-bridge-router/sbtc-bridge-router.ts route <amount-sats>
 *   bun sbtc-bridge-router/sbtc-bridge-router.ts compare
 *   bun sbtc-bridge-router/sbtc-bridge-router.ts split <amount-sats>
 *   bun sbtc-bridge-router/sbtc-bridge-router.ts doctor
 */

import { Command } from "commander";

const STYX_API = "https://app.styx.so/api";
const FETCH_TIMEOUT_MS = 15_000;

// Pool constraints from Styx documentation
const POOLS = {
  main: { id: "main", name: "Styx Legacy Pool", minDeposit: 10_000, maxDeposit: 400_000, swapTypes: ["sbtc", "usda", "pepe"] },
  aibtc: { id: "aibtc", name: "Styx AI BTC Pool", minDeposit: 10_000, maxDeposit: 1_000_000, swapTypes: ["sbtc", "aibtc"] },
} as const;

const DIRECT_PEGIN = {
  name: "Direct sBTC Peg-In",
  minDeposit: 1,
  maxDeposit: Infinity,
  maxSignerFee: 80_000,
  estimatedBlocks: 6, // ~60 min for Bitcoin confirmations
  reclaimLockTime: 950,
};

interface PoolStatus {
  pool: string;
  realAvailable: number;
  estimatedAvailable: number;
  lastUpdated: number;
}

interface StyxFees {
  low: number;
  medium: number;
  high: number;
}

interface RouteOption {
  path: string;
  pool: string | null;
  amount: number;
  available: number;
  coverage: number;
  confidence: "high" | "medium" | "low" | "insufficient";
  fee_sat_vb: number;
  estimated_time: string;
  can_execute: boolean;
  reason?: string;
  mcp_tool: string;
  mcp_params: Record<string, unknown>;
}

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

async function getPoolStatus(pool: "main" | "aibtc"): Promise<PoolStatus> {
  return fetchJson<PoolStatus>(`${STYX_API}/pool-status?pool=${pool}`);
}

async function getFees(): Promise<StyxFees> {
  return fetchJson<StyxFees>(`${STYX_API}/fees`);
}

function confidence(amount: number, available: number): RouteOption["confidence"] {
  if (available <= 0 || amount > available) return "insufficient";
  const ratio = available / amount;
  if (ratio >= 5) return "high";
  if (ratio >= 2) return "medium";
  return "low";
}

function buildRoute(
  amount: number,
  poolKey: "main" | "aibtc",
  status: PoolStatus,
  fees: StyxFees
): RouteOption {
  const pool = POOLS[poolKey];
  const available = status.estimatedAvailable;

  if (amount < pool.minDeposit) {
    return {
      path: "styx", pool: poolKey, amount, available,
      coverage: 0, confidence: "insufficient",
      fee_sat_vb: fees.medium, estimated_time: "~5 min",
      can_execute: false,
      reason: `Below minimum deposit (${pool.minDeposit.toLocaleString()} sats)`,
      mcp_tool: "styx_deposit", mcp_params: { amount, pool: poolKey },
    };
  }

  if (amount > pool.maxDeposit) {
    return {
      path: "styx", pool: poolKey, amount, available,
      coverage: pool.maxDeposit / amount, confidence: "insufficient",
      fee_sat_vb: fees.medium, estimated_time: "~5 min",
      can_execute: false,
      reason: `Exceeds max deposit (${pool.maxDeposit.toLocaleString()} sats). Max: ${pool.maxDeposit.toLocaleString()}`,
      mcp_tool: "styx_deposit", mcp_params: { amount: pool.maxDeposit, pool: poolKey },
    };
  }

  const conf = confidence(amount, available);
  return {
    path: "styx", pool: poolKey, amount, available,
    coverage: Math.min(available / amount, 1),
    confidence: conf,
    fee_sat_vb: fees.medium,
    estimated_time: "~5 min (instant on Stacks after BTC confirm)",
    can_execute: conf !== "insufficient",
    mcp_tool: "styx_deposit",
    mcp_params: { amount, pool: poolKey, fee: "medium" },
  };
}

function buildDirectRoute(amount: number, fees: StyxFees): RouteOption {
  return {
    path: "direct_pegin", pool: null, amount,
    available: Infinity,
    coverage: 1,
    confidence: "high",
    fee_sat_vb: fees.medium,
    estimated_time: "~60-90 min (6 BTC confirmations + signer processing)",
    can_execute: true,
    reason: amount > 0 ? undefined : "Amount must be > 0",
    mcp_tool: "sbtc_deposit",
    mcp_params: { amount, feeRate: "medium" },
  };
}

// ─── Program ─────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("sbtc-bridge-router")
  .description("Optimal BTC→sBTC routing across Styx pools and direct peg-in. Three paths. One answer.")
  .version("1.0.0");

// ─── route ───────────────────────────────────────────────────────────────────

program
  .command("route <amount-sats>")
  .description("Find the optimal BTC→sBTC path for a specific amount.")
  .action(async (amountStr: string) => {
    try {
      const amount = parseInt(amountStr, 10);
      if (isNaN(amount) || amount <= 0) fail("Amount must be a positive integer (sats)");

      const [mainStatus, aibtcStatus, fees] = await Promise.all([
        getPoolStatus("main"),
        getPoolStatus("aibtc"),
        getFees(),
      ]);

      const routes: RouteOption[] = [
        buildRoute(amount, "main", mainStatus, fees),
        buildRoute(amount, "aibtc", aibtcStatus, fees),
        buildDirectRoute(amount, fees),
      ];

      // Pick best: prefer Styx (faster) if available with medium+ confidence
      const executable = routes.filter((r) => r.can_execute);
      const styxOptions = executable.filter((r) => r.path === "styx");
      const bestStyx = styxOptions.sort((a, b) => {
        const confOrder = { high: 3, medium: 2, low: 1, insufficient: 0 };
        return confOrder[b.confidence] - confOrder[a.confidence];
      })[0];

      const recommended = bestStyx && bestStyx.confidence !== "low"
        ? bestStyx
        : executable.find((r) => r.path === "direct_pegin") ?? executable[0];

      out({
        skill: "sbtc-bridge-router",
        command: "route",
        amount_sats: amount,
        recommended: recommended ? {
          path: recommended.path,
          pool: recommended.pool,
          confidence: recommended.confidence,
          estimated_time: recommended.estimated_time,
          execute_with: recommended.mcp_tool,
          params: recommended.mcp_params,
        } : null,
        all_routes: routes.map((r) => ({
          path: r.path,
          pool: r.pool,
          can_execute: r.can_execute,
          confidence: r.confidence,
          available_sats: r.available === Infinity ? "unlimited" : r.available,
          coverage: r.coverage === 1 ? "full" : `${Math.round(r.coverage * 100)}%`,
          estimated_time: r.estimated_time,
          reason: r.reason,
        })),
        fees: { low: fees.low, medium: fees.medium, high: fees.high, unit: "sat/vB" },
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── compare ─────────────────────────────────────────────────────────────────

program
  .command("compare")
  .description("Side-by-side comparison of all BTC→sBTC paths — liquidity, limits, speed, fees.")
  .action(async () => {
    try {
      const [mainStatus, aibtcStatus, fees] = await Promise.all([
        getPoolStatus("main"),
        getPoolStatus("aibtc"),
        getFees(),
      ]);

      const mainLiqGap = mainStatus.realAvailable - mainStatus.estimatedAvailable;
      const aibtcLiqGap = aibtcStatus.realAvailable - aibtcStatus.estimatedAvailable;

      out({
        skill: "sbtc-bridge-router",
        command: "compare",
        paths: [
          {
            name: POOLS.main.name,
            pool: "main",
            min_deposit: POOLS.main.minDeposit,
            max_deposit: POOLS.main.maxDeposit,
            real_available: mainStatus.realAvailable,
            estimated_available: mainStatus.estimatedAvailable,
            liquidity_gap: mainLiqGap,
            liquidity_gap_pct: `${Math.round((mainLiqGap / mainStatus.realAvailable) * 100)}%`,
            speed: "~5 min",
            swap_types: POOLS.main.swapTypes,
            last_updated: new Date(mainStatus.lastUpdated).toISOString(),
          },
          {
            name: POOLS.aibtc.name,
            pool: "aibtc",
            min_deposit: POOLS.aibtc.minDeposit,
            max_deposit: POOLS.aibtc.maxDeposit,
            real_available: aibtcStatus.realAvailable,
            estimated_available: aibtcStatus.estimatedAvailable,
            liquidity_gap: aibtcLiqGap,
            liquidity_gap_pct: `${Math.round((aibtcLiqGap / aibtcStatus.realAvailable) * 100)}%`,
            speed: "~5 min",
            swap_types: POOLS.aibtc.swapTypes,
            last_updated: new Date(aibtcStatus.lastUpdated).toISOString(),
          },
          {
            name: DIRECT_PEGIN.name,
            pool: null,
            min_deposit: 1,
            max_deposit: "unlimited",
            real_available: "unlimited",
            estimated_available: "unlimited",
            liquidity_gap: 0,
            liquidity_gap_pct: "0%",
            speed: "~60-90 min",
            swap_types: ["sbtc"],
            max_signer_fee: DIRECT_PEGIN.maxSignerFee,
            reclaim_lock_blocks: DIRECT_PEGIN.reclaimLockTime,
          },
        ],
        fees: { low: fees.low, medium: fees.medium, high: fees.high, unit: "sat/vB" },
        note: "estimated_available is the conservative number — use it for routing decisions. liquidity_gap shows reserved/pending deposits not yet settled.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── split ───────────────────────────────────────────────────────────────────

program
  .command("split <amount-sats>")
  .description("Multi-pool routing for large amounts — split across Styx pools and direct peg-in.")
  .action(async (amountStr: string) => {
    try {
      const amount = parseInt(amountStr, 10);
      if (isNaN(amount) || amount <= 0) fail("Amount must be a positive integer (sats)");

      const [mainStatus, aibtcStatus, fees] = await Promise.all([
        getPoolStatus("main"),
        getPoolStatus("aibtc"),
        getFees(),
      ]);

      const legs: Array<{ path: string; pool: string | null; amount: number; mcp_tool: string; mcp_params: Record<string, unknown> }> = [];
      let remaining = amount;

      // Allocate to aibtc first (higher max, AI-powered)
      const aibtcMax = Math.min(remaining, POOLS.aibtc.maxDeposit, aibtcStatus.estimatedAvailable);
      if (aibtcMax >= POOLS.aibtc.minDeposit) {
        legs.push({
          path: "styx", pool: "aibtc", amount: aibtcMax,
          mcp_tool: "styx_deposit", mcp_params: { amount: aibtcMax, pool: "aibtc", fee: "medium" },
        });
        remaining -= aibtcMax;
      }

      // Then main pool
      if (remaining > 0) {
        const mainMax = Math.min(remaining, POOLS.main.maxDeposit, mainStatus.estimatedAvailable);
        if (mainMax >= POOLS.main.minDeposit) {
          legs.push({
            path: "styx", pool: "main", amount: mainMax,
            mcp_tool: "styx_deposit", mcp_params: { amount: mainMax, pool: "main", fee: "medium" },
          });
          remaining -= mainMax;
        }
      }

      // Remainder via direct peg-in
      if (remaining > 0) {
        legs.push({
          path: "direct_pegin", pool: null, amount: remaining,
          mcp_tool: "sbtc_deposit", mcp_params: { amount: remaining, feeRate: "medium" },
        });
        remaining = 0;
      }

      const styxTotal = legs.filter((l) => l.path === "styx").reduce((s, l) => s + l.amount, 0);
      const directTotal = legs.filter((l) => l.path === "direct_pegin").reduce((s, l) => s + l.amount, 0);

      out({
        skill: "sbtc-bridge-router",
        command: "split",
        total_amount: amount,
        legs,
        summary: {
          num_legs: legs.length,
          via_styx: styxTotal,
          via_direct: directTotal,
          styx_pct: `${Math.round((styxTotal / amount) * 100)}%`,
          direct_pct: `${Math.round((directTotal / amount) * 100)}%`,
          estimated_time: directTotal > 0
            ? "~60-90 min (limited by direct peg-in leg)"
            : "~5 min (all via Styx)",
        },
        note: directTotal > 0
          ? "Split includes a direct peg-in leg which is slower. Execute Styx legs first for immediate partial sBTC."
          : "Entire amount routable via Styx — fast execution.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── doctor ──────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check all BTC→sBTC path availability — API health, pool status, fee estimates.")
  .action(async () => {
    try {
      const checks: Record<string, { status: string; detail?: string }> = {};

      try {
        const main = await getPoolStatus("main");
        checks.styx_main = { status: "ok", detail: `${main.estimatedAvailable.toLocaleString()} sats available` };
      } catch {
        checks.styx_main = { status: "unreachable" };
      }

      try {
        const aibtc = await getPoolStatus("aibtc");
        checks.styx_aibtc = { status: "ok", detail: `${aibtc.estimatedAvailable.toLocaleString()} sats available` };
      } catch {
        checks.styx_aibtc = { status: "unreachable" };
      }

      try {
        const fees = await getFees();
        checks.styx_fees = { status: "ok", detail: `low=${fees.low}, med=${fees.medium}, high=${fees.high} sat/vB` };
      } catch {
        checks.styx_fees = { status: "unreachable" };
      }

      checks.direct_pegin = { status: "ok", detail: "Always available via sbtc_deposit MCP tool" };

      const allOk = Object.values(checks).every((c) => c.status === "ok");

      out({
        skill: "sbtc-bridge-router",
        command: "doctor",
        result: allOk ? "ready" : "degraded",
        checks,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

program.parse(process.argv);
