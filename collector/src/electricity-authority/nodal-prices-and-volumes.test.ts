import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readManifest } from "../archive.ts";
import {
  collectNodalPricesAndVolumes,
  DATASET,
} from "./nodal-prices-and-volumes.ts";

const FOLDER = "Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes";
const name = (day: string) =>
  `${FOLDER}/2026/2026111${day}_DispatchNodalPricesAndVolumes.csv`;
// Day 18 is not listed. Day 20 is listed but the server refuses it.
const files: Record<string, string | null> = {
  [name("7")]: "day 17",
  [name("9")]: "day 19",
  [`${FOLDER}/2026/20261120_DispatchNodalPricesAndVolumes.csv`]: null,
};
// Azure markers hold characters that need URL encoding.
const MARKER = "2!92!a=b/c";

let server: Server;
let baseUrl: string;
let bronzeDir: string;

beforeEach(async () => {
  bronzeDir = await mkdtemp(join(tmpdir(), "gw-collect-"));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("comp") === "list") {
      const names = Object.keys(files);
      const marker = url.searchParams.get("marker");
      // The first page holds one name and a marker. The next page needs the exact marker.
      const page =
        marker === null
          ? names.slice(0, 1)
          : marker === MARKER
            ? names.slice(1)
            : [];
      const next = marker === null ? `<NextMarker>${MARKER}</NextMarker>` : "";
      res.end(
        `<?xml version="1.0"?><EnumerationResults><Blobs>${page
          .map((n) => `<Blob><Name>${n}</Name></Blob>`)
          .join("")}</Blobs>${next}</EnumerationResults>`,
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

test("archives listed days across listing pages, reports unlisted days, continues after a failed day", async () => {
  const result = await collectNodalPricesAndVolumes({
    bronzeDir,
    baseUrl,
    from: "2026-11-17",
    to: "2026-11-20",
  });
  expect(result.missing).toEqual(["2026-11-18"]);
  expect(result.records.map((r) => [r.status, r.trading_dates])).toEqual([
    ["new", ["2026-11-17"]],
    ["new", ["2026-11-19"]],
  ]);
  expect(result.failed).toEqual([{ date: "2026-11-20", error: "HTTP 403" }]);
  const manifest = await readManifest(bronzeDir);
  expect(manifest.map((r) => r.dataset)).toEqual([DATASET, DATASET]);
});
