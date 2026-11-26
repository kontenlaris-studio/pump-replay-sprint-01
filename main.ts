// Pump.fun Replay Sprint — paper bot entrypoint (agent-fun/replay/v2).
//
// This file only wires the strategy to the kit SDK's runBot loop: the SDK
// reads hello and batch lines, keeps the account state current, and writes
// the orders the strategy returns. All trading decisions live in
// strategy.ts, which keeps this adapter small enough to trust at a glance
// and lets the strategy be backtested on its own through the same Bot
// interface the harness uses.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
