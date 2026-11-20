-- Validation queries for docs/validation/2026-10-29.md (trading date 2026-10-29).
--
-- Run from the repo root:   duckdb < docs/validation/2026-10-29.sql
--
-- Reads gold and silver Parquet under data/ and EMI CSV files under data/emi/.
-- Opens no database file (in-memory) and writes nothing.
-- Load once (temp tables), then each SELECT only projects a report table.
--
-- EMI downloads. Run once from the repo root. Each file has its own folder under data/emi/
-- (data/ is git-ignored). The 'Run at' stamps in the CSV headers change on each download.
--
--   mkdir -p data/emi/w2qjha data/emi/w_p_c data/emi/g42mes data/emi/w_gg_c_nz \
--            data/emi/w_gg_c_island data/emi/w_gg_c_node data/emi/w_gd_c_nz \
--            data/emi/w_hvdc_c data/emi/generation_md
--   curl -fL -o data/emi/w2qjha/w2qjha.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W2QJHA?DateFrom=20261029&DateTo=20261029'
--   curl -fL -o data/emi/w_p_c/w_p_c.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_P_C?DateFrom=20261029&DateTo=20261029&RegionType=POC_REF&Show=SIMPLE'
--   curl -fL -o data/emi/g42mes/g42mes.csv 'https://www.emi.ea.govt.nz/All/Download/DataReport/CSV/G42MES?DateFrom=20261029&DateTo=20261029'
--   curl -fL -o data/emi/w_gg_c_nz/w_gg_c_nz.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_GG_C?DateFrom=20261029&DateTo=20261029&RegionType=NZ&Show=Gwh'
--   curl -fL -o data/emi/w_gg_c_island/w_gg_c_island.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_GG_C?DateFrom=20261029&DateTo=20261029&RegionType=ISLAND&Show=Gwh'
--   curl -fL -o data/emi/w_gg_c_node/w_gg_c_node.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_GG_C?DateFrom=20261029&DateTo=20261029&RegionType=POC&Show=Gwh'
--   curl -fL -o data/emi/w_gd_c_nz/w_gd_c_nz.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_GD_C?DateFrom=20261029&DateTo=20261029&RegionType=NZ&Show=Gwh'
--   curl -fL -o data/emi/w_hvdc_c/w_hvdc_c.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_HVDC_C?DateFrom=20261029&DateTo=20261029&TimeScale=DAY&Show=GWh'
--   curl -fL -o data/emi/generation_md/202610_Generation_MD.csv 'https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/202610_Generation_MD.csv'
--
-- CSV header lines differ per report, so each read_csv uses a skip count.
--   W2QJHA skip 8, W_P_C skip 11, G42MES skip 12, W_GG_C skip 11 (NZ, island, node),
--   W_GD_C skip 11, W_HVDC_C skip 10.
-- W_GG_C RegionType=POC is the Node option on the EMI Generation trends form.

-- =====================================================================
-- Load once
-- =====================================================================

-- Fuel map: exact copy of publisher/src/silver/fuel-map.ts (both vocabularies).
-- Unmapped codes are an anti-join to this table, not a second NOT IN list.
CREATE TEMP TABLE fuel_map AS
SELECT * FROM (VALUES
    ('Hydro', 'hydro'),
    ('Wind', 'wind'),
    ('Geo', 'geothermal'),
    ('Solar', 'solar'),
    ('Gas', 'gas'),
    ('Coal', 'coal_gas'),
    ('Diesel', 'other'),
    ('Wood', 'other'),
    ('HYD', 'hydro'),
    ('WIN', 'wind'),
    ('GEO', 'geothermal'),
    ('SOL', 'solar'),
    ('ELE', 'battery'),
    ('GAS', 'gas'),
    ('DSL', 'other'),
    ('CLG', 'coal_gas')
) AS t(fuel_code, fuel_category);

-- Reference nodes of ADR-0012 (publisher/src/gold/prices.ts).
CREATE TEMP TABLE reference_nodes AS
SELECT * FROM (VALUES
    ('OTA2201', 'upper_north_island'),
    ('HAY2201', 'lower_north_island'),
    ('BEN2201', 'south_island')
) AS t(point_of_connection, price_region);

