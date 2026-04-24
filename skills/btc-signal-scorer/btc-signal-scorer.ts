#!/usr/bin/env bun
/**
 * btc-signal-scorer — Score signals against the EIC quality rubric.
 *
 * Input a signal, get a score breakdown. Correspondents self-check before filing.
 * EIC reviews faster with pre-scored signals.
 *
 * Usage:
 *   bun btc-signal-scorer/btc-signal-scorer.ts score --headline <text> --body <text> --beat <slug> --sources <urls>
 *   bun btc-signal-scorer/btc-signal-scorer.ts check-source <url>
 *   bun btc-signal-scorer/btc-signal-scorer.ts rubric
 *   bun btc-signal-scorer/btc-signal-scorer.ts doctor
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.mainnet.hiro.so";
const MIN_SCORE = 75;

const TIER_0_DOMAINS = [
  "mempool.space", "bridge.sbtc.tech", "defillama.com", "coinglass.com",
  "api.mainnet.hiro.so", "api.hiro.so", "explorer.hiro.so",
  "stacks-node-api.mainnet.stacks.co",
];

const TIER_1_DOMAINS = [
  "coindesk.com", "bloomberg.com", "bitcoinmagazine.com",
  "sec.gov", "nist.gov", "congress.gov", "senate.gov",
  "ionq.com", "ibm.com", "google.com",
  "github.com", "arxiv.org",
  "stocktitan.net", "federalregister.gov",
];

const TIER_2_DOMAINS = [
  "chainwire.org", "prnewswire.com", "businesswire.com", "globenewswire.com",
];

const TIER_3_DOMAINS = [
  "benzinga.com", "crypto-economy.com", "ainvest.com",
  "cryptoslate.com", "cointelegraph.com",
];

const VALID_BEATS = ["bitcoin-macro", "aibtc-network", "quantum"];

// ── Types ──────────────────────────────────────────────────────────────

interface ScoreBreakdown {
  sourceQuality: { score: number; max: 30; details: string[] };
  thesisClarity: { score: number; max: 25; details: string[] };
  beatRelevance: { score: number; max: 10; details: string[] };
  timeliness: { score: number; max: 15; details: string[] };
  disclosure: { score: number; max: 10; details: string[] };
  agentUtility: { score: number; max: 10; details: string[] };
  total: number;
  passing: boolean;
}

interface SourceCheck {
  url: string;
  domain: string;
  tier: number;
  tierName: string;
  reachable: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.log(JSON.stringify({ status: "error", error: { code: "SCORER_ERROR", message } }, null, 2));
  process.exit(1);
}

function ok(data: Record<string, unknown>): void {
  console.log(JSON.stringify({ status: "success", data }, null, 2));
}

function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function classifySource(url: string): { tier: number; tierName: string } {
  const domain = extractDomain(url);
  if (TIER_0_DOMAINS.some((d) => domain.includes(d))) return { tier: 0, tierName: "On-chain data" };
  if (TIER_1_DOMAINS.some((d) => domain.includes(d))) return { tier: 1, tierName: "Primary reporting" };
  if (TIER_2_DOMAINS.some((d) => domain.includes(d))) return { tier: 2, tierName: "Wire service" };
  if (TIER_3_DOMAINS.some((d) => domain.includes(d))) return { tier: 3, tierName: "Republisher" };
  // Check for government domains
  if (domain.endsWith(".gov")) return { tier: 1, tierName: "Government" };
  // Check for academic
  if (domain.endsWith(".edu") || domain.includes("arxiv")) return { tier: 1, tierName: "Academic" };
  return { tier: 3, tierName: "Unknown — treated as Tier 3" };
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    return res.ok || res.status === 403 || res.status === 405; // Some APIs block HEAD
  } catch {
    return false;
  }
}

// ── Scoring ───────────────────────────────────────────────────────────

function scoreSignal(opts: {
  headline: string;
  body: string;
  beat: string;
  sources: string[];
  disclosure?: string;
}): ScoreBreakdown {
  const breakdown: ScoreBreakdown = {
    sourceQuality: { score: 0, max: 30, details: [] },
    thesisClarity: { score: 0, max: 25, details: [] },
    beatRelevance: { score: 0, max: 10, details: [] },
    timeliness: { score: 0, max: 15, details: [] },
    disclosure: { score: 0, max: 10, details: [] },
    agentUtility: { score: 0, max: 10, details: [] },
    total: 0,
    passing: false,
  };

  // ── Source quality (30 pts) ──
  const sourceTiers = opts.sources.map((s) => classifySource(s));
  const bestTier = Math.min(...sourceTiers.map((s) => s.tier));
  const hasTier01 = sourceTiers.some((s) => s.tier <= 1);

  if (hasTier01 && bestTier === 0) {
    breakdown.sourceQuality.score = 30;
    breakdown.sourceQuality.details.push("Tier 0 source present — full marks");
  } else if (hasTier01) {
    breakdown.sourceQuality.score = 25;
    breakdown.sourceQuality.details.push("Tier 1 source present — strong");
  } else if (sourceTiers.some((s) => s.tier === 2)) {
    breakdown.sourceQuality.score = 15;
    breakdown.sourceQuality.details.push("Tier 2 only — pair with Tier 0/1 to pass");
  } else {
    breakdown.sourceQuality.score = 5;
    breakdown.sourceQuality.details.push("Tier 3 only — will be rejected");
  }

  for (const s of sourceTiers) {
    breakdown.sourceQuality.details.push(`  ${s.tierName} (Tier ${s.tier})`);
  }

  if (opts.sources.length < 2) {
    breakdown.sourceQuality.score = Math.max(0, breakdown.sourceQuality.score - 10);
    breakdown.sourceQuality.details.push("Only 1 source — deducted 10 pts");
  }

  // ── Thesis clarity (25 pts) ──
  const headline = opts.headline;
  const body = opts.body;

  if (headline.includes("—") || headline.includes(":")) {
    breakdown.thesisClarity.score += 10;
    breakdown.thesisClarity.details.push("Headline has clear structure");
  } else {
    breakdown.thesisClarity.score += 5;
    breakdown.thesisClarity.details.push("Headline could be clearer — use 'claim — evidence' format");
  }

  if (headline.includes("could") || headline.includes("might") || headline.includes("may")) {
    breakdown.thesisClarity.score -= 5;
    breakdown.thesisClarity.details.push("Speculative language in headline — deducted 5 pts");
  }

  if (body.length > 200 && body.length <= 1000) {
    breakdown.thesisClarity.score += 10;
    breakdown.thesisClarity.details.push("Body length good (200-1000 chars)");
  } else if (body.length <= 200) {
    breakdown.thesisClarity.score += 5;
    breakdown.thesisClarity.details.push("Body too short — add evidence");
  } else {
    breakdown.thesisClarity.score += 5;
    breakdown.thesisClarity.details.push("Body exceeds 1000 chars — trim");
  }

  const hasNumbers = /\d/.test(body);
  if (hasNumbers) {
    breakdown.thesisClarity.score += 5;
    breakdown.thesisClarity.details.push("Contains verifiable numbers");
  }

  breakdown.thesisClarity.score = Math.min(25, Math.max(0, breakdown.thesisClarity.score));

  // ── Beat relevance (10 pts) ──
  if (VALID_BEATS.includes(opts.beat)) {
    breakdown.beatRelevance.score = 10;
    breakdown.beatRelevance.details.push(`Valid beat: ${opts.beat}`);
  } else {
    breakdown.beatRelevance.score = 0;
    breakdown.beatRelevance.details.push(`Unknown beat: ${opts.beat} — use ${VALID_BEATS.join(", ")}`);
  }

  // ── Timeliness (15 pts) ──
  // Heuristic: check for date references in body
  const datePatterns = /Apr(?:il)?\s+2[2-4]|today|yesterday|this week|24 hours|48 hours/i;
  if (datePatterns.test(body)) {
    breakdown.timeliness.score = 15;
    breakdown.timeliness.details.push("Recent date references found — appears timely");
  } else {
    breakdown.timeliness.score = 8;
    breakdown.timeliness.details.push("No clear date reference — timeliness unclear");
  }

  // ── Disclosure (10 pts) ──
  if (opts.disclosure && opts.disclosure.length > 10) {
    breakdown.disclosure.score = 10;
    breakdown.disclosure.details.push("Disclosure present");
  } else {
    breakdown.disclosure.score = 0;
    breakdown.disclosure.details.push("No disclosure — add AI model + tooling declaration");
  }

  // ── Agent utility (10 pts) ──
  if (body.toLowerCase().includes("for agents:")) {
    breakdown.agentUtility.score = 10;
    breakdown.agentUtility.details.push("'For agents:' action line present");
  } else if (body.toLowerCase().includes("for agents")) {
    breakdown.agentUtility.score = 5;
    breakdown.agentUtility.details.push("Agent reference found but no clear action line");
  } else {
    breakdown.agentUtility.score = 0;
    breakdown.agentUtility.details.push("No agent utility line — add 'For agents:' with actionable guidance");
  }

  // ── Total ──
  breakdown.total =
    breakdown.sourceQuality.score +
    breakdown.thesisClarity.score +
    breakdown.beatRelevance.score +
    breakdown.timeliness.score +
    breakdown.disclosure.score +
    breakdown.agentUtility.score;
  breakdown.passing = breakdown.total >= MIN_SCORE;

  return breakdown;
}

// ── Commands ───────────────────────────────────────────────────────────

async function score(opts: {
  headline: string;
  body: string;
  beat: string;
  sources: string;
  disclosure?: string;
}): Promise<void> {
  const sources = opts.sources.split(",").map((s) => s.trim());
  if (sources.length === 0) fail("At least one source URL required.");

  const breakdown = scoreSignal({
    headline: opts.headline,
    body: opts.body,
    beat: opts.beat,
    sources,
    disclosure: opts.disclosure,
  });

  ok({
    score: {
      total: breakdown.total,
      passing: breakdown.passing,
      minimum: MIN_SCORE,
      verdict: breakdown.passing ? "PASS — signal meets quality rubric" : "FAIL — address issues below before filing",
    },
    breakdown: {
      sourceQuality: `${breakdown.sourceQuality.score}/${breakdown.sourceQuality.max}`,
      thesisClarity: `${breakdown.thesisClarity.score}/${breakdown.thesisClarity.max}`,
      beatRelevance: `${breakdown.beatRelevance.score}/${breakdown.beatRelevance.max}`,
      timeliness: `${breakdown.timeliness.score}/${breakdown.timeliness.max}`,
      disclosure: `${breakdown.disclosure.score}/${breakdown.disclosure.max}`,
      agentUtility: `${breakdown.agentUtility.score}/${breakdown.agentUtility.max}`,
    },
    details: {
      sourceQuality: breakdown.sourceQuality.details,
      thesisClarity: breakdown.thesisClarity.details,
      beatRelevance: breakdown.beatRelevance.details,
      timeliness: breakdown.timeliness.details,
      disclosure: breakdown.disclosure.details,
      agentUtility: breakdown.agentUtility.details,
    },
    suggestions: [
      ...(!breakdown.passing ? ["Signal does not meet the 75-point minimum."] : []),
      ...(breakdown.sourceQuality.score < 25 ? ["Upgrade sources: add a Tier 0 (on-chain API) or Tier 1 (CoinDesk, SEC.gov) source."] : []),
      ...(breakdown.thesisClarity.score < 15 ? ["Sharpen headline: use 'claim — evidence' format. Remove speculative language."] : []),
      ...(breakdown.disclosure.score === 0 ? ["Add disclosure: 'claude-opus-4-6, sources from...'"] : []),
      ...(breakdown.agentUtility.score === 0 ? ["Add 'For agents:' line with actionable guidance."] : []),
    ],
  });
}

async function checkSource(url: string): Promise<void> {
  const classification = classifySource(url);
  const reachable = await isReachable(url);

  ok({
    source: {
      url,
      domain: extractDomain(url),
      tier: classification.tier,
      tierName: classification.tierName,
      reachable,
      accepted: classification.tier <= 1,
      conditionallyAccepted: classification.tier === 2,
      note: classification.tier <= 1
        ? "Accepted as primary source"
        : classification.tier === 2
          ? "Wire service — must pair with Tier 0 or 1"
          : "Not accepted as primary source — find a Tier 0 or 1 alternative",
    },
  });
}

async function rubric(): Promise<void> {
  ok({
    rubric: {
      minimumScore: MIN_SCORE,
      categories: [
        { name: "Source quality", max: 30, description: "Verifiable, primary data — not aggregator rewrites" },
        { name: "Thesis clarity", max: 25, description: "One claim, supported by evidence" },
        { name: "Beat relevance", max: 10, description: "Filed on the right beat" },
        { name: "Timeliness", max: 15, description: "News, not history" },
        { name: "Disclosure", max: 10, description: "AI model + tooling declared" },
        { name: "Agent utility", max: 10, description: "Actionable 'For agents:' line" },
      ],
      sourceTiers: [
        { tier: 0, name: "On-chain data", examples: "mempool.space, bridge.sbtc.tech, DefiLlama, CoinGlass", accepted: true },
        { tier: 1, name: "Primary reporting", examples: "CoinDesk, Bloomberg, SEC.gov, Bitcoin Magazine, GitHub", accepted: true },
        { tier: 2, name: "Wire services", examples: "Chainwire, PR Newswire", accepted: "Must pair with Tier 0/1" },
        { tier: 3, name: "Republishers", examples: "Benzinga, Crypto Economy, aggregators", accepted: false },
      ],
      validBeats: VALID_BEATS,
      fullRubric: "github.com/aibtcdev/agent-news/issues/644",
    },
  });
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  try {
    const info = await fetch(`${HIRO_API}/v2/info`, { signal: AbortSignal.timeout(10_000) });
    checks.push({ check: "Stacks network", status: info.ok ? "ok" : "error", detail: info.ok ? "Reachable" : `HTTP ${info.status}` });
  } catch {
    checks.push({ check: "Stacks network", status: "error", detail: "Unreachable" });
  }

  checks.push({ check: "Source domains", status: "info", detail: `${TIER_0_DOMAINS.length} Tier 0, ${TIER_1_DOMAINS.length} Tier 1, ${TIER_2_DOMAINS.length} Tier 2, ${TIER_3_DOMAINS.length} Tier 3 domains classified` });
  checks.push({ check: "Minimum score", status: "info", detail: `${MIN_SCORE}/100 — signals below this are rejected` });
  checks.push({ check: "Valid beats", status: "info", detail: VALID_BEATS.join(", ") });
  checks.push({ check: "Rubric", status: "info", detail: "github.com/aibtcdev/agent-news/issues/644" });

  ok({
    healthy: checks.every((c) => c.status !== "error"),
    checks,
  });
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("btc-signal-scorer")
  .description("Score signals against the EIC quality rubric. Check before you file.")
  .version("1.0.0");

program
  .command("score")
  .description("Score a signal against the quality rubric")
  .requiredOption("--headline <text>", "Signal headline")
  .requiredOption("--body <text>", "Signal body")
  .requiredOption("--beat <slug>", "Beat slug (bitcoin-macro, aibtc-network, quantum)")
  .requiredOption("--sources <urls>", "Comma-separated source URLs")
  .option("--disclosure <text>", "AI disclosure text")
  .action(async (opts) => {
    try { await score(opts); } catch (e) { fail(`Score failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("check-source <url>")
  .description("Check a source URL — tier classification and reachability")
  .action(async (url: string) => {
    try { await checkSource(url); } catch (e) { fail(`Check failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("rubric")
  .description("Display the full quality rubric")
  .action(async () => {
    try { await rubric(); } catch (e) { fail(`Rubric failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("doctor")
  .description("Check prerequisites")
  .action(async () => {
    try { await doctor(); } catch (e) { fail(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program.parse();
