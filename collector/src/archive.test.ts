import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { archiveFile, readManifest } from "./archive.ts";

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

test("uses If-Modified-Since when the server sends no ETag", async () => {
  const lastModified = "Thu, 19 Nov 2026 18:06:00 GMT";
  handler = (req, res) => {
    if (req.headers["if-modified-since"] === lastModified)
      return void res.writeHead(304).end();
    res.writeHead(200, { "Last-Modified": lastModified }).end("v1");
  };
  await run();
  const second = await run();
  expect(requests[1]?.["if-modified-since"]).toBe(lastModified);
  expect(requests[1]?.["if-none-match"]).toBeUndefined();
  expect(second.status).toBe("unchanged");
});

test("a 304 with no previous record fails", async () => {
  handler = (_req, res) => void res.writeHead(304).end();
  await expect(run()).rejects.toThrow("HTTP 304");
  expect(await readManifest(bronze)).toEqual([]);
});

test("rejects a file name or dataset that would leave bronze", async () => {
  const evil = new URL("/Prices/..%2F..%2Fevil.csv", base).href;
  await expect(run({ url: evil })).rejects.toThrow("Unsafe file name");
  for (const dataset of ["..", "a/b", "a\\b", "", "."]) {
    await expect(run({ dataset })).rejects.toThrow("Unsafe dataset");
  }
  expect(requests).toHaveLength(0);
});

test("a timeout is retried", async () => {
  handler = () => {}; // never answers
  await expect(run({ retries: 1, timeoutMs: 20 })).rejects.toThrow();
  expect(requests).toHaveLength(2);
});

test("a truncated download is retried", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.write("partial");
    setTimeout(() => res.destroy(), 5);
  };
  await expect(run({ retries: 1 })).rejects.toThrow();
  expect(requests).toHaveLength(2);
});

test("a corrupt manifest line fails with its line number", async () => {
  await run();
  await appendFile(join(bronze, "manifest.jsonl"), '{"dataset":"pri');
  await expect(readManifest(bronze)).rejects.toThrow("Corrupt manifest line 2");
});