CREATE TEMP TABLE generation_md_wide AS
SELECT *
FROM read_csv('data/emi/generation_md/202610_Generation_MD.csv', header = true)
WHERE Trading_Date = DATE '2026-10-29';

-- TP1–TP48 unpivot for this date. TP49 and TP50 are empty on an ordinary 48-period day.
CREATE TEMP TABLE generation_md AS
SELECT Site_Code, POC_Code, Nwk_Code, Gen_Code, Fuel_Code,
       CAST(substr(tp, 3) AS INTEGER) AS trading_period,
       kilowatt_hours
FROM generation_md_wide
UNPIVOT (kilowatt_hours FOR tp IN (
    TP1, TP2, TP3, TP4, TP5, TP6, TP7, TP8, TP9, TP10, TP11, TP12,
    TP13, TP14, TP15, TP16, TP17, TP18, TP19, TP20, TP21, TP22, TP23, TP24,
    TP25, TP26, TP27, TP28, TP29, TP30, TP31, TP32, TP33, TP34, TP35, TP36,
    TP37, TP38, TP39, TP40, TP41, TP42, TP43, TP44, TP45, TP46, TP47, TP48
));

CREATE TEMP TABLE generation_md_poc_day AS
SELECT POC_Code AS poc, sum(kilowatt_hours) / 1e6 AS md_gwh
FROM generation_md
GROUP BY 1;

CREATE TEMP TABLE gold_generation_by_fuel_day AS
SELECT * FROM read_parquet('data/gold/generation_by_fuel_day/trading_date=2026-10-29/data.parquet');

CREATE TEMP TABLE gold_price_daily_summary AS
SELECT * FROM read_parquet('data/gold/price_daily_summary/trading_date=2026-10-29/data.parquet');

CREATE TEMP TABLE gold_price_periods AS
SELECT * FROM read_parquet('data/gold/price_periods/trading_date=2026-10-29/data.parquet');

CREATE TEMP TABLE gold_price_spreads AS
SELECT * FROM read_parquet('data/gold/price_spreads/trading_date=2026-10-29/data.parquet');

CREATE TEMP TABLE gold_hvdc_transfer_day AS
SELECT * FROM read_parquet('data/gold/hvdc_transfer_day/trading_date=2026-10-29/data.parquet');

CREATE TEMP TABLE gold_hvdc_transfer_period AS
SELECT * FROM read_parquet('data/gold/hvdc_transfer_period/trading_date=2026-10-29/data.parquet');

CREATE TEMP TABLE silver_dispatch_energy_prices AS
SELECT * FROM read_parquet('data/silver/dispatch_energy_prices/trading_date=2026-10-29/data.parquet');

CREATE TEMP TABLE w2qjha AS
SELECT * FROM read_csv('data/emi/w2qjha/w2qjha.csv', skip = 8, header = true);

CREATE TEMP TABLE w2qjha_period AS
SELECT w."Point of connection" AS point_of_connection,
       w."Trading period" AS trading_period,
       min(w."Weighted Price ($/MWh)") AS emi_weighted,
       max(w."Weighted Price ($/MWh)") - min(w."Weighted Price ($/MWh)") AS weighted_spread
FROM w2qjha w
JOIN reference_nodes r ON r.point_of_connection = w."Point of connection"
GROUP BY 1, 2;

CREATE TEMP TABLE w_p_c AS
SELECT "Region ID" AS point_of_connection,
       CAST(hour("Period start") * 2 + minute("Period start") / 30 + 1 AS INTEGER) AS trading_period,
       "Price ($/MWh)" AS price
FROM read_csv('data/emi/w_p_c/w_p_c.csv', skip = 11, header = true);

CREATE TEMP TABLE g42mes AS
SELECT * FROM read_csv('data/emi/g42mes/g42mes.csv', skip = 12, header = true);

CREATE TEMP TABLE w_gg_c_nz AS
SELECT * FROM read_csv('data/emi/w_gg_c_nz/w_gg_c_nz.csv', skip = 11, header = true);

