# Dispatch energy prices fixtures

Real extracts of two daily files. Each keeps the header and every row for two points of connection (`OHG1101`, which has a blank `Island`, and `ALB0331`). All trading periods remain.

| File | Source | Day |
| --- | --- | --- |
| `20261118_DispatchEnergyPrices.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20261118_DispatchEnergyPrices.csv> | Normal day, 48 periods |
| `20260927_DispatchEnergyPrices.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20260927_DispatchEnergyPrices.csv> | DST start, 46 periods |

Fetched anonymously with `curl` on 2026-11-20, then filtered with `awk -F, 'NR==1||$4=="OHG1101"||$4=="ALB0331"'`.
