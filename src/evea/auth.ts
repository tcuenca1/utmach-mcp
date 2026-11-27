import { existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { loadConfig, resolveSite, type SitePreset } from "../config/sites.js";
import { getBrowserProfileDir } from "../storage/paths.js";
import { saveSession, type EveaSession } from "../storage/session.js";
import { MoodleClient } from "./client.js";

function detectBrowserChannel(): "chrome" | "msedge" | undefined {
  const cfg = loadConfig();
  const envChannel = process.env.UTMACH_BROWSER_CHANNEL?.trim();
  const preferred = envChannel || cfg.browserChannel;
  if (preferred === "chrome" || preferred === "msedge") {
    return preferred;
  }

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

function decodeMoodleMobileToken(rawTokenParam: string): {
  signature?: string;
  token: string;
  privateToken?: string;
} | null {
  try {
    const cleaned = decodeURIComponent(rawTokenParam.trim()).replace(/[\s'"]+$/g, "");
    const decoded = Buffer.from(cleaned, "base64").toString("utf8");
    const parts = decoded.split(":::");
    if (parts.length >= 2 && parts[1] && /^[a-f0-9]{16,}$/i.test(parts[1])) {
      return {
        signature: parts[0],
        token: parts[1],
        privateToken: parts[2] || undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function extractTokenFromString(text: string): {
  signature?: string;
  token: string;
  privateToken?: string;
} | null {
  // Soporta moodlemobile://token=... y cualquier esquema custom (ej. eveautmach://token=...)
  const match = text.match(/[a-z][a-z0-9+.-]*:\/\/token=([A-Za-z0-9+/=%_-]+)/i);
  if (!match?.[1]) {
    return null;
  }
  return decodeMoodleMobileToken(match[1]);
}

export interface LoginOptions {
  siteAlias?: string;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

export async function loginEvea(options: LoginOptions = {}): Promise<EveaSession> {
  const site: SitePreset = resolveSite(options.siteAlias);
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const log = options.onStatus ?? ((msg: string) => console.error(msg));

  const channel = detectBrowserChannel();
  const profileDir = getBrowserProfileDir(site.alias);
  const passport = String(randomInt(100000, 999999999));
  const launchUrl = `${site.baseUrl}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`;
  const loginPageUrl = `${site.baseUrl}/login/index.php`;

  log(`Abriendo ${channel ?? "navegador"} para iniciar sesión en ${site.label}...`);
  log(`URL: ${site.baseUrl}`);
  log("Inicia sesión con tu cuenta institucional de Microsoft y aprueba el 2FA. La ventana se cerrará sola al capturar el token.");

  const context: BrowserContext = await chromium.launchPersistentContext(profileDir, {
    channel,
    headless: false,
    viewport: { width: 1120, height: 760 },
  });

  let captured: { token: string; privateToken?: string } | null = null;
  let probingLaunch = false;
  let resolveToken!: (val: { token: string; privateToken?: string }) => void;
  let rejectToken!: (err: Error) => void;

  const tokenPromise = new Promise<{ token: string; privateToken?: string }>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const tryCapture = (source: string | undefined | null) => {
    if (!source || captured) return;
    const found = extractTokenFromString(source);
    if (found) {
      captured = { token: found.token, privateToken: found.privateToken };
      resolveToken(captured);
    }
  };

  /**
   * Una vez que el navegador tiene una sesión autenticada de Moodle,
   * consultamos launch.php vía context.request (sin seguir redirects externos)
   * para leer el header Location: moodlemobile://token=... sin congelar Chrome.
   */
  const probeLaunchEndpoint = async () => {
    if (captured || probingLaunch) return;
    probingLaunch = true;
    try {
      let currentUrl = launchUrl;
      for (let hop = 0; hop < 5 && !captured; hop++) {
        const resp = await context.request.get(currentUrl, { maxRedirects: 0 });
        const status = resp.status();
        const loc = resp.headers()["location"];
        if (loc) {
          tryCapture(loc);
          if (captured) break;
          const safeLoc = loc.replace(/token=[^&\s]+/gi, "token=<redacted>");
          log(`[diag] launch.php hop ${hop + 1}: HTTP ${status} -> ${safeLoc}`);
          if (status >= 300 && status < 400 && (loc.startsWith("http://") || loc.startsWith("https://"))) {
            currentUrl = loc;
            continue;
          }
          break;
        }

        const body = await resp.text().catch(() => "");
        tryCapture(body);
        if (!captured) {
          const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const errMatch = body.match(/class="[^"]*errormessage[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
          log(
            `[diag] launch.php hop ${hop + 1}: HTTP ${status} sin token (len=${body.length}, title="${titleMatch?.[1]?.trim() ?? ""}", err="${errMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? ""}")`
          );
        }
        break;
      }
    } catch (err) {
      log(`[diag] probeLaunchEndpoint error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      probingLaunch = false;
    }
  };

  const isAuthenticatedMoodleUrl = (url: string): boolean => {
    if (!url.startsWith(site.baseUrl)) return false;
    if (url.includes("/login/")) return false;
    if (url.includes("/auth/oauth2/")) return false;
    return true;
  };

  const attachListeners = (page: Page) => {
    page.on("request", (req) => {
      tryCapture(req.url());
    });
    page.on("requestfailed", (req) => {
      tryCapture(req.url());
    });
    page.on("response", async (res) => {
      const headers = res.headers();
      if (headers["location"]) {
        tryCapture(headers["location"]);
      }
      if (!captured && res.url().includes("/admin/tool/mobile/launch.php")) {
        try {
          const body = await res.text();
          tryCapture(body);
        } catch {
          // ignore
        }
      }
    });
    page.on("framenavigated", async (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      tryCapture(url);
      if (!captured && isAuthenticatedMoodleUrl(url)) {
        log(`Sesión detectada en EVEA (${url}). Obteniendo token oficial...`);
        await probeLaunchEndpoint();
      }
    });
  };

  const page = context.pages()[0] ?? (await context.newPage());
  attachListeners(page);
  context.on("page", (newPage) => attachListeners(newPage));

  context.on("close", () => {
    if (!captured) {
      rejectToken(new Error("El navegador se cerró antes de completar el inicio de sesión."));
    }
  });

  // Poll de respaldo cada 2s por si ya hay cookie MoodleSession válida
  const pollInterval = setInterval(async () => {
    if (captured) return;
    try {
      const currentUrl = page.url();
      if (isAuthenticatedMoodleUrl(currentUrl)) {
        await probeLaunchEndpoint();
      }
    } catch {
      // ignore
    }
  }, 2000);

  const timer = setTimeout(() => {
    if (!captured) {
      rejectToken(new Error("Tiempo agotado esperando el inicio de sesión en EVEA."));
    }
  }, timeoutMs);

  try {
    // Empezar por la página normal de login de EVEA (evita bloqueos de protocolo externo en Chrome)
    await page.goto(loginPageUrl, { waitUntil: "domcontentloaded" });

    // Si el perfil ya tenía sesión iniciada y redirigió al dashboard, probamos de inmediato
    if (isAuthenticatedMoodleUrl(page.url())) {
      await probeLaunchEndpoint();
    }

    const result = await tokenPromise;

    let moodleSessionCookie: string | undefined;
    try {
      const cookies = await context.cookies(site.baseUrl);
      const ms = cookies.find((c) => c.name === "MoodleSession");
      if (ms) moodleSessionCookie = ms.value;
    } catch {
      // optional
    }

    const now = new Date().toISOString();
    const session: EveaSession = {
      siteAlias: site.alias,
      baseUrl: site.baseUrl,
      token: result.token,
      privateToken: result.privateToken,
      moodleSessionCookie,
      createdAt: now,
      updatedAt: now,
    };

    const client = new MoodleClient(session);
    const info = await client.getSiteInfo();
    session.userId = info.userid;
    session.username = info.username;
    session.fullName = info.fullname;
    session.siteName = info.sitename;

    saveSession(session);
    log(`Sesión guardada correctamente para ${info.fullname} (${info.username}) en ${site.alias}.`);
    return session;
  } finally {
    clearInterval(pollInterval);
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
}
