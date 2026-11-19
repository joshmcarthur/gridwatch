import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  archiveFile,
  readManifest,
  tradingDatesChangedSince,
} from "./archive.ts";

type Handler = Parameters<typeof createServer>[1];

let server: Server;
let base: string;
let bronze: string;
let body = "v1";
let etag = '"e1"';
let requests: Array<Record<string, string | string[] | undefined>> = [];
let handler: Handler | undefined;

beforeEach(async () => {
  body = "v1";
  etag = '"e1"';
  requests = [];
  handler = undefined;
  bronze = await mkdtemp(join(tmpdir(), "gw-bronze-"));
  server = createServer((req, res) => {
    requests.push(req.headers);
    if (handler) return handler(req, res);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      ETag: etag,
      "Last-Modified": "Thu, 19 Nov 2026 18:06:00 GMT",
    });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/Prices/20261119_Prices.csv`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(bronze, { recursive: true, force: true });
});

const run = (extra: Partial<Parameters<typeof archiveFile>[0]> = {}) =>
  archiveFile({
    bronzeDir: bronze,
    dataset: "prices",
    url: base,
    tradingDates: ["2026-11-19"],
    backoffMs: 1,
    ...extra,
  });

test("new file is stored unchanged and recorded", async () => {
  const record = await run();
  expect(record).toMatchObject({
    status: "new",
    etag: '"e1"',
    size: 2,
    file_name: "20261119_Prices.csv",
  });
  expect(record.sha256).toHaveLength(64);
  expect(await readFile(join(bronze, record.path), "utf8")).toBe("v1");
  expect(await readManifest(bronze)).toEqual([record]);
});

test("unchanged file sends a conditional request, skips the download and records the check", async () => {
  const first = await run();
  const second = await run();
  expect(requests[1]?.["if-none-match"]).toBe('"e1"');
  expect(second).toMatchObject({
    status: "unchanged",
    sha256: first.sha256,
    path: first.path,
  });
  expect(second.retrieved_at).toBeUndefined();
  expect(await readManifest(bronze)).toHaveLength(2);
});

test("changed file keeps the previous version", async () => {
  const first = await run();
  body = "version two";
  etag = '"e2"';
  const second = await run();
  expect(second.status).toBe("changed");
  expect(second.path).not.toBe(first.path);
  expect(await readFile(join(bronze, first.path), "utf8")).toBe("v1");
  expect(await readFile(join(bronze, second.path), "utf8")).toBe("version two");
});

test("same bytes under a new ETag are not stored twice", async () => {
  const first = await run();
  etag = '"e2"';
  const second = await run();
  expect(second).toMatchObject({
    status: "unchanged",
    etag: '"e2"',
    path: first.path,
  });
});

test("interrupted download leaves no file and no manifest record", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.write("partial");
    setTimeout(() => res.destroy(), 5);
  };
  await expect(run({ retries: 0 })).rejects.toThrow();
  expect(await readManifest(bronze)).toEqual([]);
  expect(await readdir(join(bronze, "prices"))).toEqual([]);
});

test("transient errors are retried", async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    if (calls < 3) return void res.writeHead(503).end();
    res.writeHead(200).end("ok");
  };
  expect((await run()).status).toBe("new");
  expect(calls).toBe(3);
});

test("other errors fail at once", async () => {
  handler = (_req, res) => void res.writeHead(404).end();
  await expect(run()).rejects.toThrow("HTTP 404");
  expect(requests).toHaveLength(1);
});

test("tradingDatesChangedSince lists dates of stored versions after T", async () => {
  const t0 = new Date("2026-11-19T00:00:00Z");
  const t1 = new Date("2026-11-20T00:00:00Z");
  const t2 = new Date("2026-11-21T00:00:00Z");
  await run({ now: () => t0, tradingDates: ["2026-11-18"] });
  body = "v2";
  etag = '"e2"';
  await run({ now: () => t2, tradingDates: ["2026-11-18"] });
  await run({ now: () => t2, tradingDates: ["2026-11-18"] }); // unchanged: not listed again
  expect(
    await tradingDatesChangedSince(bronze, new Date("2026-11-18T00:00:00Z")),
  ).toEqual(["2026-11-18"]);
  expect(await tradingDatesChangedSince(bronze, t1)).toEqual(["2026-11-18"]);
  expect(await tradingDatesChangedSince(bronze, t2)).toEqual([]);
});