CREATE TEMP TABLE w_gg_c_island AS
SELECT * FROM read_csv('data/emi/w_gg_c_island/w_gg_c_island.csv', skip = 11, header = true);

CREATE TEMP TABLE w_gg_c_node AS
SELECT * FROM read_csv('data/emi/w_gg_c_node/w_gg_c_node.csv', skip = 11, header = true);

CREATE TEMP TABLE w_gg_c_node_day AS
SELECT "Region ID" AS poc, sum("Generation (GWh)") AS emi_gwh
FROM w_gg_c_node
GROUP BY 1;

CREATE TEMP TABLE w_gd_c_nz AS
SELECT * FROM read_csv('data/emi/w_gd_c_nz/w_gd_c_nz.csv', skip = 11, header = true);

CREATE TEMP TABLE w_hvdc_c AS
SELECT * FROM read_csv('data/emi/w_hvdc_c/w_hvdc_c.csv', skip = 10, header = true);

-- =====================================================================
-- Day, and the inputs_complete / analysis_version line (Day; Generation by fuel; Regional prices)
-- =====================================================================
SELECT 'generation_by_fuel_day' AS gold_table, analysis_version, inputs_complete, count(*) AS rows
FROM gold_generation_by_fuel_day
GROUP BY ALL
UNION ALL
SELECT 'price_daily_summary', analysis_version, inputs_complete, count(*)
FROM gold_price_daily_summary
GROUP BY ALL
UNION ALL
SELECT 'price_periods', analysis_version, inputs_complete, count(*)
FROM gold_price_periods
GROUP BY ALL
UNION ALL
SELECT 'price_spreads', analysis_version, inputs_complete, count(*)
FROM gold_price_spreads
GROUP BY ALL
UNION ALL
SELECT 'hvdc_transfer_day', analysis_version, inputs_complete, count(*)
FROM gold_hvdc_transfer_day
GROUP BY ALL
UNION ALL
SELECT 'hvdc_transfer_period', analysis_version, inputs_complete, count(*)
FROM gold_hvdc_transfer_period
GROUP BY ALL;

-- Day: trading periods in gold price_periods (report says 48).
SELECT count(DISTINCT trading_period) AS trading_periods
FROM gold_price_periods;

-- =====================================================================
-- Generation by fuel: gold table (Generation by fuel, first table)
-- =====================================================================
SELECT fuel_category, island, megawatt_hours, average_megawatts, inputs_complete
FROM gold_generation_by_fuel_day
ORDER BY fuel_category, island NULLS LAST;

-- =====================================================================
-- Generation by fuel: gold GWh by fuel, primary and all-fuel totals (Generation by fuel, second table)
-- =====================================================================
SELECT fuel_category, round(sum(megawatt_hours) / 1000.0, 6) AS gold_gwh
FROM gold_generation_by_fuel_day
GROUP BY ROLLUP (fuel_category)
ORDER BY fuel_category NULLS LAST;

SELECT round(sum(CASE WHEN fuel_category <> 'battery' THEN megawatt_hours ELSE 0 END) / 1000.0, 6) AS primary_gwh,
       round(sum(megawatt_hours) / 1000.0, 6) AS all_gwh
FROM gold_generation_by_fuel_day;

-- =====================================================================
-- Generation by fuel: gold vs published Generation_MD, by fuel (Generation by fuel, third table)
-- =====================================================================
SELECT coalesce(g.fuel_category, p.fuel_category) AS fuel_category,
       round(g.gold_gwh, 6) AS gold_gwh,
       round(p.published_gwh, 6) AS published_gwh,
       round(g.gold_gwh - p.published_gwh, 6) AS difference_gwh
FROM (
    SELECT fuel_category, sum(megawatt_hours) / 1000.0 AS gold_gwh
    FROM gold_generation_by_fuel_day
    GROUP BY fuel_category
) g
FULL OUTER JOIN (
    SELECT m.fuel_category, sum(md.kilowatt_hours) / 1e6 AS published_gwh
    FROM generation_md md
    LEFT JOIN fuel_map m ON m.fuel_code = md.Fuel_Code
    GROUP BY m.fuel_category
) p USING (fuel_category)
ORDER BY fuel_category NULLS LAST;

