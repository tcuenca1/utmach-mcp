import { getEveaGrades, listEveaTasks } from "../evea/service.js";
import {
  getSiutmachAttendance,
  getSiutmachGrades,
  getSiutmachSchedule,
} from "../siutmach/service.js";

export function normalizeSubjectName(name: string): string {
  // Primero quitar prefijos entre corchetes como "[ 6A - MATU. ] " de SIUTMACH
  const withoutTag = name.replace(/^\[[^\]]+\]\s*/, "");
  // En EVEA los nombres suelen ser: "INGENIERÍA DE SOFTWARE II - SEXTO A DIURNA - DOCENTE"
  const beforeDash = withoutTag.split(" - ")[0] ?? withoutTag;
  return beforeDash
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseNumericGrade(raw?: string | number | null): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const cleaned = raw.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned[0]);
  return Number.isFinite(n) ? n : null;
}

// ---------- 1. utmach_daily_briefing ----------

export async function getDailyBriefing(params: {
  site?: string;
  day?: string;
  daysAheadTasks?: number;
  refresh?: boolean;
}) {
  const day = params.day ?? "hoy";
  const daysAhead = params.daysAheadTasks ?? 7;
  const warnings: string[] = [];

  let scheduleSection: Awaited<ReturnType<typeof getSiutmachSchedule>> | null = null;
  let attendanceAlerts: Array<{
    subject: string;
    absentHours: number;
    maxAbsentHoursAllowed: number;
    remainingAbsentHours: number;
    alertLevel: string;
  }> = [];
  let upcomingTasks: Array<{
    assignId: number;
    courseName: string;
    name: string;
    dueDate: string | null;
    isOverdue: boolean;
    hasDateConflict: boolean;
    url: string;
  }> = [];

  await Promise.all([
    getSiutmachSchedule({ day, includeTutorias: true, refresh: params.refresh })
      .then((res) => {
        scheduleSection = res;
      })
      .catch((err) => {
        warnings.push(`SIUTMACH horario no disponible: ${err instanceof Error ? err.message : String(err)}`);
      }),

    getSiutmachAttendance({ refresh: params.refresh })
      .then((res) => {
        attendanceAlerts = res.records
          .filter((r) => r.alertLevel !== "ok" || r.absentHours > 0)
          .map((r) => ({
            subject: r.subject,
            absentHours: r.absentHours,
            maxAbsentHoursAllowed: r.maxAbsentHoursAllowed,
            remainingAbsentHours: r.remainingAbsentHours,
            alertLevel: r.alertLevel,
          }));
      })
      .catch((err) => {
        warnings.push(`SIUTMACH asistencias no disponibles: ${err instanceof Error ? err.message : String(err)}`);
      }),

    listEveaTasks({ site: params.site, includeSubmitted: false, refresh: params.refresh })
      .then((res) => {
        const now = Date.now();
        const horizon = now + daysAhead * 24 * 60 * 60 * 1000;
        upcomingTasks = res.tasks
          .filter((t) => {
            if (!t.dueDate) return false;
            const ts = Date.parse(t.dueDate);
            return (ts >= now && ts <= horizon) || t.dateConflict.hasConflict;
          })
          .map((t) => ({
            assignId: t.assignId,
            courseName: t.courseName,
            name: t.name,
            dueDate: t.dueDate,
            isOverdue: t.isOverdue,
            hasDateConflict: t.dateConflict.hasConflict,
            url: t.url,
          }));
      })
      .catch((err) => {
        warnings.push(`EVEA tareas no disponibles: ${err instanceof Error ? err.message : String(err)}`);
      }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    dayRequested: day,
    classes: scheduleSection,
    upcomingTasksNextDays: {
      daysAhead,
      count: upcomingTasks.length,
      tasks: upcomingTasks,
    },
    attendanceSummary: attendanceAlerts,
    warnings,
  };
}

// ---------- 2. utmach_compare_grades ----------

export async function compareEveaAndSiutmachGrades(params: {
  site?: string;
  refresh?: boolean;
}) {
  const [eveaRes, siuRes] = await Promise.all([
    getEveaGrades({ site: params.site, refresh: params.refresh }),
    getSiutmachGrades({ scope: "current", includeDetail: true, refresh: params.refresh }),
  ]);

  const eveaCourses = "courses" in eveaRes && Array.isArray(eveaRes.courses) ? eveaRes.courses : [];
  const siuSubjects = siuRes.current?.subjects ?? [];

  const eveaByNorm = new Map<string, (typeof eveaCourses)[number]>();
  for (const c of eveaCourses) {
    eveaByNorm.set(normalizeSubjectName(c.courseName), c);
  }

  const comparisons = siuSubjects.map((s) => {
    const norm = normalizeSubjectName(s.subject);
    let eveaMatch = eveaByNorm.get(norm);
    if (!eveaMatch) {
      for (const [k, v] of eveaByNorm.entries()) {
        if (k.includes(norm) || norm.includes(k)) {
          eveaMatch = v;
          break;
        }
      }
    }

    const eveaNum = parseNumericGrade(eveaMatch?.rawGrade ?? eveaMatch?.grade);
    const siuP1Num = parseNumericGrade(s.parcial1Final);
    const siuP2Num = parseNumericGrade(s.parcial2Final);

    let note = "Sin nota numérica publicada en EVEA para comparar.";
    if (eveaNum !== null && siuP1Num !== null) {
      const diff = Number((eveaNum - siuP1Num).toFixed(2));
      note =
        Math.abs(diff) < 0.05
          ? "EVEA coincide con Parcial 1 de SIUTMACH."
          : `Diferencia de ${diff > 0 ? "+" : ""}${diff} pts respecto a Parcial 1 SIUTMACH (puede deberse a actividades de Parcial 2 o ponderación distinta en Moodle).`;
    } else if (siuP1Num !== null) {
      note = "Parcial 1 oficial cargado en SIUTMACH; EVEA aún no muestra total consolidado.";
    }

    return {
      subject: s.subject,
      teacher: s.teacher ?? null,
      siutmach: {
        parcial1Status: s.parcial1Status ?? null,
        parcial1Final: s.parcial1Final ?? null,
        parcial1Process70: s.parcial1Process70 ?? null,
        parcial1Exam: s.parcial1Exam ?? null,
        parcial2Status: s.parcial2Status ?? null,
        parcial2Final: s.parcial2Final ?? null,
      },
      evea: eveaMatch
        ? {
            courseId: eveaMatch.courseId,
            courseName: eveaMatch.courseName,
            grade: eveaMatch.grade,
            rawGrade: eveaMatch.rawGrade,
          }
        : null,
      comparisonNote: note,
    };
  });

  return {
    student: siuRes.student,
    totalCompared: comparisons.length,
    comparisons,
  };
}
