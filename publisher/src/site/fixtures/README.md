# Exporter lock sample

This is the byte-for-byte lock of `exportSite` on the trimmed silver Generation_MD extract, the January NSP snapshot, and synthetic Otahuhu / Haywards / Benmore prices (OTA 80 + period, HAY 70 + period, BEN 60 + period). The day is 2026-09-27 (DST start, 46 periods). There is no HVDC_Flows file, so `sankey` is `missing`.

It is not the visual sample the site builds when gold is absent. Those days live in `site/fixtures/` and are real EMI publishes.

To refresh this lock after an exporter or contract change, run `UPDATE_SITE_FIXTURES=1 npm test -- export.test.ts` from the repository root, and review the diff here.
