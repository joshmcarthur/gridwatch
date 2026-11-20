-- Validation queries for docs/validation/2026-10-29.md (trading date 2026-10-29).
--
-- Run from the repo root:   duckdb < docs/validation/2026-10-29.sql
--
-- Reads gold and silver Parquet under data/ and EMI CSV files under data/emi/.
-- Opens no database file (in-memory) and writes nothing. Each query is headed by
-- the report section or table it produces.
--
-- EMI downloads. Run once from the repo root. Each file has its own folder under data/emi/
-- (data/ is git-ignored). The 'Run at' stamps in the CSV headers change on each download.
--
--   mkdir -p data/emi/w2qjha data/emi/w_p_c data/emi/g42mes data/emi/w_gg_c_nz \
--            data/emi/w_gg_c_island data/emi/w_gd_c_nz data/emi/w_hvdc_c data/emi/generation_md
--   curl -fL -o data/emi/w2qjha/w2qjha.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W2QJHA?DateFrom=20261029&DateTo=20261029'
--   curl -fL -o data/emi/w_p_c/w_p_c.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_P_C?DateFrom=20261029&DateTo=20261029&RegionType=POC_REF&Show=SIMPLE'
--   curl -fL -o data/emi/g42mes/g42mes.csv 'https://www.emi.ea.govt.nz/All/Download/DataReport/CSV/G42MES?DateFrom=20261029&DateTo=20261029'
--   curl -fL -o data/emi/w_gg_c_nz/w_gg_c_nz.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_GG_C?DateFrom=20261029&DateTo=20261029&RegionType=NZ&Show=Gwh'
--   curl -fL -o data/emi/w_gg_c_island/w_gg_c_island.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_GG_C?DateFrom=20261029&DateTo=20261029&RegionType=ISLAND&Show=Gwh'
--   curl -fL -o data/emi/w_gd_c_nz/w_gd_c_nz.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_GD_C?DateFrom=20261029&DateTo=20261029&RegionType=NZ&Show=Gwh'
--   curl -fL -o data/emi/w_hvdc_c/w_hvdc_c.csv 'https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/W_HVDC_C?DateFrom=20261029&DateTo=20261029&TimeScale=DAY&Show=GWh'
--   curl -fL -o data/emi/generation_md/202610_Generation_MD.csv 'https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/202610_Generation_MD.csv'
--
-- CSV header lines differ per report, so each read_csv uses a skip count.
--   W2QJHA skip 8, W_P_C skip 11, G42MES skip 12, W_GG_C skip 11, W_GD_C skip 11, W_HVDC_C skip 10.
--
-- Figures read by hand (no query, not reproduced here):
--   W_GG_C node-level report (node series, 208 nodes, 118.651 GWh) for the node counts,
--   the 125 nodes absent from Generation_MD (4.093 GWh), KIW2201 (2.726 GWh) and HLY2201 (0.696 GWh).
--   These were read by hand from the EMI Generation trends node report for 29 October 2026.
--   The node report URL is not recorded in the report. Treat them as unverified until re-read.

-- =====================================================================
-- Day, and the inputs_complete / analysis_version line (Day; Generation by fuel; Regional prices)
-- =====================================================================
SELECT 'generation_by_fuel_day' AS gold_table, analysis_version, inputs_complete, count(*) AS rows
FROM read_parquet('data/gold/generation_by_fuel_day/trading_date=2026-10-29/data.parquet')
GROUP BY ALL
UNION ALL
SELECT 'price_daily_summary', analysis_version, inputs_complete, count(*)
FROM read_parquet('data/gold/price_daily_summary/trading_date=2026-10-29/data.parquet')
GROUP BY ALL
UNION ALL
SELECT 'price_periods', analysis_version, inputs_complete, count(*)
FROM read_parquet('data/gold/price_periods/trading_date=2026-10-29/data.parquet')
GROUP BY ALL
UNION ALL
SELECT 'price_spreads', analysis_version, inputs_complete, count(*)
FROM read_parquet('data/gold/price_spreads/trading_date=2026-10-29/data.parquet')
GROUP BY ALL;

-- Day: trading periods in gold price_periods (report says 48).
SELECT count(DISTINCT trading_period) AS trading_periods
FROM read_parquet('data/gold/price_periods/trading_date=2026-10-29/data.parquet');

-- =====================================================================
-- Generation by fuel: gold table (Generation by fuel, first table)
-- =====================================================================
SELECT fuel_category, island, megawatt_hours, average_megawatts, inputs_complete
FROM read_parquet('data/gold/generation_by_fuel_day/trading_date=2026-10-29/data.parquet')
ORDER BY fuel_category, island NULLS LAST;

