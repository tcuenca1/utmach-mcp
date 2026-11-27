import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionsDir } from "./paths.js";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface SiutmachSession {
  baseUrl: string;
  cookies: StoredCookie[];
  landingUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export function getSiutmachSessionPath(): string {
  return join(getSessionsDir(), "siutmach.json");
}

export function loadSiutmachSession(): SiutmachSession | null {
  const path = getSiutmachSessionPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SiutmachSession;
    if (!parsed.cookies || parsed.cookies.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSiutmachSession(session: SiutmachSession): void {
  writeFileSync(getSiutmachSessionPath(), JSON.stringify(session, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function deleteSiutmachSession(): boolean {
  const path = getSiutmachSessionPath();
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}

export function buildCookieHeader(session: SiutmachSession): string {
  return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
