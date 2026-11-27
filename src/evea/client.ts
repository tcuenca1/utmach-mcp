import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EveaSession } from "../storage/session.js";

export interface MoodleSiteInfo {
  sitename: string;
  username: string;
  firstname: string;
  lastname: string;
  fullname: string;
  userid: number;
  siteurl: string;
  userpictureurl?: string;
  release?: string;
  version?: string;
}

export class MoodleApiError extends Error {
  constructor(
    message: string,
    public readonly errorcode?: string,
    public readonly exception?: string,
    public readonly siteAlias?: string
  ) {
    super(message);
    this.name = "MoodleApiError";
  }
}

function appendFormParam(form: URLSearchParams, prefix: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      appendFormParam(form, `${prefix}[${index}]`, item);
    });
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      appendFormParam(form, `${prefix}[${k}]`, v);
    }
  } else if (typeof value === "boolean") {
    form.append(prefix, value ? "1" : "0");
  } else {
    form.append(prefix, String(value));
  }
}

class SimpleRateLimiter {
  private lastRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs = 180) {}

  async acquire(): Promise<void> {
    const task = this.queue.then(async () => {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
      }
      this.lastRequestAt = Date.now();
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

const globalLimiter = new SimpleRateLimiter(180);

export class MoodleClient {
  constructor(public readonly session: EveaSession) {}

  async call<T>(wsfunction: string, params: Record<string, unknown> = {}): Promise<T> {
    await globalLimiter.acquire();

    const url = `${this.session.baseUrl}/webservice/rest/server.php`;
    const form = new URLSearchParams();
    form.append("wstoken", this.session.token);
    form.append("wsfunction", wsfunction);
    form.append("moodlewsrestformat", "json");

    for (const [key, value] of Object.entries(params)) {
      appendFormParam(form, key, value);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "utmach-mcp/0.1.0",
      },
      body: form.toString(),
    });

    if (!res.ok) {
      throw new MoodleApiError(
        `Error HTTP ${res.status} al llamar a ${wsfunction} en ${this.session.baseUrl}`,
        `http_${res.status}`,
        undefined,
        this.session.siteAlias
      );
    }

    const data = (await res.json()) as unknown;
    if (data && typeof data === "object" && "exception" in data && "errorcode" in data) {
      const errObj = data as { exception: string; errorcode: string; message?: string };
      const code = errObj.errorcode;
      if (code === "invalidtoken" || code === "expiredtoken" || code === "accessexception") {
        throw new MoodleApiError(
          `La sesión/token en "${this.session.siteAlias}" expiró o no tiene permiso (${code}: ${errObj.message ?? ""}). Ejecuta: utmach login --site ${this.session.siteAlias}`,
          code,
          errObj.exception,
          this.session.siteAlias
        );
      }
      throw new MoodleApiError(
        `Moodle API error en ${wsfunction} (${code}): ${errObj.message ?? errObj.exception}`,
        code,
        errObj.exception,
        this.session.siteAlias
      );
    }

    return data as T;
  }

  async getSiteInfo(): Promise<MoodleSiteInfo> {
    return this.call<MoodleSiteInfo>("core_webservice_get_site_info");
  }

  buildAuthenticatedFileUrl(rawUrl: string): string {
    let url = rawUrl;
    if (url.includes("/pluginfile.php/") && !url.includes("/webservice/pluginfile.php/")) {
      url = url.replace("/pluginfile.php/", "/webservice/pluginfile.php/");
    }
    const parsed = new URL(url);
    if (!parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", this.session.token);
    }
    return parsed.toString();
  }

  async downloadFile(rawUrl: string, destPath: string): Promise<{ path: string; sizeBytes: number; contentType: string }> {
    await globalLimiter.acquire();

    const authUrl = this.buildAuthenticatedFileUrl(rawUrl);
    const res = await fetch(authUrl, {
      headers: { "User-Agent": "utmach-mcp/0.1.0" },
    });

    if (!res.ok || !res.body) {
      throw new MoodleApiError(
        `No se pudo descargar el archivo (HTTP ${res.status}): ${rawUrl}`,
        `http_${res.status}`,
        undefined,
        this.session.siteAlias
      );
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const dir = dirname(destPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const nodeStream = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
    await pipeline(nodeStream, createWriteStream(destPath));

    const { statSync } = await import("node:fs");
    const sizeBytes = statSync(destPath).size;
    return { path: destPath, sizeBytes, contentType };
  }
}
