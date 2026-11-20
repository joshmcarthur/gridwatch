# Dispatch reserve prices fixtures

Real copies of two daily files, not trimmed. The source lists only two points of connection (`HAY2201` and `BEN2201`), so each whole file is small (about 36 KB). All trading periods and both reserve classes remain.

| File | Source | Day |
| --- | --- | --- |
| `20261118_DispatchReservePrices.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchReservePrices/2026/20261118_DispatchReservePrices.csv> | Normal day, 48 periods |
| `20260927_DispatchReservePrices.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchReservePrices/2026/20260927_DispatchReservePrices.csv> | DST start, 46 periods |

Fetched anonymously with `curl` on 2026-11-20. No rows removed.
