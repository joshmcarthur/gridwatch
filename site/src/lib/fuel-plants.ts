import type {
  FuelCategory,
  Island,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import { FUEL_LABELS, STACK_ORDER } from "./generation-mix.ts";

const energyFormat = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 1,
});

const FUEL_ORDER: readonly FuelCategory[] = [...STACK_ORDER, "battery"];

const BATTERY_LABEL = "Battery";

export type FuelPlantRow = {
  name: string;
  island: string;
  megawatt_hours: string;
};

export type FuelPlantTable = {
  fuel: FuelCategory;
  label: string;
  captionId: string;
  plants: FuelPlantRow[];
};

export type FuelPlantsView =
  | { kind: "missing"; message: string }
  | { kind: "ready"; tables: FuelPlantTable[] };

/** Groups gold plant-day rows into one table per fuel in the day's mix. */
export function fuelPlants(day: SiteDay): FuelPlantsView {
  if (
    day.generation.state === "missing" ||
    day.generation.plants === undefined
  ) {
    return {
      kind: "missing",
      message: "The plant list for this day is not ready yet.",
    };
  }

  const byFuel = new Map<FuelCategory, FuelPlantRow[]>();
  for (const plant of day.generation.plants) {
    if (plant.megawatt_hours <= 0) continue;
    const rows = byFuel.get(plant.fuel) ?? [];
    rows.push({
      name: displayPlantName(plant.plant_name, plant.plant_id),
      island: islandWords(plant.island),
      megawatt_hours: energyFormat.format(plant.megawatt_hours),
    });
    byFuel.set(plant.fuel, rows);
  }

  const tables: FuelPlantTable[] = fuelsInMix(day).map((fuel) => ({
    fuel,
    label: fuelLabel(fuel),
    captionId: `fuel-plants-${fuel}`,
    plants: byFuel.get(fuel) ?? [],
  }));

  return { kind: "ready", tables };
}

export function displayPlantName(plantName: string, plantId: string): string {
  const trimmed = plantName.trim();
  const raw = trimmed.length > 0 ? trimmed : plantId;
  return raw.replaceAll("_", " ");
}

function fuelsInMix(day: SiteDay): FuelCategory[] {
  const sums = new Map<FuelCategory, number>();
  for (const row of day.generation.daily) {
    sums.set(row.fuel, (sums.get(row.fuel) ?? 0) + row.megawatt_hours);
  }
  return FUEL_ORDER.filter((fuel) => (sums.get(fuel) ?? 0) > 0);
}

function fuelLabel(fuel: FuelCategory): string {
  if (fuel === "battery") return BATTERY_LABEL;
  return FUEL_LABELS[fuel];
}

function islandWords(island: Island | null): string {
  switch (island) {
    case "NI":
      return "North Island";
    case "SI":
      return "South Island";
    case null:
      return "Not mapped";
    default: {
      const _exhaustive: never = island;
      return _exhaustive;
    }
  }
}
