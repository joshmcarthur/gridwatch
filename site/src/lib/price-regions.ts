/** Plain-language labels for the three reference-node price regions. */
export const PRICE_REGIONS: Record<string, string> = {
  upper_north_island: "the Upper North Island (Ōtāhuhu, Auckland)",
  lower_north_island: "the Lower North Island (Haywards, near Wellington)",
  south_island: "the South Island (Benmore, in the Waitaki)",
};

/** Short region names for daily stats and legends. */
export const PRICE_REGION_SHORT: Record<string, string> = {
  upper_north_island: "Upper North Island",
  lower_north_island: "Lower North Island",
  south_island: "South Island",
};

/** Place names for the three sample points. Body copy uses these, not POC codes. */
export const PRICE_PLACE: Record<string, string> = {
  OTA2201: "Ōtāhuhu",
  HAY2201: "Haywards",
  BEN2201: "Benmore",
  upper_north_island: "Ōtāhuhu",
  lower_north_island: "Haywards",
  south_island: "Benmore",
};

export function placeName(pocOrRegion: string): string {
  return PRICE_PLACE[pocOrRegion] ?? pocOrRegion;
}

export function regionShort(regionId: string): string {
  return PRICE_REGION_SHORT[regionId] ?? regionId.replaceAll("_", " ");
}

/** Legend and caption label: "Ōtāhuhu (Upper North Island)". */
export function placeLegend(poc: string, regionId: string): string {
  return `${placeName(poc)} (${regionShort(regionId)})`;
}

const centsOne = new Intl.NumberFormat("en-NZ", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const centsWhole = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 0,
});

/** A $/MWh price as cents per kWh: `6.9c` under 10c, `17c` from 10c (ADR-0029). */
export function centsPerKwh(dollarsPerMwh: number): string {
  const cents = dollarsPerMwh / 10;
  if (Math.abs(cents) < 10) return `${centsOne.format(cents)}c`;
  return `${centsWhole.format(Math.round(cents))}c`;
}
