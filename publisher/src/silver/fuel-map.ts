/** The Gridwatch fuel categories (brief section 8.1 with `coal_gas` for `coal` and `battery` added, ADR-0008). */
export const FUEL_CATEGORIES = [
  "hydro",
  "geothermal",
  "wind",
  "gas",
  "coal_gas",
  "solar",
  "battery",
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
  Coal: "coal_gas", // only huntly_1_4 at HLY2201 has this code; see ADR-0008
  Diesel: "other",
  Wood: "other",
  // Generation_MD, short vocabulary; the fleet file uses the same short codes
  HYD: "hydro",
  WIN: "wind",
  GEO: "geothermal",
  SOL: "solar",
  ELE: "battery", // storage, not primary energy; see ADR-0008
  // Fleet file only
  GAS: "gas",
  DSL: "other",
  CLG: "coal_gas", // the fleet file says "Coal/Gas"; see ADR-0008
};

/**
 * Plant IDs whose Generation_MD fuel code is wrong. The match is the plant ID
 * (`<site>/<lower-case Gen_Code>`). It does not change the source fuel code. Owner on #105:
 * Waipori at `WPG0331` is mostly Mahinerangi wind, labelled Hydro in Generation_MD.
 */
export const FUEL_PLANT_OVERRIDES: Record<string, FuelCategory> = {
  "WPG/waipori": "wind",
};

/**
 * Fleet unit IDs (`<POC>:<unit code>`) whose automatic plant link is wrong or empty.
 * The automatic link is unique (POC, fuel category) in Generation_MD (ADR-0008). This map
 * wins over that link. Use it when two plants share a POC and a fuel, or when Generation_MD
 * has no plant row. A unit that is still unmapped stays off the plant tables.
 */
export const UNIT_PLANT_OVERRIDES: Record<string, string> = {};
