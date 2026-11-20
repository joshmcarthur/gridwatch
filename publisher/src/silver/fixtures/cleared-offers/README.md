# Cleared offers fixtures

Real extracts of three daily files. Each keeps the header and every row for four units and points of connection. All trading periods remain.

| Kept rows | What it covers |
| --- | --- |
| `UnitCode` `KPO0` (Karāpiro) | An injection unit with a macron in the plant name, in every period |
| `UnitCode` `PTA3` (Patea unit 3) | An injection unit with a blank `Island` |
| `UnitCode` `RHO99` | An offtake row with a unit code. Only the plant name is `N/A` |
| `PointOfConnectionCode` `BOB1101` | An offtake row with unit and plant name `N/A`, in every period |

| File | Source | Day |
| --- | --- | --- |
| `20261118_ClearedOffers.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/ClearedOffers/2026/20261118_ClearedOffers.csv> | Normal day, 48 periods. Six intervals have two cases. |
| `20260927_ClearedOffers.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/ClearedOffers/2026/20260927_ClearedOffers.csv> | DST start, 46 periods |
| `20260405_ClearedOffers.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/ClearedOffers/2026/20260405_ClearedOffers.csv> | DST end, 50 periods |

Fetched anonymously with `curl` on 2026-11-20, then filtered with `awk -F, 'NR==1||$9=="KPO0"||$9=="RHO99"||$9=="PTA3"||$8=="BOB1101"'`.