-- Unmapped Generation_MD fuel codes (report says none; expected 0 rows). Anti-join to fuel_map.
SELECT w.Fuel_Code, count(*) AS rows
FROM generation_md_wide w
ANTI JOIN fuel_map m ON m.fuel_code = w.Fuel_Code
GROUP BY w.Fuel_Code;

-- =====================================================================
-- National generation: gold vs EMI Generation trends W_GG_C and W_GD_C (National generation section)
-- NZ, island and demand totals in GWh. Gold primary by island in the second query.
-- =====================================================================
SELECT 'W_GG_C NZ' AS source, round(sum("Generation (GWh)"), 6) AS gwh, count(*) AS periods
FROM w_gg_c_nz
UNION ALL
SELECT 'W_GG_C NI (island)', round(sum("Generation (GWh)"), 6), count(*)
FROM w_gg_c_island
WHERE "Region ID" = 'NI'
UNION ALL
SELECT 'W_GG_C SI (island)', round(sum("Generation (GWh)"), 6), count(*)
FROM w_gg_c_island
WHERE "Region ID" = 'SI'
UNION ALL
SELECT 'W_GG_C node (POC)', round(sum("Generation (GWh)"), 6), count(DISTINCT "Region ID")
FROM w_gg_c_node
UNION ALL
SELECT 'W_GD_C NZ', round(sum("Demand (GWh)"), 6), count(*)
FROM w_gd_c_nz;

SELECT island,
       round(sum(CASE WHEN fuel_category <> 'battery' THEN megawatt_hours ELSE 0 END) / 1000.0, 6) AS gold_primary_gwh
FROM gold_generation_by_fuel_day
GROUP BY island
ORDER BY island;

-- W_GG_C node series vs NZ total (Differences: national generation).
SELECT round((SELECT sum("Generation (GWh)") FROM w_gg_c_nz)
           - (SELECT sum("Generation (GWh)") FROM w_gg_c_node), 6) AS nz_minus_node_gwh,
       round((SELECT sum("Generation (GWh)") FROM w_gg_c_island WHERE "Region ID" = 'NI')
           + (SELECT sum("Generation (GWh)") FROM w_gg_c_island WHERE "Region ID" = 'SI')
           - (SELECT sum("Generation (GWh)") FROM w_gg_c_nz), 6) AS island_sum_minus_nz_gwh;

-- EMI nodes absent from Generation_MD.
SELECT count(*) AS emi_nodes_absent_from_md, round(sum(n.emi_gwh), 6) AS gwh
FROM w_gg_c_node_day n
ANTI JOIN generation_md_poc_day m USING (poc);

-- Generation_MD POCs absent from the W_GG_C node series.
SELECT m.poc, round(m.md_gwh, 6) AS md_gwh
FROM generation_md_poc_day m
ANTI JOIN w_gg_c_node_day n USING (poc)
ORDER BY md_gwh DESC;

-- Named POCs in Differences: KIW2201 (MD only) and HLY2201 (EMI only).
SELECT coalesce(n.poc, m.poc) AS poc,
       round(n.emi_gwh, 6) AS emi_gwh,
       round(m.md_gwh, 6) AS md_gwh
FROM w_gg_c_node_day n
FULL OUTER JOIN generation_md_poc_day m USING (poc)
WHERE coalesce(n.poc, m.poc) IN ('KIW2201', 'HLY2201')
ORDER BY poc;

-- POCs present in both products.
SELECT count(*) AS pocs_in_both,
       round(sum(n.emi_gwh), 6) AS emi_gwh,
       round(sum(m.md_gwh), 6) AS md_gwh,
       round(sum(n.emi_gwh) - sum(m.md_gwh), 6) AS emi_minus_md_gwh
FROM w_gg_c_node_day n
JOIN generation_md_poc_day m USING (poc);

