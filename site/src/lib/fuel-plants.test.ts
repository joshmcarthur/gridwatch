import {
  assertSiteDay,
  type GenerationSection,
  type SiteDay,
} from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import fixtureJson from "../../fixtures/days/2026-09-27.json";
import { displayPlantName, fuelPlants } from "./fuel-plants.ts";

const fixtureUnknown: unknown = fixtureJson;
assertSiteDay(fixtureUnknown);
const fixture: SiteDay = fixtureUnknown;

function dayWith(generation: Partial<GenerationSection>): SiteDay {
  return { ...fixture, generation: { ...fixture.generation, ...generation } };
}

test("displayPlantName uses spaces instead of underscores, and falls back to the id", () => {
  expect(displayPlantName("ohau_a", "OHA/ohau_a")).toBe("ohau a");
  expect(displayPlantName("Tauhara", "TAB/tauhara")).toBe("Tauhara");
  expect(displayPlantName("", "ZZZ/mystery")).toBe("ZZZ/mystery");
});

test("missing generation, or no plants field, is one missing-data sentence", () => {
  expect(fuelPlants(dayWith({ state: "missing", plants: [] }))).toEqual({
    kind: "missing",
    message: "The plant list for this day is not ready yet.",
  });
  expect(fuelPlants(dayWith({ plants: undefined }))).toEqual({
    kind: "missing",
    message: "The plant list for this day is not ready yet.",
  });
});

test("one table per fuel in the mix, zeros omitted, largest plants stay in export order", () => {
  const view = fuelPlants(
    dayWith({
      daily: [
        {
          fuel: "hydro",
          island: "SI",
          megawatt_hours: 200,
          average_megawatts: 8,
        },
        {
          fuel: "hydro",
          island: "NI",
          megawatt_hours: 10,
          average_megawatts: 0.4,
        },
        {
          fuel: "gas",
          island: "NI",
          megawatt_hours: 5,
          average_megawatts: 0.2,
        },
        {
          fuel: "battery",
          island: "NI",
          megawatt_hours: 1,
          average_megawatts: 0.04,
        },
        {
          fuel: "wind",
          island: "NI",
          megawatt_hours: 0,
          average_megawatts: 0,
        },
      ],
      plants: [
        {
          plant_id: "MAN/manapouri",
          plant_name: "manapouri",
          fuel: "hydro",
          island: "SI",
          megawatt_hours: 17050.6,
          average_megawatts: 741.3,
        },
        {
          plant_id: "OHA/ohau_a",
          plant_name: "ohau_a",
          fuel: "hydro",
          island: "SI",
          megawatt_hours: 12.3,
          average_megawatts: 0.5,
        },
        {
          plant_id: "HLY/huntly_5",
          plant_name: "Huntly 5",
          fuel: "gas",
          island: "NI",
          megawatt_hours: 0,
          average_megawatts: 0,
        },
        {
          plant_id: "HLY/huntly_p40",
          plant_name: "Huntly P40",
          fuel: "gas",
          island: "NI",
          megawatt_hours: 5,
          average_megawatts: 0.2,
        },
        {
          plant_id: "ROT/roto",
          plant_name: "Rotohiko",
          fuel: "battery",
          island: "NI",
          megawatt_hours: 1,
          average_megawatts: 0.04,
        },
      ],
    }),
  );
  if (view.kind !== "ready") throw new Error("expected ready");
  expect(view.tables.map((table) => table.label)).toEqual([
    "Hydro",
    "Gas",
    "Battery",
  ]);
  expect(view.tables[0]?.plants).toEqual([
    {
      name: "manapouri",
      island: "South Island",
      megawatt_hours: "17,050.6",
    },
    { name: "ohau a", island: "South Island", megawatt_hours: "12.3" },
  ]);
  expect(view.tables[1]?.plants).toEqual([
    { name: "Huntly P40", island: "North Island", megawatt_hours: "5" },
  ]);
  expect(view.tables[2]?.plants).toEqual([
    { name: "Rotohiko", island: "North Island", megawatt_hours: "1" },
  ]);
});

test("a fuel in the mix with no plant rows still gets a table, empty", () => {
  const view = fuelPlants(
    dayWith({
      daily: [
        {
          fuel: "hydro",
          island: "NI",
          megawatt_hours: 10,
          average_megawatts: 0.4,
        },
      ],
      plants: [],
    }),
  );
  if (view.kind !== "ready") throw new Error("expected ready");
  expect(view.tables).toEqual([
    {
      fuel: "hydro",
      label: "Hydro",
      captionId: "fuel-plants-hydro",
      plants: [],
    },
  ]);
});
