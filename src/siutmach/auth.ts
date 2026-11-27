import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { loadConfig } from "../config/sites.js";
import { getBrowserProfileDir, getDataDir } from "../storage/paths.js";
import {
  buildCookieHeader,
  loadSiutmachSession,
  saveSiutmachSession,
  type SiutmachSession,
  type StoredCookie,
} from "../storage/siutmach-session.js";

export const SIUTMACH_BASE_URL = "https://app.utmachala.edu.ec/siutmach/public";

function detectBrowserChannel(): "chrome" | "msedge" | undefined {
  const cfg = loadConfig();
  const preferred = process.env.UTMACH_BROWSER_CHANNEL?.trim() || cfg.browserChannel;
  if (preferred === "chrome" || preferred === "msedge") return preferred;

  if (process.platform === "win32") {
    if (
      existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") ||
      existsSync("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe")
    ) {
      return "chrome";
    }
    if (existsSync("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")) {
      return "msedge";
    }
  }
  return "chrome";
}

async function isLoggedInPage(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (!url.startsWith("https://app.utmachala.edu.ec/siutmach")) return false;
    // Si ya no existe el input #password del formulario de login, el usuario entró al portal
    const hasLoginInput = await page.locator("input#password[name='password']").count();
    return hasLoginInput === 0;
  } catch {
    return false;
  }
}

async function extractSessionCookies(context: BrowserContext): Promise<StoredCookie[]> {
  const raw = await context.cookies("https://app.utmachala.edu.ec");
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
  }));
}

export async function loginSiutmach(timeoutMs = 5 * 60 * 1000): Promise<SiutmachSession> {
  const channel = detectBrowserChannel();
  const profileDir = getBrowserProfileDir("siutmach");

  console.error(`Abriendo ${channel ?? "navegador"} para iniciar sesión en SIUTMACH...`);
  console.error(`URL: ${SIUTMACH_BASE_URL}/`);
  console.error("Inicia sesión manualmente con tu usuario y contraseña. Nunca guardamos tu contraseña, solo la sesión temporal.");

  const context = await chromium.launchPersistentContext(profileDir, {
    channel,
    headless: false,
    viewport: { width: 1200, height: 800 },
  });

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(`${SIUTMACH_BASE_URL}/`, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error("El navegador se cerró antes de completar el inicio de sesión.");
      }
      if (await isLoggedInPage(page)) {
        // Pequeña espera para que terminen de setearse las cookies de sesión
        await page.waitForTimeout(1200);
        const cookies = await extractSessionCookies(context);
        if (cookies.length === 0) {
          throw new Error("No se encontraron cookies de sesión de SIUTMACH.");
        }
        const now = new Date().toISOString();
        const session: SiutmachSession = {
          baseUrl: SIUTMACH_BASE_URL,
          cookies,
          landingUrl: page.url(),
          createdAt: now,
          updatedAt: now,
        };
        saveSiutmachSession(session);
        console.error(`Sesión de SIUTMACH guardada correctamente (landing: ${session.landingUrl}).`);
        return session;
      }
      await page.waitForTimeout(800);
    }

    throw new Error("Tiempo agotado esperando el inicio de sesión en SIUTMACH.");
  } finally {
    await context.close().catch(() => {});
  }
}