-- =====================================================================
-- HVDC transfer: gold hvdc_transfer_day / hvdc_transfer_period vs EMI W_HVDC_C
-- Sign convention (ADR-0016): positive is northward at Haywards, matching W_HVDC_C.
-- Gold energy is MWh; EMI energy is GWh. Gold period average_megawatts is north
-- received x 2. EMI peak flow may be a finer-resolution peak than the period average.
-- =====================================================================
SELECT g.direction AS gold_direction,
       e.Direction AS emi_direction,
       round(g.north_island_received_mwh / 1000.0, 6) AS gold_north_received_gwh,
       e."Energy transfer (GWh)" AS emi_energy_gwh,
       round(g.north_island_received_mwh / 1000.0 - e."Energy transfer (GWh)", 6) AS energy_difference_gwh,
       round(g.average_megawatts, 3) AS gold_average_mw,
       e."Average flow (MW)" AS emi_average_mw,
       round(g.average_megawatts - e."Average flow (MW)", 3) AS average_difference_mw,
       g.inputs_complete,
       g.analysis_version
FROM gold_hvdc_transfer_day g
CROSS JOIN w_hvdc_c e;

SELECT round(max(p.average_megawatts), 3) AS gold_max_period_average_mw,
       e."Peak flow (MW)" AS emi_peak_mw,
       round(max(p.average_megawatts) - e."Peak flow (MW)", 3) AS difference_mw
FROM gold_hvdc_transfer_period p
CROSS JOIN w_hvdc_c e
GROUP BY e."Peak flow (MW)";

-- Regional prices: silver row count per node (report says 286 per node, 858 in total)
-- and proxy flag on gold price_periods (report says false for each node).
SELECT s.point_of_connection, count(*) AS silver_rows
FROM silver_dispatch_energy_prices s
JOIN reference_nodes r USING (point_of_connection)
GROUP BY s.point_of_connection
ORDER BY s.point_of_connection;

SELECT p.point_of_connection, bool_or(p.has_proxy_price) AS any_proxy, count(*) AS periods
FROM gold_price_periods p
JOIN reference_nodes r USING (point_of_connection)
GROUP BY p.point_of_connection
ORDER BY p.point_of_connection;

-- =====================================================================
-- Daily prices: gold price_daily_summary vs EMI G42MES (Regional prices, daily table)
-- Gold min/max are published-row extrema (ADR-0012). The G42MES average is compared to gold mean_price.
-- =====================================================================
SELECT g.point_of_connection AS node,
       round(g.mean_price, 3) AS gold_mean_price,
       round(e."Average price", 3) AS emi_g42mes_average,
       round(g.mean_price - e."Average price", 3) AS mean_difference
FROM gold_price_daily_summary g
JOIN g42mes e ON e."Region ID" = g.point_of_connection
JOIN reference_nodes r ON r.point_of_connection = g.point_of_connection
ORDER BY node;

-- =====================================================================
-- Period extrema: gold price_periods min/max vs G42MES min/max (Regional prices, extrema table)
-- =====================================================================
SELECT p.point_of_connection AS node,
       round(min(p.price), 3) AS gold_min_period_price,
       round(e."Minimum price", 3) AS emi_g42mes_min,
       round(max(p.price), 3) AS gold_max_period_price,
       round(e."Maximum price", 3) AS emi_g42mes_max
FROM gold_price_periods p
JOIN g42mes e ON e."Region ID" = p.point_of_connection
JOIN reference_nodes r ON r.point_of_connection = p.point_of_connection
GROUP BY p.point_of_connection, e."Minimum price", e."Maximum price"
ORDER BY node;

-- =====================================================================
-- Period prices: gold price_periods vs EMI W2QJHA weighted price (Regional prices, period table)
-- Tolerance $0.01 and $0.10. Counts, extrema of the difference, and the periods outside $0.01.
-- =====================================================================
SELECT j.point_of_connection AS node,
       count(*) AS periods,
       count(*) FILTER (WHERE abs(j.diff) <= 0.01) AS within_0_01,
       count(*) FILTER (WHERE abs(j.diff) <= 0.10) AS within_0_10,
       round(min(j.diff), 4) AS min_diff,
       round(max(j.diff), 4) AS max_diff,
       string_agg(j.trading_period::VARCHAR, ',' ORDER BY j.trading_period) FILTER (WHERE abs(j.diff) > 0.01) AS periods_outside_0_01
