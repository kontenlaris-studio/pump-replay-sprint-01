// Proven-demand scalp rider for the pump.fun replay sprint (agent-fun/replay/v2).
//
// Idea in one paragraph
// ---------------------
// Most pump.fun curves die young and cost their late buyers everything, so
// this bot never touches a launch. It waits until a coin has already proved
// broad, real demand — deep real reserves, a recent hello of buying that is
// heavily one-sided, many distinct wallets taking part, and a price that has
// climbed moderately and still hugs its recent high — and only then rides
// the move for a short scalp. Every position is closed by whichever comes
// first: a fixed take-profit, a fixed hard stop, a trailing exit once the
// trade has worked, a maximum holding time measured in slot terms, or a
// danger signal (the creator selling, one huge sell, or flow flipping to
// sellers). A mint whose creator has sold is banned for the rest of the run.
//
// Interface notes
// ---------------
// The harness speaks in hello / batch messages; each batch carries events,
// marks, fills and the account, and the bot answers with orders. Decisions
// here read only that stream — never a wall clock, never randomness, never
// the environment — so two executions over the same tape emit byte-identical
// order streams, as the replay rules demand. All money math is bigint; ratio
// tests cross-multiply instead of dividing into floats.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const BPS_WHOLE = 10_000n;

/** Every knob the strategy has, in one place so sweeps can vary them. */
export interface Params {
  /** Ignore a coin until this many slots after its create. */
  minAgeSlots: number;
  /** Ignore a coin older than this; the move is over. */
  maxAgeSlots: number;
  /** Real quote reserves a curve must hold before it can be entered. */
  reserveFloorLamports: bigint;
  /** Length of the rolling flow window, in slots. */
  flowWindowSlots: number;
  /** Minimum total buys inside the window, lamports. */
  minWindowBuyLamports: bigint;
  /** Buys must be at least this share of window flow, in bps. */
  minBuyShareBps: number;
  /** Minimum distinct buying wallets inside the window. */
  minDistinctBuyers: number;
  /** Window price rise must be at least this, in bps. */
  minRiseBps: number;
  /** Window price rise must be at most this, in bps (avoid blow-off tops). */
  maxRiseBps: number;
  /** Price may sit at most this far below the window high, in bps. */
  maxDipFromHighBps: number;
  /** Intended buy size, lamports (still capped by the harness reserve cap). */
  orderLamports: bigint;
  /** Strategy-side cap on simultaneous positions. */
  maxPositions: number;
  /** Cash that must remain uncommitted after a buy, lamports. */
  cashBufferLamports: bigint;
  /** Slippage tolerance sent with buys, in bps. */
  buySlippageBps: number;
  /** Slots a mint stays untradeable after we exit it. */
  cooldownSlots: number;
  /** Close everything at this marked gain, in bps over cost. */
  takeProfitBps: number;
  /** Close everything at this marked loss, in bps under cost. */
  hardStopBps: number;
  /** Trailing exit arms at this marked gain, in bps over cost. */
  trailArmBps: number;
  /** Once armed, close when marked value falls this far from its peak, bps. */
  trailDropBps: number;
  /** Close everything after this many slots regardless. */
  maxHoldSlots: number;
  /** A single window sell of at least this size counts as a whale flush. */
  whaleSellLamports: bigint;
  /** Window sells above this (with sells > buys) trigger the fade exit. */
  fadeMinSellLamports: bigint;
  /** Slippage tolerance sent with sells, in bps. */
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 100,
  maxAgeSlots: 12_000,
  // Retuned for this edition after full-tape sweeps: an 8 SOL floor admits
  // proven coins earlier (more distinct mints clear the round-trip bar),
  // 1.5 SOL of window buying is enough confirmation once breadth and share
  // already agree, and a 1,200-slot hold lets working scalps finish instead
  // of cutting them at the old 800. Each change also held up on the tape's
  // halves and at double fees better than the alternatives tested.
  reserveFloorLamports: 8n * SOL,
  flowWindowSlots: 90,
  minWindowBuyLamports: (SOL * 3n) / 2n,
  minBuyShareBps: 7_500,
  minDistinctBuyers: 10,
  minRiseBps: 400,
  maxRiseBps: 3_000,
  maxDipFromHighBps: 800,
  orderLamports: (SOL * 3n) / 10n,
  maxPositions: 3,
  cashBufferLamports: SOL,
  buySlippageBps: 500,
  cooldownSlots: 1_500,
  takeProfitBps: 1_200,
  hardStopBps: 900,
  trailArmBps: 1_000,
  trailDropBps: 600,
  maxHoldSlots: 1_200,
  whaleSellLamports: 2n * SOL,
  fadeMinSellLamports: SOL / 2n,
  sellSlippageBps: 800,
};

