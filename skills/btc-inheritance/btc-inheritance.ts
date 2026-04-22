#!/usr/bin/env bun
/**
 * btc-inheritance — Dead man's switch for Bitcoin.
 *
 * Check in regularly or your sats automatically transfer to designated
 * .btc beneficiaries. Self-custody estate planning — no lawyers, no trusts.
 *
 * Usage:
 *   bun btc-inheritance/btc-inheritance.ts setup --beneficiaries <name.btc,...> --split <pct,...> --days <n>
 *   bun btc-inheritance/btc-inheritance.ts checkin
 *   bun btc-inheritance/btc-inheritance.ts status
 *   bun btc-inheritance/btc-inheritance.ts update --beneficiaries <name.btc,...> --split <pct,...>
 *   bun btc-inheritance/btc-inheritance.ts trigger
 *   bun btc-inheritance/btc-inheritance.ts doctor
 */

import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.mainnet.hiro.so";
const PLAN_DIR = `${process.env.HOME}/.bff/inheritance`;
const PLAN_FILE = `${PLAN_DIR}/plan.json`;
const BLOCKS_PER_DAY = 43_200;
const MIN_INTERVAL_DAYS = 7;

// ── Types ──────────────────────────────────────────────────────────────

interface Beneficiary {
  name: string;
  splitPct: number;
}

interface InheritancePlan {
  beneficiaries: Beneficiary[];
  intervalDays: number;
  intervalBlocks: number;
  lastCheckinBlock: number;
  lastCheckinTime: string;
  deadlineBlock: number;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.log(JSON.stringify({ status: "error", error: { code: "INHERITANCE_ERROR", message } }, null, 2));
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

async function getCurrentBlock(): Promise<number> {
  const info = await fetchJson<{ stacks_tip_height: number }>(`${HIRO_API}/v2/info`);
  return info.stacks_tip_height;
}

function satsDisplay(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BTC (${sats.toLocaleString()} sats)`;
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(2)}M sats`;
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(1)}K sats`;
  return `${sats} sats`;
}

// ── State persistence ─────────────────────────────────────────────────

function savePlan(plan: InheritancePlan): void {
  mkdirSync(PLAN_DIR, { recursive: true });
  writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
}

function loadPlan(): InheritancePlan | null {
  if (!existsSync(PLAN_FILE)) return null;
  return JSON.parse(readFileSync(PLAN_FILE, "utf-8")) as InheritancePlan;
}

function parseBeneficiaries(names: string, splits: string): Beneficiary[] {
  const nameList = names.split(",").map((n) => n.trim());
  const splitList = splits.split(",").map((s) => parseInt(s.trim(), 10));

  if (nameList.length !== splitList.length) {
    fail(`Beneficiary count (${nameList.length}) doesn't match split count (${splitList.length}).`);
  }
  if (nameList.some((n) => !n.includes("."))) {
    fail("All beneficiaries must be BNS names (e.g., family.btc).");
  }
  const total = splitList.reduce((a, b) => a + b, 0);
  if (total !== 100) {
    fail(`Splits must sum to 100%. Got: ${total}%.`);
  }

  return nameList.map((name, i) => ({ name, splitPct: splitList[i] }));
}

function getPlanStatus(plan: InheritancePlan, currentBlock: number): "active" | "warning" | "critical" | "expired" {
  if (currentBlock >= plan.deadlineBlock) return "expired";
  const remaining = plan.deadlineBlock - currentBlock;
  const total = plan.intervalBlocks;
  const pct = remaining / total;
  if (pct < 0.25) return "critical";
  if (pct < 0.50) return "warning";
  return "active";
}

// ── Commands ───────────────────────────────────────────────────────────

