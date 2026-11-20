# Nodal prices and volumes fixtures

Real extracts of two daily files. Each keeps the header and every row for three points of connection. All trading periods remain.

| Point of connection | Rows it gives |
| --- | --- |
| `ALB0331` | Point of connection rows (unit `N/A`): load and price |
| `ARA2201` | Generation rows for unit `ARA0` |
| `PPI2201` | Generation rows for unit `PPI0`. The unit is dead and disconnected on 18 Nov 2026 |

| File | Source | Day |
| --- | --- | --- |
| `20261118_DispatchNodalPricesAndVolumes.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/2026/20261118_DispatchNodalPricesAndVolumes.csv> | Normal day, 48 periods. 282 intervals, six of them with two cases (a re-run) |
| `20260927_DispatchNodalPricesAndVolumes.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/2026/20260927_DispatchNodalPricesAndVolumes.csv> | DST start, 46 periods |

Fetched anonymously with `curl` on 2026-11-20, then filtered with `awk -F, 'NR==1||$7=="ALB0331"||$7=="ARA2201"||$7=="PPI2201"'`.
