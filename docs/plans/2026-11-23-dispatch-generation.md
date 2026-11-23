# Dispatch generation for recent days

Thermo-nuclear: reuse gold generation tables, the load RTD-case rule, and the fuel-override pattern; no new collector.

## Background

Recent daily pages miss generation because gold reads only Generation_MD. Nodal dispatch is already in silver, CC BY 4.0, and lands the next morning. Spec: `docs/specs/2026-11-23-dispatch-generation-design.md`.

## Key Considerations

Prefer Generation_MD when that silver day exists. Otherwise build the same four gold generation tables from nodal unit MW. Label `source` `metered` or `dispatch`. Map units to plants by (POC, fuel) uniqueness, then `UNIT_PLANT_OVERRIDES`. Energy balance and Sankey stay on the HVDC month lag.

Reuse: `publisher/src/gold/generation.ts`, `grid-load.ts` latest-case SQL, `fuel-map.ts` override pattern, `entity-mappings.ts` unit join, site `generation.source` as an optional contract field.

## Files

- Modify: `publisher/src/silver/fuel-map.ts` — add `UNIT_PLANT_OVERRIDES`
- Modify: `publisher/src/silver/entity-mappings.ts` — (POC, fuel) join, override coalesce, fingerprint
- Modify: `publisher/src/silver/entity-mappings.test.ts`
- Modify: `publisher/src/gold/generation.ts` and `generation.test.ts`
- Modify: `publisher/src/site/contract.ts`, `export-generation.ts`, `export.ts` (`EXPORT_VERSION`)
- Modify: site daily copy and `market-conditions.ts` lag note
- Amend: `docs/adr/0008-entity-model.md`, `docs/adr/0011-gold-table-pattern.md`, `docs/adr/0014-site-json-contract.md`
- Create: `docs/adr/0028-dispatch-generation.md`

## Commit boundaries

1. Entity unit→plant join and `UNIT_PLANT_OVERRIDES` (ADR-0008 amendment). Testable without gold. Done in working tree.
2. Gold overlay: metered if MD exists, else dispatch from nodal. ADR-0011 amendment, ADR-0028. Done in working tree.
3. Site contract `generation.source`, copy, lag note. ADR-0014 amendment. Next.

## Closed Considerations

- Transpower / em6: no reuse licence.
- Parallel gold tables: unnecessary while energy balance is HVDC-gated.
- Units as plant ids: would break day-compare when MD lands.

## Open Considerations

Override seed rows after measuring unmapped units on the tighter join.
