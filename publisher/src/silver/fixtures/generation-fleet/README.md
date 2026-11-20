# Generation fleet fixture

Real extract of the existing generation fleet file. It keeps the header and every row for four points of connection: `ARA2201`, `ARG1101` (two operator periods), `ASB0661` (two plants, one with two operator periods) and `BEN2202`.

| File | Source |
| --- | --- |
| `DispatchedGenerationPlant.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/GenerationFleet/Existing/DispatchedGenerationPlant.csv> |

Fetched anonymously with `curl` on 2026-11-20, then filtered with `awk -F, 'NR==1||$2=="ARG1101"||$2=="ASB0661"||$2=="BEN2202"||$2=="ARA2201"'`. Column 2 is `PointOfConnectionCode`. The source overwrites this file in place, so the file name carries no date.
