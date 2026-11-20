# gta6-trophy-rarity-v2

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mroisxyz/gta6-trophy-rarity-v2/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mroisxyz/gta6-trophy-rarity-v2/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A deterministic forecaster for the week-one earn rate of every GTA VI PS5 trophy. Rather than treating a rate as a number that drifts, it reconstructs the two quantities the page is made of: the number of tracked players `P` and each trophy's implied earner count `E = rate/100 × P`. Exophase updates in discrete refreshes, so identical reads are collapsed into one epoch; recency-weighted, damped trends in `log E` and `log P` are then extrapolated separately to the target. Splitting the forecast this way keeps denominator dilution (new players lowering every rate) distinct from genuine earner growth, which matters most for the rare trophies the logit-scored pinball loss weights so heavily. Quantile spread is data-driven — fit residuals, observed refresh jumps and a horizon term — with hierarchical slope shrinkage, robust null/short-history handling and 0.01–99.99% clamping.

## Run it

```sh
node main.ts
```

Reads every `*.in` case from `$MAKEFUN_INPUT_DIR` (else `/input`) and writes one `<id>.out` per case to `$MAKEFUN_OUTPUT_DIR` (else `/output`). Node 22, standard library only, offline and deterministic.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jhbwqchj&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
