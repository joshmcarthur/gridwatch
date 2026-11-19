# data

This directory is the default `DATA_ROOT`. Git ignores everything here except this file.

| Directory | Layer                         | Contents                                                                               | Written by |
| --------- | ----------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `bronze/` | Raw archive                   | Source files exactly as published, plus a manifest                                     | collector  |
| `silver/` | Canonical datasets            | Typed, validated Parquet. UTC timestamps. Source IDs kept. Partitioned by trading date | publisher  |
| `gold/`   | Derived and presentation data | Analytical Parquet tables. Site JSON under `gold/site/`                                | publisher  |
