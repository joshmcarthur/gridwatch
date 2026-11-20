# Generation_MD fixtures

Real extracts of two monthly files. Each keeps the header and the rows of five points of connection (`ARA2201`, `ASB0661`, `CML0331`, `KIW2201`, `BRB0331`) for the listed days. That gives 6 or 7 unit rows a day, because one point of connection can hold more than one unit. The rows cover both code vocabularies: `Hydro/Hydro`, `Solar/Solar`, `HYD/HYD`, `WIN/ONW` and `ELE/BAT`. All periods stay in each row.

| File | Source | Days kept |
| --- | --- | --- |
| `202604_Generation_MD.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/202604_Generation_MD.csv> | 2026-04-01 (normal, 48 periods), 2026-04-05 (DST end, 50 periods) |
| `202609_Generation_MD.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/202609_Generation_MD.csv> | 2026-09-26 (normal), 2026-09-27 (DST start, 46 periods) |

Fetched anonymously with `curl` on 2026-11-20, then filtered with `awk -F, 'NR==1||(($7=="2026-04-01"||$7=="2026-04-05")&&($2=="ARA2201"||$2=="ASB0661"||$2=="CML0331"||$2=="KIW2201"||$2=="BRB0331"))'`. The September file used the dates 2026-09-26 and 2026-09-27.

The files have no rows for the other days of the month. The tests use this to check a day that the file does not hold.

The `202609` file also holds two rows that are not real extracts: `HLY2201`, `GENE`, `huntly_1_4`, fuel `Coal`, tech `Thrml`, for 2026-09-26 and 2026-09-27. They copy the `ARA2201` values and change the identifiers. The live files have this plant with the fuel code `Coal`, and the fuel map tests need that code in a fixture. That makes 8 unit rows on 2026-09-26 and 8 on 2026-09-27 in this file.