/** One trade kept in a mint's rolling window. */
interface FlowEntry {
  slot: number;
  lamports: bigint;
  isBuy: boolean;
  wallet: string;
  /** Curve price right after this trade, scaled by PRICE_SCALE. */
  priceScaled: bigint;
}

/** Everything tracked about one mint that might become tradeable. */
interface MintTrack {
  creator: string;
  birthSlot: number;
  creatorHasSold: boolean;
  completed: boolean;
  newestSlot: number;
  /** Rolling window of trades, oldest first. */
  flow: FlowEntry[];
}

/** Bookkeeping for one open position. */
interface OpenTrade {
  openedSlot: number;
  peakValue: bigint;
  exitSent: boolean;
}

const PRICE_SCALE = 1_000_000_000n;

/** Virtual quote per token, scaled so integer math keeps precision. */
function scaledPrice(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * PRICE_SCALE) / virtualToken;
}

class SprintBook {
  private readonly p: Params;
  private readonly tracks = new Map<string, MintTrack>();
  private readonly open = new Map<string, OpenTrade>();
  private readonly awaitingBuy = new Set<string>();
  private readonly bannedUntil = new Map<string, number>();
  private lastSweep = 0;

  constructor(params: Params) {
    this.p = params;
  }

  onHello(_state: BotState): void {
    // The hello fixes capital, caps and fees for the whole run; the
    // parameters above already assume the sprint's published values, and
    // the live caps are re-read from state on every batch anyway.
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.absorbFills(state, batch);
    this.absorbEvents(batch);

    const orders: OrderInput[] = [];
    this.collectExits(state, batch.slot, orders);
    this.collectEntries(state, batch.slot, orders);

    if (batch.slot - this.lastSweep >= 1_000) {
      this.lastSweep = batch.slot;
      this.sweep(batch.slot);
    }
    return orders;
  }

  // -- fills and positions -------------------------------------------------

