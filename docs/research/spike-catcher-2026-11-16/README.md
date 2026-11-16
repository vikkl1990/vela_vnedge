# Can the bot catch pumps and dumps? (16 November 2026)

Question: markets pump and dump in minutes; can a scalper-style catcher long the pumps and short the dumps (or fade them) and make money after costs?

## Data and definition
Delta India 1-minute candles: 81 markets, 14 Oct to 14 Nov (2.6 million bars), and the last 80 hours of the 61 most liquid markets. An event is a 5-minute move of at least 5 standard deviations of that market's own 1-minute returns over the previous day and at least 1.2%, debounced 30 minutes per market and direction: 2,800 events (about 93 a day across the universe).

## Results
1. **Chasing loses** (`results-forward-returns.txt`). After a spike price continues only 35 to 43% of the time; going with it nets -11 to -20 bps after fees at 5 to 60 minutes. Fading is about break-even (-0.5 to +1 bps), better only on moves of 3% or more (+24 bps at 15 minutes, +33 at 60).
2. **Fading with real stops** (`results-fade.txt`). Short the pump or long the dump, stop beyond the spike's extreme, target a retrace, time exit. 72 variants: 11 positive, which chance gives. Best +17 bps on 367 events, 95% interval -11 to +43; the positive part is long-after-dump (+29 bps), shorts after pumps are about zero.
3. **Going with the spike, tight stop and trail** looked like +100 bps and positive in all 72 variants. That was the fill model: stops filled at the stop price even when the minute gapped through it, with 2 bps of slippage. With fills at the open when it opens through the stop: +7.6 bps at 2 bps slippage (interval -17 to +32, 7 of 72 positive), and negative everywhere at 10 to 15 bps slippage and beyond (`results-momentum-slip*.txt`).
4. **The last 72 hours** (`results-last-72h.txt`): 265 spikes on 61 liquid markets, 66% gave back at least half within an hour of the extreme. The largest are small caps (RARE +52%, AKE +36%, ASTER, SOPH, EVAA). Two-thirds of the move after detection is often still to come (RARE was +6.8% in 5 minutes when detected and ran to +52%), which is exactly why a stop is hit before the exhaustion.
5. **The bot's coverage** (`results-bot-coverage.txt`): the account held a position in 9% of those spikes (23 of 265), the shadow book in 45%. Shadow trades opened within 30 minutes after a spike lost -0.20R each (155 trades), with the spike and against it alike: scanners on 15m and above fire after the move, which is a chase.

## Limits
One month, mostly a falling market; 1-minute bars hide intrabar order, so any tight-stop result depends on the fill model (that is the whole story of result 3); the slippage figures are assumptions, not measurements of Delta's book during spikes; about 150 variants were tried, so only effects with a clear interval and both halves positive deserve belief and none qualified.

## Reading
No rule tested earns a reliable edge after costs, so no catcher is proposed for the account. The honest next step, if wanted, is a shadow-only forward experiment that records real fills during spikes, not another backtest.
