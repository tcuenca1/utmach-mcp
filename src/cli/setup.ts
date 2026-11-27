import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ClientTarget {
  name: string;
  configPath: string;
  rootKey: "mcpServers" | "servers";
  onlyIfParentExists: boolean;
}

function getServerEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "mcp", "server.js");
}

function getSkillSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "skills", "utmach", "SKILL.md");
}

function getTargets(): ClientTarget[] {
  const home = homedir();
  const appData = process.env.APPDATA || join(home, "AppData", "Roaming");

  return [
    {
      name: "Antigravity",
      configPath: join(home, ".gemini", "config", "mcp_config.json"),
      rootKey: "mcpServers",
      onlyIfParentExists: true,
    },
    {
      name: "Antigravity (legacy)",
      configPath: join(home, ".antigravity", "config", "mcp_config.json"),
      rootKey: "mcpServers",
      onlyIfParentExists: true,
    },
    {
      name: "Claude Code",
      configPath: join(home, ".claude.json"),
      rootKey: "mcpServers",
      onlyIfParentExists: false,
    },
    {
      name: "Cursor",
      configPath: join(home, ".cursor", "mcp.json"),
      rootKey: "mcpServers",
      onlyIfParentExists: true,
    },
    {
      name: "VS Code (Copilot)",
      configPath: join(appData, "Code", "User", "mcp.json"),
      rootKey: "servers",
      onlyIfParentExists: true,
    },
  ];
}

export function runSetup(): void {
  const serverPath = getServerEntryPath();
  const targets = getTargets();

  console.log(`Registrando servidor MCP "utmach" -> node ${serverPath}\n`);

  let configured = 0;

  for (const t of targets) {
    const parent = dirname(t.configPath);
    if (t.onlyIfParentExists && !existsSync(parent)) {
      console.log(`[SKIP] ${t.name.padEnd(20)} (no detectado: ${parent})`);
      continue;
    }

    mkdirSync(parent, { recursive: true });

    let json: Record<string, unknown> = {};
    if (existsSync(t.configPath)) {
      const raw = readFileSync(t.configPath, "utf8").trim();
      if (raw.length > 0) {
        try {
          json = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          console.log(`[WARN] ${t.name.padEnd(20)} JSON inválido en ${t.configPath}, se omite para no sobrescribir.`);
          continue;
        }
      }
      copyFileSync(t.configPath, `${t.configPath}.utmach-bak`);
    }

    const servers = (json[t.rootKey] as Record<string, unknown> | undefined) ?? {};
    servers["utmach"] =
      t.rootKey === "servers"
        ? { type: "stdio", command: "node", args: [serverPath] }
        : { command: "node", args: [serverPath] };
    json[t.rootKey] = servers;

    writeFileSync(t.configPath, JSON.stringify(json, null, 2) + "\n", "utf8");
    console.log(`[OK]   ${t.name.padEnd(20)} ${t.configPath}`);
    configured++;
  }

  // Instalar skill de guía para agentes (Antigravity / .agents y Claude Code) si existe
  const skillSrc = getSkillSourcePath();
  if (existsSync(skillSrc)) {
    const home = homedir();
    const skillTargets = [
      { name: "Agents Skill", dir: join(home, ".agents", "skills", "utmach") },
      { name: "Claude Skill", dir: join(home, ".claude", "skills", "utmach") },
    ];
    for (const st of skillTargets) {
      if (existsSync(dirname(dirname(st.dir)))) {
        mkdirSync(st.dir, { recursive: true });
        copyFileSync(skillSrc, join(st.dir, "SKILL.md"));
        console.log(`[OK]   ${st.name.padEnd(20)} ${join(st.dir, "SKILL.md")}`);
      }
    }
  }

  console.log(`\nListo (${configured} cliente(s) actualizado(s)). Reinicia tu agente de IA para cargar "utmach".`);
}
