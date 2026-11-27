import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCacheDir } from "./paths.js";

export const CACHE_TTL_MS = {
  courses: 24 * 60 * 60 * 1000,               // 24h
  materials: 6 * 60 * 60 * 1000,              // 6h
  grades: 60 * 60 * 1000,                     // 1h
  announcements: 60 * 60 * 1000,              // 1h
  tasks: 15 * 60 * 1000,                      // 15m
  taskDetail: 15 * 60 * 1000,                 // 15m
  siteInfo: 60 * 60 * 1000,                   // 1h
  siutmachSchedule: 7 * 24 * 60 * 60 * 1000,  // 7 días
  siutmachHistory: 24 * 60 * 60 * 1000,       // 24h
  siutmachAttendance: 3 * 60 * 60 * 1000,     // 3h
  siutmachCurrentGrades: 3 * 60 * 60 * 1000,  // 3h
} as const;

interface CacheEnvelope<T> {
  key: string;
  cachedAt: number;
  expiresAt: number;
  data: T;
}

function keyToPath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const safePrefix = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  return join(getCacheDir(), `${safePrefix}_${hash}.json`);
}

export function getCached<T>(key: string): { data: T; cachedAt: number } | null {
  const path = keyToPath(key);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const envelope = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope<T>;
    if (Date.now() > envelope.expiresAt) {
      return null;
    }
    return { data: envelope.data, cachedAt: envelope.cachedAt };
  } catch {
    return null;
  }
}

export function setCached<T>(key: string, data: T, ttlMs: number): void {
  const now = Date.now();
  const envelope: CacheEnvelope<T> = {
    key,
    cachedAt: now,
    expiresAt: now + ttlMs,
    data,
  };
  writeFileSync(keyToPath(key), JSON.stringify(envelope), "utf8");
}

export async function withCache<T>(
  key: string,
  ttlMs: number,
  refresh: boolean,
  fetcher: () => Promise<T>
): Promise<{ data: T; fromCache: boolean; cachedAt: string }> {
  if (!refresh) {
    const hit = getCached<T>(key);
    if (hit) {
      return {
        data: hit.data,
        fromCache: true,
        cachedAt: new Date(hit.cachedAt).toISOString(),
      };
    }
  }
  const data = await fetcher();
  setCached(key, data, ttlMs);
  return {
    data,
    fromCache: false,
    cachedAt: new Date().toISOString(),
  };
}

export function clearCache(): { deletedFiles: number; freedBytes: number } {
  const dir = getCacheDir();
  let deletedFiles = 0;
  let freedBytes = 0;

  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile()) {
        freedBytes += st.size;
        unlinkSync(full);
        deletedFiles++;
      }
    } catch {
      // ignore locked files
    }
  }

  return { deletedFiles, freedBytes };
}

export function getCacheStats(): { files: number; totalBytes: number } {
  const dir = getCacheDir();
  let files = 0;
  let totalBytes = 0;

  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile()) {
        files++;
        totalBytes += st.size;
      }
    } catch {
      // ignore
    }
  }

  return { files, totalBytes };
}
