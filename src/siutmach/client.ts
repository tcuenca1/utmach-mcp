import {
  buildCookieHeader,
  loadSiutmachSession,
  type SiutmachSession,
} from "../storage/siutmach-session.js";

class SiutmachRateLimiter {
  private lastAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs = 300) {}

  async acquire(): Promise<void> {
    const task = this.queue.then(async () => {
      const elapsed = Date.now() - this.lastAt;
      if (elapsed < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
      }
      this.lastAt = Date.now();
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

const limiter = new SiutmachRateLimiter(300);

export class SiutmachSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiutmachSessionError";
  }
}

export class SiutmachClient {
  constructor(public readonly session: SiutmachSession) {}

  static fromSavedSession(): SiutmachClient {
    const session = loadSiutmachSession();
    if (!session) {
      throw new SiutmachSessionError(
        "No hay sesión guardada de SIUTMACH. Ejecuta en tu terminal: utmach siutmach login"
      );
    }
    return new SiutmachClient(session);
  }

  private headers(): Record<string, string> {
    return {
      Cookie: buildCookieHeader(this.session),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "utmach-mcp/0.1.0",
    };
  }

  async postJson<T>(relativePath: string, params?: Record<string, string | number>): Promise<T> {
    await limiter.acquire();
    const url = `${this.session.baseUrl}${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}`;
    const body = params
      ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
      : "";

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body,
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`SIUTMACH HTTP ${res.status} en ${relativePath}`);
    }

    const text = await res.text();
    if (text.includes('id="password"') && text.includes('name="password"')) {
      throw new SiutmachSessionError(
        "La sesión de SIUTMACH expiró. Ejecuta en tu terminal: utmach siutmach login"
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Respuesta no-JSON inesperada en SIUTMACH ${relativePath}`);
    }
  }

  async postHtml(relativePath: string, params?: Record<string, string | number>): Promise<string> {
    await limiter.acquire();
    const url = `${this.session.baseUrl}${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}`;
    const body = params
      ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
      : "";

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body,
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`SIUTMACH HTTP ${res.status} en ${relativePath}`);
    }

    const html = await res.text();
    if (html.includes('id="password"') && html.includes('name="password"')) {
      throw new SiutmachSessionError(
        "La sesión de SIUTMACH expiró. Ejecuta en tu terminal: utmach siutmach login"
      );
    }

    return html;
  }
}