-- =====================================================================
-- Generation by fuel: gold GWh by fuel, primary and all-fuel totals (Generation by fuel, second table)
-- =====================================================================
SELECT fuel_category, round(sum(megawatt_hours) / 1000.0, 6) AS gold_gwh
FROM read_parquet('data/gold/generation_by_fuel_day/trading_date=2026-10-29/data.parquet')
GROUP BY ROLLUP (fuel_category)
ORDER BY fuel_category NULLS LAST;

SELECT round(sum(CASE WHEN fuel_category <> 'battery' THEN megawatt_hours ELSE 0 END) / 1000.0, 6) AS primary_gwh,
       round(sum(megawatt_hours) / 1000.0, 6) AS all_gwh
FROM read_parquet('data/gold/generation_by_fuel_day/trading_date=2026-10-29/data.parquet');

-- =====================================================================
-- Generation by fuel: gold vs published Generation_MD, by fuel (Generation by fuel, third table)
-- Fuel mapping copied from publisher/src/silver/fuel-map.ts. Check the unmapped count is 0.
-- =====================================================================
WITH fuel_map(fuel_code, fuel_category) AS (
    VALUES ('Hydro', 'hydro'), ('HYD', 'hydro'),
           ('Geo', 'geothermal'), ('GEO', 'geothermal'),
           ('Wind', 'wind'), ('WIN', 'wind'),
           ('Solar', 'solar'), ('SOL', 'solar'),
           ('Gas', 'gas'), ('GAS', 'gas'),
           ('Coal', 'coal_gas'), ('CLG', 'coal_gas'),
           ('ELE', 'battery'),
           ('Diesel', 'other'), ('DSL', 'other'), ('Wood', 'other')
),
md AS (
    SELECT Fuel_Code, sum(list_sum([
        TP1, TP2, TP3, TP4, TP5, TP6, TP7, TP8, TP9, TP10, TP11, TP12,
        TP13, TP14, TP15, TP16, TP17, TP18, TP19, TP20, TP21, TP22, TP23, TP24,
        TP25, TP26, TP27, TP28, TP29, TP30, TP31, TP32, TP33, TP34, TP35, TP36,
        TP37, TP38, TP39, TP40, TP41, TP42, TP43, TP44, TP45, TP46, TP47, TP48
    ])) / 1e6 AS gwh
    FROM read_csv('data/emi/generation_md/202610_Generation_MD.csv', header = true)
    WHERE Trading_Date = DATE '2026-10-29'
    GROUP BY Fuel_Code
),
published AS (
    SELECT m.fuel_category, sum(md.gwh) AS published_gwh
    FROM md LEFT JOIN fuel_map m ON m.fuel_code = md.Fuel_Code
    GROUP BY m.fuel_category
),
gold AS (
    SELECT fuel_category, sum(megawatt_hours) / 1000.0 AS gold_gwh
    FROM read_parquet('data/gold/generation_by_fuel_day/trading_date=2026-10-29/data.parquet')
    GROUP BY fuel_category
)
SELECT coalesce(g.fuel_category, p.fuel_category) AS fuel_category,
       round(g.gold_gwh, 6) AS gold_gwh,
       round(p.published_gwh, 6) AS published_gwh,
       round(g.gold_gwh - p.published_gwh, 6) AS difference_gwh
FROM gold g FULL OUTER JOIN published p USING (fuel_category)
ORDER BY fuel_category NULLS LAST;

-- Unmapped Generation_MD fuel codes (report says none; expected 0 rows).
SELECT Fuel_Code, count(*) AS rows
FROM read_csv('data/emi/generation_md/202610_Generation_MD.csv', header = true)
WHERE Trading_Date = DATE '2026-10-29'
  AND Fuel_Code NOT IN ('Hydro', 'HYD', 'Geo', 'GEO', 'Wind', 'WIN', 'Solar', 'SOL',
                        'Gas', 'GAS', 'Coal', 'CLG', 'ELE', 'Diesel', 'DSL', 'Wood')
GROUP BY Fuel_Code;

-- =====================================================================
-- National generation: gold vs EMI Generation trends W_GG_C and W_GD_C (National generation section)
-- NZ, island and demand totals in GWh. Gold primary by island in the second query.
-- =====================================================================
SELECT 'W_GG_C NZ' AS source, round(sum("Generation (GWh)"), 6) AS gwh, count(*) AS periods
FROM read_csv('data/emi/w_gg_c_nz/w_gg_c_nz.csv', skip = 11, header = true)
UNION ALL
SELECT 'W_GG_C NI (island)', round(sum("Generation (GWh)"), 6), count(*)
FROM read_csv('data/emi/w_gg_c_island/w_gg_c_island.csv', skip = 11, header = true)
WHERE "Region ID" = 'NI'
UNION ALL
SELECT 'W_GG_C SI (island)', round(sum("Generation (GWh)"), 6), count(*)
FROM read_csv('data/emi/w_gg_c_island/w_gg_c_island.csv', skip = 11, header = true)
WHERE "Region ID" = 'SI'
UNION ALL
SELECT 'W_GD_C NZ', round(sum("Demand (GWh)"), 6), count(*)
FROM read_csv('data/emi/w_gd_c_nz/w_gd_c_nz.csv', skip = 11, header = true);

