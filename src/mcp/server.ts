#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  compareEveaAndSiutmachGrades,
  getDailyBriefing,
} from "../combined/service.js";
import {
  checkEveaChanges,
  getEveaGrades,
  getEveaStatus,
  getEveaTaskDetail,
  listEveaAnnouncements,
  listEveaCourses,
  listEveaMaterials,
  listEveaTasks,
  readEveaMaterial,
} from "../evea/service.js";
import {
  getSiutmachAttendance,
  getSiutmachGrades,
  getSiutmachSchedule,
  getSiutmachStatus,
} from "../siutmach/service.js";

const server = new McpServer({
  name: "utmach-mcp",
  version: "0.1.0",
});

const siteParam = z
  .string()
  .optional()
  .describe("Instancia EVEA opcional: presencial (default), cec, enlinea, ir, nivelacion.");

const refreshParam = z
  .boolean()
  .optional()
  .describe("Si es true, ignora la caché local y consulta datos frescos en vivo.");

function jsonResponse(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

// 1. evea_status
server.tool(
  "evea_status",
  "Verifica el estado de la sesión autenticada en EVEA Moodle UTMACH, datos del estudiante y sitios disponibles.",
  { site: siteParam },
  async ({ site }) => {
    try {
      return jsonResponse(await getEveaStatus(site));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 2. evea_list_courses
server.tool(
  "evea_list_courses",
  "Lista los cursos matriculados en EVEA Moodle UTMACH (por defecto los cursos en progreso).",
  {
    site: siteParam,
    classification: z
      .enum(["inprogress", "past", "future", "all"])
      .optional()
      .describe("Filtro de periodo del curso (default: inprogress)."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await listEveaCourses(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 3. evea_list_tasks
server.tool(
  "evea_list_tasks",
  "Lista todas las tareas de EVEA Moodle, incluyendo tareas ocultas (sin fecha en el timeline) y detectando conflictos de fechas en las consignas.",
  {
    site: siteParam,
    courseId: z.number().int().optional().describe("ID opcional de un curso específico."),
    includeSubmitted: z
      .boolean()
      .optional()
      .describe("Si es true, incluye tareas ya entregadas (default: false, solo pendientes)."),
    onlyHidden: z
      .boolean()
      .optional()
      .describe("Si es true, devuelve solo tareas ocultas que no aparecen en el timeline."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await listEveaTasks(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 4. evea_get_task_detail
server.tool(
  "evea_get_task_detail",
  "Obtiene el detalle completo de una tarea: consigna en Markdown, fechas, conflicto de fechas, archivos adjuntos, estado de entrega y calificación/retroalimentación.",
  {
    site: siteParam,
    assignId: z.number().int().optional().describe("ID de la tarea (assignId)."),
    cmid: z.number().int().optional().describe("ID del módulo de curso (cmid)."),
    courseId: z.number().int().optional().describe("ID del curso (acelera la búsqueda)."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await getEveaTaskDetail(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 5. evea_get_grades
server.tool(
  "evea_get_grades",
  "Consulta calificaciones en EVEA Moodle: resumen de todos los cursos si se omite courseId, o desglose detallado de un curso específico.",
  {
    site: siteParam,
    courseId: z.number().int().optional().describe("ID del curso para ver detalle ítem por ítem."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await getEveaGrades(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 6. evea_list_materials
server.tool(
  "evea_list_materials",
  "Lista los materiales, archivos (PDF, DOCX, PPTX), enlaces y actividades de un curso organizados por unidad/semana.",
  {
    site: siteParam,
    courseId: z.number().int().describe("ID del curso (obtenido con evea_list_courses)."),
    sectionQuery: z
      .string()
      .optional()
      .describe("Filtro opcional por nombre de unidad, tema o recurso."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await listEveaMaterials(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 7. evea_read_material
server.tool(
  "evea_read_material",
  "Descarga un archivo de EVEA (PDF, DOCX, PPTX o texto) a caché local y devuelve su contenido extraído en texto/Markdown con soporte de paginación y detección de PDFs escaneados.",
  {
    site: siteParam,
    fileUrl: z.string().url().describe("URL del archivo obtenida con evea_list_materials o evea_get_task_detail."),
    fileName: z.string().optional().describe("Nombre de archivo sugerido (ej. tema2.pdf)."),
    startPage: z.number().int().min(1).optional().describe("Página o diapositiva inicial (1-indexed)."),
    endPage: z.number().int().min(1).optional().describe("Página o diapositiva final (1-indexed)."),
    maxChars: z.number().int().min(1000).max(100000).optional().describe("Límite máximo de caracteres (default: 30000)."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await readEveaMaterial(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 8. evea_list_announcements
server.tool(
  "evea_list_announcements",
  "Lista los avisos y anuncios recientes publicados por los docentes en los foros de los cursos.",
  {
    site: siteParam,
    courseId: z.number().int().optional().describe("ID opcional de un curso específico."),
    limit: z.number().int().min(1).max(50).optional().describe("Máximo de anuncios a devolver (default: 15)."),
    includeAllForums: z.boolean().optional().describe("Si es true, incluye foros generales además del foro de Avisos."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await listEveaAnnouncements(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 9. evea_check_changes
server.tool(
  "evea_check_changes",
  "Compara el estado actual de EVEA contra la última revisión guardada y reporta nuevas tareas, cambios de fecha límite, nuevas notas o anuncios recientes.",
  {
    site: siteParam,
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await checkEveaChanges(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ---------- SIUTMACH (Fase 2) ----------

// 10. siutmach_status
server.tool(
  "siutmach_status",
  "Verifica la sesión activa en SIUTMACH y devuelve datos del estudiante, carrera y periodo académico activo.",
  {},
  async () => {
    try {
      return jsonResponse(await getSiutmachStatus());
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 11. siutmach_get_schedule
server.tool(
  "siutmach_get_schedule",
  "Consulta tu horario oficial de clases y tutorías en SIUTMACH (con aulas, días y horas). Puedes filtrar por día ('hoy', 'mañana', 'lunes', etc.).",
  {
    day: z
      .string()
      .optional()
      .describe("Filtro opcional por día: 'hoy', 'mañana', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes'."),
    includeTutorias: z
      .boolean()
      .optional()
      .describe("Si es false, omite bloques de tutorías académicas (default: true)."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await getSiutmachSchedule(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 12. siutmach_get_attendance
server.tool(
  "siutmach_get_attendance",
  "Consulta tus horas de asistencia y faltas oficiales en SIUTMACH por materia, calculando cuántas horas de falta te quedan antes del límite reglamentario (15%).",
  {
    onlyCurrentPeriod: z
      .boolean()
      .optional()
      .describe("Si es true (default), devuelve solo las materias del periodo académico actual; si es false, devuelve todo el historial."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await getSiutmachAttendance(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 13. siutmach_get_grades
server.tool(
  "siutmach_get_grades",
  "Consulta calificaciones oficiales en SIUTMACH: notas parciales del semestre actual (Parcial 1/2, 70%, examen y componentes) y/o historial académico completo con progreso en la malla.",
  {
    scope: z
      .enum(["current", "history", "all"])
      .optional()
      .describe("'current' para el periodo actual (default), 'history' para récord histórico y avance de malla, o 'all' para ambos."),
    includeDetail: z
      .boolean()
      .optional()
      .describe("En 'current', incluye desglose detallado de Parcial 1/2 y componentes (default: true)."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await getSiutmachGrades(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ---------- CRUCE EVEA + SIUTMACH ----------

// 14. utmach_daily_briefing
server.tool(
  "utmach_daily_briefing",
  "Resumen diario combinado: tus clases de hoy/mañana (SIUTMACH) + tareas próximas o con conflicto de fecha (EVEA) + alertas de asistencia (SIUTMACH).",
  {
    site: siteParam,
    day: z.string().optional().describe("Día para el horario: 'hoy' (default), 'mañana', 'lunes', etc."),
    daysAheadTasks: z.number().int().min(1).max(30).optional().describe("Ventana de días para tareas próximas en EVEA (default: 7)."),
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await getDailyBriefing(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// 15. utmach_compare_grades
server.tool(
  "utmach_compare_grades",
  "Compara tus notas oficiales del periodo actual en SIUTMACH (Parcial 1/2) contra los totales publicados en EVEA Moodle, detectando diferencias por asignatura.",
  {
    site: siteParam,
    refresh: refreshParam,
  },
  async (args) => {
    try {
      return jsonResponse(await compareEveaAndSiutmachGrades(args));
    } catch (err) {
      return errorResponse(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Error fatal en utmach-mcp:", err);
  process.exit(1);
});
