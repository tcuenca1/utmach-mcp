import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getSessionPath } from "./paths.js";

export interface EveaSession {
  siteAlias: string;
  baseUrl: string;
  token: string;
  privateToken?: string;
  moodleSessionCookie?: string;
  sesskey?: string;
  userId?: number;
  username?: string;
  fullName?: string;
  siteName?: string;
  createdAt: string;
  updatedAt: string;
}

export function loadSession(siteAlias: string): EveaSession | null {
  const path = getSessionPath(siteAlias);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as EveaSession;
    if (!parsed.token || !parsed.baseUrl) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: EveaSession): void {
  const path = getSessionPath(session.siteAlias);
  writeFileSync(path, JSON.stringify(session, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function deleteSession(siteAlias: string): boolean {
  const path = getSessionPath(siteAlias);
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}