SELECT island,
       round(sum(CASE WHEN fuel_category <> 'battery' THEN megawatt_hours ELSE 0 END) / 1000.0, 6) AS gold_primary_gwh
FROM read_parquet('data/gold/generation_by_fuel_day/trading_date=2026-10-29/data.parquet')
GROUP BY island
ORDER BY island;

-- =====================================================================
-- HVDC transfer: EMI W_HVDC_C, day scale (HVDC transfer section; external only, not in gold)
-- =====================================================================
SELECT Direction, "Energy transfer (GWh)" AS energy_gwh, "Peak flow (MW)" AS peak_mw, "Average flow (MW)" AS average_mw
FROM read_csv('data/emi/w_hvdc_c/w_hvdc_c.csv', skip = 10, header = true);

-- =====================================================================
-- Daily prices: gold price_daily_summary vs EMI G42MES (Regional prices, daily table)
-- Gold min/max are published-row extrema (ADR-0012). The G42MES average is compared to gold mean_price.
-- =====================================================================
SELECT g.point_of_connection AS node,
       round(g.mean_price, 3) AS gold_mean_price,
       round(e."Average price", 3) AS emi_g42mes_average,
       round(g.mean_price - e."Average price", 3) AS mean_difference
FROM read_parquet('data/gold/price_daily_summary/trading_date=2026-10-29/data.parquet') g
JOIN read_csv('data/emi/g42mes/g42mes.csv', skip = 12, header = true) e
  ON e."Region ID" = g.point_of_connection
WHERE g.point_of_connection IN ('OTA2201', 'HAY2201', 'BEN2201')
ORDER BY node;

-- =====================================================================
-- Period extrema: gold price_periods min/max vs G42MES min/max (Regional prices, extrema table)
-- =====================================================================
SELECT p.point_of_connection AS node,
       round(min(p.price), 3) AS gold_min_period_price,
       round(e."Minimum price", 3) AS emi_g42mes_min,
       round(max(p.price), 3) AS gold_max_period_price,
       round(e."Maximum price", 3) AS emi_g42mes_max
FROM read_parquet('data/gold/price_periods/trading_date=2026-10-29/data.parquet') p
JOIN read_csv('data/emi/g42mes/g42mes.csv', skip = 12, header = true) e
  ON e."Region ID" = p.point_of_connection
WHERE p.point_of_connection IN ('OTA2201', 'HAY2201', 'BEN2201')
GROUP BY p.point_of_connection, e."Minimum price", e."Maximum price"
ORDER BY node;

-- =====================================================================
-- Period prices: gold price_periods vs EMI W2QJHA weighted price (Regional prices, period table)
-- Tolerance $0.01 and $0.10. Counts, extrema of the difference, and the periods outside $0.01.
-- =====================================================================
WITH emi AS (
    SELECT "Point of connection" AS point_of_connection,
           "Trading period" AS trading_period,
           min("Weighted Price ($/MWh)") AS emi_weighted,
           max("Weighted Price ($/MWh)") - min("Weighted Price ($/MWh)") AS weighted_spread
    FROM read_csv('data/emi/w2qjha/w2qjha.csv', skip = 8, header = true)
    WHERE "Point of connection" IN ('OTA2201', 'HAY2201', 'BEN2201')
    GROUP BY 1, 2
),
joined AS (
    SELECT p.point_of_connection, p.trading_period, p.price, e.emi_weighted,
           round(p.price - e.emi_weighted, 6) AS diff
    FROM read_parquet('data/gold/price_periods/trading_date=2026-10-29/data.parquet') p
    JOIN emi e USING (point_of_connection, trading_period)
)
SELECT point_of_connection AS node,
       count(*) AS periods,
       count(*) FILTER (WHERE abs(diff) <= 0.01) AS within_0_01,
       count(*) FILTER (WHERE abs(diff) <= 0.10) AS within_0_10,
       round(min(diff), 4) AS min_diff,
       round(max(diff), 4) AS max_diff,
       string_agg(trading_period::VARCHAR, ',' ORDER BY trading_period) FILTER (WHERE abs(diff) > 0.01) AS periods_outside_0_01
FROM joined
GROUP BY point_of_connection
ORDER BY node;

