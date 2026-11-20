import { priceAnomaly } from "./analysis/price-anomaly.ts";
import { energyBalance } from "./gold/energy-balance.ts";
import { generation } from "./gold/generation.ts";
import { gridLoad } from "./gold/grid-load.ts";
import { hvdc } from "./gold/hvdc.ts";
import { prices } from "./gold/prices.ts";
import { reserves } from "./gold/reserves.ts";
import { publishClearedOffers } from "./silver/cleared-offers.ts";
import type {
  PartitionKey,
  PublishResult,
  VersionColumn,
} from "./silver/common.ts";
import type { CompletenessView } from "./silver/completeness.ts";
import { publishDispatchEnergyPrices } from "./silver/dispatch-energy-prices.ts";
import { publishDispatchReservePrices } from "./silver/dispatch-reserve-prices.ts";
import {
  entityWantedVersions,
  publishEntityMappings,
} from "./silver/entity-mappings.ts";
import { publishGenerationFleet } from "./silver/generation-fleet.ts";
import { publishGenerationMd } from "./silver/generation-md.ts";
import { publishHvdcFlows } from "./silver/hvdc-flows.ts";
import { publishNetworkSupplyPoints } from "./silver/network-supply-points.ts";
import { publishNodalPricesAndVolumes } from "./silver/nodal-prices-and-volumes.ts";

export interface PublisherDataset {
  /** The dataset ID. It is the same in the manifest, the bronze folder and the silver folder. */
  id: string;
  /** The partition folder is `<partitionKey>=YYYY-MM-DD`. */
  partitionKey: PartitionKey;
  /** The directory that holds this dataset's partitions. Default: the silver directory. A gold table holds them in gold (ADR-0011). */
  partitionRoot?(dirs: { silverDir: string; goldDir: string }): string;
  /**
   * The silver folder that holds the partitions, when it differs from `id`. The entity mappings
   * write several tables, and the runner reads the first.
   */
  table?: string;
  /**
   * The column that holds the input version of a silver row. Default `bronze_sha256`. A dataset
   * with no bronze file of its own uses a fingerprint of its silver inputs.
   */
  versionColumn?: VersionColumn;
  /**
   * True when the date is complete only if every trading period is present.
   * The count is 46, 48 or 50, from `periodsInTradingDate` (ADR-0010).
   * Snapshots and entity mappings leave this unset.
   */
  countsTradingPeriods?: boolean;
  /**
   * The version each date should hold, from silver and, for a gold table that reads gold, from
   * `goldDir`. Default: the manifest (bronze).
   */
  wantedVersions?(
    silverDir: string,
    completeness: CompletenessView,
    goldDir: string,
  ): Promise<Map<string, string>>;
  /** Publish the partition of one date. */
  publish(options: {
    bronzeDir: string;
    silverDir: string;
    goldDir: string;
    /** This run's completeness rows. Gold reads them (ADR-0010). Silver ignores them. */
    completeness: CompletenessView;
    date: string;
  }): Promise<PublishResult>;
}

/**
 * The datasets the runner publishes. A new silver dataset adds one entry here and one in
 * `collector/src/datasets.ts`. A gold table adds one entry after silver, and after any gold
 * table it reads (ADR-0011).
 */
export const datasets: PublisherDataset[] = [
  {
    id: "dispatch_energy_prices",
    partitionKey: "trading_date",
    countsTradingPeriods: true,
    publish: publishDispatchEnergyPrices,
  },
  {
    id: "dispatch_reserve_prices",
    partitionKey: "trading_date",
    countsTradingPeriods: true,
    publish: publishDispatchReservePrices,
  },
  {
    id: "nodal_prices_and_volumes",
    partitionKey: "trading_date",
    countsTradingPeriods: true,
    publish: publishNodalPricesAndVolumes,
  },
  {
    id: "cleared_offers",
    partitionKey: "trading_date",
    countsTradingPeriods: true,
    publish: publishClearedOffers,
  },
  {
    id: "generation_md",
    partitionKey: "trading_date",
    countsTradingPeriods: true,
    publish: publishGenerationMd,
  },
  {
    id: "hvdc_flows",
    partitionKey: "trading_date",
    countsTradingPeriods: true,
    publish: publishHvdcFlows,
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
  // Gold runs after silver in the same run (ADR-0011). Registry order is the DAG.
  generation,
  prices,
  reserves,
  hvdc,
  gridLoad,
  // After the gold tables it reads: generation, HVDC and grid load (ADR-0011, ADR-0018).
  energyBalance,
  // Detectors read gold prices, so they come after it (ADR-0015).
  priceAnomaly,
];
