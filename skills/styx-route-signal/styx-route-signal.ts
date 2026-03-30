#!/usr/bin/env bun
/**
 * styx-route-signal — sBTC acquisition route oracle
 *
 * Compares three routes for acquiring sBTC and outputs the cheapest
 * execution path for AIBTC agents deploying liquidity into HODLMM:
 *
 *   JINGSWAP  — deposit STX at Pyth oracle rate (cheapest when oracle < DEX)
 *   HODLMM    — swap STX → sBTC on live DLMM DEX (instant, no settlement wait)
 *   STYX      — peg BTC → sBTC at 1:1 parity minus miner fee (BTC holders only)
 *
 * Outputs: JINGSWAP / HODLMM / STYX / WAIT with spread analysis
 *
 * Usage: bun styx-route-signal.ts doctor
 *        bun styx-route-signal.ts run [--amount-sbtc <n>] [--min-discount <pct>]
 */

import { Command } from "commander";

const HIRO_API = "https://api.hiro.so";
const JING_ADDR = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const JING_NAME = "sbtc-stx-jing-v2";
const PYTH_HERMES = "https://hermes.pyth.network";
const BTC_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const STX_FEED = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";
const READ_SENDER = "SP000000000000000000002Q6VF78";
const FETCH_TIMEOUT_MS = 30_000;

