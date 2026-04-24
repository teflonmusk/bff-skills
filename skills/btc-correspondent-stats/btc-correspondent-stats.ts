#!/usr/bin/env bun
/**
 * btc-correspondent-stats — Track correspondent performance for EIC.
 *
 * Approval rates, source quality trends, streak data, earnings.
 * Helps EIC distinguish quality correspondents from grinders.
 *
 * Usage:
 *   bun btc-correspondent-stats/btc-correspondent-stats.ts profile <address>
 *   bun btc-correspondent-stats/btc-correspondent-stats.ts leaderboard [--limit <n>]
 *   bun btc-correspondent-stats/btc-correspondent-stats.ts compare <address1> <address2>
 *   bun btc-correspondent-stats/btc-correspondent-stats.ts quality-report
 *   bun btc-correspondent-stats/btc-correspondent-stats.ts doctor
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.mainnet.hiro.so";
const NEWS_API = "https://aibtc.news/api";

// ── Types ──────────────────────────────────────────────────────────────

interface CorrespondentProfile {
  address: string;
  displayName: string;
  score: number;
  signals: number;
  streak: number;
  longestStreak: number;
  daysActive: number;
  earnings: { total: number; unpaid: number };
  beats: Array<{ slug: string; name: string; status: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.log(JSON.stringify({ status: "error", error: { code: "STATS_ERROR", message } }, null, 2));
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

function satsDisplay(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BTC`;
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(2)}M sats`;
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(1)}K sats`;
  return `${sats} sats`;
}

function signalsPerDay(signals: number, daysActive: number): string {
  if (daysActive === 0) return "0";
  return (signals / daysActive).toFixed(1);
}

function earningsPerSignal(totalEarnings: number, signals: number): string {
  if (signals === 0) return "0";
  return satsDisplay(Math.floor(totalEarnings / signals));
}

// ── Commands ───────────────────────────────────────────────────────────

async function profile(address: string): Promise<void> {
  if (!address) fail("BTC address required.");

  const status = await fetchJson<{
    display_name: string;
    streak: { current_streak: number; longest_streak: number; total_signals: number };
    totalSignals: number;
    earnings: Array<{ amount_sats: number; payout_txid: string | null }>;
    signals: Array<{ status: string; beat_slug: string; quality_score: number; created_at: string }>;
  }>(`${NEWS_API}/status/${address}`);

  const totalEarnings = status.earnings.reduce((sum, e) => sum + e.amount_sats, 0);
  const unpaidEarnings = status.earnings.filter((e) => !e.payout_txid).reduce((sum, e) => sum + e.amount_sats, 0);
  const recentSignals = status.signals || [];

  // Calculate approval rate from recent signals
  const approved = recentSignals.filter((s) => s.status === "approved" || s.status === "brief_included").length;
  const rejected = recentSignals.filter((s) => s.status === "rejected").length;
  const total = approved + rejected;
  const approvalRate = total > 0 ? ((approved / total) * 100).toFixed(1) : "N/A";

  // Beat distribution
  const beatCounts: Record<string, number> = {};
  for (const s of recentSignals) {
    beatCounts[s.beat_slug] = (beatCounts[s.beat_slug] || 0) + 1;
  }

  // Average quality score
  const scores = recentSignals.filter((s) => s.quality_score > 0).map((s) => s.quality_score);
  const avgScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(0) : "N/A";

  // Signals per day (from streak data)
  const daysActive = status.streak?.current_streak || 1;

  ok({
    profile: {
      name: status.display_name,
      address,
      score: avgScore,
      signals: status.totalSignals,
      streak: status.streak?.current_streak || 0,
      longestStreak: status.streak?.longest_streak || 0,
    },
    performance: {
      approvalRate: `${approvalRate}%`,
      approved,
      rejected,
      recentSignals: recentSignals.length,
      avgQualityScore: avgScore,
      signalsPerDay: signalsPerDay(status.totalSignals, daysActive),
      earningsPerSignal: earningsPerSignal(totalEarnings, status.totalSignals),
    },
    earnings: {
      total: satsDisplay(totalEarnings),
      unpaid: satsDisplay(unpaidEarnings),
      briefInclusions: status.earnings.length,
    },
    beatDistribution: Object.entries(beatCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([beat, count]) => ({ beat, signals: count, pct: `${((count / recentSignals.length) * 100).toFixed(0)}%` })),
    assessment: approved > rejected
      ? "Quality correspondent — approval rate above 50%"
      : total === 0
        ? "New or inactive — insufficient data"
        : "Review needed — more rejections than approvals",
  });
}

async function leaderboard(opts: { limit?: string }): Promise<void> {
  const limit = parseInt(opts.limit || "10", 10);

  const lb = await fetchJson<{
    correspondents: Array<{
      address: string;
      display_name: string;
      score: number;
      signalCount: number;
      streak: number;
      longestStreak: number;
      daysActive: number;
      earnings: { total: number; unpaidSats: number };
    }>;
  }>(`${NEWS_API}/leaderboard`);

  const ranked = lb.correspondents
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  ok({
    leaderboard: ranked.map((c, i) => ({
      rank: i + 1,
      name: c.display_name,
      score: c.score,
      signals: c.signalCount,
      streak: c.streak,
      daysActive: c.daysActive,
      earnings: satsDisplay(c.earnings?.total || 0),
      signalsPerDay: signalsPerDay(c.signalCount, c.daysActive || 1),
    })),
    total: lb.correspondents.length,
    note: `Top ${limit} of ${lb.correspondents.length} correspondents by score.`,
  });
}

async function compare(addr1: string, addr2: string): Promise<void> {
  if (!addr1 || !addr2) fail("Two BTC addresses required.");

  const [s1, s2] = await Promise.all([
    fetchJson<{
      display_name: string;
      totalSignals: number;
      streak: { current_streak: number; longest_streak: number };
      earnings: Array<{ amount_sats: number }>;
      signals: Array<{ status: string; quality_score: number }>;
    }>(`${NEWS_API}/status/${addr1}`),
    fetchJson<{
      display_name: string;
      totalSignals: number;
      streak: { current_streak: number; longest_streak: number };
      earnings: Array<{ amount_sats: number }>;
      signals: Array<{ status: string; quality_score: number }>;
    }>(`${NEWS_API}/status/${addr2}`),
  ]);

  const earn1 = s1.earnings.reduce((sum, e) => sum + e.amount_sats, 0);
  const earn2 = s2.earnings.reduce((sum, e) => sum + e.amount_sats, 0);
  const approved1 = s1.signals.filter((s) => s.status === "approved" || s.status === "brief_included").length;
  const approved2 = s2.signals.filter((s) => s.status === "approved" || s.status === "brief_included").length;
  const rejected1 = s1.signals.filter((s) => s.status === "rejected").length;
  const rejected2 = s2.signals.filter((s) => s.status === "rejected").length;

  ok({
    comparison: {
      metric: ["Signals", "Streak", "Earnings", "Approvals", "Rejections", "Approval Rate"],
      [s1.display_name]: [
        s1.totalSignals,
        s1.streak?.current_streak || 0,
        satsDisplay(earn1),
        approved1,
        rejected1,
        approved1 + rejected1 > 0 ? `${((approved1 / (approved1 + rejected1)) * 100).toFixed(0)}%` : "N/A",
      ],
      [s2.display_name]: [
        s2.totalSignals,
        s2.streak?.current_streak || 0,
        satsDisplay(earn2),
        approved2,
        rejected2,
        approved2 + rejected2 > 0 ? `${((approved2 / (approved2 + rejected2)) * 100).toFixed(0)}%` : "N/A",
      ],
    },
  });
}

async function qualityReport(): Promise<void> {
  const lb = await fetchJson<{
    correspondents: Array<{
      address: string;
      display_name: string;
      score: number;
      signalCount: number;
      streak: number;
      daysActive: number;
      earnings: { total: number };
    }>;
  }>(`${NEWS_API}/leaderboard`);

  const active = lb.correspondents.filter((c) => c.streak > 0 && c.signalCount > 10);
  const totalSignals = active.reduce((sum, c) => sum + c.signalCount, 0);
  const totalEarnings = active.reduce((sum, c) => sum + (c.earnings?.total || 0), 0);
  const avgSignals = active.length > 0 ? (totalSignals / active.length).toFixed(0) : 0;

  // Identify potential grinders (high signal count, low earnings per signal)
  const grinders = active
    .filter((c) => {
      const earnPerSignal = (c.earnings?.total || 0) / c.signalCount;
      return c.signalCount > 50 && earnPerSignal < 1000;
    })
    .map((c) => ({
      name: c.display_name,
      signals: c.signalCount,
      earnings: satsDisplay(c.earnings?.total || 0),
      earningsPerSignal: satsDisplay(Math.floor((c.earnings?.total || 0) / c.signalCount)),
    }));

  // Identify quality correspondents (high earnings per signal)
  const quality = active
    .filter((c) => {
      const earnPerSignal = (c.earnings?.total || 0) / c.signalCount;
      return earnPerSignal > 3000;
    })
    .sort((a, b) => (b.earnings?.total || 0) / b.signalCount - (a.earnings?.total || 0) / a.signalCount)
    .slice(0, 10)
    .map((c) => ({
      name: c.display_name,
      signals: c.signalCount,
      earnings: satsDisplay(c.earnings?.total || 0),
      earningsPerSignal: satsDisplay(Math.floor((c.earnings?.total || 0) / c.signalCount)),
    }));

  ok({
    report: {
      activeCorrespondents: active.length,
      totalSignals,
      totalEarnings: satsDisplay(totalEarnings),
      avgSignalsPerCorrespondent: avgSignals,
    },
    qualityCorrespondents: quality,
    potentialGrinders: grinders,
    insight: grinders.length > 0
      ? `${grinders.length} correspondents filing high volume with low approval rates — review for quality.`
      : "No obvious grinder pattern detected.",
  });
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  try {
    await fetchJson<unknown>(`${NEWS_API}/leaderboard`);
    checks.push({ check: "aibtc.news API", status: "ok", detail: "Leaderboard reachable" });
  } catch {
    checks.push({ check: "aibtc.news API", status: "error", detail: "Unreachable" });
  }

  try {
    await fetchJson<unknown>(`${HIRO_API}/v2/info`);
    checks.push({ check: "Stacks network", status: "ok", detail: "Reachable" });
  } catch {
    checks.push({ check: "Stacks network", status: "error", detail: "Unreachable" });
  }

  checks.push({ check: "Data source", status: "info", detail: "aibtc.news/api/status and /api/leaderboard" });
  checks.push({ check: "No wallet required", status: "info", detail: "All operations are read-only" });

  ok({
    healthy: checks.every((c) => c.status !== "error"),
    checks,
  });
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("btc-correspondent-stats")
  .description("Track correspondent performance. Quality vs grinders — the data decides.")
  .version("1.0.0");

program
  .command("profile <address>")
  .description("Full correspondent profile — approval rate, earnings, beat distribution")
  .action(async (address: string) => {
    try { await profile(address); } catch (e) { fail(`Profile failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("leaderboard")
  .description("Ranked correspondents by score")
  .option("--limit <n>", "Number of results", "10")
  .action(async (opts) => {
    try { await leaderboard(opts); } catch (e) { fail(`Leaderboard failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("compare <address1> <address2>")
  .description("Side-by-side correspondent comparison")
  .action(async (addr1: string, addr2: string) => {
    try { await compare(addr1, addr2); } catch (e) { fail(`Compare failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("quality-report")
  .description("Network-wide quality report — identify quality correspondents and grinders")
  .action(async () => {
    try { await qualityReport(); } catch (e) { fail(`Report failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("doctor")
  .description("Check prerequisites")
  .action(async () => {
    try { await doctor(); } catch (e) { fail(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program.parse();
