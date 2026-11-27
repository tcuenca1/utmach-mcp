import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getConfigPath } from "../storage/paths.js";

export interface SitePreset {
  alias: string;
  label: string;
  baseUrl: string;
}

export const DEFAULT_SITES: Record<string, SitePreset> = {
  presencial: {
    alias: "presencial",
    label: "EVEA Carreras Presenciales",
    baseUrl: "https://moodle.utmachala.edu.ec/cursosvirtuales",
  },
  cec: {
    alias: "cec",
    label: "EVEA Centro de Educación Continua (CEC)",
    baseUrl: "https://eveacec.utmachala.edu.ec/main",
  },
  enlinea: {
    alias: "enlinea",
    label: "EVEA Carreras en Línea",
    baseUrl: "https://eveaenlinea.utmachala.edu.ec/main",
  },
  ir: {
    alias: "ir",
    label: "EVEA Internado Rotativo",
    baseUrl: "https://eveair.utmachala.edu.ec/main",
  },
  nivelacion: {
    alias: "nivelacion",
    label: "EVEA Nivelación",
    baseUrl: "https://eveanivelacion.utmachala.edu.ec/main",
  },
};

export interface UserConfig {
  defaultSite: string;
  browserChannel?: "chrome" | "msedge" | "chromium";
  customSites?: Record<string, { label?: string; baseUrl: string }>;
}

const DEFAULT_CONFIG: UserConfig = {
  defaultSite: "presencial",
};

export function loadConfig(): UserConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UserConfig>;
    return {
      defaultSite: parsed.defaultSite || DEFAULT_CONFIG.defaultSite,
      browserChannel: parsed.browserChannel,
      customSites: parsed.customSites,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: UserConfig): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

export function listAllSites(): SitePreset[] {
  const config = loadConfig();
  const merged: Record<string, SitePreset> = { ...DEFAULT_SITES };

  if (config.customSites) {
    for (const [alias, entry] of Object.entries(config.customSites)) {
      merged[alias] = {
        alias,
        label: entry.label || `EVEA (${alias})`,
        baseUrl: entry.baseUrl.replace(/\/+$/, ""),
      };
    }
  }

  return Object.values(merged);
}

export function resolveSite(alias?: string): SitePreset {
  const config = loadConfig();
  const target = (alias?.trim() || process.env.UTMACH_SITE?.trim() || config.defaultSite || "presencial").toLowerCase();

  const all = listAllSites();
  const found = all.find((s) => s.alias.toLowerCase() === target);
  if (found) {
    return found;
  }

  if (target.startsWith("http://") || target.startsWith("https://")) {
    return {
      alias: "custom",
      label: "EVEA URL personalizada",
      baseUrl: target.replace(/\/+$/, ""),
    };
  }

  const valid = all.map((s) => s.alias).join(", ");
  throw new Error(`Instancia EVEA desconocida: "${target}". Opciones válidas: ${valid}`);
}