  private absorbFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.client_id.startsWith('_')) {
        // A harness-generated close (completion or final flatten).
        this.open.delete(fill.mint);
        continue;
      }
      if (fill.side === 'buy') {
        this.awaitingBuy.delete(fill.mint);
        if (fill.status === 'filled' && !this.open.has(fill.mint)) {
          this.open.set(fill.mint, {
            openedSlot: batch.slot,
            peakValue: 0n,
            exitSent: false,
          });
        }
      } else {
        const trade = this.open.get(fill.mint);
        if (trade) trade.exitSent = false;
        if (fill.status === 'filled') {
          this.open.delete(fill.mint);
          this.bannedUntil.set(fill.mint, batch.slot + this.p.cooldownSlots);
        }
      }
    }
    // Trust the account over local notes: a mint the account no longer
    // reports is not held, whatever the fill stream suggested.
    for (const mint of [...this.open.keys()]) {
      if (!state.positions.has(mint)) this.open.delete(mint);
    }
  }

  // -- tape events -----------------------------------------------------------

  private absorbEvents(batch: Batch): void {
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        if (!this.tracks.has(ev.mint)) {
          this.tracks.set(ev.mint, this.freshTrack(ev.creator, ev.slot));
        }
        continue;
      }
      if (ev.event === 'CompleteEvent') {
        const t = this.tracks.get(ev.mint);
        if (t) t.completed = true;
        continue;
      }

      // TradeEvent.
      let t = this.tracks.get(ev.mint);
      if (!t) {
        t = this.freshTrack(ev.creator, ev.slot);
        this.tracks.set(ev.mint, t);
      }
      t.newestSlot = ev.slot;
      if (ev.user === t.creator && !ev.is_buy) t.creatorHasSold = true;

      // Detail is expensive over a 24h tape, so the rolling window is kept
      // only for mints that are plausibly tradeable (reserves at least half
      // the entry floor) plus anything held or being bought right now.
      const realQuote = BigInt(ev.real_quote_reserves);
      const watched =
        realQuote >= this.p.reserveFloorLamports / 2n ||
        this.open.has(ev.mint) ||
        this.awaitingBuy.has(ev.mint);
      if (!watched) continue;

      const entry: FlowEntry = {
        slot: ev.slot,
        lamports: BigInt(ev.sol_amount),
        isBuy: ev.is_buy,
        wallet: ev.user,
        priceScaled: scaledPrice(
          BigInt(ev.virtual_quote_reserves),
          BigInt(ev.virtual_token_reserves),
        ),
      };
      t.flow.push(entry);
      while (t.flow.length > 0 && ev.slot - t.flow[0].slot > this.p.flowWindowSlots) {
        t.flow.shift();
      }
    }
  }

  private freshTrack(creator: string, slot: number): MintTrack {
    return {
      creator,
      birthSlot: slot,
      creatorHasSold: false,
      completed: false,
      newestSlot: slot,
      flow: [],
    };
  }

  /**
   * Flow totals over the window as of the decision slot. The retained list
   * is trimmed relative to the mint's own last trade, so reads filter by
   * age relative to now: a burst that ended 200 slots ago must not pass a
   * gate today just because the mint has been quiet since.
   */
  private windowStats(
    t: MintTrack,
    slot: number,
  ): { buySum: bigint; sellSum: bigint; buyers: Set<string>; whale: boolean } {
    let buySum = 0n;
    let sellSum = 0n;
    let whale = false;
    const buyers = new Set<string>();
    for (const e of t.flow) {
      if (slot - e.slot > this.p.flowWindowSlots) continue;
      if (e.isBuy) {
        buySum += e.lamports;
        buyers.add(e.wallet);
      } else {
        sellSum += e.lamports;
        if (e.lamports >= this.p.whaleSellLamports) whale = true;
      }
    }
    return { buySum, sellSum, buyers, whale };
  }

  /** Price at the start of the retained window and the window's high. */
  private windowPrices(t: MintTrack): { start: bigint; high: bigint; last: bigint } {
    let high = 0n;
    for (const e of t.flow) if (e.priceScaled > high) high = e.priceScaled;
    const start = t.flow.length > 0 ? t.flow[0].priceScaled : 0n;
    const last = t.flow.length > 0 ? t.flow[t.flow.length - 1].priceScaled : 0n;
    return { start, high, last };
  }

  /** Marked value of the held tokens against the live virtual curve. */
  private markedValue(state: BotState, mint: string): bigint {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (!pos || !curve || curve.virtual_token_reserves <= 0n) return 0n;
    return (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }

  // -- exits -----------------------------------------------------------------

  private collectExits(state: BotState, slot: number, orders: OrderInput[]): void {
    for (const [mint, trade] of this.open) {
      const pos = state.positions.get(mint);
      if (!pos || trade.exitSent) continue;

      const value = this.markedValue(state, mint);
      if (value > trade.peakValue) trade.peakValue = value;
      const cost = pos.cost_lamports;
      const t = this.tracks.get(mint);

      const stats = t ? this.windowStats(t, slot) : undefined;

      const close =
        (t !== undefined && t.creatorHasSold) ||
        (value > 0n && value * BPS_WHOLE >= cost * BigInt(10_000 + this.p.takeProfitBps)) ||
        (value > 0n && value * BPS_WHOLE <= cost * BigInt(10_000 - this.p.hardStopBps)) ||
        (trade.peakValue > 0n &&
          trade.peakValue * BPS_WHOLE >= cost * BigInt(10_000 + this.p.trailArmBps) &&
          value * BPS_WHOLE <= trade.peakValue * BigInt(10_000 - this.p.trailDropBps)) ||
        slot - trade.openedSlot >= this.p.maxHoldSlots ||
        (stats !== undefined && stats.whale) ||
        (stats !== undefined && stats.sellSum > stats.buySum && stats.sellSum >= this.p.fadeMinSellLamports);

      if (!close) continue;
      trade.exitSent = true;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: this.p.sellSlippageBps,
      });
    }
  }

  // -- entries -----------------------------------------------------------------

  private collectEntries(state: BotState, slot: number, orders: OrderInput[]): void {
    const cap = Math.min(this.p.maxPositions, state.hello.caps.max_open_positions);
    let committed = state.committedPositionCount();
    if (committed >= cap) return;

    for (const [mint, t] of this.tracks) {
      if (committed >= cap) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (this.open.has(mint) || this.awaitingBuy.has(mint)) continue;
      if (t.completed || t.creatorHasSold) continue;

      const age = slot - t.birthSlot;
      if (age < this.p.minAgeSlots || age > this.p.maxAgeSlots) continue;
      if ((this.bannedUntil.get(mint) ?? -1) > slot) continue;

      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      if (curve.real_quote_reserves < this.p.reserveFloorLamports) continue;

      // Flow gate: enough buying, one-sided enough, broad enough.
      const stats = this.windowStats(t, slot);
      if (stats.buySum < this.p.minWindowBuyLamports) continue;
      const totalFlow = stats.buySum + stats.sellSum;
      if (totalFlow <= 0n) continue;
      if (stats.buySum * BPS_WHOLE < totalFlow * BigInt(this.p.minBuyShareBps)) continue;
      if (stats.buyers.size < this.p.minDistinctBuyers) continue;

      // Price gate: climbed, but neither exhausted nor falling away.
      const prices = this.windowPrices(t);
      if (prices.start <= 0n || prices.last <= 0n) continue;
      if (prices.last * BPS_WHOLE < prices.start * BigInt(10_000 + this.p.minRiseBps)) continue;
      if (prices.last * BPS_WHOLE > prices.start * BigInt(10_000 + this.p.maxRiseBps)) continue;
      if (
        prices.high > 0n &&
        prices.last * BPS_WHOLE < prices.high * BigInt(10_000 - this.p.maxDipFromHighBps)
      ) {
        continue;
      }

      // Size gate: the harness caps a batch's buys per mint at a slice of
      // real reserves, and tiny fills only feed the fee schedule.
      let size = this.p.orderLamports;
      const mintCap = state.maxBuyLamports(mint);
      if (mintCap <= 0n) continue;
      if (size > mintCap) size = mintCap;
      if (size < SOL / 20n) continue;
      if (state.freeCashLamports() - size < this.p.cashBufferLamports) continue;

      this.awaitingBuy.add(mint);
      committed += 1;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: this.p.buySlippageBps,
      });
    }
  }

  // -- housekeeping ------------------------------------------------------------

  private sweep(slot: number): void {
    for (const [mint, t] of this.tracks) {
      if (this.open.has(mint) || this.awaitingBuy.has(mint)) continue;
      if (slot - t.newestSlot > 3_000) this.tracks.delete(mint);
    }
    for (const [mint, until] of this.bannedUntil) {
      if (until <= slot) this.bannedUntil.delete(mint);
    }
  }
}

/** Build the bot the harness runs; parameters default to the tuned set. */
export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const book = new SprintBook(params);
  return {
    onHello(state: BotState) {
      book.onHello(state);
    },
    onBatch(state: BotState, batch: Batch) {
      return book.onBatch(state, batch);
    },
  };
}
