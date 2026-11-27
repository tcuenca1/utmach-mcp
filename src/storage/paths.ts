import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getDataDir(): string {
  const custom = process.env.UTMACH_DATA_DIR?.trim();
  const base = custom && custom.length > 0 ? custom : join(homedir(), ".utmach");
  mkdirSync(base, { recursive: true });
  return base;
}

export function getConfigPath(): string {
  return join(getDataDir(), "config.json");
}

export function getSessionsDir(): string {
  const dir = join(getDataDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSessionPath(siteAlias: string): string {
  const safe = siteAlias.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(getSessionsDir(), `${safe}.json`);
}

export function getBrowserProfileDir(siteAlias: string): string {
  const safe = siteAlias.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = join(getDataDir(), "browser-profiles", safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getCacheDir(): string {
  const dir = join(getDataDir(), "cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getFilesDir(): string {
  const dir = join(getDataDir(), "files");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSnapshotsDir(): string {
  const dir = join(getDataDir(), "snapshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}
