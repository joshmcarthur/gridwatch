import { publishClearedOffers } from "./silver/cleared-offers.ts";
import type { PublishResult } from "./silver/common.ts";
import { publishDispatchEnergyPrices } from "./silver/dispatch-energy-prices.ts";
import { publishDispatchReservePrices } from "./silver/dispatch-reserve-prices.ts";
import {
  entityWantedVersions,
  publishEntityMappings,
} from "./silver/entity-mappings.ts";
import { publishGenerationFleet } from "./silver/generation-fleet.ts";
import { publishGenerationMd } from "./silver/generation-md.ts";
import { publishNetworkSupplyPoints } from "./silver/network-supply-points.ts";
import { publishNodalPricesAndVolumes } from "./silver/nodal-prices-and-volumes.ts";

export interface PublisherDataset {
  /** The dataset ID. It is the same in the manifest, the bronze folder and the silver folder. */
  id: string;
  /** The partition folder is `<partitionKey>=YYYY-MM-DD`. */
  partitionKey: "trading_date" | "snapshot_date";
  /**
   * The silver folder that holds the partitions, when it differs from `id`. The entity mappings
   * write several tables, and the runner reads the first.
   */
  table?: string;
  /**
   * The column that holds the input version of a silver row. Default `bronze_sha256`. A dataset
   * with no bronze file of its own uses a fingerprint of its silver inputs.
   */
  versionColumn?: string;
  /** The version each date should hold, from silver. Default: the manifest (bronze). */
  wantedVersions?(silverDir: string): Promise<Map<string, string>>;
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
    id: "cleared_offers",
    partitionKey: "trading_date",
    publish: publishClearedOffers,
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
  // Last: it reads the silver of the datasets above (ADR-0008).
  {
    id: "entity_mappings",
    table: "entity_points_of_connection",
    versionColumn: "inputs_sha256",
    partitionKey: "trading_date",
    wantedVersions: entityWantedVersions,
    publish: ({ silverDir, date }) =>
      publishEntityMappings({ silverDir, date }),
  },
];
