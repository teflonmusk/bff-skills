#!/usr/bin/env bun
/**
 * brief-analyzer — Analyze aibtc.news brief inclusion patterns
 *
 * Data-driven filing strategy for correspondents.
 *
 * Usage:
 *   bun brief-analyzer/brief-analyzer.ts daily <date>
 *   bun brief-analyzer/brief-analyzer.ts trend <start-date> <end-date>
 *   bun brief-analyzer/brief-analyzer.ts correspondent <btc-address>
 *   bun brief-analyzer/brief-analyzer.ts beats
 */

import { Command } from "commander";

const AIBTC_NEWS_API = "https://aibtc.news/api";
const FETCH_TIMEOUT_MS = 20_000;

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

interface BriefSignal {
  signal_id: string;
  position: number;
  btc_address: string;
  beat_slug: string;
  headline: string;
  created_at: string;
}

interface BriefResponse {
  date: string;
  compiledAt: string | null;
  summary?: { correspondents: number; beats: number; signals: number };
  included_signals?: BriefSignal[];
  included_signal_ids?: string[];
}

interface Signal {
  id: string;
  btcAddress?: string;
  btc_address?: string;
  displayName?: string;
  display_name?: string;
  beat?: string;
  beatSlug?: string;
  beat_slug?: string;
  headline?: string;
  status?: string;
  created_at?: string;
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("brief-analyzer")
  .description("Analyze aibtc.news brief patterns — inclusion rates, beat coverage, correspondent concentration.")
  .version("1.0.0");

// ─── daily ────────────────────────────────────────────────────────────────────

program
  .command("daily <date>")
  .description("Analyze a single day's brief — inclusions, beats, correspondents.")
  .action(async (date: string) => {
    try {
      const brief = await fetchJson<BriefResponse>(`${AIBTC_NEWS_API}/brief?date=${date}`);

      if (!brief.compiledAt) {
        out({
          skill: "brief-analyzer",
          command: "daily",
          date,
          compiled: false,
          note: "Brief has not been compiled yet for this date.",
        });
        return;
      }

      const signals = brief.included_signals ?? [];
      const beatCounts: Record<string, number> = {};
      const correspondentCounts: Record<string, number> = {};

      for (const s of signals) {
        beatCounts[s.beat_slug] = (beatCounts[s.beat_slug] ?? 0) + 1;
        correspondentCounts[s.btc_address] = (correspondentCounts[s.btc_address] ?? 0) + 1;
      }

      const uniqueCorrespondents = Object.keys(correspondentCounts).length;
      const maxInclusionsPerCorrespondent = Math.max(...Object.values(correspondentCounts), 0);
      const uniqueBeats = Object.keys(beatCounts).length;

      out({
        skill: "brief-analyzer",
        command: "daily",
        date,
        compiled: true,
        compiled_at: brief.compiledAt,
        total_inclusions: signals.length,
        unique_correspondents: uniqueCorrespondents,
        unique_beats: uniqueBeats,
        max_inclusions_per_correspondent: maxInclusionsPerCorrespondent,
        one_per_correspondent: maxInclusionsPerCorrespondent <= 1,
        beat_distribution: beatCounts,
        correspondent_distribution: correspondentCounts,
        signals: signals.map((s) => ({
          beat: s.beat_slug,
          correspondent: s.btc_address.slice(0, 12) + "...",
          headline: s.headline.slice(0, 80),
          position: s.position,
        })),
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── trend ────────────────────────────────────────────────────────────────────

program
  .command("trend <start-date> <end-date>")
  .description("Analyze brief patterns across a date range.")
  .action(async (startDate: string, endDate: string) => {
    try {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const days: Array<{
        date: string;
        inclusions: number;
        correspondents: number;
        beats: number;
      }> = [];

      let totalInclusions = 0;
      let totalDays = 0;
      const beatTotals: Record<string, number> = {};
      const correspondentTotals: Record<string, number> = {};

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        try {
          const brief = await fetchJson<BriefResponse>(`${AIBTC_NEWS_API}/brief?date=${dateStr}`);
          if (!brief.compiledAt) continue;

          const signals = brief.included_signals ?? [];
          const dayBeats = new Set<string>();
          const dayCorrespondents = new Set<string>();

          for (const s of signals) {
            dayBeats.add(s.beat_slug);
            dayCorrespondents.add(s.btc_address);
            beatTotals[s.beat_slug] = (beatTotals[s.beat_slug] ?? 0) + 1;
            correspondentTotals[s.btc_address] = (correspondentTotals[s.btc_address] ?? 0) + 1;
          }

          days.push({
            date: dateStr,
            inclusions: signals.length,
            correspondents: dayCorrespondents.size,
            beats: dayBeats.size,
          });

          totalInclusions += signals.length;
          totalDays++;
        } catch {
          // Skip days with no brief
        }
      }

      const topCorrespondents = Object.entries(correspondentTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([addr, count]) => ({ address: addr.slice(0, 12) + "...", inclusions: count }));

      out({
        skill: "brief-analyzer",
        command: "trend",
        range: { start: startDate, end: endDate },
        days_compiled: totalDays,
        total_inclusions: totalInclusions,
        avg_inclusions_per_day: totalDays > 0 ? Math.round(totalInclusions / totalDays) : 0,
        beat_totals: beatTotals,
        top_correspondents: topCorrespondents,
        daily: days,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── correspondent ────────────────────────────────────────────────────────────

program
  .command("correspondent <btc-address>")
  .description("Show a correspondent's brief inclusion history.")
  .action(async (btcAddress: string) => {
    try {
      if (!btcAddress.startsWith("bc1")) fail("Address must start with bc1");

      const status = await fetchJson<{
        display_name: string | null;
        totalSignals: number;
        streak: { current_streak: number } | null;
        earnings: Array<{
          amount_sats: number;
          reason: string;
          reference_id: string;
          created_at: string;
          payout_txid: string | null;
          voided_at: string | null;
        }>;
      }>(`${AIBTC_NEWS_API}/status/${encodeURIComponent(btcAddress)}`);

      const earnings = status.earnings ?? [];
      const inclusions = earnings.filter((e) => e.reason === "brief_inclusion" && !e.voided_at);
      const prizes = earnings.filter((e) => e.reason.includes("prize") && !e.voided_at);
      const voided = earnings.filter((e) => e.voided_at);
      const withTxid = inclusions.filter((e) => e.payout_txid);

      const inclusionSats = inclusions.reduce((s, e) => s + e.amount_sats, 0);
      const prizeSats = prizes.reduce((s, e) => s + e.amount_sats, 0);

      out({
        skill: "brief-analyzer",
        command: "correspondent",
        address: btcAddress,
        display_name: status.display_name,
        total_signals: status.totalSignals,
        streak: status.streak?.current_streak ?? 0,
        brief_inclusions: inclusions.length,
        inclusion_sats: inclusionSats,
        prizes: prizes.length,
        prize_sats: prizeSats,
        total_earned_sats: inclusionSats + prizeSats,
        voided_entries: voided.length,
        payout_confirmed: withTxid.length,
        payout_pending: inclusions.length - withTxid.length,
        inclusion_rate: status.totalSignals > 0
          ? `${Math.round((inclusions.length / status.totalSignals) * 100)}%`
          : "n/a",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── beats ────────────────────────────────────────────────────────────────────

program
  .command("beats")
  .description("Current beat coverage — which beats are overserved vs underserved.")
  .option("--days <n>", "Number of recent days to analyze", "7")
  .action(async (opts: { days: string }) => {
    try {
      const numDays = parseInt(opts.days, 10);
      const beatCounts: Record<string, number> = {};
      let totalDays = 0;

      for (let i = 0; i < numDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);

        try {
          const brief = await fetchJson<BriefResponse>(`${AIBTC_NEWS_API}/brief?date=${dateStr}`);
          if (!brief.compiledAt) continue;

          const signals = brief.included_signals ?? [];
          for (const s of signals) {
            beatCounts[s.beat_slug] = (beatCounts[s.beat_slug] ?? 0) + 1;
          }
          totalDays++;
        } catch {
          // Skip
        }
      }

      const sorted = Object.entries(beatCounts).sort((a, b) => b[1] - a[1]);
      const totalInclusions = sorted.reduce((s, [, c]) => s + c, 0);

      const analysis = sorted.map(([beat, count]) => ({
        beat,
        inclusions: count,
        avg_per_day: totalDays > 0 ? Math.round((count / totalDays) * 10) / 10 : 0,
        share: totalInclusions > 0 ? `${Math.round((count / totalInclusions) * 100)}%` : "0%",
      }));

      out({
        skill: "brief-analyzer",
        command: "beats",
        days_analyzed: totalDays,
        total_inclusions: totalInclusions,
        beats: analysis,
        underserved: analysis.filter((b) => b.avg_per_day < 1).map((b) => b.beat),
        overserved: analysis.filter((b) => b.avg_per_day > 3).map((b) => b.beat),
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse(process.argv);
