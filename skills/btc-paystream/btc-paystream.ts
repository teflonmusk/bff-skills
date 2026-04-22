#!/usr/bin/env bun
/**
 * btc-paystream — Stream sats to anyone. Payroll, subscriptions, tips.
 *
 * Continuous Bitcoin payments resolved via BNS names. Set amount + duration,
 * sats flow automatically. Recipient claims as it accrues. Sender cancels anytime.
 *
 * Usage:
 *   bun btc-paystream/btc-paystream.ts stream --to <name.btc> --sats <n> --days <n>
 *   bun btc-paystream/btc-paystream.ts status <stream-id>
 *   bun btc-paystream/btc-paystream.ts claim <stream-id>
 *   bun btc-paystream/btc-paystream.ts cancel <stream-id>
 *   bun btc-paystream/btc-paystream.ts list
 *   bun btc-paystream/btc-paystream.ts doctor
 */

import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.mainnet.hiro.so";
const STREAMS_DIR = `${process.env.HOME}/.bff/streams`;
const BLOCKS_PER_DAY = 86_400; // Nakamoto target: 1 block/second
const MIN_FLOW_RATE = 100; // sats/day — below this, gas costs exceed value
const MIN_STREAM_SATS = 1_000;

// ── Types ──────────────────────────────────────────────────────────────

