import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readManifest } from "../archive.ts";
import { collectHvdcFlows, DATASET } from "./hvdc-flows.ts";

const FOLDER = "Datasets/Wholesale/Metered_data/HVDC_Flows";
const name = (month: string) => `${FOLDER}/${month}_HVDC_flows.csv`;
// 202608 is outside the range. 202610 is listed but the server refuses it. 202611 is not listed.
const files: Record<string, string | null> = {
  [name("202608")]: "august",
  [name("202609")]: "september",
  [name("202610")]: null,
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

test("lists the folder, archives the months that overlap the range with every date of the month, reports unlisted months and continues after a failed month", async () => {
  const result = await collectHvdcFlows({
    bronzeDir,
    baseUrl,
    from: "2026-09-15",
    to: "2026-11-19",
  });
  expect(result.missing).toEqual(["2026-11"]);
  expect(result.failed).toEqual([{ month: "2026-10", error: "HTTP 403" }]);
  expect(result.records).toHaveLength(1);
  const [record] = result.records;
  expect(record?.status).toBe("new");
  expect(record?.file_name).toBe("202609_HVDC_flows.csv");
  expect(record?.trading_dates).toHaveLength(30);
  expect(record?.trading_dates[0]).toBe("2026-09-01");
  expect(record?.trading_dates[29]).toBe("2026-09-30");
  const manifest = await readManifest(bronzeDir);
  expect(manifest.map((r) => r.dataset)).toEqual([DATASET]);
});

test("a second run reports the month as unchanged", async () => {
  const options = {
    bronzeDir,
    baseUrl,
    from: "2026-09-01",
    to: "2026-09-30",
  };
  await collectHvdcFlows(options);
  const again = await collectHvdcFlows(options);
  expect(again.records.map((r) => r.status)).toEqual(["unchanged"]);
});
