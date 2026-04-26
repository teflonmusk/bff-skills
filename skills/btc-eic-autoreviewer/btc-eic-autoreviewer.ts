#!/usr/bin/env bun
/**
 * btc-eic-autoreviewer — Automated signal review for EIC.
 *
 * Fetches submitted signals, applies gate checks, ranks by score,
 * and outputs the approval/rejection set for the daily brief.
 *
 * The EIC signs and submits the batch — the script does the triage.
 *
 * Usage:
 *   bun btc-eic-autoreviewer/btc-eic-autoreviewer.ts triage [--beat <slug>] [--min-score <n>]
 *   bun btc-eic-autoreviewer/btc-eic-autoreviewer.ts gates <signal-id>
 *   bun btc-eic-autoreviewer/btc-eic-autoreviewer.ts batch-approve --ids <id1,id2,...>
 *   bun btc-eic-autoreviewer/btc-eic-autoreviewer.ts auto-review [--cutoff <HH:MM>] [--dry-run]
 *   bun btc-eic-autoreviewer/btc-eic-autoreviewer.ts doctor
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const NEWS_API = "https://aibtc.news/api";
const MIN_SCORE = 75;
const CAP_PER_BEAT = 10;
const VALID_BEATS = ["bitcoin-macro", "aibtc-network", "quantum"];

const TIER_0_DOMAINS = [
  "mempool.space", "bridge.sbtc.tech", "defillama.com", "coinglass.com",
  "api.mainnet.hiro.so", "api.hiro.so", "explorer.hiro.so",
];

const TIER_1_DOMAINS = [
  "coindesk.com", "bloomberg.com", "bitcoinmagazine.com",
  "sec.gov", "nist.gov", "congress.gov", "senate.gov",
  "github.com", "arxiv.org", "ionq.com",
  "stocktitan.net", "federalregister.gov",
];

// ── Types ──────────────────────────────────────────────────────────────

interface Signal {
  id: string;
  beatSlug: string;
  headline: string;
  content: string;
  sources: Array<{ url: string; title: string }>;
  quality_score: number;
  disclosure: string | null;
  status: string;
  tags: string[];
  btcAddress: string;
  timestamp: string;
}

interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

interface TriageResult {
  signal: { id: string; headline: string; score: number; beat: string };
  gates: GateResult[];
  allGatesPassed: boolean;
  decision: "approve" | "reject" | "approved-not-included" | "cap-blocked";
  reason: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.log(JSON.stringify({ status: "error", error: { code: "AUTOREVIEWER_ERROR", message } }, null, 2));
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

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getSourceTier(url: string): number {
  const domain = extractDomain(url);
  if (TIER_0_DOMAINS.some((d) => domain.includes(d))) return 0;
  if (TIER_1_DOMAINS.some((d) => domain.includes(d))) return 1;
  if (domain.endsWith(".gov") || domain.endsWith(".edu")) return 1;
  return 3;
}

// ── Gate Checks ───────────────────────────────────────────────────────

function checkGates(signal: Signal): GateResult[] {
  const results: GateResult[] = [];

  // Source gate
  const sources = typeof signal.sources === "string" ? JSON.parse(signal.sources) : signal.sources;
  const tiers = (sources || []).map((s: { url: string }) => getSourceTier(s.url));
  const hasTier01 = tiers.some((t: number) => t <= 1);
  results.push({
    gate: "SOURCE_TIER",
    passed: hasTier01,
    detail: hasTier01
      ? `Tier ${Math.min(...tiers)} source present`
      : "No Tier 0/1 source — all sources are Tier 2/3",
  });

  // Beat gate
  const validBeat = VALID_BEATS.includes(signal.beatSlug);
  results.push({
    gate: "BEAT_ROUTING",
    passed: validBeat,
    detail: validBeat ? `Valid beat: ${signal.beatSlug}` : `Invalid beat: ${signal.beatSlug}`,
  });

  // Disclosure gate
  const hasDisclosure = !!signal.disclosure && signal.disclosure.length > 5;
  results.push({
    gate: "DISCLOSURE",
    passed: hasDisclosure,
    detail: hasDisclosure ? "Disclosure present" : "No disclosure",
  });

  // Score minimum gate
  const aboveMin = signal.quality_score >= MIN_SCORE;
  results.push({
    gate: "SCORE_MINIMUM",
    passed: aboveMin,
    detail: aboveMin
      ? `Score ${signal.quality_score} >= ${MIN_SCORE}`
      : `Score ${signal.quality_score} < ${MIN_SCORE} minimum`,
  });

  // Format gate
  const headlineOk = signal.headline.length <= 120;
  const bodyOk = (signal.content || "").length <= 1000;
  results.push({
    gate: "FORMAT",
    passed: headlineOk && bodyOk,
    detail: !headlineOk ? "Headline > 120 chars" : !bodyOk ? "Body > 1000 chars" : "Format OK",
  });

  // Agent utility gate
  const body = signal.content || "";
  const hasAgentLine = body.toLowerCase().includes("for agents:");
  results.push({
    gate: "AGENT_UTILITY",
    passed: hasAgentLine,
    detail: hasAgentLine ? "'For agents:' line present" : "No 'For agents:' action line",
  });

  return results;
}

// ── Commands ───────────────────────────────────────────────────────────

async function triage(opts: { beat?: string; minScore?: string }): Promise<void> {
  const minScore = parseInt(opts.minScore || String(MIN_SCORE), 10);

  const data = await fetchJson<{ signals: Signal[] }>(`${NEWS_API}/signals?limit=200`);
  let submitted = data.signals.filter((s) => s.status === "submitted");

  if (opts.beat) {
    submitted = submitted.filter((s) => s.beatSlug === opts.beat);
  }

  // Group by beat
  const byBeat: Record<string, TriageResult[]> = {};

  for (const signal of submitted) {
    const gates = checkGates(signal);
    const allPassed = gates.every((g) => g.passed);
    const beat = signal.beatSlug;

    if (!byBeat[beat]) byBeat[beat] = [];

    let decision: TriageResult["decision"];
    let reason: string;

    if (!allPassed) {
      const failed = gates.filter((g) => !g.passed);
      decision = "reject";
      reason = `GATE: ${failed.map((g) => g.gate).join(", ")}. ${failed.map((g) => g.detail).join(". ")}`;
    } else {
      decision = "approve"; // tentative — will be capped below
      reason = "All gates passed";
    }

    byBeat[beat].push({
      signal: { id: signal.id, headline: signal.headline, score: signal.quality_score, beat },
      gates,
      allGatesPassed: allPassed,
      decision,
      reason,
    });
  }

  // Apply cap per beat — top 10 by score get approved, rest are cap-blocked
  const summary: Record<string, { approve: number; reject: number; capBlocked: number; floor: number }> = {};

  for (const [beat, results] of Object.entries(byBeat)) {
    const passed = results.filter((r) => r.allGatesPassed).sort((a, b) => b.signal.score - a.signal.score);
    const rejected = results.filter((r) => !r.allGatesPassed);

    const approved = passed.slice(0, CAP_PER_BEAT);
    const capBlocked = passed.slice(CAP_PER_BEAT);

    for (const r of capBlocked) {
      r.decision = "cap-blocked";
      r.reason = `Score ${r.signal.score} but cap full (floor: ${approved[approved.length - 1]?.signal.score || 0})`;
    }

    const floor = approved.length > 0 ? approved[approved.length - 1].signal.score : 0;
    summary[beat] = {
      approve: approved.length,
      reject: rejected.length,
      capBlocked: capBlocked.length,
      floor,
    };
  }

  // Output
  const allResults = Object.values(byBeat).flat();
  const approvals = allResults.filter((r) => r.decision === "approve");
  const rejections = allResults.filter((r) => r.decision === "reject");
  const blocked = allResults.filter((r) => r.decision === "cap-blocked");

  ok({
    triage: {
      total: submitted.length,
      approve: approvals.length,
      reject: rejections.length,
      capBlocked: blocked.length,
    },
    beatSummary: summary,
    approvals: approvals.map((r) => ({
      id: r.signal.id,
      beat: r.signal.beat,
      score: r.signal.score,
      headline: r.signal.headline.slice(0, 60),
    })),
    rejections: rejections.map((r) => ({
      id: r.signal.id,
      beat: r.signal.beat,
      score: r.signal.score,
      headline: r.signal.headline.slice(0, 60),
      reason: r.reason,
    })),
    capBlocked: blocked.slice(0, 10).map((r) => ({
      id: r.signal.id,
      beat: r.signal.beat,
      score: r.signal.score,
      headline: r.signal.headline.slice(0, 60),
      reason: r.reason,
    })),
    actionRequired: {
      description: "Run batch-approve with the approval IDs, then batch-reject with rejection IDs.",
      approveIds: approvals.map((r) => r.signal.id).join(","),
      rejectIds: rejections.map((r) => r.signal.id).join(","),
    },
  });
}

async function gates(signalId: string): Promise<void> {
  const signal = await fetchJson<Signal>(`${NEWS_API}/signals/${signalId}`);
  const results = checkGates(signal);
  const allPassed = results.every((g) => g.passed);

  ok({
    signal: { id: signal.id, headline: signal.headline, score: signal.quality_score, beat: signal.beatSlug },
    gates: results,
    allGatesPassed: allPassed,
    verdict: allPassed ? "PASS — eligible for quality ranking" : "FAIL — address failed gates before resubmitting",
  });
}

async function autoReview(opts: { cutoff?: string; dryRun?: boolean }): Promise<void> {
  const cutoffHour = parseInt((opts.cutoff || "14:00").split(":")[0], 10);
  const cutoffMin = parseInt((opts.cutoff || "14:00").split(":")[1], 10);
  const now = new Date();
  const cutoffTime = new Date(now);
  cutoffTime.setUTCHours(cutoffHour, cutoffMin, 0, 0);

  // If cutoff is in the future, use start of today as window start
  const windowStart = new Date(now);
  windowStart.setUTCHours(0, 0, 0, 0);

  const data = await fetchJson<{ signals: Signal[] }>(`${NEWS_API}/signals?limit=200`);
  // Only include signals filed within today's window (before cutoff)
  const submitted = data.signals.filter((s) => {
    if (s.status !== "submitted") return false;
    const filed = new Date(s.timestamp);
    return filed >= windowStart && filed <= cutoffTime;
  });

  // Gate check all signals
  const triaged: Array<{ signal: Signal; gates: GateResult[]; allPassed: boolean }> = [];
  for (const signal of submitted) {
    const gates = checkGates(signal);
    triaged.push({ signal, gates, allPassed: gates.every((g) => g.passed) });
  }

  // Split by gate result
  const passed = triaged.filter((t) => t.allPassed);
  const failed = triaged.filter((t) => !t.allPassed);

  // Group passed by beat, sort by score, cap at 10
  const byBeat: Record<string, typeof passed> = {};
  for (const t of passed) {
    const beat = t.signal.beatSlug;
    if (!byBeat[beat]) byBeat[beat] = [];
    byBeat[beat].push(t);
  }

  const toApprove: string[] = [];
  const toApproveNotIncluded: string[] = [];
  const toReject: Array<{ id: string; reason: string }> = [];

  for (const [beat, signals] of Object.entries(byBeat)) {
    const sorted = signals.sort((a, b) => b.signal.quality_score - a.signal.quality_score);
    const top = sorted.slice(0, CAP_PER_BEAT);
    const rest = sorted.slice(CAP_PER_BEAT);

    for (const t of top) toApprove.push(t.signal.id);
    for (const t of rest) toApproveNotIncluded.push(t.signal.id);
  }

  for (const t of failed) {
    const failedGates = t.gates.filter((g) => !g.passed);
    toReject.push({
      id: t.signal.id,
      reason: `GATE: ${failedGates.map((g) => g.gate).join(", ")}. ${failedGates.map((g) => g.detail).join(". ")}. One refile.`,
    });
  }

  ok({
    autoReview: {
      total: submitted.length,
      toApprove: toApprove.length,
      toApproveNotIncluded: toApproveNotIncluded.length,
      toReject: toReject.length,
      dryRun: opts.dryRun || false,
    },
    approve: toApprove,
    approveNotIncluded: toApproveNotIncluded,
    reject: toReject.slice(0, 20),
    cutoff: {
      windowStart: windowStart.toISOString(),
      cutoffTime: cutoffTime.toISOString(),
      signalsInWindow: submitted.length,
    },
    instruction: opts.dryRun
      ? "Dry run — no signals were modified. Remove --dry-run to execute."
      : "Execute: parent agent should sign and submit each approval/rejection via PATCH /api/signals/{id}/review. All decisions are final — top 10 per beat by score, no rolling approvals.",
  });
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  try {
    await fetchJson<unknown>(`${NEWS_API}/signals?limit=1`);
    checks.push({ check: "aibtc.news API", status: "ok", detail: "Reachable" });
  } catch {
    checks.push({ check: "aibtc.news API", status: "error", detail: "Unreachable" });
  }

  checks.push({ check: "Gate checks", status: "info", detail: "SOURCE_TIER, BEAT_ROUTING, DISCLOSURE, SCORE_MINIMUM, FORMAT, AGENT_UTILITY" });
  checks.push({ check: "Cap per beat", status: "info", detail: `${CAP_PER_BEAT} signals per beat per day` });
  checks.push({ check: "Minimum score", status: "info", detail: `${MIN_SCORE}/100` });
  checks.push({ check: "Valid beats", status: "info", detail: VALID_BEATS.join(", ") });

  ok({ healthy: checks.every((c) => c.status !== "error"), checks });
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("btc-eic-autoreviewer")
  .description("Automated signal review for EIC. Gates, ranks, triages — you sign.")
  .version("1.0.0");

program
  .command("triage")
  .description("Triage all submitted signals — gate check, rank, output approval/rejection sets")
  .option("--beat <slug>", "Filter by beat")
  .option("--min-score <n>", "Minimum score override", String(MIN_SCORE))
  .action(async (opts) => {
    try { await triage(opts); } catch (e) { fail(`Triage failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("gates <signal-id>")
  .description("Check gates for a specific signal")
  .action(async (signalId: string) => {
    try { await gates(signalId); } catch (e) { fail(`Gates failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("auto-review")
  .description("Full auto-review: gate check all signals, rank by score, output batch decisions")
  .option("--cutoff <HH:MM>", "UTC cutoff time for daily review", "15:00")
  .option("--dry-run", "Preview decisions without executing")
  .action(async (opts) => {
    try { await autoReview(opts); } catch (e) { fail(`Auto-review failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("doctor")
  .description("Check prerequisites")
  .action(async () => {
    try { await doctor(); } catch (e) { fail(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program.parse();
