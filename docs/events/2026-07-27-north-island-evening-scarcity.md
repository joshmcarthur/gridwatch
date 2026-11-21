# Monday 27 July 2026: North Island evening scarcity with price separation

Hand reconstruction for [#21](https://github.com/joshmcarthur/gridwatch/issues/21). Owner choice, 22 November 2026 (Pacific/Auckland): candidate 1, this evening.

Every number below comes from [`2026-07-27-north-island-evening-scarcity.sql`](2026-07-27-north-island-evening-scarcity.sql). Run it from the repo root after collecting and publishing trading date 2026-07-27:

```bash
duckdb < docs/events/2026-07-27-north-island-evening-scarcity.sql
```

Gold is the published analysis tables; silver is the cleaned files they read. Gold period prices are the time-weighted mean of dispatch publishes in that 30-minute trading period (a price applies until the next publish in the same period; [ADR-0012](../adr/0012-gold-prices.md) rule B). Dollars are New Zealand dollars per megawatt-hour ($/MWh). Average megawatts are energy in the half-hour, times two.

## Confidence

Claims use the three levels in the project brief, section 7.2.

| Level | Meaning |
| --- | --- |
| **Confirmed** | Direct official market data or a published notice establishes the fact. |
| **Strong evidence** | Several observations support the reading. |
| **Possible explanation** | Consistent with the data, not independently established. |

A fact from gold or silver is **confirmed** in these tables. A fact that appears only in the Electricity Authority trading conduct report is **confirmed** as a published notice, and is marked so that it is not mistaken for a gold number. Correlation is not treated as cause.

## Sources

- Gold and silver for trading date 2026-07-27, published in this environment on 21 November 2026 UTC. All seven input datasets for the date are `complete` (Q1). Gold `inputs_complete` is true on every period row used below. No proxy prices (Q1b).
- Mapping snapshots: network supply points dated 2026-07-25; generation fleet dated 2026-11-22 (the current file; entity mappings use the oldest fleet snapshot when none is as old as the day).
- [Electricity Authority, *Trading conduct report 26 July – 1 August 2026*](https://www.ea.govt.nz/documents/10647/Trading_conduct_report_-_26_July_2026.pdf). The file name says 26 July; the report covers 26 July to 1 August.

This collect is one trading day of daily files plus the July 2026 monthly Generation_MD and HVDC_Flows files, not a 12-month backfill. Detector baselines need 28 earlier days, so this collect writes no observations (Q13).

## The evening in one page

Monday 27 July 2026 is an ordinary 48-period winter weekday. New Zealand is on standard time (UTC+12). Trading period 1 is 00:00–00:30. Period 36 is 17:30–18:00.

In period 36 the wholesale price at Ōtāhuhu (`OTA2201`, the upper North Island reference node) is **$3,296.04/MWh**. Haywards (`HAY2201`, lower North Island, the North Island end of the Cook Strait link) is **$2,853.43**. Benmore (`BEN2201`, South Island, the other end of the link) is **$571.46** (Q4). The Ōtāhuhu–Benmore spread is **$2,724.58/MWh** (Q5). North Island 60-second reserve (SIR) is **$2,154.45/MWh**; South Island SIR is **$0** (Q8).

That Ōtāhuhu period price and the Benmore period price match the Authority report ($3,296 and $571 at 5.30pm). North Island SIR matches the report ($2,154). **Confirmed.**

National wind in that half-hour is 150 MW. North Island coal/gas (the Huntly Rankine units) and gas ramp from 262 MW at 15:30 to 747 MW at 17:30 (Q10d). The high-voltage direct current (HVDC) link across Cook Strait runs north all day. The highest 30-minute average at Haywards is 1,098 MW at 16:30–17:00, an hour before the price spike; in period 36 it is 966 MW (Q9c, Q9b). **Confirmed.**

The same half-hour contains an 85-second dispatch publish of **$21,000/MWh** at Hepburn Road (`HEP0331`) (Q7b). The period-weighted price at that node is $3,377.46, because the rest of the half-hour is much cheaper (Q7d). Gold period prices for this half-hour sit in the thousands of dollars. **Confirmed.**

## What happened

### Prices

Gold tracks three reference nodes ([ADR-0012](../adr/0012-gold-prices.md)). Daily means on this date are ordinary next to the evening: Ōtāhuhu $248.67, Haywards $214.72, Benmore $70.60. The highest published *row* at Ōtāhuhu is $20,459.18, because `min_price` / `max_price` on the daily summary are extrema of dispatch publishes, not of period prices (Q2). **Confirmed.**

Reference-node period prices (Q3, Q4):

| Period | NZST | Ōtāhuhu | Haywards | Benmore |
| ---: | --- | ---: | ---: | ---: |
| 16 | 07:30–08:00 | 1,228.29 | 1,066.20 | 145.23 |
| 34 | 16:30–17:00 | 156.25 | 130.14 | 22.36 |
| 35 | 17:00–17:30 | 141.04 | 119.64 | 54.09 |
| **36** | **17:30–18:00** | **3,296.04** | **2,853.43** | **571.46** |
| 37 | 18:00–18:30 | 1,311.29 | 1,133.28 | 258.10 |
| 38 | 18:30–19:00 | 1,038.33 | 892.53 | 83.41 |
| 39 | 19:00–19:30 | 1,116.46 | 963.99 | 94.70 |
| 40 | 19:30–20:00 | 215.57 | 183.95 | 101.00 |

The evening spike lasts four trading periods (36–39), then drops. Period 16 (07:30–08:00) is a second, smaller North Island spike; the Authority later published a customer advice notice (CAN) covering 07:30–08:30. **Confirmed** for the prices. The notice itself is **confirmed** from the report.

Ōtāhuhu minus Benmore (Q5, Q5b):

| Period | NZST | Spread $/MWh |
| ---: | --- | ---: |
| 16 | 07:30–08:00 | 1,083.06 |
| 34 | 16:30–17:00 | 133.89 |
| **36** | **17:30–18:00** | **2,724.58** |
| 37 | 18:00–18:30 | 1,053.19 |
| 38 | 18:30–19:00 | 954.92 |
| 39 | 19:00–19:30 | 1,021.77 |

Haywards sits with Ōtāhuhu, not with Benmore: the Haywards–Benmore spread in period 36 is $2,281.97; Ōtāhuhu–Haywards is $442.61 (Q5). The split is between the islands, with a further step up into Auckland. **Confirmed.**

Across all 246 priced points of connection, the period-36 median period price is $2,918.21 and the maximum period price is $3,557.49 at Maungaturoto (`MTO0331`) (Q6, Q7d). Period-weighted prices do not reach $21,000 anywhere. **Confirmed.**

### The 85 seconds at Hepburn Road

Dispatch energy prices (silver) for period 36 at Hepburn Road, Ōtāhuhu and Benmore (Q7):

| NZST | HEP0331 | OTA2201 | BEN2201 |
| --- | ---: | ---: | ---: |
| 17:29:43 | 146.94 | 143.61 | 41.50 |
| 17:34:47 | 215.46 | 210.42 | 95.76 |
| 17:39:40 | 290.15 | 283.36 | 107.25 |
| 17:45:33 | 3,395.32 | 3,315.89 | 151.31 |
| **17:50:26** | **21,000.00** | **20,459.18** | **9,793.96** |
| 17:51:51 | 7,996.51 | 7,809.20 | 151.31 |
| 17:54:44 | 5,406.57 | 5,279.74 | 151.30 |

Hepburn Road publishes exactly $21,000.00 at 17:50:26 NZST. The next publish is 85 seconds later (Q7b). The Authority report says scheduling, pricing and dispatch (SPD) flagged energy scarcity at Hepburn Road for 84 seconds and that energy scarcity sets the node to $21,000/MWh. The $21,000 publish and the 85-second gap are **confirmed** in dispatch prices. The scarcity *flag* and the 84-second SPD run are **confirmed** only as the report’s account; these tables have no SPD case files.

At the same instant, 39 points of connection publish at or above $20,000, and 207 publish at or above $10,000. The highest publish is $22,070.66 at Wellsford (`WEL0331`) (Q7c). Benmore itself publishes $9,793.96 for those 85 seconds, then returns to $151. **Confirmed.**

So two facts sit together. The period-weighted prices show island separation. The 85-second publish is high at both ends of the link, then the South Island drops and the North Island stays high. A detector that only sees period means will report ~$3,300 at Ōtāhuhu, not $21,000. The $21,000 is in `max_price` of the period row ($20,459.18 at Ōtāhuhu; $21,000.00 at Hepburn Road) (Q4, Q7d). **Confirmed.**

### Reserves

FIR is 6-second instantaneous reserve. SIR is 60-second. Gold holds one period price per class and island ([ADR-0013](../adr/0013-gold-reserve-prices.md)).

| Period | NZST | FIR NI | SIR NI | FIR SI | SIR SI | SIR NI max row |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 16 | 07:30–08:00 | 10.90 | 895.38 | 0.00 | 0.00 | 2,660.92 |
| 35 | 17:00–17:30 | 7.00 | 49.78 | 0.00 | 0.00 | 81.14 |
| **36** | **17:30–18:00** | **49.93** | **2,154.45** | **0.00** | **0.00** | **6,500.00** |
| 37 | 18:00–18:30 | 5.00 | 835.13 | 0.00 | 0.00 | 4,375.05 |
| 38 | 18:30–19:00 | 10.00 | 787.79 | 0.00 | 0.00 | 4,401.50 |
| 39 | 19:00–19:30 | 4.97 | 851.46 | 0.00 | 0.00 | 4,424.61 |

(Q8). South Island reserve stays at or near $0 through the evening. North Island SIR is the product that spikes. **Confirmed.**

SIR publishes in period 36 (Q8c): $69.82, $65.91, $99.00, $2,609.91, then **$6,500.00** at 17:50:26 and 17:51:51, then $4,310.15. The Authority report says a SIR scarcity price of $6,500 occurred for one 5-minute period. The $6,500 publishes are **confirmed**. Calling that interval “scarcity pricing” is **confirmed** from the report, not from an SPD case.

### Generation

National metered generation on the day (Q10b), battery separate because it is storage ([ADR-0008](../adr/0008-entity-model.md)):

| Fuel | MWh | Average MW |
| --- | ---: | ---: |
| hydro | 96,683.5 | 4,028.5 |
| geothermal | 30,192.5 | 1,258.0 |
| gas | 4,599.9 | 191.7 |
| wind | 4,476.2 | 186.5 |
| coal/gas (Huntly Rankine) | 4,117.8 | 171.6 |
| solar | 739.5 | 30.8 |
| other | 321.5 | 13.4 |
| battery | 165.6 | 6.9 |

Hydro is 68.5% of primary energy (battery excluded) (Q10g). Wind averages 186.5 MW, with a day range of 91.1–289.3 MW (Q10e). The Authority’s weekly wind range was 22–1,066 MW with a mean of 460 MW; this Monday sits at the low end of that week. **Confirmed** in gold that wind is low on this day. Comparison with the weekly mean is **confirmed** from the report, not from this one-day collect.

Evening ramp, average MW (Q10d):

| Period | NZST | Coal/gas | Gas | Thermal | NI hydro | SI hydro | NI wind | NZ wind |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 15:30–16:00 | 151.9 | 110.4 | 262.3 | 1,026.6 | 2,935.8 | 59.3 | 114.8 |
| 34 | 16:30–17:00 | 206.4 | 204.5 | 410.9 | 1,224.1 | 3,132.1 | 49.9 | 125.8 |
| 35 | 17:00–17:30 | 255.9 | 309.5 | 565.4 | 1,412.0 | 3,208.5 | 46.8 | 139.0 |
| **36** | **17:30–18:00** | **295.5** | **451.2** | **746.7** | **1,571.9** | **3,207.8** | **69.3** | **150.0** |
| 37 | 18:00–18:30 | 353.2 | 460.4 | 813.5 | 1,580.3 | 3,206.2 | 93.7 | 171.5 |

Thermal (coal/gas plus gas) rises 484 MW between 15:30 and 17:30, and another 67 MW by 18:00. North Island hydro rises 545 MW over the same 15:30–17:30 window. South Island hydro is already high. Wind does not provide the extra megawatts. **Confirmed.**

Selected plants in period 36 (Q11e):

| Plant | Fuel | Average MW |
| --- | --- | ---: |
| Huntly Rankine (`HLY/huntly_1_4`) | coal/gas | 295.5 |
| Stratford (`SFD/stratford`) | gas | 172.4 |
| Junction Road | gas | 90.3 |
| McKee | gas | 83.8 |
| Huntly 6 / P40 (`HLY/huntly_p40`) | gas | 45.9 |
| Ruakākā Energy Park | battery | 40.6 |
| Whirinaki | other | 7.8 |

Huntly Rankine output in period 32 is 151.9 MW and in period 37 is 353.2 MW (Q11b). Huntly 6 (P40) is 0 MW through period 34, 40.4 MW in period 35, 45.9 MW in period 36 (Q11f). Junction Road starts in period 33; McKee in period 34 (Q11f). Whirinaki is 0 MW through period 35, 7.8 MW in period 36, 35.4 MW in period 37 (Q11b). Fleet fuel code for Whirinaki is `DSL` (diesel) (Q14b). **Confirmed.**

There is no Generation_MD row for Huntly 5 (Q11d). Fleet nameplate for that unit is 403 MW of gas (Q14b). Day totals for Huntly plants are Rankine, P40 and the Rotohiko battery only (Q11c). **Confirmed** that Huntly 5 did not meter generation. The Authority report lists Huntly 5 on full outage until 10 August: **confirmed** from the report. Gold cannot name the outage.

### HVDC transfer

Gold transfer is metered HVDC_Flows, not an island residual ([ADR-0016](../adr/0016-hvdc-flows.md)). Positive is northward at Haywards.

The day is northbound the whole way: 21,493.034 MWh received at Haywards, 895.5 MW day average (Q9). Highest 30-minute average: **1,098.0 MW** in period 34 (16:30–17:00). Period 36: **966.4 MW** (Q9b, Q9c). **Confirmed.**

The Authority report says the highest northward flow of the week was 1,170 MW on Monday at 4.30pm, the highest since 2013. That is a finer peak than a 30-minute average. Gold cannot show it. The 1,098 MW half-hour at 16:30 is **confirmed**. The 1,170 MW figure is **confirmed** from the report only.

Maximum transfer is period 34; the price spike is period 36. Transfer has already dropped 132 MW by 17:30. **Confirmed.**

### Load

Grid load in gold is the real-time dispatch *model* load at grid exit points, not metered consumption ([ADR-0018](../adr/0018-energy-balance.md)). Highest national modelled load: **7,098.8 MW** in period 16 (07:30–08:00), then 7,092.7 MW in period 17. Evening peak of the evening window: **6,954.0 MW** in period 37; period 36 is 6,879.7 MW (Q12b, Q12). **Confirmed** as modelled load.

The Authority report says Monday saw the highest half-hourly demand ever recorded, around 3.55 GWh (7.1 GW) at 7.30am. 7,098.8 MW × 0.5 h = 3.549 GWh. That matches. **Confirmed** against the report, with the caveat that gold is modelled load.

Energy-balance residual (generation + HVDC import − modelled load) in period 36 is 23.0 MW in the North Island and 42.0 MW in the South Island (Q12c). That residual holds transmission losses, Generation_MD omissions and the gap between metered generation and RTD load. It is **not** the system operator’s generation-balance residual. The report’s 58 MW national residual, 1 MW North Island residual and 40 MW South Island residual at 5.30pm are **confirmed** from the report only. Equating the two residuals would be wrong.

## What the data suggests about why

1. **The North Island was tight on energy and reserve in the same half-hour.** High modelled load, low wind, thermal still ramping, SIR at $2,154 and a $21,000 publish at Hepburn Road sit in period 36 together. **Strong evidence.**

2. **The South Island was not tight in the same way.** Benmore’s period price is $571, South Island hydro is above 3,200 MW, South Island reserve is $0, and the link is carrying close to 1,000 MW north. Island separation is the shape of a North Island shortage while the South Island can still send. **Strong evidence.**

3. **Thermal and North Island hydro responded, and not instantly.** From 15:30 to 17:30, North Island thermal rises 484 MW and North Island hydro 545 MW, while wind stays near 50–70 MW. The Authority report says capacity could not ramp fast enough for rising demand. The ramp in gold is **confirmed**. That it was too slow for the load is **strong evidence** (prices and SIR explode in the same window the ramp is still climbing). The report’s wording is **confirmed** as the Authority’s account.

4. **Co-optimised reserve on a northward HVDC is a possible mechanism for the SIR spike.** When the link is the binding risk, reserve to cover it has to sit in the receiving island, and SPD co-optimises energy and reserve (report footnote 3). Gold shows northward transfer, NI SIR at $2,154 and SI SIR at $0, which is the pattern that mechanism produces. It does not name the risk setter. **Possible explanation** from the report plus the gold pattern. Binding HVDC risk belongs in an SPD case ([#44](https://github.com/joshmcarthur/gridwatch/issues/44)).

5. **Hydro was abundant on the day.** Hydro generated 96,683.5 MWh (Q10b). South Island hydro in period 36 is 3,207.8 MW (Q10d). **Confirmed.** The report puts national controlled storage on 25 July at 83% nominally full and about 131% of the historical average. That storage figure is **confirmed** from the report. These tables have no hydro storage series ([#47](https://github.com/joshmcarthur/gridwatch/issues/47)). High prices plus a thermal ramp, read without storage, can look like a shortage of water.

6. **Outages and plant faults sit behind some of the missing megawatts, and gold cannot name them.** Huntly 5 meters nothing (Q11d). Rankine output peaks at 353.2 MW in period 37 against 750 MW of nameplate on units 1, 2 and 4 (Q11b, Q14b). The report: Huntly 5 full outage; Huntly 4 full outage; Huntly 2 unexpected fault, 140 MW offered; Ruakākā on planned outage 10:00–16:00, so limited recharge before the evening; Stratford peaker 1 on outage. Ruakākā still discharges 40.6 MW in period 36 (Q11e), which is consistent with a battery that could not fully recharge. **Possible explanation** for why the Rankine band and Huntly 5 are short; **confirmed** as metered zeros, as fleet nameplate, and as the report’s outage list. Matching plants to the planned outage coordination process (POCP) is [#45](https://github.com/joshmcarthur/gridwatch/issues/45).

7. **Whirinaki ran.** Metered output is 7.8 MW in period 36 and 35.4 MW in period 37 (Q11b). From 17:45, Cleared Offers show non-zero `cleared_generation_megawatts` and non-zero SIR on WHI1–WHI3 (Q14). The report says Whirinaki did not clear in the energy market and was constrained on to provide reserve. The cleared quantities are **confirmed**. Whether that energy was in-merit or constrained-on needs offer prices, which Cleared Offers does not carry. **Possible explanation** from the report.

8. **Demand-forecast error is in the report, not in these tables.** The report: demand 212 MW higher than forecast on Monday evening; the greatest one-hour-ahead forecast difference on Monday was $115/MWh at 6.00pm, with demand 139 MW high. Gold has no forecast series. **Confirmed** from the report only. A demand-deviation detector ([#35](https://github.com/joshmcarthur/gridwatch/issues/35)) would still need a baseline of comparable evenings, not the forecast.

## What these tables cannot tell

| Gap | Why it matters on this day | Phase 5 |
| --- | --- | --- |
| SPD 5-minute cases | Names the scarcity flag, ENSHORTFALL, the residual of 58 MW, the risk setter, binding constraints, offer tranches and `PRICECLEARED`. Dispatch prices show the $21,000 outcome and an 85-second gap, not the solve. [sources.md §11](../sources.md#11-spd-case-files-selected-periods) opened the *17:30* RTD zip for this date as a schema check: `ENSHORTFALL` was 0 at period start. The $21,000 publish is at 17:50. A targeted read has to pick that interval, not the period-start case. | [#44](https://github.com/joshmcarthur/gridwatch/issues/44) |
| Generator and transmission outages | Huntly 2 fault, Huntly 4 and 5 outages, Ruakākā planned outage, Stratford peaker 1. Gold sees zeros and a Rankine band, not the POCP record. | [#45](https://github.com/joshmcarthur/gridwatch/issues/45) |
| Named transmission constraints | Spreads show island separation. They do not name a branch or a limit. After real-time pricing, that list lives in RTD cases. | [#46](https://github.com/joshmcarthur/gridwatch/issues/46) |
| Hydro storage, inflows, water values | Distinguishes a wet North Island squeeze from a dry-year shortage. The report’s 83% / 131% figures are the only storage numbers here. | [#47](https://github.com/joshmcarthur/gridwatch/issues/47) |
| Full offer stacks and who was marginal | Cleared Offers give cleared MW, including reserve. They do not give tranche prices. High prices this week, the report says, were scarcity or high reserve, not high-priced energy clearing. | [#44](https://github.com/joshmcarthur/gridwatch/issues/44) (case `PERIOD` / `TRADERPERIOD`) |
| Intra-period HVDC peak | Gold is a 30-minute metered average. 1,098 MW at 16:30 versus the report’s 1,170 MW. Island residuals must not be used as a substitute ([ADR-0016](../adr/0016-hvdc-flows.md)). | already in gold at period grain |
| Low-residual customer advice notices | The report: CAN at 9:38am Sunday for 07:30–08:30 and 18:00–19:00 Monday; another on Monday morning for Tuesday. Gold has the prices in those windows, not the notice. | notice text; residual in SPD ([#44](https://github.com/joshmcarthur/gridwatch/issues/44)) |
| System-operator generation-balance residual | Report: 58 MW national, 1 MW North Island, 40 MW South Island at 5.30pm. Gold’s energy-balance residual is a different quantity (Q12c). | [#44](https://github.com/joshmcarthur/gridwatch/issues/44) `SOLUTION,ISLAND` |

## Morning, same day

The owner chose the evening. Period 16 is the same mechanism at smaller size: Ōtāhuhu $1,228.29, Benmore $145.23, North Island SIR $895.38, modelled load 7,098.8 MW (Q4, Q8, Q12b). The report calls 7.30am the record demand half-hour and notes North Island reserve spikes, low wind and demand-forecast errors. **Confirmed** in gold for the prices, SIR and modelled load. Treat it as same-day context, not a second event write-up.

## Detectors, episodes and evidence packages

This section is the closing note for [#22](https://github.com/joshmcarthur/gridwatch/issues/22), [#32](https://github.com/joshmcarthur/gridwatch/issues/32)–[#35](https://github.com/joshmcarthur/gridwatch/issues/35), [#36](https://github.com/joshmcarthur/gridwatch/issues/36) / [ADR-0021](../adr/0021-episodes.md), and [#38](https://github.com/joshmcarthur/gridwatch/issues/38).

This one-day collect cannot run the detectors: every price, spread and reserve baseline has `baseline_ready = false` and `observation_count = 0`. `episode_days` has `episode_count = 0` (Q13, Q13b). That is a collect limit, not a detector miss. A 28-day `price_periods` window in front of 27 July is required before this date can be used as a live grouping test.

On a full backfill the same evening is already a worked example in [ADR-0019](../adr/0019-observations-and-price-anomaly-detector.md): `reserve_price_high` on 2026-07-27, SIR\|NI, periods 35–40 (six periods), measured $2,154.45, median $0.49, threshold $13.13, severity 170.5. That measured value is the period-36 SIR price in Q8. **Confirmed** as the documented backfill, not re-run here.

What the configured detectors would do with these gold numbers, once a baseline exists:

**Price anomaly (#22).** Periods 36–39 at Ōtāhuhu are $3,296, $1,311, $1,038, $1,116. Haywards is the same shape. That is a run of at least two periods, far above a $25 deviation from any recent median. Benmore’s $571 in period 36 against $258, $83, $94 in 37–39 may or may not hold a two-period run, depending on the 28-day 99th percentile. The detector reads the period mean, so the 85-second $21,000 does not become the measured value. `max_price` on the period row is the place that spike survives. A single isolated 85-second scarcity that did not lift the next period would miss `minPeriods = 2`. On this day it lifted four periods, so the two-period rule still fires. **Strong evidence** from the gold series plus the ADR-0019 rule; not a live observation in this collect.

**Price separation (#32).** Ōtāhuhu–Benmore spreads of $2,725, $1,053, $955, $1,022 in periods 36–39 clear a $100 floor and a two-period run. Sign is positive: Ōtāhuhu dearer. The observation must not claim a cause. **Strong evidence** of what the detector should emit.

**Generation change (#33).** North Island wind in period 36 is 69 MW against a day range of 91–289 MW nationally. A per-trading-period baseline may treat a winter evening of ~50 MW of North Island wind as normal, so `generation_low` may not fire. Thermal `generation_high` (coal/gas 152 → 353 MW, gas 110 → 460 MW) almost certainly would, at plant and fuel grain. [ADR-0021](../adr/0021-episodes.md) does **not** join `generation_high` to `price_high`. The Rankine ramp belongs in the evidence package, not in the grouping key. That split is the right one for this evening: the thermal units are the response, not the scarcity. **Possible explanation** until a backfill counts false positives on winter evenings.

**Reserve price anomaly (#34).** SIR\|NI periods 35–40 is already the ADR-0019 example. FIR\|NI at $49.93 in period 36 is one period and may not make a two-period run (period 35 FIR is $7, period 37 is $5). South Island reserve will not fire. The evening is a North Island *reserve* event as well as an energy event. A published explanation has to keep those two prices in view, or it will read as “the energy price was high” and miss why SIR is $2,154 while energy at Benmore is $571.

**Demand deviation (#35).** Not built. Period 16 is the national modelled-load peak (7,098.8 MW). Period 37 is 6,954 MW. A same-period baseline on recent Mondays would likely flag the morning; the evening is high but not the day’s high. The report’s forecast error (demand 212 MW above forecast) is a different comparison and is not in these tables.

**Episode grouping (#36 / ADR-0021).** v1 rules on this *kind* of evening, with observations in hand: `price_high` at NI nodes overlapping `reserve_price_high` on NI join (`price_high_reserve_price_high_adjacent_island`); `separation_high` on a pair whose dearer node is NI joins that component; `generation_low` on NI, if it fires, joins on overlap; `generation_high` does not. Result: one North Island episode covering the overlapping energy, reserve and separation runs, severity equal to the worst member (here, SIR severity 170 from the documented backfill). South Island `price_high` at Benmore, if any, stays out unless a pair observation pulls on the dearer-NI sign. That is the grouping this reconstruction needs. It would fail to form one episode if `generation_low` is required and wind never flags, or if reserve had not been built. Those are detector gaps, not a grouping-rule miss. A March-style high-price *month* would not form one dispatch-scale episode; this evening would.

**Evidence packages (#38).** A package for this episode needs, at least:

- The three reference-node period prices and the three spreads for periods 32–40, with `inputs_complete`.
- Period `max_price` (row extrema) next to the period mean, so the $21,000 / $20,459 publishes are not washed out.
- The Hepburn Road publish series in period 36, including the 85-second $21,000, cited from silver dispatch energy prices. SPD scarcity remains a report claim until #44.
- FIR/SIR by island for the same window, including the $6,500 SIR rows.
- Fuel-level MW: coal/gas, gas, NI/SI hydro, NI wind, battery. Plant-level Huntly Rankine, Huntly P40, Stratford, Junction Road, McKee, Ruakākā, Whirinaki.
- HVDC 30-minute average, with an explicit note that 1,098 MW is not the report’s 1,170 MW peak, and that transfer had dropped by period 36.
- Modelled load, labelled modelled, plus the energy-balance residual labelled as a different quantity from the 58 MW system-operator residual.
- Completeness of every input.
- A claims list: each value, unit, table, query id from this SQL file, and a §7.2 confidence tag.
- Context that is *not* a grouping member: the thermal ramp (`generation_high`), Huntly 5’s absence, the Authority report’s outage list and CANs, hydro storage from the report.
- A limits list pointing at #44 (the 17:50 case, not 17:30), #45, #46 and #47.

Without `max_price` and the Hepburn Road rows, an LLM given only period means would describe a $3,296 spike and never mention $21,000. Without the SIR series it would describe a price event and miss a reserve event. Without the storage caveat it could call a wet week a dry year. Those three are the package tests this evening sets.
