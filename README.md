# utmach-mcp

[![CI](https://github.com/tcuenca1/utmach-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tcuenca1/utmach-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)

Servidor **MCP (Model Context Protocol)** + CLI operativa en TypeScript para conectar agentes de IA (**Antigravity**, **Claude Code**, **Cursor**, **VS Code Copilot**, etc.) a los portales académicos de la **Universidad Técnica de Machala (UTMACH)**:

* **EVEA Moodle UTMACH** — vía **API REST oficial de Moodle Web Services** (`moodle_mobile_app`), sin scraping HTML.
* **SIUTMACH** — horarios oficiales, control de asistencias, notas parciales (70% + 30%) y avance de malla curricular.

> Inspirado en [JOSETRA44/DUTIC-mcp](https://github.com/JOSETRA44/DUTIC-mcp) y diseñado específicamente para la arquitectura real de los sistemas de la UTMACH.

---

## Arquitectura

```text
[Tú: "¿Qué clases tengo hoy, qué tareas vencen esta semana y cómo voy en asistencias?"]
        │
        ▼
[Agente de IA]  (Antigravity · Claude Code · Cursor · VS Code Copilot)
        │  MCP sobre stdio (100% local)
        ▼
[utmach-mcp]  (Caché TTL en disco + rate-limiting conservador)
        ├──► EVEA Moodle UTMACH  (API REST oficial con token personal tras Microsoft SSO + 2FA)
        └──► SIUTMACH            (Endpoints internos de solo lectura con sesión temporal local)
```

---

## Requisitos

* **[Node.js](https://nodejs.org) ≥ 20**
* **Google Chrome** o **Microsoft Edge** instalado *(Playwright reutiliza tu navegador local sin descargar binarios de Chromium)*.

---

## Instalación

```bash
git clone https://github.com/tcuenca1/utmach-mcp.git
cd utmach-mcp
npm install
npm run build
npm link   # deja los comandos `utmach` y `utmach-mcp` disponibles globalmente
```

*(Si prefieres no ejecutar `npm link`, puedes reemplazar `utmach` por `node dist/cli/index.js` en todos los comandos).*

---

## Primeros pasos

### 1. Inicia sesión en EVEA Moodle

```bash
utmach login                  # Carreras Presenciales (predeterminado)
utmach login --site cec       # Opcional: Centro de Educación Continua (CEC)
```

Se abrirá tu Chrome en el portal de EVEA. Inicia sesión con tu cuenta institucional de Microsoft y aprueba tu **Microsoft Authenticator**; al entrar al aula virtual, `utmach` captura automáticamente tu token oficial de Moodle Web Services y cierra la ventana. **Nunca guarda tu contraseña.**

### 2. Inicia sesión en SIUTMACH

```bash
utmach siutmach login
```

Abre Chrome en SIUTMACH para que inicies sesión manualmente. Solo se guarda la cookie de sesión temporal en `~/.utmach/sessions/siutmach.json` (con permisos restrictivos) — **jamás se guarda tu contraseña**.

### 3. Registra el servidor MCP en tus agentes de IA

```bash
utmach setup
```

Detecta y registra `"utmach"` automáticamente (creando copias de seguridad `*.utmach-bak` sin tocar otros servidores) en:
* **Antigravity** (`~/.gemini/config/mcp_config.json`)
* **Claude Code** (`~/.claude.json`)
* **Cursor** (`~/.cursor/mcp.json`)
* **VS Code / GitHub Copilot** (`%APPDATA%/Code/User/mcp.json`)

Reinicia tu agente de IA y ya puedes empezar a consultar tus plataformas académicas en lenguaje natural.

---

## Instancias EVEA soportadas

Todas las instancias oficiales de [utmachala.edu.ec/evea](https://www.utmachala.edu.ec/evea/) tienen habilitado Moodle Mobile Web Services y funcionan con el mismo motor:

| Alias (`--site`) | Área | URL base |
| :--- | :--- | :--- |
| `presencial` *(default)* | Carreras Presenciales | `https://moodle.utmachala.edu.ec/cursosvirtuales` |
| `cec` | Centro de Educación Continua | `https://eveacec.utmachala.edu.ec/main` |
| `enlinea` | Carreras en Línea | `https://eveaenlinea.utmachala.edu.ec/main` |
| `ir` | Internado Rotativo | `https://eveair.utmachala.edu.ec/main` |
| `nivelacion` | Nivelación | `https://eveanivelacion.utmachala.edu.ec/main` |

---

## Herramientas MCP disponibles (15)

### EVEA Moodle (9 herramientas)
| Herramienta | Qué hace |
| :--- | :--- |
| `evea_status` | Verifica tu sesión autenticada, versión de Moodle e instancias disponibles. |
| `evea_list_courses` | Lista tus cursos matriculados (`inprogress`, `past`, `future`, `all`). |
| `evea_list_tasks` | Lista tareas pendientes/entregadas, marca las **ocultas** (fuera del timeline) y detecta **conflictos de fecha** en las consignas. |
| `evea_get_task_detail` | Consigna completa en Markdown, fechas, adjuntos, estado de entrega y calificación/retroalimentación. |
| `evea_get_grades` | Resumen de calificaciones de todos los cursos o desglose ítem por ítem de un curso. |
| `evea_list_materials` | Lista archivos (PDF, DOCX, PPTX), enlaces y recursos de un curso organizados por unidad. |
| `evea_read_material` | Descarga un material a caché local y extrae su texto/Markdown (soporta **PDF, DOCX y PPTX**, paginación `startPage`/`endPage` y detección honesta de PDFs escaneados). |
| `evea_list_announcements` | Avisos y foros recientes publicados por docentes. |
| `evea_check_changes` | Compara el estado actual contra la última revisión guardada (nuevas tareas, cambios de fecha, nuevas notas o anuncios). |

### SIUTMACH (4 herramientas)
| Herramienta | Qué hace |
| :--- | :--- |
| `siutmach_status` | Verifica la sesión activa y devuelve perfil, carrera y periodo académico activo. |
| `siutmach_get_schedule` | Horario semanal de clases y tutorías con aulas/laboratorios (filtrable por `hoy`, `mañana`, `lunes`…). |
| `siutmach_get_attendance` | Horas asistidas, faltas y cuántas horas de falta te quedan antes del límite reglamentario del **15%** (por defecto solo periodo actual). |
| `siutmach_get_grades` | Desglose oficial del periodo actual (**Parcial 1 y 2**: 70% por componentes + 30% examen + nota final) y/o **récord histórico + progreso en la malla**. |

### Cruce inteligente EVEA + SIUTMACH (2 herramientas)
| Herramienta | Qué hace |
| :--- | :--- |
| `utmach_daily_briefing` | Resumen del día: tus clases de hoy/mañana (SIUTMACH) + tareas próximas o con conflicto de fecha (EVEA) + resumen de asistencias. |
| `utmach_compare_grades` | Cruza tus notas oficiales parciales de SIUTMACH contra los totales de EVEA Moodle y reporta diferencias por asignatura. |

---

## Ejemplos de preguntas para tu agente de IA

* *"Dame mi briefing de hoy: qué clases tengo, qué tareas vencen esta semana y cómo voy en asistencias."*
* *"¿Tengo alguna tarea oculta o con fecha contradictoria en EVEA?"*
* *"Lee el sílabo de Ingeniería de Software II y dime los temas del segundo parcial."*
* *"Compara mis notas oficiales de SIUTMACH con las de EVEA."*
* *"¿Cuál es mi avance actual en la malla curricular?"*

---

## Comandos CLI

```bash
utmach login [--site <alias>]     # Inicia sesión en EVEA (Microsoft SSO + 2FA)
utmach status [--site <alias>]    # Verifica sesión de EVEA
utmach sites                      # Lista las instancias EVEA preconfiguradas
utmach siutmach login             # Inicia sesión manual en SIUTMACH
utmach siutmach status            # Verifica sesión de SIUTMACH
utmach setup                      # Registra el MCP en Antigravity, Claude Code, Cursor y VS Code
utmach cache info                 # Estadísticas de la caché local
utmach cache clear                # Limpia la caché local
```

> **¿Qué pasa si caduca una sesión?** El servidor MCP nunca abre ventanas de navegador por su cuenta. Devuelve un mensaje claro para que tu IA te avise y tú renueves la sesión con `utmach login` o `utmach siutmach login`.

---

## Privacidad, seguridad y aviso legal

* **100% local:** tus tokens, cookies de sesión y archivos cacheados se almacenan únicamente en `~/.utmach/` dentro de tu computadora. No existen servidores intermedios ni telemetría.
* **Cero contraseñas guardadas:** ni tu clave de Microsoft ni tu clave de SIUTMACH se persisten en disco.
* **Solo lectura estricta:** ninguna herramienta envía tareas, modifica matrículas ni realiza acciones de escritura en los portales.
* **Respeto a los servidores institucionales:** caché en disco con TTL inteligente (horarios 7 días, cursos/historial 24 h, materiales 6 h, asistencias/notas 1–3 h, tareas 15 min) + rate-limiting conservador.
* **Aviso legal:** `utmach-mcp` es un proyecto independiente de código abierto para uso personal y educativo del titular de su propia cuenta, sin afiliación ni respaldo oficial de la Universidad Técnica de Machala (UTMACH). Respeta la privacidad de terceros: no recolectes ni almacenes datos personales de otros estudiantes o docentes.

---

## Desarrollo

```bash
npm run typecheck   # Verificación de tipos TypeScript
npm run build       # Compilación a dist/
npm test            # Compila y ejecuta tests unitarios (node:test)
```

## Licencia

[MIT](LICENSE) © 2026 Terry Cuenca
