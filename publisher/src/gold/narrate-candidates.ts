import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit } from "../silver/common.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import { goldPartitionPath } from "./common.ts";
import { TABLES as RANKING_TABLES } from "./episode-ranking.ts";
import {
  type BuildEvidenceOptions,
  buildEvidencePackage,
  type EvidencePackage,
  serializeEvidencePackage,
} from "./evidence.ts";
import {
  type CompleteNarrative,
  checkNarrative,
  generateNarrative,
  type PromptPackage,
  promptPayload,
  serializeNarrative,
  warnNarrativeCheck,
} from "./narrative.ts";

export interface NarrateCandidatesOptions {
  goldDir: string;
  silverDir: string;
  completeness: CompletenessView;
  range?: { from: string; to: string };
  force: boolean;
  complete: CompleteNarrative;
  model: string;
  now?: Date;
  buildPackage?: (options: BuildEvidenceOptions) => Promise<EvidencePackage>;
}

export interface NarrateCandidatesResult {
  written: number;
  skipped: number;
  failed: string[];
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const evidenceFile = (goldDir: string, date: string, episodeId: string) =>
  join(goldDir, "evidence", date, `${episodeId}.json`);

const narrativeFile = (goldDir: string, date: string, episodeId: string) =>
  join(goldDir, "narratives", date, `${episodeId}.json`);

async function writeJsonAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(`${path}.tmp`, body);
    await rename(`${path}.tmp`, path);
  } finally {
    await rm(`${path}.tmp`, { force: true });
  }
}

function rankingDates(
  goldDir: string,
  range?: { from: string; to: string },
): string[] {
  const root = join(goldDir, RANKING_TABLES[1]);
  if (!existsSync(root)) return [];
  const prefix = "trading_date=";
  const dates = readdirSync(root)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  if (!range) return dates;
  return dates.filter((date) => date >= range.from && date <= range.to);
}

async function candidateIds(goldDir: string, date: string): Promise<string[]> {
  const scoresPath = goldPartitionPath(goldDir, RANKING_TABLES[1], date);
  if (!existsSync(scoresPath)) return [];
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const rows = (
      await connection.runAndReadAll(
        `SELECT episode_id FROM read_parquet(${lit(scoresPath)})
         WHERE is_candidate
         ORDER BY day_rank, episode_id`,
      )
    ).getRowObjectsJson() as Array<{ episode_id: unknown }>;
    return rows
      .map((row) => asString(row.episode_id))
      .filter((id): id is string => id !== null);
  } finally {
    connection.closeSync();
  }
}

/**
 * Write evidence and a narrative for each ranked candidate. Skip a file that already
 * exists unless `force` is set. One failed episode does not stop the others.
 */
export async function narrateCandidates(
  options: NarrateCandidatesOptions,
): Promise<NarrateCandidatesResult> {
  const buildPackage = options.buildPackage ?? buildEvidencePackage;
  const now = options.now ?? new Date();
  const result: NarrateCandidatesResult = {
    written: 0,
    skipped: 0,
    failed: [],
  };
  for (const date of rankingDates(options.goldDir, options.range)) {
    for (const episodeId of await candidateIds(options.goldDir, date)) {
      const path = narrativeFile(options.goldDir, date, episodeId);
      if (!options.force && existsSync(path)) {
        result.skipped += 1;
        continue;
      }
      try {
        const pkg = await buildPackage({
          goldDir: options.goldDir,
          silverDir: options.silverDir,
          completeness: options.completeness,
          episodeId,
          date,
        });
        const evidenceBytes = serializeEvidencePackage(pkg);
        await writeJsonAtomic(
          evidenceFile(options.goldDir, date, episodeId),
          evidenceBytes,
        );
        const record = await generateNarrative(pkg as PromptPackage, {
          complete: options.complete,
          model: options.model,
          now,
          packageId: createHash("sha256").update(evidenceBytes).digest("hex"),
        });
        warnNarrativeCheck(
          checkNarrative(record, promptPayload(pkg as PromptPackage)),
          `narrative check ${episodeId}`,
        );
        await writeJsonAtomic(path, serializeNarrative(record));
        result.written += 1;
      } catch (error) {
        result.failed.push(`${date} ${episodeId}: ${(error as Error).message}`);
      }
    }
  }
  return result;
}