export async function checkSiutmachStatus(): Promise<{
  authenticated: boolean;
  landingUrl?: string;
  updatedAt?: string;
  message?: string;
}> {
  const session = loadSiutmachSession();
  if (!session) {
    return {
      authenticated: false,
      message: "No hay sesión guardada de SIUTMACH. Ejecuta: utmach siutmach login",
    };
  }

  try {
    const checkUrl = session.landingUrl || `${SIUTMACH_BASE_URL}/`;
    const res = await fetch(checkUrl, {
      headers: {
        Cookie: buildCookieHeader(session),
        "User-Agent": "utmach-mcp/0.1.0",
      },
      redirect: "follow",
    });
    const html = await res.text();
    const looksLikeLogin = html.includes('id="password"') && html.includes('name="password"');
    if (!res.ok || looksLikeLogin) {
      return {
        authenticated: false,
        message: "La sesión de SIUTMACH expiró. Ejecuta: utmach siutmach login",
      };
    }
    return {
      authenticated: true,
      landingUrl: res.url,
      updatedAt: session.updatedAt,
    };
  } catch (err) {
    return {
      authenticated: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CapturedEndpoint {
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status: number;
  contentType: string;
  postDataPreview?: string;
  responsePreview: string;
}

/**
 * Abre SIUTMACH en Chrome y registra los endpoints internos (XHR/Fetch/HTML)
 * que visita el usuario al abrir Horario, Asistencias y Calificaciones.
 * Guarda el resultado en ~/.utmach/debug/siutmach-endpoints.json (nunca en el repo).
 */
export async function inspectSiutmach(): Promise<{ outputPath: string; count: number }> {
  const channel = detectBrowserChannel();
  const profileDir = getBrowserProfileDir("siutmach");
  const debugDir = join(getDataDir(), "debug");
  mkdirSync(debugDir, { recursive: true });
  const outputPath = join(debugDir, "siutmach-endpoints.json");

  console.error("Abriendo Chrome en modo inspección de SIUTMACH...");
  console.error("1. Inicia sesión si te lo pide.");
  console.error("2. Haz clic en: HORARIO, ASISTENCIAS y CALIFICACIONES (espera a que cargue cada vista).");
  console.error("3. Cuando termines de abrir esas vistas, CIERRA la ventana de Chrome.");

  const context = await chromium.launchPersistentContext(profileDir, {
    channel,
    headless: false,
    viewport: { width: 1280, height: 820 },
  });

  const captured: CapturedEndpoint[] = [];
  const seen = new Set<string>();

  const attach = (page: Page) => {
    page.on("response", async (res) => {
      try {
        const req = res.request();
        const url = res.url();
        if (!url.includes("utmachala.edu.ec")) return;

        const rType = req.resourceType();
        if (!["xhr", "fetch", "document"].includes(rType)) return;

        // Ignorar assets estáticos
        if (/\.(css|js|png|jpg|jpeg|svg|woff2?|ico)(\?|$)/i.test(url)) return;

        const contentType = res.headers()["content-type"] ?? "";
        const method = req.method();
        const key = `${method} ${url}`;

        let bodyText = "";
        try {
          bodyText = await res.text();
        } catch {
          bodyText = "";
        }

        // Redactar contraseñas si el usuario pasó por login
        let postData = req.postData() ?? undefined;
        if (postData && /password|clave|pass/i.test(postData)) {
          postData = "<redacted-credentials>";
        }

        const entry: CapturedEndpoint = {
          timestamp: new Date().toISOString(),
          method,
          url,
          resourceType: rType,
          status: res.status(),
          contentType,
          postDataPreview: postData ? postData.slice(0, 300) : undefined,
          responsePreview: bodyText.slice(0, 4000),
        };

        if (!seen.has(key) || rType === "xhr" || rType === "fetch") {
          seen.add(key);
          captured.push(entry);
          console.error(`  [cap] ${method} (${rType}, ${res.status()}) ${url}`);
        }

        // Persistir cookies actualizadas mientras la ventana sigue abierta
        if (await isLoggedInPage(page)) {
          const cookies = await extractSessionCookies(context);
          if (cookies.length > 0) {
            const now = new Date().toISOString();
            saveSiutmachSession({
              baseUrl: SIUTMACH_BASE_URL,
              cookies,
              landingUrl: page.url(),
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      } catch {
        // ignore
      }
    });
  };

  const page = context.pages()[0] ?? (await context.newPage());
  attach(page);
  context.on("page", (p) => attach(p));

  await page.goto(`${SIUTMACH_BASE_URL}/`, { waitUntil: "domcontentloaded" });

  // Esperar hasta que el usuario cierre el navegador
  await new Promise<void>((resolve) => {
    context.on("close", async () => resolve());
    page.on("close", () => {
      if (context.pages().length === 0) resolve();
    });
  });

  // Guardar también la sesión si quedó logueado
  try {
    const cookies = await extractSessionCookies(context);
    if (cookies.length > 0) {
      const now = new Date().toISOString();
      saveSiutmachSession({
        baseUrl: SIUTMACH_BASE_URL,
        cookies,
        landingUrl: `${SIUTMACH_BASE_URL}/`,
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch {
    // context already closed
  }

  writeFileSync(outputPath, JSON.stringify(captured, null, 2), { encoding: "utf8", mode: 0o600 });
  return { outputPath, count: captured.length };
}
