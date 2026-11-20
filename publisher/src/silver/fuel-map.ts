/** The Gridwatch fuel categories (brief section 8.1, ADR-0008). */
export const FUEL_CATEGORIES = [
  "hydro",
  "geothermal",
  "wind",
  "gas",
  "coal",
  "solar",
  "other",
] as const;

export type FuelCategory = (typeof FUEL_CATEGORIES)[number];

/**
 * Source fuel code to Gridwatch category. The match is exact, and case matters. The
 * Generation_MD `Fuel_Code` and the fleet `FuelCode` use two vocabularies, so each spelling
 * has its own line. Codes seen on live data on 2026-11-20 are all here, except the fleet
 * placeholder `N/A`. A code that is not here goes to the unmapped report (ADR-0008). Never add
 * a catch-all line.
 */
export const FUEL_MAP: Record<string, FuelCategory> = {
  // Generation_MD, long vocabulary
  Hydro: "hydro",
  Wind: "wind",
  Geo: "geothermal",
  Solar: "solar",
  Gas: "gas",
  Diesel: "other",
  Wood: "other",
  // Generation_MD, short vocabulary; the fleet file uses the same short codes
  HYD: "hydro",
  WIN: "wind",
  GEO: "geothermal",
  SOL: "solar",
  ELE: "other", // battery storage, not a fuel
  // Fleet file only
  GAS: "gas",
  DSL: "other",
  CLG: "coal", // Huntly Rankine units burn coal and gas; see ADR-0008
};