-- W2QJHA weighted price is constant within each node and period (max spread across case rows).
SELECT max(weighted_spread) AS max_weighted_spread_within_period
FROM (
    SELECT max("Weighted Price ($/MWh)") - min("Weighted Price ($/MWh)") AS weighted_spread
    FROM read_csv('data/emi/w2qjha/w2qjha.csv', skip = 8, header = true)
    WHERE "Point of connection" IN ('OTA2201', 'HAY2201', 'BEN2201')
    GROUP BY "Point of connection", "Trading period"
);

-- EMI W_P_C simple average vs W2QJHA weighted price, same period (Regional prices text: max abs difference $0.00).
WITH emi AS (
    SELECT "Point of connection" AS point_of_connection,
           "Trading period" AS trading_period,
           min("Weighted Price ($/MWh)") AS emi_weighted
    FROM read_csv('data/emi/w2qjha/w2qjha.csv', skip = 8, header = true)
    WHERE "Point of connection" IN ('OTA2201', 'HAY2201', 'BEN2201')
    GROUP BY 1, 2
),
wpc AS (
    SELECT "Region ID" AS point_of_connection,
           CAST(hour("Period start") * 2 + minute("Period start") / 30 + 1 AS INTEGER) AS trading_period,
           "Price ($/MWh)" AS wpc_price
    FROM read_csv('data/emi/w_p_c/w_p_c.csv', skip = 11, header = true)
    WHERE "Region ID" IN ('OTA2201', 'HAY2201', 'BEN2201')
)
SELECT max(abs(w.wpc_price - e.emi_weighted)) AS max_abs_wpc_minus_weighted,
       count(*) AS periods_compared
FROM wpc w JOIN emi e USING (point_of_connection, trading_period);

-- Worked example: Ōtāhuhu periods 7, 13, 15 and 28. EMI W2QJHA case rows by effective start.
-- The first silver publish is the rule B price (ADR-0012). The report quotes these numbers.
SELECT "Trading period" AS tp, "Effective start time" AS effective_start,
       "Duration (seconds)" AS duration_s, "Price ($/MWh)" AS emi_case_price, "Case ID"
FROM read_csv('data/emi/w2qjha/w2qjha.csv', skip = 8, header = true)
WHERE "Point of connection" = 'OTA2201'
  AND "Trading period" IN (7, 13, 15, 28)
ORDER BY tp, effective_start;

SELECT trading_period AS tp, min(source_published_at) AS first_publish,
       arg_min(dollars_per_megawatt_hour, source_published_at) AS first_publish_price
FROM read_parquet('data/silver/dispatch_energy_prices/trading_date=2026-10-29/data.parquet')
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
FROM read_parquet('data/gold/price_periods/trading_date=2026-10-29/data.parquet') p,
     (SELECT min("Weighted Price ($/MWh)") AS emi_weighted
      FROM read_csv('data/emi/w2qjha/w2qjha.csv', skip = 8, header = true)
      WHERE "Point of connection" = 'OTA2201' AND "Trading period" = 7) e
WHERE p.point_of_connection = 'OTA2201' AND p.trading_period = 7;

-- =====================================================================
-- Spreads: gold price_spreads vs EMI W_P_C node means (Spreads table)
-- Spread is from minus to. EMI mean spread is the difference of EMI node means.
-- =====================================================================
WITH wpc AS (
    SELECT "Region ID" AS point_of_connection, avg("Price ($/MWh)") AS emi_mean
    FROM read_csv('data/emi/w_p_c/w_p_c.csv', skip = 11, header = true)
    WHERE "Region ID" IN ('OTA2201', 'HAY2201', 'BEN2201')
    GROUP BY 1
),
gold_spreads AS (
    SELECT from_point_of_connection AS from_node, to_point_of_connection AS to_node,
           avg(spread) AS gold_mean_spread
    FROM read_parquet('data/gold/price_spreads/trading_date=2026-10-29/data.parquet')
    GROUP BY 1, 2
)
SELECT g.from_node || ' - ' || g.to_node AS pair,
       round(g.gold_mean_spread, 3) AS gold_mean_spread,
       round(f.emi_mean - t.emi_mean, 3) AS emi_mean_spread,
       round(g.gold_mean_spread - (f.emi_mean - t.emi_mean), 3) AS difference
FROM gold_spreads g
JOIN wpc f ON f.point_of_connection = g.from_node
JOIN wpc t ON t.point_of_connection = g.to_node
ORDER BY pair;

-- EMI node means used above, for the report's EMI mean column.
SELECT "Region ID" AS node, round(avg("Price ($/MWh)"), 3) AS emi_wpc_node_mean
FROM read_csv('data/emi/w_p_c/w_p_c.csv', skip = 11, header = true)
WHERE "Region ID" IN ('OTA2201', 'HAY2201', 'BEN2201')
GROUP BY 1
ORDER BY 1;
