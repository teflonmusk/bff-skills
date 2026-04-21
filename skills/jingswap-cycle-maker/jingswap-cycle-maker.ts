#!/usr/bin/env bun
/**
 * jingswap-cycle-maker — Automated market making on JingSwap auction cycles
 *
 * JingSwap runs batch auctions: depositors place sBTC and STX on opposite sides,
 * deposits close, oracle sets the price, settlement distributes pro-rata.
 * This skill automates the full lifecycle: scan for opportunities, deposit,
 * close deposits when ready, and settle.
 *
 * Usage:
 *   bun jingswap-cycle-maker/jingswap-cycle-maker.ts scan [--market sbtc-stx]
 *   bun jingswap-cycle-maker/jingswap-cycle-maker.ts deposit --side <sbtc|stx> --amount <n> [--market sbtc-stx]
 *   bun jingswap-cycle-maker/jingswap-cycle-maker.ts close [--market sbtc-stx]
 *   bun jingswap-cycle-maker/jingswap-cycle-maker.ts settle [--market sbtc-stx]
 *   bun jingswap-cycle-maker/jingswap-cycle-maker.ts auto --side <sbtc|stx> --amount <n> [--market sbtc-stx]
 *   bun jingswap-cycle-maker/jingswap-cycle-maker.ts history [--market sbtc-stx] [--cycles 5]
 *   bun jingswap-cycle-maker/jingswap-cycle-maker.ts doctor
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.mainnet.hiro.so";
const DEPOSIT_MIN_BLOCKS = 150;
const BUFFER_BLOCKS = 30;
const CANCEL_THRESHOLD = 500;
// ── Helpers ────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.log(JSON.stringify({ status: "error", error: { code: "EXECUTION_ERROR", message } }, null, 2));
  process.exit(1);
}

function ok(data: Record<string, unknown>): void {
  console.log(JSON.stringify({ status: "success", data }, null, 2));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

// ── Commands ───────────────────────────────────────────────────────────

async function scan(opts: { market: string }): Promise<void> {
  const market = opts.market || "sbtc-stx";

  // Get cycle state and prices — output MCP tool calls for parent agent
  const opportunity: Record<string, unknown> = {
    description: "Scan analyzes the current JingSwap cycle and recommends actions.",
    mcpCalls: [
      {
        tool: "jingswap_get_cycle_state",
        params: { market },
        purpose: "Get current cycle phase, totals, and block elapsed",
      },
      {
        tool: "jingswap_get_prices",
        params: { market },
        purpose: "Get oracle and DEX prices for opportunity analysis",
      },
    ],
    analysisLogic: {
      step1: "Check phase: 0=deposit (can deposit), 1=buffer (wait), 2=settle (can settle)",
      step2: "Check imbalance: if one side is 0, that side is the opportunity",
      step3: "Compare oracle vs DEX price — divergence >1% = arbitrage potential",
      step4: "Check if deposits can be closed: phase=0, blocksElapsed>=150, both sides meet minimums",
      step5: "Generate recommendation: deposit on thin side, close if ready, settle if buffer complete",
    },
    thresholds: {
      minSbtcSats: 1000,
      minStxMicro: 1_000_000,
      depositMinBlocks: DEPOSIT_MIN_BLOCKS,
      bufferBlocks: BUFFER_BLOCKS,
      priceDivergenceAlert: 0.01,
    },
  };

  // Try to get live data for immediate analysis
  try {
    const stateUrl = `${HIRO_API}/v2/info`;
    const info = await fetchJson<{ stacks_tip_height: number; burn_block_height: number }>(stateUrl);

    opportunity.liveContext = {
      stacksHeight: info.stacks_tip_height,
      burnHeight: info.burn_block_height,
      note: "Use jingswap_get_cycle_state and jingswap_get_prices MCP tools for full analysis",
    };
  } catch {
    opportunity.liveContext = { note: "Could not reach Hiro API — use MCP tools directly" };
  }

  ok(opportunity);
}

async function deposit(opts: { side: string; amount: string; market: string }): Promise<void> {
  const market = opts.market || "sbtc-stx";
  const side = opts.side?.toLowerCase();
  const amount = parseFloat(opts.amount);

  if (!side || !["sbtc", "stx"].includes(side)) {
    fail("--side must be 'sbtc' or 'stx'");
  }
  if (!amount || amount <= 0) {
    fail("--amount must be a positive number");
  }

  // Validate against minimums
  if (side === "sbtc" && amount < 1000) {
    fail(`Minimum sBTC deposit is 1000 sats. Got: ${amount}`);
  }
  if (side === "stx" && amount < 1) {
    fail(`Minimum STX deposit is 1 STX. Got: ${amount}`);
  }

  const action = side === "sbtc"
    ? {
        tool: "jingswap_deposit_sbtc",
        params: { amount: Math.floor(amount), market },
        description: `Deposit ${amount} sats sBTC into cycle on ${market} market`,
        preCheck: "Verify phase=0 (deposit) via jingswap_get_cycle_state first",
      }
    : {
        tool: "jingswap_deposit_stx",
        // Convert whole STX to micro-STX (1 STX = 1,000,000 micro-STX) — Stacks contracts expect micro-STX
        params: { amount: Math.round(amount * 1_000_000), market },
        description: `Deposit ${amount} STX (${Math.round(amount * 1_000_000)} micro-STX) into cycle on ${market} market`,
        preCheck: "Verify phase=0 (deposit) AND check oracle vs DEX price divergence <2% via jingswap_get_prices first",
      };

  ok({
    action: "deposit",
    side,
    amount,
    market,
    execute: action,
    warnings: [
      "Deposits are locked until settlement or cancellation",
      "You can cancel during deposit phase only (jingswap_cancel_sbtc or jingswap_cancel_stx)",
      "After deposits close, funds are committed until settlement",
      "Settlement price is set by Pyth oracle — not by depositors",
    ],
    strategy: {
      tip: side === "sbtc"
        ? "You're providing the scarce side. If STX demand exists, you'll get filled at oracle price."
        : "You're providing STX demand. If sBTC supply arrives, you'll buy at oracle price.",
      riskLevel: "medium",
      riskFactors: [
        "Oracle price may differ from your target entry",
        "Cycle may not settle if other side doesn't meet minimum",
        "Settlement can take 500+ blocks if oracle update fails",
      ],
    },
  });
}

async function close(opts: { market: string }): Promise<void> {
  const market = opts.market || "sbtc-stx";

  ok({
    action: "close_deposits",
    market,
    execute: {
      tool: "jingswap_close_deposits",
      params: { market },
      description: "Close the deposit phase and transition to buffer",
    },
    preChecks: [
      "phase must be 0 (deposit)",
      `blocksElapsed must be >= ${DEPOSIT_MIN_BLOCKS}`,
      "Both sides must meet minimum deposits (sBTC >= 1000 sats, STX >= 1,000,000 micro-STX)",
      "Run jingswap_get_cycle_state first to verify all conditions",
    ],
    postAction: {
      description: `After closing, wait ${BUFFER_BLOCKS} blocks (~1 min) then call settle`,
      nextStep: "settle",
    },
  });
}

async function settle(opts: { market: string }): Promise<void> {
  const market = opts.market || "sbtc-stx";

  ok({
    action: "settle",
    market,
    execute: {
      tool: "jingswap_settle_with_refresh",
      params: { market },
      description: "Settle the cycle with fresh Pyth oracle prices (recommended over jingswap_settle)",
    },
    preChecks: [
      "Phase must be 1 (buffer complete) or 2 (settle)",
      "Deposits must have been closed first",
      "Use jingswap_settle_with_refresh — stored prices are almost always stale",
    ],
    postAction: {
      description: "After settlement, funds are distributed pro-rata to all depositors",
      nextStep: "Check jingswap_get_settlement for results, then scan for next cycle",
    },
    fallback: {
      description: "If settlement fails repeatedly after 500+ blocks, cancel the cycle",
      tool: "jingswap_cancel_cycle",
      params: { market },
      condition: `Only available ${CANCEL_THRESHOLD} blocks after deposits closed`,
    },
  });
}

async function auto(opts: { side: string; amount: string; market: string }): Promise<void> {
  const market = opts.market || "sbtc-stx";
  const side = opts.side?.toLowerCase();
  const amount = parseFloat(opts.amount);

  if (!side || !["sbtc", "stx"].includes(side)) {
    fail("--side must be 'sbtc' or 'stx'");
  }
  if (!amount || amount <= 0) {
    fail("--amount must be a positive number");
  }

  ok({
    action: "auto_market_make",
    description: "Full lifecycle automation plan for the parent agent to execute",
    market,
    side,
    amount,
    lifecycle: [
      {
        step: 1,
        action: "scan",
        tool: "jingswap_get_cycle_state",
        params: { market },
        decision: "If phase=0 and our side is thin → proceed to deposit. If phase=1/2 → proceed to settle.",
      },
      {
        step: 2,
        action: "check_prices",
        tool: "jingswap_get_prices",
        params: { market },
        decision: "Compare oracle vs DEX price. If divergence >2%, flag as high-risk. Proceed if <2%.",
      },
      {
        step: 3,
        action: "deposit",
        tool: side === "sbtc" ? "jingswap_deposit_sbtc" : "jingswap_deposit_stx",
        // sBTC in sats, STX converted to micro-STX (1 STX = 1,000,000 micro-STX)
        params: side === "sbtc" ? { amount: Math.floor(amount), market } : { amount: Math.round(amount * 1_000_000), market },
        condition: "Only if phase=0 (deposit phase)",
      },
      {
        step: 4,
        action: "wait_for_counterparty",
        description: "Monitor cycle state until both sides meet minimums",
        tool: "jingswap_get_cycle_state",
        params: { market },
        pollInterval: "300 blocks (~10 min)",
        timeout: "If no counterparty after 10,000 blocks, consider cancelling",
      },
      {
        step: 5,
        action: "close_deposits",
        tool: "jingswap_close_deposits",
        params: { market },
        condition: `phase=0, blocksElapsed>=${DEPOSIT_MIN_BLOCKS}, both sides meet minimums`,
      },
      {
        step: 6,
        action: "wait_buffer",
        description: `Wait ${BUFFER_BLOCKS} blocks (~1 min) for buffer phase`,
      },
      {
        step: 7,
        action: "settle",
        tool: "jingswap_settle_with_refresh",
        params: { market },
        condition: "phase=2 (settle phase)",
        retry: "If settlement fails, retry up to 3 times with 30-block gaps",
      },
      {
        step: 8,
        action: "verify",
        tool: "jingswap_get_settlement",
        params: { cycle: "current", market },
        description: "Verify settlement completed and check clearing price",
      },
      {
        step: 9,
        action: "next_cycle",
        description: "New cycle starts automatically. Return to step 1 to repeat.",
      },
    ],
    riskManagement: {
      maxPriceDivergence: "2% between oracle and DEX — abort if exceeded",
      cancelThreshold: `${CANCEL_THRESHOLD} blocks after close if settlement keeps failing`,
      maxWaitBlocks: 10_000,
      cancelTool: "jingswap_cancel_cycle",
    },
  });
}

async function history(opts: { market: string; cycles: string }): Promise<void> {
  const market = opts.market || "sbtc-stx";
  const cycleCount = parseInt(opts.cycles || "5", 10);

  ok({
    action: "history",
    market,
    execute: {
      tool: "jingswap_get_cycles_history",
      params: { market, count: cycleCount },
      description: `Fetch last ${cycleCount} cycles for ${market} market`,
    },
    analysis: {
      description: `After fetching, analyze the last ${cycleCount} cycles for:`,
      metrics: [
        "Average clearing price (STX per BTC)",
        "Average cycle duration (blocks from start to settlement)",
        "Fill rate (cycles settled vs cancelled)",
        "Volume trend (total sBTC + STX per cycle)",
        "Price divergence (settlement price vs oracle at time of deposit)",
      ],
    },
  });
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  // Check Hiro API
  try {
    const info = await fetchJson<{ stacks_tip_height: number }>(`${HIRO_API}/v2/info`);
    checks.push({ check: "Stacks API", status: "ok", detail: `Height ${info.stacks_tip_height}` });
  } catch (e) {
    checks.push({ check: "Stacks API", status: "error", detail: `Unreachable: ${e}` });
  }

  checks.push({
    check: "JingSwap MCP tools",
    status: "info",
    detail: "Required: jingswap_get_cycle_state, jingswap_get_prices, jingswap_deposit_sbtc, jingswap_deposit_stx, jingswap_close_deposits, jingswap_settle_with_refresh",
  });
  checks.push({
    check: "Markets",
    status: "info",
    detail: "sbtc-stx (primary, active) and sbtc-usdcx (secondary)",
  });
  checks.push({
    check: "Wallet requirement",
    status: "info",
    detail: "Deposit and settlement require unlocked wallet with sBTC or STX balance",
  });
  checks.push({
    check: "Cycle phases",
    status: "info",
    detail: `0=deposit (min ${DEPOSIT_MIN_BLOCKS} blocks), 1=buffer (${BUFFER_BLOCKS} blocks), 2=settle`,
  });
  checks.push({
    check: "Minimum deposits",
    status: "info",
    detail: "sBTC: 1,000 sats | STX: 1,000,000 micro-STX (1 STX)",
  });

  ok({
    healthy: checks.every((c) => c.status !== "error"),
    checks,
    note: "JingSwap cycle maker is an execution skill. It orchestrates the full auction " +
      "lifecycle: scan → deposit → close → settle. The parent agent executes MCP tool " +
      "calls with the parameters this skill generates.",
  });
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("jingswap-cycle-maker")
  .description("Automated market making on JingSwap sBTC auction cycles")
  .version("1.0.0");

program
  .command("scan")
  .description("Scan current cycle for market-making opportunities")
  .option("--market <market>", "Market: sbtc-stx or sbtc-usdcx", "sbtc-stx")
  .action(async (opts) => {
    try { await scan(opts); } catch (e) { fail(`Scan failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("deposit")
  .description("Deposit sBTC or STX into the current auction cycle")
  .requiredOption("--side <side>", "Side to deposit: sbtc or stx")
  .requiredOption("--amount <amount>", "Amount (sats for sBTC, STX for STX)")
  .option("--market <market>", "Market: sbtc-stx or sbtc-usdcx", "sbtc-stx")
  .action(async (opts) => {
    try { await deposit(opts); } catch (e) { fail(`Deposit failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("close")
  .description("Close the deposit phase — transitions to buffer then settlement")
  .option("--market <market>", "Market: sbtc-stx or sbtc-usdcx", "sbtc-stx")
  .action(async (opts) => {
    try { await close(opts); } catch (e) { fail(`Close failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("settle")
  .description("Settle the cycle with fresh oracle prices — distributes funds")
  .option("--market <market>", "Market: sbtc-stx or sbtc-usdcx", "sbtc-stx")
  .action(async (opts) => {
    try { await settle(opts); } catch (e) { fail(`Settle failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("auto")
  .description("Full lifecycle automation — scan, deposit, close, settle, repeat")
  .requiredOption("--side <side>", "Side to deposit: sbtc or stx")
  .requiredOption("--amount <amount>", "Amount per cycle (sats for sBTC, STX for STX)")
  .option("--market <market>", "Market: sbtc-stx or sbtc-usdcx", "sbtc-stx")
  .action(async (opts) => {
    try { await auto(opts); } catch (e) { fail(`Auto failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("history")
  .description("Analyze historical cycle performance — clearing prices, volume, fill rates")
  .option("--market <market>", "Market: sbtc-stx or sbtc-usdcx", "sbtc-stx")
  .option("--cycles <n>", "Number of recent cycles to analyze", "5")
  .action(async (opts) => {
    try { await history(opts); } catch (e) { fail(`History failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("doctor")
  .description("Check prerequisites — API access, MCP tools, wallet status")
  .action(async () => {
    try { await doctor(); } catch (e) { fail(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program.parse();
