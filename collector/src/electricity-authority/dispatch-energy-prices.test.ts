import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readManifest } from "../archive.ts";
import {
  collectDispatchEnergyPrices,
  DATASET,
} from "./dispatch-energy-prices.ts";

const FOLDER = "Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices";
// The source lists two pages. The second day is not listed at all.
const files: Record<string, string> = {
  [`${FOLDER}/2026/20261117_DispatchEnergyPrices.csv`]: "day 17",
  [`${FOLDER}/2026/20261119_DispatchEnergyPrices.csv`]: "day 19",
};

let server: Server;
let baseUrl: string;
let bronzeDir: string;

beforeEach(async () => {
  bronzeDir = await mkdtemp(join(tmpdir(), "gw-collect-"));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("comp") === "list") {
      const names = Object.keys(files);
      const page = url.searchParams.get("marker")
        ? names.slice(1)
        : names.slice(0, 1);
      const next = url.searchParams.get("marker")
        ? ""
        : `<NextMarker>m1</NextMarker>`;
      res.end(
        `<?xml version="1.0"?><EnumerationResults><Blobs>${page
          .map((n) => `<Blob><Name>${n}</Name></Blob>`)
          .join("")}</Blobs>${next}</EnumerationResults>`,
      );
      return;
    }
    const body = files[url.pathname.slice(1)];
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { ETag: '"e"' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(bronzeDir, { recursive: true, force: true });
});

test("archives each listed day in the range and reports unlisted days", async () => {
  const result = await collectDispatchEnergyPrices({
    bronzeDir,
    baseUrl,
    from: "2026-11-17",
    to: "2026-11-19",
  });
  expect(result.missing).toEqual(["2026-11-18"]);
  expect(result.records.map((r) => [r.status, r.trading_dates])).toEqual([
    ["new", ["2026-11-17"]],
    ["new", ["2026-11-19"]],
  ]);
  const manifest = await readManifest(bronzeDir);
  expect(manifest.map((r) => r.dataset)).toEqual([DATASET, DATASET]);
});

test("a second run records unchanged", async () => {
  const range = { bronzeDir, baseUrl, from: "2026-11-17", to: "2026-11-17" };
  await collectDispatchEnergyPrices(range);
  const again = await collectDispatchEnergyPrices(range);
  expect(again.records[0]?.status).toBe("unchanged");
});
