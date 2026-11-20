# Network supply points fixtures

Real extracts of two dated snapshots. Each keeps the header and every row (current and closed) for five points of connection:

- `ALB0331` and `OHG1101`: the two points in the dispatch energy prices fixtures. `OHG1101` has a blank `Island` in the price file and no coordinates here. It starts on 2026-06-26, so the January snapshot does not hold it.
- `AER0011`: no coordinates. The January snapshot already holds it with a start date of 2026-02-01.
- `AKL0331` and `ABY0111`: several closed rows, and coordinates in the North and South Island.

| File | Source | Snapshot |
| --- | --- | --- |
| `20261119_NetworkSupplyPointsTable.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/MappingsAndGeospatial/NetworkSupplyPointsTable/20261119_NetworkSupplyPointsTable.csv> | Latest at the time |
| `20260106_NetworkSupplyPointsTable.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/MappingsAndGeospatial/NetworkSupplyPointsTable/20260106_NetworkSupplyPointsTable.csv> | First snapshot the source keeps |

Fetched anonymously with `curl` on 2026-11-20, then filtered with `awk -F, 'NR==1||$4=="ALB0331"||$4=="OHG1101"||$4=="AER0011"||$4=="AKL0331"||$4=="ABY0111"'`. Column 4 is `POC code`. We then blanked the `SB ICP` column (an ICP number). Silver drops that column.
