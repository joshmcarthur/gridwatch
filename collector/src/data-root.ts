import { join, resolve } from "node:path";

/** Resolve the bronze, silver and gold directories from DATA_ROOT (default ./data). */
export function dataPaths(env: NodeJS.ProcessEnv = process.env) {
  const root = resolve(env.DATA_ROOT ?? "./data");
  return {
    root,
    bronze: join(root, "bronze"),
    silver: join(root, "silver"),
    gold: join(root, "gold"),
  };
}
