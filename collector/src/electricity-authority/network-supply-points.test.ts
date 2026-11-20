import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readManifest } from "../archive.ts";
import {
  collectNetworkSupplyPoints,
  DATASET,
} from "./network-supply-points.ts";

const FOLDER =
  "Datasets/Wholesale/MappingsAndGeospatial/NetworkSupplyPointsTable";
const name = (date: string) => `${FOLDER}/${date}_NetworkSupplyPointsTable.csv`;
// The listing holds a folder blob, a file with another name, and snapshots on some days only.
// Snapshot 20261112 is listed but the server refuses it.
const files: Record<string, string | null> = {
  [FOLDER]: "",
  [`${FOLDER}/readme.txt`]: "not a snapshot",
  [name("20261108")]: "snapshot 8",
  [name("20261110")]: "snapshot 10",
  [name("20261112")]: null,
  [name("20261119")]: "snapshot 19",
};

let server: Server;
let baseUrl: string;
let bronzeDir: string;

beforeEach(async () => {
  bronzeDir = await mkdtemp(join(tmpdir(), "gw-collect-"));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("comp") === "list") {
      res.end(
        `<?xml version="1.0"?><EnumerationResults><Blobs>${Object.keys(files)
          .map((n) => `<Blob><Name>${n}</Name></Blob>`)
          .join("")}</Blobs></EnumerationResults>`,
      );
      return;
    }
    const body = files[url.pathname.slice(1)];
    if (body == null) res.writeHead(403).end();
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

test("archives the snapshots in the range, ignores other names, continues after a failed snapshot", async () => {
  const result = await collectNetworkSupplyPoints({
    bronzeDir,
    baseUrl,
    from: "2026-11-09",
    to: "2026-11-19",
  });
  expect(result.records.map((r) => [r.status, r.trading_dates])).toEqual([
    ["new", ["2026-11-10"]],
    ["new", ["2026-11-19"]],
  ]);
  expect(result.failed).toEqual([{ date: "2026-11-12", error: "HTTP 403" }]);
  const manifest = await readManifest(bronzeDir);
  expect(manifest.map((r) => r.dataset)).toEqual([DATASET, DATASET]);
});

test("a second run finds the snapshots unchanged", async () => {
  const options = { bronzeDir, baseUrl, from: "2026-11-08", to: "2026-11-10" };
  await collectNetworkSupplyPoints(options);
  const again = await collectNetworkSupplyPoints(options);
  expect(again.records.map((r) => r.status)).toEqual([
    "unchanged",
    "unchanged",
  ]);
});
