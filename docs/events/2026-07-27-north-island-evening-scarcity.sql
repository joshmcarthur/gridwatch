-- Reconstruction queries for docs/events/2026-07-27-north-island-evening-scarcity.md
-- Trading date 2026-07-27 (Monday). Ordinary 48-period day. NZ standard time (UTC+12).
--
-- Run from the repo root, after collecting and publishing 2026-07-27:
--   duckdb < docs/events/2026-07-27-north-island-evening-scarcity.sql
--
-- Opens no database file (in-memory) and writes nothing.
-- Load gold/silver Parquet once into temp tables, then each SELECT is one figure.
-- Query labels (Q1, Q2, …) match the write-up.
--
-- Collect (this environment, 21 Nov 2026 UTC):
--   node collector/src/main.ts --from 2026-07-27 --to 2026-07-27
--   node publisher/src/main.ts --dataset network_supply_points --dataset generation_fleet
--   node publisher/src/main.ts --from 2026-07-27 --to 2026-07-27
-- Docker equivalent: docker compose run --rm collector --from 2026-07-27 --to 2026-07-27
-- then publisher for the mapping snapshots, then publisher --from 2026-07-27 --to 2026-07-27.
-- Monthly Generation_MD and HVDC_Flows files for July 2026 come in with that one-day range.

-- =====================================================================
-- Load once
-- =====================================================================

