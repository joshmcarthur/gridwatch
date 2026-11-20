# Gold price fixtures

A real extract of one daily dispatch energy prices file: 2026-11-18, normal day, 48 periods. It keeps the header and every row for four points of connection: the reference nodes `OTA2201`, `HAY2201` and `BEN2201`, and `ALB0331`.

Source: <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20261118_DispatchEnergyPrices.csv>

Fetched anonymously with `curl` on 2026-11-20, then filtered with `awk -F, 'NR==1||$4=="OTA2201"||$4=="HAY2201"||$4=="BEN2201"||$4=="ALB0331"'`.
