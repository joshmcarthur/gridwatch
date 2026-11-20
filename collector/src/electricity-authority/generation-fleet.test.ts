import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { collectGenerationFleet } from "./generation-fleet.ts";

let body = "version 1";
let server: Server;
let baseUrl: string;
let bronzeDir: string;

beforeEach(async () => {
  bronzeDir = await mkdtemp(join(tmpdir(), "gw-collect-"));
  body = "version 1";
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.endsWith("/DispatchedGenerationPlant.csv"))
      res.writeHead(200).end(body);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(bronzeDir, { recursive: true, force: true });
});

test("labels each check with the snapshot date and stores a changed file as a new version", async () => {
  const first = await collectGenerationFleet({
    bronzeDir,
    baseUrl,
    date: "2026-11-19",
  });
  expect([first.status, first.trading_dates]).toEqual(["new", ["2026-11-19"]]);
  const same = await collectGenerationFleet({
    bronzeDir,
    baseUrl,
    date: "2026-11-20",
  });
  expect([same.status, same.trading_dates, same.path]).toEqual([
    "unchanged",
    ["2026-11-20"],
    first.path,
  ]);
  body = "version 2";
  const changed = await collectGenerationFleet({
    bronzeDir,
    baseUrl,
    date: "2026-11-21",
  });
  expect(changed.status).toBe("changed");
  expect(changed.path).not.toBe(first.path);
});