CREATE TEMP TABLE price_periods AS
SELECT * FROM read_parquet('data/gold/price_periods/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE price_daily AS
SELECT * FROM read_parquet('data/gold/price_daily_summary/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE price_spreads AS
SELECT * FROM read_parquet('data/gold/price_spreads/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE price_distribution AS
SELECT * FROM read_parquet('data/gold/price_distribution/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE reserve_period AS
SELECT * FROM read_parquet('data/gold/reserve_by_class_island_period/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE reserve_day AS
SELECT * FROM read_parquet('data/gold/reserve_by_class_island_day/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE fuel_period AS
SELECT * FROM read_parquet('data/gold/generation_by_fuel_period/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE fuel_day AS
SELECT * FROM read_parquet('data/gold/generation_by_fuel_day/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE plant_period AS
SELECT * FROM read_parquet('data/gold/generation_by_plant_period/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE plant_day AS
SELECT * FROM read_parquet('data/gold/generation_by_plant_day/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE hvdc_period AS
SELECT * FROM read_parquet('data/gold/hvdc_transfer_period/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE hvdc_day AS
SELECT * FROM read_parquet('data/gold/hvdc_transfer_day/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE load_period AS
SELECT * FROM read_parquet('data/gold/grid_load_period/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE energy_balance_period AS
SELECT * FROM read_parquet('data/gold/energy_balance_period/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE energy_balance_day AS
SELECT * FROM read_parquet('data/gold/energy_balance_day/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE dispatch_energy AS
SELECT * FROM read_parquet('data/silver/dispatch_energy_prices/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE dispatch_reserve AS
SELECT * FROM read_parquet('data/silver/dispatch_reserve_prices/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE cleared_offers AS
SELECT * FROM read_parquet('data/silver/cleared_offers/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE entity_units AS
SELECT * FROM read_parquet('data/silver/entity_units/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE completeness AS
SELECT * FROM read_parquet('data/silver/_completeness/data.parquet');

CREATE TEMP TABLE price_anomaly_baselines AS
SELECT * FROM read_parquet('data/gold/price_anomaly_baselines/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE price_separation_baselines AS
SELECT * FROM read_parquet('data/gold/price_separation_baselines/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE reserve_price_anomaly_baselines AS
SELECT * FROM read_parquet('data/gold/reserve_price_anomaly_baselines/trading_date=2026-07-27/data.parquet');

CREATE TEMP TABLE episode_days AS
SELECT * FROM read_parquet('data/gold/episode_days/trading_date=2026-07-27/data.parquet');

-- Clock time of a trading period on this NZST day: period 1 is 00:00–00:30.
CREATE MACRO period_clock(p) AS
  printf('%02d:%02d–%02d:%02d',
    (p - 1) * 30 // 60,
    (p - 1) * 30 % 60,
    (p * 30) // 60 % 24,
    (p * 30) % 60);

-- =====================================================================
-- Q1 Completeness
-- =====================================================================
SELECT 'Q1 completeness' AS figure;
SELECT dataset, trading_date::VARCHAR AS trading_date, status,
       expected_period_count, actual_period_count
FROM completeness
WHERE dataset IN (
  'dispatch_energy_prices', 'dispatch_reserve_prices', 'nodal_prices_and_volumes',
  'cleared_offers', 'generation_md', 'hvdc_flows', 'entity_mappings'
)
ORDER BY dataset;

SELECT 'Q1b gold inputs_complete' AS figure;
SELECT 'price_periods' AS tbl, bool_and(inputs_complete) AS all_complete, count(*) AS n FROM price_periods
UNION ALL SELECT 'price_spreads', bool_and(inputs_complete), count(*) FROM price_spreads
UNION ALL SELECT 'reserve_period', bool_and(inputs_complete), count(*) FROM reserve_period
UNION ALL SELECT 'fuel_period', bool_and(inputs_complete), count(*) FROM fuel_period
UNION ALL SELECT 'hvdc_period', bool_and(inputs_complete), count(*) FROM hvdc_period
UNION ALL SELECT 'load_period', bool_and(inputs_complete), count(*) FROM load_period
UNION ALL SELECT 'energy_balance_period', bool_and(inputs_complete), count(*) FROM energy_balance_period
UNION ALL SELECT 'price_periods_proxy', bool_or(has_proxy_price), count(*) FILTER (WHERE has_proxy_price) FROM price_periods;

-- =====================================================================
-- Q2 Daily reference-node prices (ADR-0012)
-- min_price / max_price are extrema of published rows, not of period prices.
-- =====================================================================
SELECT 'Q2 price daily summary' AS figure;
SELECT point_of_connection, price_region,
       round(mean_price, 2) AS mean_price,
       round(min_price, 2) AS min_row_price,
       round(max_price, 2) AS max_row_price,
       periods_present, periods_expected, rows_present, inputs_complete
FROM price_daily
ORDER BY point_of_connection;

-- =====================================================================
-- Q3 Period prices at the three reference nodes, whole day
-- =====================================================================
SELECT 'Q3 reference node period prices' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       round(max(CASE WHEN point_of_connection = 'OTA2201' THEN price END), 2) AS ota,
       round(max(CASE WHEN point_of_connection = 'HAY2201' THEN price END), 2) AS hay,
       round(max(CASE WHEN point_of_connection = 'BEN2201' THEN price END), 2) AS ben,
       round(max(CASE WHEN point_of_connection = 'OTA2201' THEN min_price END), 2) AS ota_min_row,
       round(max(CASE WHEN point_of_connection = 'OTA2201' THEN max_price END), 2) AS ota_max_row
FROM price_periods
GROUP BY trading_period
ORDER BY trading_period;

-- =====================================================================
-- Q4 Evening window (periods 32–40) and morning CAN window (15–18)
-- =====================================================================
SELECT 'Q4 key periods' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst, point_of_connection, price_region,
       round(price, 2) AS period_price,
       round(min_price, 2) AS min_row, round(max_price, 2) AS max_row,
       rows_present
FROM price_periods
WHERE trading_period IN (15, 16, 17, 18, 32, 33, 34, 35, 36, 37, 38, 39, 40)
ORDER BY trading_period, point_of_connection;

-- =====================================================================
-- Q5 Spreads, evening
-- =====================================================================
SELECT 'Q5 spreads evening' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       from_point_of_connection AS "from", to_point_of_connection AS "to",
       round(from_price, 2) AS from_price, round(to_price, 2) AS to_price,
       round(spread, 2) AS spread
FROM price_spreads
WHERE trading_period BETWEEN 32 AND 40
ORDER BY trading_period, from_point_of_connection, to_point_of_connection;

SELECT 'Q5b largest OTA-BEN spreads' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst, round(spread, 2) AS ota_minus_ben
FROM price_spreads
WHERE from_point_of_connection = 'OTA2201' AND to_point_of_connection = 'BEN2201'
ORDER BY spread DESC
LIMIT 6;

-- =====================================================================
-- Q6 National period-price distribution (all POCs)
-- =====================================================================
SELECT 'Q6 price distribution key periods' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst, poc_count,
       round(min_price, 2) AS min_p, round(median_price, 2) AS median_p,
       round(p95_price, 2) AS p95, round(max_price, 2) AS max_p
FROM price_distribution
WHERE trading_period IN (15, 16, 17, 18, 33, 34, 35, 36, 37, 38, 39, 40)
ORDER BY trading_period;

-- =====================================================================
-- Q7 HEP0331 / OTA / BEN publishes in period 36, and 85-second $21,000
-- =====================================================================
SELECT 'Q7 dispatch publishes TP36 at HEP, OTA, BEN' AS figure;
SELECT point_of_connection,
       source_published_at AT TIME ZONE 'UTC' AS published_utc,
       (source_published_at AT TIME ZONE 'Pacific/Auckland')::VARCHAR AS published_nzst,
       round(dollars_per_megawatt_hour, 2) AS price
FROM dispatch_energy
WHERE trading_period = 36
  AND point_of_connection IN ('HEP0331', 'OTA2201', 'BEN2201')
ORDER BY point_of_connection, source_published_at;

SELECT 'Q7b seconds at HEP0331 $21,000' AS figure;
WITH ordered AS (
  SELECT source_published_at, dollars_per_megawatt_hour AS price,
         lead(source_published_at) OVER (ORDER BY source_published_at) AS next_at
  FROM dispatch_energy
  WHERE trading_period = 36 AND point_of_connection = 'HEP0331'
)
SELECT price, source_published_at AT TIME ZONE 'UTC' AS start_utc,
       next_at AT TIME ZONE 'UTC' AS next_utc,
       epoch(next_at - source_published_at) AS seconds_until_next
FROM ordered
WHERE price = 21000;

SELECT 'Q7c count of TP36 publishes at or above $20,000 / $10,000' AS figure;
SELECT count(*) FILTER (WHERE dollars_per_megawatt_hour >= 20000) AS n_ge_20000,
       count(*) FILTER (WHERE dollars_per_megawatt_hour >= 10000) AS n_ge_10000,
       count(DISTINCT point_of_connection) FILTER (WHERE dollars_per_megawatt_hour >= 20000) AS pocs_ge_20000,
       max(dollars_per_megawatt_hour) AS max_published
FROM dispatch_energy
WHERE trading_period = 36;

SELECT 'Q7d HEP0331 / OTA / WEL / BEN period prices in TP36 (rule B)' AS figure;
WITH spans AS (
  SELECT event_start_utc, event_end_utc
  FROM price_periods
  WHERE trading_period = 36 AND point_of_connection = 'OTA2201'
),
rows AS (
  SELECT r.point_of_connection, r.dollars_per_megawatt_hour AS price, r.source_published_at,
         s.event_start_utc, s.event_end_utc,
         row_number() OVER w AS rn,
         lead(r.source_published_at) OVER w AS next_published_at
  FROM dispatch_energy r CROSS JOIN spans s
  WHERE r.trading_period = 36
    AND r.point_of_connection IN ('HEP0331', 'OTA2201', 'WEL0331', 'MTO0331', 'BEN2201')
  WINDOW w AS (PARTITION BY r.point_of_connection
               ORDER BY r.source_published_at, r.dollars_per_megawatt_hour)
),
segments AS (
  SELECT point_of_connection, price,
    CASE WHEN rn = 1 THEN event_start_utc
         ELSE least(greatest(source_published_at, event_start_utc), event_end_utc) END AS segment_start,
    CASE WHEN next_published_at IS NULL THEN event_end_utc
         ELSE least(greatest(next_published_at, event_start_utc), event_end_utc) END AS segment_end
  FROM rows
)
SELECT point_of_connection,
       round(sum(price * epoch(segment_end - segment_start))
             / sum(epoch(segment_end - segment_start)), 2) AS period_price,
       round(min(price), 2) AS min_row, round(max(price), 2) AS max_row,
       sum(epoch(segment_end - segment_start)) FILTER (WHERE price = 21000) AS seconds_at_21000,
       sum(epoch(segment_end - segment_start)) FILTER (WHERE price >= 20000) AS seconds_at_20000
FROM segments
GROUP BY 1
ORDER BY period_price DESC;

-- =====================================================================
-- Q8 Reserve prices
-- =====================================================================
SELECT 'Q8 reserve period prices' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       round(max(CASE WHEN reserve_class = 'FIR' AND island = 'NI' THEN dollars_per_megawatt_hour END), 2) AS fir_ni,
       round(max(CASE WHEN reserve_class = 'SIR' AND island = 'NI' THEN dollars_per_megawatt_hour END), 2) AS sir_ni,
       round(max(CASE WHEN reserve_class = 'FIR' AND island = 'SI' THEN dollars_per_megawatt_hour END), 2) AS fir_si,
       round(max(CASE WHEN reserve_class = 'SIR' AND island = 'SI' THEN dollars_per_megawatt_hour END), 2) AS sir_si,
       round(max(CASE WHEN reserve_class = 'SIR' AND island = 'NI' THEN max_price END), 2) AS sir_ni_max_row
FROM reserve_period
GROUP BY trading_period
ORDER BY trading_period;

SELECT 'Q8b reserve daily' AS figure;
SELECT reserve_class, island, round(mean_price, 2) AS mean_price,
       round(min_price, 2) AS min_row, round(max_price, 2) AS max_row,
       periods_present, inputs_complete
FROM reserve_day
ORDER BY island, reserve_class;

SELECT 'Q8c SIR NI publishes TP36' AS figure;
SELECT source_published_at AT TIME ZONE 'UTC' AS published_utc,
       (source_published_at AT TIME ZONE 'Pacific/Auckland')::VARCHAR AS published_nzst,
       round(dollars_per_megawatt_hour, 2) AS price
FROM dispatch_reserve
WHERE island = 'NI' AND reserve_class = 'SIR' AND trading_period = 36
ORDER BY source_published_at;

-- =====================================================================
-- Q9 HVDC transfer (ADR-0016). Positive is northward at Haywards.
-- average_megawatts is the 30-minute average (north received × 2).
-- =====================================================================
SELECT 'Q9 HVDC day' AS figure;
SELECT round(north_island_received_mwh, 3) AS north_received_mwh,
       round(south_island_sent_mwh, 3) AS south_sent_mwh,
       round(losses_mwh, 3) AS losses_mwh,
       round(average_megawatts, 1) AS average_mw,
       direction, inputs_complete
FROM hvdc_day;

SELECT 'Q9b HVDC period' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       round(north_island_received_mwh, 3) AS north_received_mwh,
       round(average_megawatts, 1) AS average_mw,
       direction
FROM hvdc_period
ORDER BY trading_period;

SELECT 'Q9c HVDC peak 30-minute averages' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       round(average_megawatts, 1) AS average_mw
FROM hvdc_period
ORDER BY average_megawatts DESC
LIMIT 5;

-- =====================================================================
-- Q10 Generation by fuel
-- =====================================================================
SELECT 'Q10 fuel day' AS figure;
SELECT fuel_category, island,
       round(megawatt_hours, 1) AS mwh,
       round(average_megawatts, 1) AS average_mw
FROM fuel_day
ORDER BY fuel_category, island;

SELECT 'Q10b national fuel day' AS figure;
SELECT fuel_category,
       round(sum(megawatt_hours), 1) AS mwh,
       round(sum(average_megawatts), 1) AS average_mw
FROM fuel_day
GROUP BY fuel_category
ORDER BY mwh DESC;

SELECT 'Q10c fuel evening TP32–40, average MW' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst, fuel_category, island,
       round(average_megawatts, 1) AS average_mw
FROM fuel_period
WHERE trading_period BETWEEN 32 AND 40
ORDER BY trading_period, fuel_category, island;

SELECT 'Q10d NI thermal, NI hydro, national wind TP30–40' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       round(sum(average_megawatts) FILTER (WHERE fuel_category = 'coal_gas'), 1) AS coal_gas,
       round(sum(average_megawatts) FILTER (WHERE fuel_category = 'gas'), 1) AS gas,
       round(sum(average_megawatts) FILTER (WHERE fuel_category IN ('coal_gas', 'gas')), 1) AS thermal,
       round(sum(average_megawatts) FILTER (WHERE fuel_category = 'hydro' AND island = 'NI'), 1) AS hydro_ni,
       round(sum(average_megawatts) FILTER (WHERE fuel_category = 'hydro' AND island = 'SI'), 1) AS hydro_si,
       round(sum(average_megawatts) FILTER (WHERE fuel_category = 'wind' AND island = 'NI'), 1) AS wind_ni,
       round(sum(average_megawatts) FILTER (WHERE fuel_category = 'wind'), 1) AS wind_nz
FROM fuel_period
WHERE trading_period BETWEEN 30 AND 40
GROUP BY trading_period
ORDER BY trading_period;

SELECT 'Q10e wind day min/max/mean' AS figure;
SELECT round(min(nz), 1) AS min_mw, round(max(nz), 1) AS max_mw, round(avg(nz), 1) AS mean_mw
FROM (
  SELECT trading_period, sum(average_megawatts) AS nz
  FROM fuel_period
  WHERE fuel_category = 'wind'
  GROUP BY trading_period
);

SELECT 'Q10f national mix TP16 vs TP32 vs TP36 vs TP37' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst, fuel_category,
       round(sum(average_megawatts), 1) AS average_mw
FROM fuel_period
WHERE trading_period IN (16, 32, 36, 37)
GROUP BY trading_period, fuel_category
ORDER BY trading_period, average_mw DESC;

SELECT 'Q10g hydro share of primary energy (battery excluded)' AS figure;
SELECT round(sum(megawatt_hours) FILTER (WHERE fuel_category = 'hydro'), 1) AS hydro_mwh,
       round(sum(megawatt_hours) FILTER (WHERE fuel_category <> 'battery'), 1) AS primary_mwh,
       round(100.0 * sum(megawatt_hours) FILTER (WHERE fuel_category = 'hydro')
             / sum(megawatt_hours) FILTER (WHERE fuel_category <> 'battery'), 1) AS hydro_pct
FROM fuel_day;

-- =====================================================================
-- Q11 Plant-level thermal, battery, Whirinaki
-- =====================================================================
SELECT 'Q11 plants TP36 at or above 20 MW' AS figure;
SELECT plant_id, plant_name, fuel_category, island, round(average_megawatts, 1) AS average_mw
FROM plant_period
WHERE trading_period = 36 AND average_megawatts >= 20
ORDER BY average_megawatts DESC;

SELECT 'Q11b Huntly / Stratford / peakers / Ruakākā / Whirinaki TP32–40' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       plant_id, plant_name, fuel_category, round(average_megawatts, 1) AS average_mw
FROM plant_period
WHERE trading_period BETWEEN 32 AND 40
  AND plant_id IN (
    'HLY/huntly_1_4', 'HLY/huntly_p40', 'HLY/rotohiko',
    'SFD/stratford', 'JRD/junctionroad', 'MKE/mckee',
    'BRB/ruakākā_energy_park', 'WHI/whirinaki'
  )
ORDER BY plant_id, trading_period;

SELECT 'Q11c Huntly plants, day totals' AS figure;
SELECT plant_id, plant_name, fuel_category,
       round(megawatt_hours, 1) AS mwh, round(average_megawatts, 1) AS average_mw
FROM plant_day
WHERE plant_id LIKE 'HLY/%'
ORDER BY plant_id;

SELECT 'Q11d Huntly 5 metered energy (should be 0 rows)' AS figure;
SELECT plant_id, plant_name, megawatt_hours
FROM plant_day
WHERE plant_id LIKE '%huntly%5%' OR plant_name ILIKE '%huntly 5%' OR plant_name ILIKE '%e3p%';

SELECT 'Q11e selected plants TP36' AS figure;
SELECT plant_id, plant_name, fuel_category, round(average_megawatts, 1) AS average_mw
FROM plant_period
WHERE trading_period = 36
  AND plant_id IN (
    'HLY/huntly_1_4', 'HLY/huntly_p40', 'SFD/stratford',
    'JRD/junctionroad', 'MKE/mckee', 'BRB/ruakākā_energy_park', 'WHI/whirinaki'
  )
ORDER BY average_megawatts DESC;

SELECT 'Q11f Huntly P40 / Junction Road / McKee TP32–40' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       plant_id, round(average_megawatts, 1) AS average_mw
FROM plant_period
WHERE trading_period BETWEEN 32 AND 40
  AND plant_id IN ('HLY/huntly_p40', 'JRD/junctionroad', 'MKE/mckee')
ORDER BY plant_id, trading_period;

-- =====================================================================
-- Q12 Grid load (modelled) and energy balance
-- Load is RTD model load, not metered consumption (ADR-0018).
-- Residual is generation + HVDC import − load. It is not the system operator's
-- generation-balance residual.
-- =====================================================================
SELECT 'Q12 national modelled load, average MW' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       round(sum(load_mwh) FILTER (WHERE island = 'NI') * 2, 1) AS ni_mw,
       round(sum(load_mwh) FILTER (WHERE island = 'SI') * 2, 1) AS si_mw,
       round(sum(load_mwh) * 2, 1) AS nz_mw
FROM load_period
GROUP BY trading_period
ORDER BY trading_period;

SELECT 'Q12b highest national modelled load' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst,
       round(sum(load_mwh) * 2, 1) AS nz_mw
FROM load_period
GROUP BY trading_period
ORDER BY nz_mw DESC
LIMIT 5;

SELECT 'Q12c energy balance TP16 and TP36' AS figure;
SELECT trading_period, period_clock(trading_period) AS nzst, island,
       round(generation_mwh * 2, 1) AS generation_mw,
       round(hvdc_import_mwh * 2, 1) AS hvdc_import_mw,
       round(load_mwh * 2, 1) AS load_mw,
       round(residual_mwh * 2, 1) AS residual_mw,
       round(residual_pct_of_load, 2) AS residual_pct_of_load,
       load_intervals, inputs_complete
FROM energy_balance_period
WHERE trading_period IN (16, 36)
ORDER BY trading_period, island;

SELECT 'Q12d energy balance day' AS figure;
SELECT island,
       round(generation_mwh, 1) AS generation_mwh,
       round(hvdc_import_mwh, 1) AS hvdc_import_mwh,
       round(load_mwh, 1) AS load_mwh,
       round(residual_mwh, 1) AS residual_mwh,
       round(residual_pct_of_load, 2) AS residual_pct_of_load
FROM energy_balance_day
ORDER BY island;

-- =====================================================================
-- Q13 Detectors and episodes on this one-day collect (no 28-day baseline)
-- =====================================================================
SELECT 'Q13 detector baselines' AS figure;
SELECT 'price_anomaly' AS detector, subject_id, baseline_ready, baseline_sample_count,
       observation_count, inputs_complete
FROM price_anomaly_baselines
UNION ALL
SELECT 'price_separation', subject_id, baseline_ready, baseline_sample_count,
       observation_count, inputs_complete
FROM price_separation_baselines
UNION ALL
SELECT 'reserve_price_anomaly', subject_id, baseline_ready, baseline_sample_count,
       observation_count, inputs_complete
FROM reserve_price_anomaly_baselines
ORDER BY detector, subject_id;

SELECT 'Q13b episode_days' AS figure;
SELECT trading_date::VARCHAR AS trading_date, episode_count, observation_count,
       analysis_version, inputs_complete
FROM episode_days;

-- =====================================================================
-- Q14 Whirinaki cleared energy and reserve (silver Cleared Offers)
-- Interval grain; sum of cleared MW across WHI units in each 5-minute case.
-- =====================================================================
SELECT 'Q14 Whirinaki cleared energy and SIR, TP36–37' AS figure;
-- One row per unit per interval (RTD can republish the same case).
WITH per_unit AS (
  SELECT trading_period, event_start_utc, unit_code,
         max(cleared_generation_megawatts) AS energy_mw,
         max(cleared_fir_megawatts) AS fir_mw,
         max(cleared_sir_megawatts) AS sir_mw
  FROM cleared_offers
  WHERE unit_code LIKE 'WHI%'
    AND trading_period IN (36, 37)
  GROUP BY trading_period, event_start_utc, unit_code
)
SELECT trading_period,
       (event_start_utc AT TIME ZONE 'Pacific/Auckland')::VARCHAR AS interval_nzst,
       round(sum(energy_mw), 1) AS cleared_energy_mw,
       round(sum(fir_mw), 1) AS cleared_fir_mw,
       round(sum(sir_mw), 1) AS cleared_sir_mw
FROM per_unit
GROUP BY trading_period, event_start_utc
ORDER BY trading_period, event_start_utc;

SELECT 'Q14b Huntly and Whirinaki fleet nameplate (entity_units for this date)' AS figure;
SELECT unit_code, plant_name, fuel_code, fuel_category, nameplate_megawatts
FROM entity_units
WHERE unit_code LIKE 'HLY%' OR plant_name ILIKE '%huntly%'
   OR unit_code LIKE 'WHI%' OR plant_name ILIKE '%whirinaki%'
ORDER BY unit_code;
