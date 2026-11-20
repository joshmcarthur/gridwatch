# HVDC_Flows fixtures

Real extracts of three monthly files. Each keeps the header and every row (four per day: `BEN2201` and `HAY2201`, each with `X` and `I`) of the listed days. No values are changed.

| File | Source | Days kept |
| --- | --- | --- |
| `202604_HVDC_flows.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Metered_data/HVDC_Flows/202604_HVDC_flows.csv> | 2026-04-05 (DST end, 50 periods, net southward), 2026-04-12 (TP38: the two ends disagree), 2026-04-26 (TP21 to TP35 all zero) |
| `202609_HVDC_flows.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Metered_data/HVDC_Flows/202609_HVDC_flows.csv> | 2026-09-27 (DST start, 46 periods) |
| `202610_HVDC_flows.csv` | <https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Metered_data/HVDC_Flows/202610_HVDC_flows.csv> | 2026-10-24 (both directions in TP27 to TP30), 2026-10-31 (northward, 48 periods) |

Fetched anonymously with `curl` on 2026-11-21, then trimmed with:

```sh
awk -F, 'NR==1 || $8=="2026-10-31"' 202610_HVDC_flows.csv
```

The command keeps the header (`NR==1`) and the rows whose `Trading_Date` (field 8) is the given date. Repeat the date test for each day listed above. The files hold every day of their month, so the tests use the days kept here and the days that the files do not hold.