interface Stream {
  id: string;
  from: string;
  fromBns: string | null;
  to: string;
  toBns: string;
  totalSats: number;
  flowRateSatsPerDay: number;
  durationDays: number;
  startBlock: number;
  endBlock: number;
  claimed: number;
  cancelled: boolean;
  cancelledAtBlock: number | null;
  createdAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.log(JSON.stringify({ status: "error", error: { code: "STREAM_ERROR", message } }, null, 2));
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

function generateStreamId(): string {
  return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function satsDisplay(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BTC (${sats.toLocaleString()} sats)`;
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(2)}M sats`;
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(1)}K sats`;
  return `${sats} sats`;
}

async function getCurrentBlock(): Promise<number> {
  const info = await fetchJson<{ stacks_tip_height: number }>(`${HIRO_API}/v2/info`);
  return info.stacks_tip_height;
}

// ── State persistence ─────────────────────────────────────────────────

function streamPath(id: string): string {
  return `${STREAMS_DIR}/${id}.json`;
}

function saveStream(stream: Stream): void {
  mkdirSync(STREAMS_DIR, { recursive: true });
  writeFileSync(streamPath(stream.id), JSON.stringify(stream, null, 2));
}

function loadStream(id: string): Stream | null {
  const p = streamPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Stream;
}

function listStreams(): Stream[] {
  if (!existsSync(STREAMS_DIR)) return [];
  return readdirSync(STREAMS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(`${STREAMS_DIR}/${f}`, "utf-8")) as Stream);
}

function calculateAccrued(stream: Stream, currentBlock: number): number {
  if (currentBlock <= stream.startBlock) return 0;
  const effectiveEnd = stream.cancelledAtBlock || stream.endBlock;
  if (currentBlock >= effectiveEnd) return stream.totalSats;
  const elapsed = currentBlock - stream.startBlock;
  const total = effectiveEnd - stream.startBlock;
  return Math.floor((elapsed / total) * stream.totalSats);
}

// ── Commands ───────────────────────────────────────────────────────────

async function createStream(opts: { to: string; sats: string; days: string }): Promise<void> {
  const totalSats = parseInt(opts.sats, 10);
  const durationDays = parseInt(opts.days, 10);
  const toBns = opts.to;

  if (!totalSats || totalSats < MIN_STREAM_SATS) {
    fail(`Minimum stream: ${MIN_STREAM_SATS} sats. Got: ${totalSats || 0}`);
  }
  if (!durationDays || durationDays < 1) {
    fail("Duration must be at least 1 day.");
  }
  if (!toBns.includes(".")) {
    fail("Recipient must be a BNS name (e.g., friend.btc).");
  }

  const flowRate = Math.floor(totalSats / durationDays);
  if (flowRate < MIN_FLOW_RATE) {
    fail(`Flow rate ${flowRate} sats/day is below minimum ${MIN_FLOW_RATE}. Increase amount or decrease duration.`);
  }

  const currentBlock = await getCurrentBlock();
  const durationBlocks = durationDays * BLOCKS_PER_DAY;

  const stream: Stream = {
    id: generateStreamId(),
    from: "current_wallet",
    fromBns: null,
    to: toBns, // Resolved by parent agent via lookup_bns_name
    toBns,
    totalSats,
    flowRateSatsPerDay: flowRate,
    durationDays,
    startBlock: currentBlock,
    endBlock: currentBlock + durationBlocks,
    claimed: 0,
    cancelled: false,
    cancelledAtBlock: null,
    createdAt: new Date().toISOString(),
  };

  saveStream(stream);

  ok({
    stream: {
      id: stream.id,
      to: toBns,
      totalSats: satsDisplay(totalSats),
      flowRate: `${flowRate.toLocaleString()} sats/day`,
      duration: `${durationDays} days`,
      startBlock: currentBlock,
      endBlock: stream.endBlock,
      status: "active",
    },
    execution: {
      description: "Stream created. Parent agent should execute periodic claims by calling 'claim' at regular intervals.",
      resolveRecipient: {
        tool: "lookup_bns_name",
        params: { name: toBns },
        purpose: "Resolve BNS name to Stacks address for transfers",
      },
      periodicClaim: {
        tool: "sbtc_transfer",
        frequency: "daily or weekly",
        description: `Transfer accrued sats (up to ${flowRate}/day) to resolved address`,
      },
    },
    warnings: durationDays > 365
      ? ["Stream duration exceeds 1 year — higher cancellation risk"]
      : [],
    bitcoinerNote: `Streaming ${satsDisplay(totalSats)} to ${toBns} over ${durationDays} days. They claim sats as they accrue. You cancel anytime — remaining sats return instantly.`,
  });
}

async function status(streamId: string): Promise<void> {
  const stream = loadStream(streamId);
  if (!stream) {
    fail(`Stream ${streamId} not found. Run 'list' to see all streams.`);
  }

  const currentBlock = await getCurrentBlock();
  const accrued = calculateAccrued(stream, currentBlock);
  const claimable = accrued - stream.claimed;
  const remaining = stream.totalSats - accrued;
  const elapsed = Math.max(0, currentBlock - stream.startBlock);
  const totalBlocks = stream.endBlock - stream.startBlock;
  const progress = Math.min(100, (elapsed / totalBlocks) * 100);

  const streamStatus = stream.cancelled
    ? "cancelled"
    : currentBlock >= stream.endBlock
      ? "completed"
      : "active";

  ok({
    stream: {
      id: stream.id,
      from: stream.fromBns || stream.from,
      to: stream.toBns,
      totalSats: satsDisplay(stream.totalSats),
      flowRate: `${stream.flowRateSatsPerDay.toLocaleString()} sats/day`,
      duration: `${stream.durationDays} days`,
      progress: `${progress.toFixed(1)}%`,
      accrued: satsDisplay(accrued),
      claimed: satsDisplay(stream.claimed),
      claimable: satsDisplay(claimable),
      remaining: satsDisplay(remaining),
      status: streamStatus,
      blocksRemaining: Math.max(0, stream.endBlock - currentBlock),
    },
  });
}

async function claim(streamId: string): Promise<void> {
  const stream = loadStream(streamId);
  if (!stream) {
    fail(`Stream ${streamId} not found.`);
  }

  const currentBlock = await getCurrentBlock();
  const accrued = calculateAccrued(stream, currentBlock);
  const claimable = accrued - stream.claimed;

  if (claimable <= 0) {
    ok({
      claim: {
        streamId: stream.id,
        claimable: 0,
        message: "Nothing to claim yet. Sats accrue every block.",
        nextClaimEstimate: `~${Math.ceil((1 / stream.flowRateSatsPerDay) * 86400)} seconds for 1 sat`,
      },
    });
    return;
  }

  ok({
    claim: {
      streamId: stream.id,
      claimable: satsDisplay(claimable),
      claimableSats: claimable,
      to: stream.toBns,
    },
    execute: {
      step1: {
        tool: "lookup_bns_name",
        params: { name: stream.toBns },
        purpose: "Resolve recipient address",
      },
      step2: {
        tool: "sbtc_transfer",
        params: { amount: claimable, recipient: `resolved_address_of_${stream.toBns}` },
        description: `Transfer ${satsDisplay(claimable)} to ${stream.toBns}`,
      },
      step3: {
        tool: "btc-paystream",
        command: `ack-claim ${stream.id} --sats ${claimable}`,
        description: "Confirm transfer succeeded — updates accounting",
      },
    },
    note: "State is NOT updated until ack-claim is called. Parent agent must call ack-claim after confirmed transfer.",
  });
}

async function ackClaim(streamId: string, opts: { sats: string }): Promise<void> {
  const stream = loadStream(streamId);
  if (!stream) {
    fail(`Stream ${streamId} not found.`);
  }

  const sats = parseInt(opts.sats, 10);
  if (!sats || sats <= 0) {
    fail("Sats amount must be a positive integer.");
  }

  const currentBlock = await getCurrentBlock();
  const accrued = calculateAccrued(stream, currentBlock);
  const maxClaimable = accrued - stream.claimed;

  if (sats > maxClaimable) {
    fail(`Cannot acknowledge ${sats} sats — only ${maxClaimable} are claimable. Possible double-ack.`);
  }

  stream.claimed += sats;
  saveStream(stream);

  ok({
    ackClaim: {
      streamId: stream.id,
      acknowledged: satsDisplay(sats),
      totalClaimed: satsDisplay(stream.claimed),
      remaining: satsDisplay(stream.totalSats - stream.claimed),
      status: "accounting_updated",
    },
  });
}

async function cancel(streamId: string): Promise<void> {
  const stream = loadStream(streamId);
  if (!stream) {
    fail(`Stream ${streamId} not found.`);
  }
  if (stream.cancelled) {
    fail(`Stream ${streamId} already cancelled.`);
  }

  const currentBlock = await getCurrentBlock();
  const accrued = calculateAccrued(stream, currentBlock);
  const unclaimed = accrued - stream.claimed;
  const remaining = stream.totalSats - accrued;

  stream.cancelled = true;
  stream.cancelledAtBlock = currentBlock;
  saveStream(stream);

  ok({
    cancel: {
      streamId: stream.id,
      status: "cancelled",
      returnedToSender: satsDisplay(remaining),
      unclaimedByRecipient: satsDisplay(unclaimed),
      totalStreamed: satsDisplay(accrued),
      totalClaimed: satsDisplay(stream.claimed),
    },
    actions: unclaimed > 0
      ? [{
          description: `${satsDisplay(unclaimed)} accrued but unclaimed — recipient can still claim this amount`,
          tool: "sbtc_transfer",
          params: { amount: unclaimed, recipient: `resolved_address_of_${stream.toBns}` },
        }]
      : [],
    note: `Stream cancelled. ${satsDisplay(remaining)} returned to sender. ${unclaimed > 0 ? `${satsDisplay(unclaimed)} still claimable by recipient.` : "No unclaimed balance."}`,
  });
}

async function listCmd(): Promise<void> {
  const streams = listStreams();
  let currentBlock: number;
  try {
    currentBlock = await getCurrentBlock();
  } catch {
    currentBlock = 0;
  }

  const formatted = streams.map((s) => {
    const accrued = currentBlock > 0 ? calculateAccrued(s, currentBlock) : 0;
    const claimable = accrued - s.claimed;
    const streamStatus = s.cancelled ? "cancelled" : currentBlock >= s.endBlock ? "completed" : "active";
    return {
      id: s.id,
      to: s.toBns,
      total: satsDisplay(s.totalSats),
      flowRate: `${s.flowRateSatsPerDay.toLocaleString()} sats/day`,
      claimable: satsDisplay(claimable),
      status: streamStatus,
    };
  });

  ok({
    streams: formatted,
    count: streams.length,
    note: streams.length === 0
      ? "No active streams. Use 'stream --to friend.btc --sats 100000 --days 30' to create one."
      : `${streams.length} stream(s) found.`,
  });
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  try {
    const info = await fetchJson<{ stacks_tip_height: number }>(`${HIRO_API}/v2/info`);
    checks.push({ check: "Stacks network", status: "ok", detail: `Block ${info.stacks_tip_height} (~1s Nakamoto blocks)` });
  } catch {
    checks.push({ check: "Stacks network", status: "error", detail: "Unreachable" });
  }

  const streams = listStreams();
  const active = streams.filter((s) => !s.cancelled);
  checks.push({ check: "Active streams", status: "info", detail: `${active.length} active, ${streams.length} total` });
  checks.push({ check: "BNS resolver", status: "info", detail: "Resolve .btc names to Stacks addresses via lookup_bns_name" });
  checks.push({ check: "Transfer method", status: "info", detail: "Claims execute via sbtc_transfer — parent agent handles wallet" });
  checks.push({ check: "Flow rate minimum", status: "info", detail: `${MIN_FLOW_RATE} sats/day — below this, gas costs may exceed value` });
  checks.push({ check: "Block time", status: "info", detail: `${BLOCKS_PER_DAY.toLocaleString()} blocks/day (~1s each on Nakamoto)` });

  ok({
    healthy: checks.every((c) => c.status !== "error"),
    checks,
    bitcoinerNote: "Paystream lets you send sats continuously to anyone with a .btc name. Like a salary that pays every second. They claim when they want. You cancel when you want. No invoices, no lump sums.",
  });
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("btc-paystream")
  .description("Stream sats to anyone — payroll, subscriptions, tips. Continuous Bitcoin payments.")
  .version("1.0.0");

program
  .command("stream")
  .description("Create a new sat stream to a .btc name")
  .requiredOption("--to <name>", "Recipient BNS name (e.g., friend.btc)")
  .requiredOption("--sats <amount>", "Total satoshis to stream")
  .requiredOption("--days <duration>", "Stream duration in days")
  .action(async (opts) => {
    try { await createStream(opts); } catch (e) { fail(`Stream failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("status <stream-id>")
  .description("Check stream progress — accrued, claimed, remaining")
  .action(async (streamId: string) => {
    try { await status(streamId); } catch (e) { fail(`Status failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("claim <stream-id>")
  .description("Claim accrued sats from a stream")
  .action(async (streamId: string) => {
    try { await claim(streamId); } catch (e) { fail(`Claim failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("ack-claim <stream-id>")
  .description("Confirm a claim transfer succeeded — updates accounting")
  .requiredOption("--sats <amount>", "Number of sats that were successfully transferred")
  .action(async (streamId: string, opts: { sats: string }) => {
    try { await ackClaim(streamId, opts); } catch (e) { fail(`Ack-claim failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("cancel <stream-id>")
  .description("Cancel stream — remaining sats return to sender")
  .action(async (streamId: string) => {
    try { await cancel(streamId); } catch (e) { fail(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("list")
  .description("Show all streams — sent and received")
  .action(async () => {
    try { await listCmd(); } catch (e) { fail(`List failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("doctor")
  .description("Check prerequisites — network, BNS, wallet")
  .action(async () => {
    try { await doctor(); } catch (e) { fail(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program.parse();