async function setup(opts: { beneficiaries: string; split: string; days: string }): Promise<void> {
  const intervalDays = parseInt(opts.days, 10);
  if (!intervalDays || intervalDays < MIN_INTERVAL_DAYS) {
    fail(`Minimum check-in interval: ${MIN_INTERVAL_DAYS} days. Got: ${intervalDays || 0}.`);
  }

  const beneficiaries = parseBeneficiaries(opts.beneficiaries, opts.split);
  const currentBlock = await getCurrentBlock();
  const intervalBlocks = intervalDays * BLOCKS_PER_DAY;

  const existing = loadPlan();
  if (existing) {
    // Warn about overwrite but proceed — single plan per wallet
  }

  const plan: InheritancePlan = {
    beneficiaries,
    intervalDays,
    intervalBlocks,
    lastCheckinBlock: currentBlock,
    lastCheckinTime: new Date().toISOString(),
    deadlineBlock: currentBlock + intervalBlocks,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  savePlan(plan);

  ok({
    plan: {
      beneficiaries: beneficiaries.map((b) => ({ name: b.name, split: `${b.splitPct}%` })),
      intervalDays,
      lastCheckin: plan.lastCheckinTime,
      deadlineBlock: plan.deadlineBlock,
      daysRemaining: intervalDays,
      status: "active",
    },
    nextAction: {
      description: `Check in before block ${plan.deadlineBlock} (${intervalDays} days). Run 'checkin' to reset the timer.`,
      automationHint: `Set a recurring reminder every ${Math.floor(intervalDays / 2)} days to run 'checkin'.`,
    },
    warning: existing ? "Previous plan overwritten." : null,
    bitcoinerNote: `Your Bitcoin inheritance plan is set. ${beneficiaries.map((b) => `${b.name} gets ${b.splitPct}%`).join(", ")}. Check in every ${intervalDays} days to keep your sats safe. Miss the deadline and they go to your beneficiaries. No lawyers. No trusts. Just Bitcoin.`,
  });
}

async function checkin(): Promise<void> {
  const plan = loadPlan();
  if (!plan) {
    fail("No inheritance plan found. Run 'setup' first.");
  }

  const currentBlock = await getCurrentBlock();
  const wasExpired = currentBlock >= plan.deadlineBlock;

  plan.lastCheckinBlock = currentBlock;
  plan.lastCheckinTime = new Date().toISOString();
  plan.deadlineBlock = currentBlock + plan.intervalBlocks;
  plan.updatedAt = new Date().toISOString();
  savePlan(plan);

  ok({
    checkin: {
      status: "confirmed",
      lastCheckin: plan.lastCheckinTime,
      newDeadline: plan.deadlineBlock,
      daysRemaining: plan.intervalDays,
      wasExpired,
    },
    message: wasExpired
      ? "Timer was expired — reset now. Your sats are safe. Consider checking in more frequently."
      : `Timer reset. Next deadline: ${plan.intervalDays} days from now. Your sats are safe.`,
  });
}

async function status(): Promise<void> {
  const plan = loadPlan();
  if (!plan) {
    fail("No inheritance plan found. Run 'setup' first.");
  }

  const currentBlock = await getCurrentBlock();
  const blocksRemaining = Math.max(0, plan.deadlineBlock - currentBlock);
  const daysRemaining = Math.max(0, Math.floor(blocksRemaining / BLOCKS_PER_DAY));
  const planStatus = getPlanStatus(plan, currentBlock);

  ok({
    plan: {
      beneficiaries: plan.beneficiaries.map((b) => ({ name: b.name, split: `${b.splitPct}%` })),
      intervalDays: plan.intervalDays,
      lastCheckin: plan.lastCheckinTime,
      deadlineBlock: plan.deadlineBlock,
      currentBlock,
      blocksRemaining,
      daysRemaining,
      status: planStatus,
    },
    urgency: planStatus === "critical"
      ? "CHECK IN NOW — your deadline is approaching. Run 'checkin' immediately."
      : planStatus === "expired"
        ? "DEADLINE PASSED — distribution can be triggered. Run 'checkin' to reset, or 'trigger' to distribute."
        : planStatus === "warning"
          ? `Check in soon — ${daysRemaining} days remaining.`
          : `All clear — ${daysRemaining} days until next check-in needed.`,
  });
}

async function update(opts: { beneficiaries: string; split: string }): Promise<void> {
  const plan = loadPlan();
  if (!plan) {
    fail("No inheritance plan found. Run 'setup' first.");
  }

  const beneficiaries = parseBeneficiaries(opts.beneficiaries, opts.split);
  plan.beneficiaries = beneficiaries;
  plan.updatedAt = new Date().toISOString();
  savePlan(plan);

  ok({
    update: {
      beneficiaries: beneficiaries.map((b) => ({ name: b.name, split: `${b.splitPct}%` })),
      note: "Beneficiaries updated. Timer NOT reset — deadline unchanged.",
      daysRemaining: Math.max(0, Math.floor((plan.deadlineBlock - (await getCurrentBlock())) / BLOCKS_PER_DAY)),
    },
  });
}

async function trigger(): Promise<void> {
  const plan = loadPlan();
  if (!plan) {
    fail("No inheritance plan found. Run 'setup' first.");
  }

  ok({
    trigger: {
      status: "distribution_ready",
      description: "Generating transfer commands for all beneficiaries.",
    },
    pipeline: [
      {
        step: 1,
        action: "Get wallet sBTC balance",
        tool: "sbtc_get_balance",
        description: "Determine total sats available for distribution",
      },
      ...plan.beneficiaries.map((b, i) => ({
        step: i + 2,
        action: `Resolve ${b.name}`,
        tool: "lookup_bns_name",
        params: { name: b.name },
        description: `Resolve ${b.name} to Stacks address`,
      })),
      ...plan.beneficiaries.map((b, i) => ({
        step: i + 2 + plan.beneficiaries.length,
        action: `Transfer ${b.splitPct}% to ${b.name}`,
        tool: "sbtc_transfer",
        params: {
          recipient: `resolved_address_of_${b.name}`,
          amount: `${b.splitPct}% of total balance`,
        },
        description: `Send ${b.splitPct}% of all sats to ${b.name}`,
      })),
    ],
    warning: "This action is irreversible. Once transfers execute, sats cannot be recalled.",
    bitcoinerNote: `Distributing your Bitcoin: ${plan.beneficiaries.map((b) => `${b.name} gets ${b.splitPct}%`).join(", ")}. This is what you set up. Your sats are going home.`,
  });
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  try {
    const info = await fetchJson<{ stacks_tip_height: number }>(`${HIRO_API}/v2/info`);
    checks.push({ check: "Stacks network", status: "ok", detail: `Block ${info.stacks_tip_height} (~2s Nakamoto blocks)` });
  } catch {
    checks.push({ check: "Stacks network", status: "error", detail: "Unreachable" });
  }

  const plan = loadPlan();
  if (plan) {
    let currentBlock = 0;
    try { currentBlock = await getCurrentBlock(); } catch { /* use 0 */ }
    const planStatus = currentBlock > 0 ? getPlanStatus(plan, currentBlock) : "unknown";
    const daysRemaining = currentBlock > 0 ? Math.max(0, Math.floor((plan.deadlineBlock - currentBlock) / BLOCKS_PER_DAY)) : "?";
    checks.push({ check: "Inheritance plan", status: "ok", detail: `${plan.beneficiaries.length} beneficiaries, ${plan.intervalDays}-day interval, status: ${planStatus}, ${daysRemaining} days remaining` });
  } else {
    checks.push({ check: "Inheritance plan", status: "info", detail: "No plan configured. Run 'setup' to create one." });
  }

  checks.push({ check: "BNS resolver", status: "info", detail: "Resolve .btc names via lookup_bns_name at trigger time" });
  checks.push({ check: "Transfer method", status: "info", detail: "Distribution via sbtc_transfer — parent agent handles wallet" });
  checks.push({ check: "Minimum interval", status: "info", detail: `${MIN_INTERVAL_DAYS} days — shorter intervals risk accidental triggers` });
  checks.push({ check: "State file", status: "info", detail: `${PLAN_FILE} — back up this file` });

  ok({
    healthy: checks.every((c) => c.status !== "error"),
    checks,
    bitcoinerNote: "Your Bitcoin shouldn't die with you. Set up a plan, check in regularly, and your sats go to the people you choose if something happens. No banks, no lawyers, no trusts. Just a timer and a transfer.",
  });
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("btc-inheritance")
  .description("Dead man's switch for Bitcoin. Check in or your sats go to your beneficiaries.")
  .version("1.0.0");

program
  .command("setup")
  .description("Create an inheritance plan — set beneficiaries, splits, and check-in interval")
  .requiredOption("--beneficiaries <names>", "Comma-separated BNS names (e.g., family.btc,friend.btc)")
  .requiredOption("--split <percentages>", "Comma-separated split percentages (must sum to 100)")
  .requiredOption("--days <interval>", "Check-in interval in days (minimum 7)")
  .action(async (opts) => {
    try { await setup(opts); } catch (e) { fail(`Setup failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("checkin")
  .description("Prove you're alive — reset the timer")
  .action(async () => {
    try { await checkin(); } catch (e) { fail(`Check-in failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("status")
  .description("Check plan status — time remaining, beneficiaries, urgency")
  .action(async () => {
    try { await status(); } catch (e) { fail(`Status failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("update")
  .description("Change beneficiaries or splits without resetting the timer")
  .requiredOption("--beneficiaries <names>", "Comma-separated BNS names")
  .requiredOption("--split <percentages>", "Comma-separated split percentages")
  .action(async (opts) => {
    try { await update(opts); } catch (e) { fail(`Update failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("trigger")
  .description("Manually trigger distribution — irreversible")
  .action(async () => {
    try { await trigger(); } catch (e) { fail(`Trigger failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("doctor")
  .description("Check prerequisites — network, plan status, BNS resolver")
  .action(async () => {
    try { await doctor(); } catch (e) { fail(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program.parse();
