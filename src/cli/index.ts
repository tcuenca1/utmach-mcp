#!/usr/bin/env node
import { listAllSites } from "../config/sites.js";
import { loginEvea } from "../evea/auth.js";
import { getEveaStatus } from "../evea/service.js";
import { checkSiutmachStatus, inspectSiutmach, loginSiutmach } from "../siutmach/auth.js";
import { clearCache, getCacheStats } from "../storage/cache.js";
import { runSetup } from "./setup.js";

function parseSiteFlag(args: string[]): string | undefined {
  const idx = args.findIndex((a) => a === "--site" || a === "-s");
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function printHelp(): void {
  console.log(`utmach — CLI operativa para utmach-mcp (EVEA Moodle UTMACH)

Uso:
  utmach login [--site <alias>]     Inicia sesión en EVEA (Microsoft SSO + 2FA) y guarda el token oficial
  utmach status [--site <alias>]    Verifica si tu sesión EVEA está activa
  utmach sites                      Lista las instancias EVEA disponibles
  utmach siutmach login             Inicia sesión manual en SIUTMACH (solo guarda cookie de sesión)
  utmach siutmach status            Verifica si tu sesión SIUTMACH está activa
  utmach setup                      Registra el servidor MCP en Antigravity, Claude Code, Cursor y VS Code
  utmach cache info                 Muestra estadísticas de la caché local
  utmach cache clear                Limpia la caché local

Instancias predefinidas (--site):
  presencial (default), cec, enlinea, ir, nivelacion
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  const site = parseSiteFlag(args);

  if (cmd === "login") {
    const session = await loginEvea({ siteAlias: site });
    console.log(`\n[OK] Conectado a ${session.siteAlias} (${session.siteName ?? session.baseUrl})`);
    console.log(`     Usuario: ${session.fullName ?? "-"} (${session.username ?? "-"})`);
    return;
  }

  if (cmd === "status") {
    const st = await getEveaStatus(site);
    if (st.authenticated) {
      console.log(`[OK] Sesión válida en "${st.site.alias}" (${st.siteName || st.site.label})`);
      console.log(`     Usuario: ${st.user.fullName} (${st.user.username}, id=${st.user.id})`);
      console.log(`     Moodle:  ${st.moodleRelease ?? "-"}`);
      console.log(`     Actualizada: ${st.sessionUpdatedAt}`);
    } else {
      console.log(`[NO] Sin sesión activa en "${st.site.alias}"`);
      if ("error" in st && st.error) console.log(`     Detalle: ${st.error}`);
      if ("message" in st && st.message) console.log(`     ${st.message}`);
    }
    return;
  }

  if (cmd === "sites") {
    const sites = listAllSites();
    console.log("Instancias EVEA disponibles:\n");
    for (const s of sites) {
      console.log(`  ${s.alias.padEnd(12)} ${s.label.padEnd(42)} ${s.baseUrl}`);
    }
    return;
  }

  if (cmd === "siutmach") {
    const sub = args[1] ?? "status";
    if (sub === "login") {
      const s = await loginSiutmach();
      console.log(`\n[OK] Conectado a SIUTMACH (${s.landingUrl ?? s.baseUrl})`);
      console.log(`     Cookies capturadas: ${s.cookies.length}`);
      return;
    }
    if (sub === "status") {
      const st = await checkSiutmachStatus();
      if (st.authenticated) {
        console.log(`[OK] Sesión válida en SIUTMACH (${st.landingUrl ?? "-"})`);
        console.log(`     Actualizada: ${st.updatedAt}`);
      } else {
        console.log(`[NO] Sin sesión activa en SIUTMACH`);
        if (st.message) console.log(`     ${st.message}`);
      }
      return;
    }
    if (sub === "inspect") {
      const res = await inspectSiutmach();
      console.log(`\n[OK] Inspección terminada: ${res.count} peticiones registradas en:`);
      console.log(`     ${res.outputPath}`);
      return;
    }
    console.error(`Subcomando desconocido de siutmach: "${sub}" (usa: login | status | inspect)`);
    process.exit(1);
  }

  if (cmd === "setup") {
    runSetup();
    return;
  }

  if (cmd === "cache") {
    const sub = args[1] ?? "info";
    if (sub === "clear") {
      const res = clearCache();
      console.log(`[OK] Caché limpiada: ${res.deletedFiles} archivo(s), ${(res.freedBytes / 1024).toFixed(1)} KB liberados.`);
    } else {
      const stats = getCacheStats();
      console.log(`Caché local: ${stats.files} archivo(s), ${(stats.totalBytes / 1024).toFixed(1)} KB.`);
    }
    return;
  }

  console.error(`Comando desconocido: "${cmd}"\n`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
