<div align="center">

<img src="assets/logo.png?v=1" width="280">

*Proven-demand scalp rider for the pump.fun replay: rides only coins with broad one-sided flow and deep reserves, mechanical exits.*

[![TypeScript](https://img.shields.io/badge/TypeScript-0A1931?style=for-the-badge&labelColor=FF7A00&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-0A1931?style=for-the-badge&labelColor=FF7A00)](LICENSE) [![By Kontenlaris Studio](https://img.shields.io/badge/By-Kontenlaris%20Studio-0A1931?style=for-the-badge&labelColor=FF7A00)](https://github.com/kontenlaris-studio)

</div>

---

# pump-replay-sprint-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kontenlaris-studio/pump-replay-sprint-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kontenlaris-studio/pump-replay-sprint-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for the 24-hour pump.fun replay sprint. It never chases a launch: a coin becomes a candidate only after broad, real demand is already visible — at least 8 SOL of real reserves, at least 1.5 SOL of buys in the last 90 slots with buys making up at least 75% of flow, at least 10 distinct buying wallets, a price up between 4% and 30% across the window and still within 8% of its high, and a creator who has never sold. Orders are 0.30 SOL, at most 3 open at once, always sized down to the harness's per-mint reserve cap. Exits are mechanical: take profit at +12%, a hard stop at −9%, a trailing exit that arms at +10% and fires 6% under the peak, a 1,200-slot maximum hold, and instant exits on a creator sell, a single 2 SOL sell, or window flow flipping to sellers. An exited mint cools down for 1,500 slots; a mint whose creator sells is banned outright.

## Why these parameters

The settings were tuned on the kit's dev window with full-tape sweeps, then deliberately kept coarse — thresholds a whole percentage point wide, not fitted decimals — because the final grade runs on a different 24 hours of chain data. Three changes from the previous edition's recipe did the work: the reserve floor dropped from 10 to 8 SOL (proven coins are admitted earlier, and more distinct mints clear the round-trip bar), the window-buy minimum dropped from 2 to 1.5 SOL (breadth and buy share already carry the confirmation), and the maximum hold rose from 800 to 1,200 slots (working scalps were being cut early). Breadth was tested stricter and looser and left at 10 wallets: both directions lost money.

## Testing status

Graded locally with the kit's own `grade-local` on the dev window (two executions, action logs identical): **net PnL +0.264572713 SOL**, 67 round trips over 56 coins, win rate 43.3%, max drawdown 1.47%, all guardrails met. The 90% interval is −0.019 to +0.577 SOL; without its 3 best coins the bot still nets +0.06 SOL, and at double fees it nets −0.052 SOL. For comparison, the previous edition's recipe scores +0.105 SOL on the same window. Block-bootstrap stress copies of the dev window were also run locally; the spread is wide, as it is for every entry in this format, and the median copy stays near break-even rather than depending on the dev tape's exact path.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=e1py682r&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