FROM (
    SELECT p.point_of_connection, p.trading_period, p.price, e.emi_weighted,
           round(p.price - e.emi_weighted, 6) AS diff
    FROM gold_price_periods p
    JOIN w2qjha_period e USING (point_of_connection, trading_period)
) j
GROUP BY j.point_of_connection
ORDER BY node;

-- W2QJHA weighted price is constant within each node and period (max spread across case rows).
SELECT max(weighted_spread) AS max_weighted_spread_within_period
FROM w2qjha_period;

-- EMI W_P_C simple average vs W2QJHA weighted price, same period (Regional prices text: max abs difference $0.00).
SELECT max(abs(w.price - e.emi_weighted)) AS max_abs_wpc_minus_weighted,
       count(*) AS periods_compared
FROM w_p_c w
JOIN w2qjha_period e USING (point_of_connection, trading_period);

-- Worked example: Ōtāhuhu periods 7, 13, 15 and 28. EMI W2QJHA case rows by effective start.
-- The first silver publish is the rule B price (ADR-0012). The report quotes these numbers.
SELECT "Trading period" AS tp, "Effective start time" AS effective_start,
       "Duration (seconds)" AS duration_s, "Price ($/MWh)" AS emi_case_price, "Case ID"
FROM w2qjha
WHERE "Point of connection" = 'OTA2201'
  AND "Trading period" IN (7, 13, 15, 28)
ORDER BY tp, effective_start;

SELECT trading_period AS tp, min(source_published_at) AS first_publish,
       arg_min(dollars_per_megawatt_hour, source_published_at) AS first_publish_price
FROM silver_dispatch_energy_prices
WHERE point_of_connection = 'OTA2201'
  AND trading_period IN (7, 13, 15, 28)
GROUP BY trading_period
ORDER BY tp;

-- Period 7 gap: weight of the leading EMI case times (first publish - EMI case price), and gold minus EMI.
-- The inputs 220 s, 22.64 and 3.06 are read from the worked-example output above.
SELECT round(220 / 1800.0 * (22.64 - 3.06), 2) AS report_weight_gap_example,
       round(p.price, 4) AS gold_period_7_ota,
       round(e.emi_weighted, 4) AS emi_weighted_period_7_ota,
       round(p.price - e.emi_weighted, 4) AS gold_minus_emi_period_7_ota
FROM gold_price_periods p
JOIN w2qjha_period e
  ON e.point_of_connection = p.point_of_connection AND e.trading_period = p.trading_period
WHERE p.point_of_connection = 'OTA2201' AND p.trading_period = 7;

-- =====================================================================
-- Spreads: gold price_spreads vs EMI W_P_C node means (Spreads table)
-- Spread is from minus to. EMI mean spread is the difference of EMI node means.
-- =====================================================================
SELECT g.from_node || ' - ' || g.to_node AS pair,
       round(g.gold_mean_spread, 3) AS gold_mean_spread,
       round(f.emi_mean - t.emi_mean, 3) AS emi_mean_spread,
       round(g.gold_mean_spread - (f.emi_mean - t.emi_mean), 3) AS difference
FROM (
    SELECT from_point_of_connection AS from_node, to_point_of_connection AS to_node,
           avg(spread) AS gold_mean_spread
    FROM gold_price_spreads
    GROUP BY 1, 2
) g
JOIN (
    SELECT point_of_connection, avg(price) AS emi_mean
    FROM w_p_c
    GROUP BY 1
) f ON f.point_of_connection = g.from_node
JOIN (
    SELECT point_of_connection, avg(price) AS emi_mean
    FROM w_p_c
    GROUP BY 1
) t ON t.point_of_connection = g.to_node
ORDER BY pair;

-- EMI node means used above, for the report's EMI mean column.
SELECT w.point_of_connection AS node, round(avg(w.price), 3) AS emi_wpc_node_mean
FROM w_p_c w
JOIN reference_nodes r USING (point_of_connection)
GROUP BY w.point_of_connection
ORDER BY 1;
