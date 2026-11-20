import type { PublishResult } from "./silver/common.ts";
import { publishDispatchEnergyPrices } from "./silver/dispatch-energy-prices.ts";
import { publishDispatchReservePrices } from "./silver/dispatch-reserve-prices.ts";
import { publishGenerationFleet } from "./silver/generation-fleet.ts";
import { publishGenerationMd } from "./silver/generation-md.ts";
import { publishNetworkSupplyPoints } from "./silver/network-supply-points.ts";
import { publishNodalPricesAndVolumes } from "./silver/nodal-prices-and-volumes.ts";

export interface PublisherDataset {
  /** The dataset ID. It is the same in the manifest, the bronze folder and the silver folder. */
  id: string;
  /** The partition folder is `<partitionKey>=YYYY-MM-DD`. */
  partitionKey: "trading_date" | "snapshot_date";
  /** Publish the silver partition of one date. */
  publish(options: {
    bronzeDir: string;
    silverDir: string;
    date: string;
  }): Promise<PublishResult>;
}

/**
 * The datasets the runner publishes. A new dataset adds one entry here and one in
 * `collector/src/datasets.ts`.
 */
export const datasets: PublisherDataset[] = [
  {
    id: "dispatch_energy_prices",
    partitionKey: "trading_date",
    publish: publishDispatchEnergyPrices,
  },
  {
    id: "dispatch_reserve_prices",
    partitionKey: "trading_date",
    publish: publishDispatchReservePrices,
  },
  {
    id: "nodal_prices_and_volumes",
    partitionKey: "trading_date",
    publish: publishNodalPricesAndVolumes,
  },
  {
    id: "generation_md",
    partitionKey: "trading_date",
    publish: publishGenerationMd,
  },
  {
    id: "network_supply_points",
    partitionKey: "snapshot_date",
    publish: publishNetworkSupplyPoints,
  },
  {
    id: "generation_fleet",
    partitionKey: "snapshot_date",
    publish: publishGenerationFleet,
  },
];