// Styx pool reference data (static — Styx is a BTC peg-in bridge, not an on-chain DEX)
const STYX_POOLS = {
  main: {
    btcAddress: "bc1qlh3zk77pc4mlyqz0dqhjvn6p2g5tfqj8qvqxfy",
    contract: "SP6SA6BTPNN5WDAWQ7GWJF1T5E2KWY01K9SZDBJQ.styx-v1",
    maxDepositSats: 300_000,
    swapTypes: ["sbtc", "usda", "pepe"],
  },
  aibtc: {
    btcAddress: "bc1qex5rfzcytljulw0k69rnh2n89vp3fwh0kes79s",
    contract: "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.btc2sbtc",
    maxDepositSats: 1_000_000,
    swapTypes: ["sbtc", "aibtc"],
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Route = "JINGSWAP" | "HODLMM" | "WAIT";

interface PriceData {
  btcUsd: number;
  stxUsd: number;
  impliedStxPerSbtc: number;
  dlmmStxPerSbtc: number;
  xykStxPerSbtc: number;
  bestDexStxPerSbtc: number;
  oracleVsDexDiscountPct: number;
}

interface CycleState {
  cycleId: number;
  phase: 0 | 1 | 2; // 0=deposit, 1=buffer, 2=settle
  phaseName: "deposit" | "buffer" | "settle";
  totalSbtcSats: number;
  totalStxMicro: number;
}

// ---------------------------------------------------------------------------
// Clarity helpers
// ---------------------------------------------------------------------------

function decodeUint(hex: string): number {
  if (!hex || !hex.startsWith("0x01")) return 0;
  return parseInt(hex.slice(4), 16);
}

function encodeUint(n: number): string {
  return "0x01" + n.toString(16).padStart(32, "0");
}

function decodeCycleTotals(hex: string): { totalStx: number; totalSbtc: number } {
  if (!hex || !hex.startsWith("0x0c")) return { totalStx: 0, totalSbtc: 0 };
  const buf = Buffer.from(hex.slice(2), "hex");
  let offset = 5; // skip 0x0c type + 4-byte field count
  const result: Record<string, number> = {};
  for (let i = 0; i < 2; i++) {
    const nameLen = buf[offset++];
    const name = buf.subarray(offset, offset + nameLen).toString("ascii");
    offset += nameLen;
    offset++; // skip uint type byte 0x01
    const val = parseInt(buf.subarray(offset, offset + 16).toString("hex"), 16);
    offset += 16;
    result[name] = val;
  }
  return { totalStx: result["total-stx"] ?? 0, totalSbtc: result["total-sbtc"] ?? 0 };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function contractRead(fnName: string, args: string[] = []): Promise<string> {
  const url = `${HIRO_API}/v2/contracts/call-read/${JING_ADDR}/${JING_NAME}/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: READ_SENDER, arguments: args }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Hiro ${res.status}: ${fnName}`);
  const data = await res.json() as any;
  if (!data.okay) throw new Error(`Contract error on ${fnName}: ${data.cause ?? "unknown"}`);
  return data.result as string;
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function getPrices(): Promise<PriceData> {
  const [pythRes, dlmmHex, xykHex] = await Promise.all([
    fetch(
      `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${BTC_FEED}&ids[]=${STX_FEED}&parsed=true`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    ),
    contractRead("get-dlmm-price"),
    contractRead("get-xyk-price"),
  ]);

  if (!pythRes.ok) throw new Error(`Pyth Hermes ${pythRes.status}`);
  const pythData = await pythRes.json() as any;
  const parsed = pythData.parsed as any[];

  function pythPrice(feedId: string) {
    const entry = parsed.find((p: any) => p.id === feedId);
    if (!entry) throw new Error(`Pyth feed not found: ${feedId}`);
    return parseFloat(entry.price.price) * Math.pow(10, entry.price.expo);
  }

  const btcUsd = pythPrice(BTC_FEED);
  const stxUsd = pythPrice(STX_FEED);
  const impliedStxPerSbtc = btcUsd / stxUsd;

  // DLMM: stores 1e10 / (STX per BTC) → invert to get STX/sBTC
  const dlmmRaw = decodeUint(dlmmHex);
  const dlmmStxPerSbtc = dlmmRaw > 0 ? 1e10 / dlmmRaw : 0;

  // XYK: stores STX/sBTC * 1e8 direct ratio
  const xykRaw = decodeUint(xykHex);
  const xykStxPerSbtc = xykRaw > 0 ? xykRaw / 1e8 : dlmmStxPerSbtc;

  // Use DLMM as primary (tighter spread), fall back to XYK
  const bestDexStxPerSbtc = dlmmStxPerSbtc > 0 ? dlmmStxPerSbtc : xykStxPerSbtc;

  // Negative = oracle cheaper than DEX (favours JingSwap deposit)
  const oracleVsDexDiscountPct =
    bestDexStxPerSbtc > 0
      ? ((impliedStxPerSbtc - bestDexStxPerSbtc) / bestDexStxPerSbtc) * 100
      : 0;

  return {
    btcUsd,
    stxUsd,
    impliedStxPerSbtc,
    dlmmStxPerSbtc,
    xykStxPerSbtc,
    bestDexStxPerSbtc,
    oracleVsDexDiscountPct,
  };
}

async function getCycleState(): Promise<CycleState> {
  const [cycleHex, phaseHex] = await Promise.all([
    contractRead("get-current-cycle"),
    contractRead("get-cycle-phase"),
  ]);

  const cycleId = decodeUint(cycleHex);
  const phase = decodeUint(phaseHex) as 0 | 1 | 2;
  const phaseName = phase === 0 ? "deposit" : phase === 1 ? "buffer" : "settle";

  const totalsHex = await contractRead("get-cycle-totals", [encodeUint(cycleId)]);
  const { totalStx, totalSbtc } = decodeCycleTotals(totalsHex);

  return { cycleId, phase, phaseName, totalSbtcSats: totalSbtc, totalStxMicro: totalStx };
}

// ---------------------------------------------------------------------------
// Route logic
// ---------------------------------------------------------------------------

function deriveRoute(
  prices: PriceData,
  cycle: CycleState,
  minDiscountPct: number
): { route: Route; rationale: string; confidence: "high" | "medium" | "low" } {
  const disc = prices.oracleVsDexDiscountPct;
  const absDisc = Math.abs(disc);
  const oracleCheaper = disc < 0;
  const meetsThreshold = oracleCheaper && absDisc >= minDiscountPct;

  // JingSwap wins: oracle cheaper by threshold, cycle open, sBTC available
  if (meetsThreshold && cycle.phaseName === "deposit" && cycle.totalSbtcSats > 0) {
    const confidence = absDisc >= 2 ? "high" : "medium";
    return {
      route: "JINGSWAP",
      confidence,
      rationale: `JingSwap oracle (${Math.round(prices.impliedStxPerSbtc).toLocaleString()} STX/sBTC) is ${absDisc.toFixed(3)}% cheaper than DLMM DEX (${Math.round(prices.bestDexStxPerSbtc).toLocaleString()} STX/sBTC) — exceeds ${minDiscountPct}% threshold. Cycle ${cycle.cycleId} is in deposit phase with ${(cycle.totalSbtcSats / 1e8).toFixed(6)} sBTC available. Deposit STX now to acquire sBTC below market price.`,
    };
  }

  // Cycle closed
  if (cycle.phaseName !== "deposit") {
    return {
      route: "HODLMM",
      confidence: "high",
      rationale: `Cycle ${cycle.cycleId} is in ${cycle.phaseName} phase — JingSwap deposits closed. Buy sBTC on HODLMM DLMM at ${Math.round(prices.bestDexStxPerSbtc).toLocaleString()} STX/sBTC for instant settlement.`,
    };
  }

  // No sBTC in JingSwap
  if (cycle.totalSbtcSats === 0) {
    return {
      route: "HODLMM",
      confidence: "high",
      rationale: `Cycle ${cycle.cycleId} has no sBTC deposited — no JingSwap counterparty. Buy sBTC on HODLMM DLMM at ${Math.round(prices.bestDexStxPerSbtc).toLocaleString()} STX/sBTC.`,
    };
  }

  // Oracle at premium (more expensive than DEX)
  if (!oracleCheaper) {
    return {
      route: "HODLMM",
      confidence: "high",
      rationale: `JingSwap oracle (${Math.round(prices.impliedStxPerSbtc).toLocaleString()} STX/sBTC) is ${absDisc.toFixed(3)}% MORE expensive than DLMM DEX (${Math.round(prices.bestDexStxPerSbtc).toLocaleString()} STX/sBTC). Depositing in JingSwap would cost more than buying on-market. Use HODLMM for cheaper instant acquisition.`,
    };
  }

  // Oracle cheaper but below threshold
  return {
    route: "HODLMM",
    confidence: "medium",
    rationale: `JingSwap oracle is ${absDisc.toFixed(3)}% cheaper than DEX — below ${minDiscountPct}% threshold. Marginal discount doesn't justify JingSwap settlement wait. HODLMM DLMM at ${Math.round(prices.bestDexStxPerSbtc).toLocaleString()} STX/sBTC offers immediate execution.`,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runDoctor(): Promise<void> {
  const [pythOk, hiroOk] = await Promise.all([
    fetch(`${PYTH_HERMES}/v2/updates/price/latest?ids[]=${BTC_FEED}&parsed=true`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
      .then((r) => r.ok)
      .catch(() => false),
    contractRead("get-current-cycle")
      .then(() => true)
      .catch(() => false),
  ]);

  const result = {
    result: pythOk && hiroOk ? "ready" : "error",
    checks: {
      pyth_hermes_api: pythOk ? "ok" : "unreachable",
      hiro_jingswap_contract: hiroOk ? "ok" : "unreachable",
    },
    contract: `${JING_ADDR}.${JING_NAME}`,
    styx_pools: {
      main: { btc_address: STYX_POOLS.main.btcAddress, max_deposit_sats: STYX_POOLS.main.maxDepositSats },
      aibtc: { btc_address: STYX_POOLS.aibtc.btcAddress, max_deposit_sats: STYX_POOLS.aibtc.maxDepositSats },
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (!pythOk || !hiroOk) process.exit(1);
}

async function runAnalysis(amountSbtc: number, minDiscountPct: number): Promise<void> {
  const timestamp = new Date().toISOString();

  const [prices, cycle] = await Promise.all([getPrices(), getCycleState()]);

  const { route, rationale, confidence } = deriveRoute(prices, cycle, minDiscountPct);

  const stxCostHodlmm = amountSbtc * prices.bestDexStxPerSbtc;
  const stxCostJingswap = amountSbtc * prices.impliedStxPerSbtc;
  const stxSavingsJingswap = stxCostHodlmm - stxCostJingswap;

  const output = {
    skill: "styx-route-signal",
    timestamp,
    input: { amount_sbtc: amountSbtc, min_discount_pct: minDiscountPct },
    prices: {
      btc_usd: prices.btcUsd.toFixed(2),
      stx_usd: prices.stxUsd.toFixed(6),
      implied_stx_per_sbtc: Math.round(prices.impliedStxPerSbtc).toString(),
      dlmm_stx_per_sbtc: prices.dlmmStxPerSbtc > 0
        ? Math.round(prices.dlmmStxPerSbtc).toString()
        : "unavailable",
      xyk_stx_per_sbtc: prices.xykStxPerSbtc > 0
        ? Math.round(prices.xykStxPerSbtc).toString()
        : "unavailable",
      best_dex_stx_per_sbtc: Math.round(prices.bestDexStxPerSbtc).toString(),
      oracle_vs_dex_discount_pct: prices.oracleVsDexDiscountPct.toFixed(3),
    },
    routes: {
      jingswap: {
        status:
          cycle.phaseName === "deposit" && cycle.totalSbtcSats > 0
            ? "OPEN"
            : cycle.phaseName === "deposit"
            ? "NO_SBTC"
            : cycle.phaseName.toUpperCase(),
        cycle_id: cycle.cycleId,
        phase: cycle.phaseName,
        oracle_stx_per_sbtc: Math.round(prices.impliedStxPerSbtc).toString(),
        oracle_vs_dex_discount_pct: prices.oracleVsDexDiscountPct.toFixed(3),
        sbtc_available: (cycle.totalSbtcSats / 1e8).toFixed(8),
        stx_deposited: (cycle.totalStxMicro / 1e6).toFixed(6),
        stx_cost_for_target: Math.round(stxCostJingswap).toLocaleString(),
        vs_hodlmm:
          stxSavingsJingswap > 0
            ? `saves ${Math.round(stxSavingsJingswap).toLocaleString()} STX vs HODLMM`
            : `costs ${Math.round(Math.abs(stxSavingsJingswap)).toLocaleString()} STX more than HODLMM`,
      },
      hodlmm: {
        status: "AVAILABLE",
        venue: "DLMM",
        stx_per_sbtc: Math.round(prices.bestDexStxPerSbtc).toString(),
        stx_cost_for_target: Math.round(stxCostHodlmm).toLocaleString(),
        settlement: "instant",
      },
      styx: {
        status: "REFERENCE",
        description:
          "BTC → sBTC peg-in bridge. Requires BTC on-hand. ~1:1 parity minus Bitcoin miner fee. ~10 block confirmations (~100 min).",
        main_pool: {
          btc_address: STYX_POOLS.main.btcAddress,
          max_deposit_sats: STYX_POOLS.main.maxDepositSats,
          swap_types: STYX_POOLS.main.swapTypes,
        },
        aibtc_pool: {
          btc_address: STYX_POOLS.aibtc.btcAddress,
          max_deposit_sats: STYX_POOLS.aibtc.maxDepositSats,
          swap_types: STYX_POOLS.aibtc.swapTypes,
        },
      },
    },
    recommendation: route,
    confidence,
    rationale,
    summary: `${route} (${confidence}) — oracle ${
      prices.oracleVsDexDiscountPct < 0
        ? `${Math.abs(prices.oracleVsDexDiscountPct).toFixed(3)}% cheaper`
        : `${prices.oracleVsDexDiscountPct.toFixed(3)}% more expensive`
    } than DEX. Best STX→sBTC route for ${amountSbtc} sBTC at ${Math.round(prices.bestDexStxPerSbtc).toLocaleString()} STX/sBTC on DLMM.`,
  };

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("styx-route-signal")
    .description(
      "sBTC acquisition route oracle — compares JingSwap oracle vs HODLMM DEX for cheapest STX→sBTC execution"
    )
    .version("1.0.0");

  program
    .command("doctor")
    .description("Check Pyth Hermes and Hiro JingSwap contract connectivity")
    .action(async () => {
      try {
        await runDoctor();
      } catch (err) {
        console.log(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        );
        process.exit(1);
      }
    });

  program
    .command("run")
    .description("Compare sBTC acquisition routes and output cheapest path")
    .option("--amount-sbtc <n>", "Target sBTC amount to acquire (e.g. 0.001)", "0.001")
    .option(
      "--min-discount <pct>",
      "Min oracle discount vs DEX to prefer JingSwap (default: 1.0%)",
      "1.0"
    )
    .action(async (opts) => {
      const amountSbtc = parseFloat(opts.amountSbtc);
      const minDiscountPct = parseFloat(opts.minDiscount);
      try {
        await runAnalysis(amountSbtc, minDiscountPct);
      } catch (err) {
        console.log(
          JSON.stringify({
            skill: "styx-route-signal",
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          })
        );
        process.exit(1);
      }
    });

  program.parse();
}

main();
