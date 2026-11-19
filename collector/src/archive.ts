import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export type ArchiveStatus = "new" | "changed" | "unchanged";

/** One line of `bronze/manifest.jsonl`. See ADR-0004. */
export interface ManifestRecord {
  dataset: string;
  source_url: string;
  hub_url?: string;
  file_name: string;
  status: ArchiveStatus;
  checked_at: string;
  /** Set only when this check stored new bytes (status new or changed). */
  retrieved_at?: string;
  etag: string | null;
  last_modified: string | null;
  sha256: string;
  size: number;
  /** Path of the stored version, relative to the bronze directory. */
  path: string;
  /** Trading dates (YYYY-MM-DD) the file covers. The dataset module supplies them. */
  trading_dates: string[];
}

export interface ArchiveOptions {
  /** The bronze directory, for example `dataPaths().bronze`. */
  bronzeDir: string;
  dataset: string;
  url: string;
  hubUrl?: string;
  tradingDates: string[];
  fetch?: typeof fetch;
  now?: () => Date;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** First backoff delay in ms. It doubles on each retry. Default 500. */
  backoffMs?: number;
  /** Time limit for one attempt, request and body. Default 120000. */
  timeoutMs?: number;
}

const MANIFEST = "manifest.jsonl";

export async function readManifest(
  bronzeDir: string,
): Promise<ManifestRecord[]> {
  let text: string;
  try {
    text = await readFile(join(bronzeDir, MANIFEST), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: ManifestRecord[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as ManifestRecord);
    } catch {
      throw new Error(
        `Corrupt manifest line ${index + 1} in ${join(bronzeDir, MANIFEST)}. Fix or remove it.`,
      );
    }
  }
  return records;
}

/** A path segment from outside (dataset ID or decoded file name) must not leave its directory. */
function assertSafeSegment(name: string, value: string): void {
  if (
    value === "" ||
    value === "." ||
    value === ".." ||
    /[/\\\0]/.test(value) ||
    basename(value) !== value
  ) {
    throw new Error(`Unsafe ${name}: ${JSON.stringify(value)}`);
  }
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

class TruncatedError extends Error {}

function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof TruncatedError) return true;
  const e = error as NodeJS.ErrnoException;
  // Timeout, or a body cut off mid-stream.
  if (e.name === "TimeoutError" || e.code === "ERR_STREAM_PREMATURE_CLOSE")
    return true;
  // undici reports network failures as these TypeErrors. Other TypeErrors are bugs.
  return (
    error instanceof TypeError &&
    (error.message === "fetch failed" || error.message === "terminated")
  );
}

/** Stream a response body to `tempPath`. Return its SHA-256 and size. */
async function download(response: Response, tempPath: string) {
  if (!response.body) throw new HttpError(response.status);
  const hash = createHash("sha256");
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(
    // The cast bridges the DOM and node:stream/web ReadableStream types.
    Readable.fromWeb(response.body as unknown as WebReadableStream),
    counter,
    createWriteStream(tempPath),
  );
  const expected = response.headers.get("content-length");
  if (expected !== null && Number(expected) !== size) {
    throw new TruncatedError(`Expected ${expected} bytes, got ${size}`);
  }
  return { sha256: hash.digest("hex"), size };
}

/**
 * Archive one source file into bronze.
 *
 * Sends a conditional request using the latest manifest record. Every successful check appends a
 * manifest record. A version is never overwritten: each distinct content has its own directory.
 */
export async function archiveFile(
  options: ArchiveOptions,
): Promise<ManifestRecord> {
  const { bronzeDir, dataset, url, hubUrl, tradingDates } = options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? 3;
  const backoff = options.backoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const fileName = decodeURIComponent(basename(new URL(url).pathname));
  assertSafeSegment("dataset", dataset);
  assertSafeSegment("file name", fileName);
  const datasetDir = join(bronzeDir, dataset);
  await mkdir(datasetDir, { recursive: true });

  const previous = (await readManifest(bronzeDir)).findLast(
    (r) => r.dataset === dataset && r.source_url === url,
  );
  const headers: Record<string, string> = {};
  if (previous?.etag) headers["If-None-Match"] = previous.etag;
  else if (previous?.last_modified)
    headers["If-Modified-Since"] = previous.last_modified;

  const tempPath = join(datasetDir, `.tmp-${randomUUID()}`);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await doFetch(url, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const checkedAt = now().toISOString();
        const etag = response.headers.get("etag");
        const lastModified = response.headers.get("last-modified");
        const common = {
          dataset,
          source_url: url,
          ...(hubUrl ? { hub_url: hubUrl } : {}),
          file_name: fileName,
          checked_at: checkedAt,
          trading_dates: tradingDates,
        };

        let record: ManifestRecord;
        if (response.status === 304 && previous) {
          await response.body?.cancel();
          record = {
            ...common,
            status: "unchanged",
            etag: previous.etag,
            last_modified: previous.last_modified,
            sha256: previous.sha256,
            size: previous.size,
            path: previous.path,
          };
        } else if (response.status === 200) {
          const { sha256, size } = await download(response, tempPath);
          if (previous?.sha256 === sha256) {
            // Same bytes under new headers. Keep the stored version.
            record = {
              ...common,
              status: "unchanged",
              etag: etag ?? previous.etag,
              last_modified: lastModified ?? previous.last_modified,
              sha256,
              size,
              path: previous.path,
            };
          } else {
            const path = join(dataset, sha256, fileName);
            await mkdir(join(bronzeDir, dataset, sha256), { recursive: true });
            await rename(tempPath, join(bronzeDir, path));
            const retrievedAt = now().toISOString();
            record = {
              ...common,
              status: previous ? "changed" : "new",
              retrieved_at: retrievedAt,
              etag,
              last_modified: lastModified,
              sha256,
              size,
              path,
            };
          }
        } else {
          await response.body?.cancel();
          throw new HttpError(response.status);
        }
        await appendFile(
          join(bronzeDir, MANIFEST),
          `${JSON.stringify(record)}\n`,
        );
        return record;
      } catch (error) {
        await rm(tempPath, { force: true });
        if (attempt >= retries || !isTransient(error)) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, backoff * 2 ** attempt),
        );
      }
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** Trading dates covered by a file version stored after `since`, sorted. */
export async function tradingDatesChangedSince(
  bronzeDir: string,
  since: Date,
  dataset?: string,
): Promise<string[]> {
  const dates = new Set<string>();
  for (const record of await readManifest(bronzeDir)) {
    if (
      (dataset === undefined || record.dataset === dataset) &&
      record.retrieved_at &&
      new Date(record.retrieved_at) > since
    ) {
      for (const date of record.trading_dates) dates.add(date);
    }
  }
  return [...dates].sort();
}
