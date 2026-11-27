import { CACHE_TTL_MS, withCache } from "../storage/cache.js";
import { SiutmachClient } from "./client.js";

const DAY_NAMES: Record<number, string> = {
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
  7: "Domingo",
};

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function cleanPlace(raw?: string): string {
  if (!raw) return "";
  return stripHtml(raw).replace(/^\|\s*/, "").trim();
}

interface RawSessionInfo {
  success: boolean;
  user?: {
    name: string;
    usersignin: string;
    email: string;
    lastaccessdate?: string;
  };
}

interface RawPeriodo {
  perid: number;
  pernombre: string;
}

interface RawHorarioItem {
  fecha?: string;
  codigo?: number;
  dia: string | number;
  hini: string;
  hfin: string;
  asignatura: string;
  tactividad: string;
  lugar?: string;
}

interface RawCarrera {
  rcodigo: number;
  carrera: string;
}

interface RawAsistenciaItem {
  nivel: string;
  curso: string;
  seccion: string;
  numeracion?: string;
  asignatura: string;
  credito: string | number;
  horas: number;
  docente: string;
  asistencia: number;
  faltas: number;
  total: number;
  pfaltas: string;
  pasistencia: string;
  ppendiente: string;
  ppmaxfaltas: string;
  periodo: string;
  plectivo: string;
  modalidad: string;
  estado: string;
}

async function fetchUserSession(client: SiutmachClient) {
  const res = await client.postJson<RawSessionInfo>("/default/auth/session");
  if (!res.success || !res.user) {
    throw new Error("No se pudo obtener la sesión activa en SIUTMACH. Ejecuta: utmach siutmach login");
  }
  return res.user;
}

// ---------- 1. siutmach_status ----------

export async function getSiutmachStatus() {
  try {
    const client = SiutmachClient.fromSavedSession();
    const [user, carrerasRes, periodosRes] = await Promise.all([
      fetchUserSession(client),
      client.postJson<{ carreras?: RawCarrera[]; success?: boolean }>(
        "/academico/syllabus/obtenercarreraxestudiante",
        { page: 1, start: 0, limit: 25 }
      ),
      client.postJson<{ data?: RawPeriodo[]; success?: boolean }>(
        "/tutoria/solicitud/periodos",
        { page: 1, start: 0, limit: 25 }
      ),
    ]);

    return {
      authenticated: true,
      user: {
        name: user.name,
        cedula: user.usersignin,
        email: user.email,
        lastAccess: user.lastaccessdate ?? null,
      },
      careers: (carrerasRes.carreras ?? []).map((c) => ({
        code: c.rcodigo,
        name: c.carrera,
      })),
      activePeriods: (periodosRes.data ?? []).map((p) => ({
        id: p.perid,
        name: p.pernombre.trim(),
      })),
      sessionUpdatedAt: client.session.updatedAt,
    };
  } catch (err) {
    return {
      authenticated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------- 2. siutmach_get_schedule ----------

export interface ScheduleSlot {
  dayNumber: number;
  dayName: string;
  startTime: string;
  endTime: string;
  subject: string;
  activityType: string;
  place: string;
}

export async function getSiutmachSchedule(params: {
  day?: string;
  includeTutorias?: boolean;
  refresh?: boolean;
}) {
  const client = SiutmachClient.fromSavedSession();
  const includeTutorias = params.includeTutorias ?? true;

  const { data, fromCache, cachedAt } = await withCache(
    "siutmach_schedule",
    CACHE_TTL_MS.siutmachSchedule,
    Boolean(params.refresh),
    async () => {
      const periodosRes = await client.postJson<{ data?: RawPeriodo[]; success?: boolean }>(
        "/tutoria/solicitud/periodos",
        { page: 1, start: 0, limit: 25 }
      );
      const firstPeriod = periodosRes.data?.[0]?.pernombre?.trim() ?? "";
      const match = firstPeriod.match(/^(\d{4})-(\d+)/);
      const lectivo = match ? match[1] : String(new Date().getFullYear());
      const nummat = match ? match[2] : "1";

      const horRes = await client.postJson<{ data?: RawHorarioItem[]; success?: boolean }>(
        "/tutoria/horario/lsthorestasig",
        { lectivo, nummat, page: 1, start: 0, limit: 100 }
      );

      const slots: ScheduleSlot[] = (horRes.data ?? []).map((item) => {
        const dayNum = Number(item.dia);
        return {
          dayNumber: dayNum,
          dayName: DAY_NAMES[dayNum] ?? `Día ${dayNum}`,
          startTime: item.hini,
          endTime: item.hfin,
          subject: item.asignatura.trim(),
          activityType: item.tactividad,
          place: cleanPlace(item.lugar),
        };
      });

      slots.sort((a, b) => a.dayNumber - b.dayNumber || a.startTime.localeCompare(b.startTime));
      return { period: firstPeriod || `${lectivo}-${nummat}`, slots };
    }
  );

  let filtered = data.slots;
  if (!includeTutorias) {
    filtered = filtered.filter((s) => s.activityType !== "htutorias");
  }

  if (params.day) {
    const q = normalizeText(params.day);
    let targetDayNum: number | null = null;
    if (q === "hoy" || q === "today") {
      const jsDay = new Date().getDay(); // 0=Dom..6=Sab
      targetDayNum = jsDay === 0 ? 7 : jsDay;
    } else if (q === "manana" || q === "tomorrow") {
      const jsDay = (new Date().getDay() + 1) % 7;
      targetDayNum = jsDay === 0 ? 7 : jsDay;
    } else {
      for (const [num, name] of Object.entries(DAY_NAMES)) {
        if (normalizeText(name).startsWith(q)) {
          targetDayNum = Number(num);
          break;
        }
      }
    }
    if (targetDayNum !== null) {
      filtered = filtered.filter((s) => s.dayNumber === targetDayNum);
    }
  }

  return {
    period: data.period,
    fromCache,
    cachedAt,
    totalSlots: filtered.length,
    schedule: filtered,
  };
}

// ---------- 3. siutmach_get_attendance ----------

export interface AttendanceRecord {
  subject: string;
  teacher: string;
  level: string;
  course: string;
  period: string;
  modality: string;
  totalCourseHours: number;
  attendedHours: number;
  absentHours: number;
  recordedHours: number;
  maxAbsentPercent: number;
  maxAbsentHoursAllowed: number;
  remainingAbsentHours: number;
  attendancePercent: number;
  absentPercent: number;
  pendingPercent: number;
  alertLevel: "ok" | "warning" | "critical";
}

export async function getSiutmachAttendance(params: {
  onlyCurrentPeriod?: boolean;
  refresh?: boolean;
}) {
  const client = SiutmachClient.fromSavedSession();
  const onlyCurrentPeriod = params.onlyCurrentPeriod ?? true;

  const { data, fromCache, cachedAt } = await withCache(
    "siutmach_attendance",
    CACHE_TTL_MS.siutmachAttendance,
    Boolean(params.refresh),
    async () => {
      const carrerasRes = await client.postJson<{ carreras?: RawCarrera[]; success?: boolean }>(
        "/academico/syllabus/obtenercarreraxestudiante",
        { page: 1, start: 0, limit: 25 }
      );
      const carreras = carrerasRes.carreras ?? [];
      if (carreras.length === 0) {
        return { career: null, records: [] as AttendanceRecord[] };
      }

      const primary = carreras[0];
      const asisRes = await client.postJson<{ asistencia?: RawAsistenciaItem[] }>(
        "/academico/asistencia/obtenerasistenciaestxcarrera",
        { ccodigo: primary.rcodigo, page: 1, start: 0, limit: 50 }
      );

      const records: AttendanceRecord[] = (asisRes.asistencia ?? []).map((a) => {
        const maxPct = Number.parseFloat(a.ppmaxfaltas) || 15;
        const maxAbsentHours = Math.floor((a.horas * maxPct) / 100);
        const remaining = Math.max(0, maxAbsentHours - a.faltas);
        const absentPct = Number((Number.parseFloat(a.pfaltas) * 100).toFixed(2));
        const attendancePct = Number((Number.parseFloat(a.pasistencia) * 100).toFixed(2));
        const pendingPct = Number((Number.parseFloat(a.ppendiente) * 100).toFixed(2));

        let alertLevel: "ok" | "warning" | "critical" = "ok";
        if (absentPct >= maxPct * 0.8 || remaining <= 2) {
          alertLevel = "critical";
        } else if (absentPct >= maxPct * 0.5 || remaining <= 4) {
          alertLevel = "warning";
        }

        return {
          subject: a.asignatura.trim(),
          teacher: a.docente.trim(),
          level: a.nivel.trim(),
          course: a.curso.trim(),
          period: a.plectivo.trim(),
          modality: a.modalidad.trim(),
          totalCourseHours: a.horas,
          attendedHours: a.asistencia,
          absentHours: a.faltas,
          recordedHours: a.total,
          maxAbsentPercent: maxPct,
          maxAbsentHoursAllowed: maxAbsentHours,
          remainingAbsentHours: remaining,
          attendancePercent: attendancePct,
          absentPercent: absentPct,
          pendingPercent: pendingPct,
          alertLevel,
        };
      });

      return { career: primary.carrera, records };
    }
  );

  let records = data.records;
  let currentPeriod: string | null = null;
  if (onlyCurrentPeriod && records.length > 0) {
    // El primer registro que devuelve SIUTMACH corresponde al periodo más reciente
    currentPeriod = records[0].period;
    records = records.filter((r) => r.period === currentPeriod);
  }

  return {
    career: data.career,
    periodFilter: onlyCurrentPeriod ? currentPeriod : "all",
    fromCache,
    cachedAt,
    totalSubjects: records.length,
    records,
  };
}

// ---------- 4. siutmach_get_grades ----------

export interface CurrentGradeComponent {
  code: string;
  parameter: string;
  maxScore: string;
  parcial1: string | null;
  parcial2: string | null;
}

export interface CurrentSubjectGrade {
  period: string;
  parallel: string;
  subject: string;
  teacher?: string;
  credits: string;
  hours: string;
  attempt: string;
  parcial1Status?: string;
  parcial2Status?: string;
  parcial1Process70?: string | null;
  parcial1Exam?: string | null;
  parcial1Final?: string | null;
  parcial2Process70?: string | null;
  parcial2Exam?: string | null;
  parcial2Final?: string | null;
  components?: CurrentGradeComponent[];
}

export interface HistorySubjectGrade {
  level: string;
  period: string;
  parallel: string;
  subject: string;
  finalGrade: string;
  absences: string;
  status: string;
  credits: string;
  hours: string;
  attempt: string;
}

export function parseDetailHtml(html: string): Partial<CurrentSubjectGrade> {
  const clean = html.replace(/data:image\/[^"']+/g, "");

  // Docente (celda junto a la imagen del docente)
  const teacherMatch = clean.match(/class="contenedor_img_small"[\s\S]*?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const teacher = teacherMatch ? stripHtml(teacherMatch[1]) : undefined;

  // Estados de parcial en encabezados
  const p1StatusMatch = clean.match(/PARCIAL\s*1[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/i);
  const p2StatusMatch = clean.match(/PARCIAL\s*2[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/i);

  const tableMatch = clean.match(/<table[^>]*id=['"]tablaparametros['"][\s\S]*?<\/table>/i);
  if (!tableMatch) {
    return { teacher };
  }

  const tableHtml = tableMatch[0];
  // SIUTMACH omite algunos <tr> de apertura en filas de componentes, así que separamos por </tr>
  const rawRows = tableHtml.split(/<\/tr>/i).slice(1); // omitir header

  const components: CurrentGradeComponent[] = [];
  let parcial1Process70: string | null = null;
  let parcial1Exam: string | null = null;
  let parcial1Final: string | null = null;
  let parcial2Process70: string | null = null;
  let parcial2Exam: string | null = null;
  let parcial2Final: string | null = null;

  for (const row of rawRows) {
    const cells = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => stripHtml(m[1]));
    if (cells.length === 0) continue;

    if (cells.length === 6) {
      components.push({
        code: cells[1].replace(/:$/, ""),
        parameter: cells[2],
        maxScore: cells[3],
        parcial1: cells[4] || null,
        parcial2: cells[5] || null,
      });
    } else if (cells.length === 3) {
      const label = normalizeText(cells[0]);
      const v1 = cells[1] || null;
      const v2 = cells[2] || null;
      if (label.includes("suma parcial")) {
        parcial1Process70 = v1;
        parcial2Process70 = v2;
      } else if (label.includes("examen final")) {
        parcial1Exam = v1;
        parcial2Exam = v2;
      } else if (label.includes("nota final")) {
        parcial1Final = v1;
        parcial2Final = v2;
      }
    }
  }

  return {
    teacher,
    parcial1Status: p1StatusMatch ? stripHtml(p1StatusMatch[1]) : undefined,
    parcial2Status: p2StatusMatch ? stripHtml(p2StatusMatch[1]) : undefined,
    parcial1Process70,
    parcial1Exam,
    parcial1Final,
    parcial2Process70,
    parcial2Exam,
    parcial2Final,
    components,
  };
}

export function parseAnticiparList(html: string): Array<CurrentSubjectGrade & { detailParams?: { distributivo: string; carcodigo: string; matcodigo: string } }> {
  const results: Array<CurrentSubjectGrade & { detailParams?: { distributivo: string; carcodigo: string; matcodigo: string } }> = [];
  const tableMatches = html.matchAll(/<table[^>]*class=['"][^'"]*ui-table-media[^'"]*['"][\s\S]*?<\/table>/gi);

  for (const tm of tableMatches) {
    const rows = Array.from(tm[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
    for (const r of rows) {
      if (r[1].includes("<th")) continue;
      const cells = Array.from(r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => m[1]);
      if (cells.length < 6) continue;

      const hiddenName = cells[0].match(/value=['"]([^'"]+)['"]/i)?.[1];
      const detailCall = cells[2].match(/verDetalles\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);

      results.push({
        period: stripHtml(cells[0]),
        parallel: stripHtml(cells[1]),
        subject: (hiddenName || stripHtml(cells[2]).replace(/Ver Detalles/i, "")).trim(),
        credits: stripHtml(cells[3]),
        hours: stripHtml(cells[4]),
        attempt: stripHtml(cells[5]),
        detailParams: detailCall
          ? { distributivo: detailCall[1], carcodigo: detailCall[2], matcodigo: detailCall[3] }
          : undefined,
      });
    }
  }
  return results;
}

export function parseHistoryHtml(html: string): {
  progress: {
    subjectsCompleted?: number;
    subjectsTotal?: number;
    creditsCompleted?: number;
    creditsTotal?: number;
    hoursCompleted?: number;
    hoursTotal?: number;
  };
  records: HistorySubjectGrade[];
} {
  const progSubjects = html.match(/progresomalla\/malla\/(\d+)\/est\/(\d+)\/o\/M\/t\/A/i);
  const progCredits = html.match(/progresomalla\/malla\/(\d+)\/est\/(\d+)\/o\/M\/t\/C/i);
  const progHours = html.match(/progresomalla\/malla\/(\d+)\/est\/(\d+)\/o\/M\/t\/H/i);

  const progress = {
    subjectsCompleted: progSubjects ? Number(progSubjects[2]) : undefined,
    subjectsTotal: progSubjects ? Number(progSubjects[1]) : undefined,
    creditsCompleted: progCredits ? Number(progCredits[2]) : undefined,
    creditsTotal: progCredits ? Number(progCredits[1]) : undefined,
    hoursCompleted: progHours ? Number(progHours[2]) : undefined,
    hoursTotal: progHours ? Number(progHours[1]) : undefined,
  };

  const records: HistorySubjectGrade[] = [];
  // Cada nivel tiene un <h2>NIVEL</h2> seguido de una tabla ui-table-media
  const blockRe = /<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<table[^>]*class=['"][^'"]*ui-table-media[^'"]*['"][\s\S]*?<\/table>/gi;
  for (const bm of html.matchAll(blockRe)) {
    const level = stripHtml(bm[1]);
    const rows = Array.from(bm[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
    for (const r of rows) {
      if (r[1].includes("<th")) continue;
      const cells = Array.from(r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => m[1]);
      if (cells.length < 9) continue;

      const hiddenName = cells[0].match(/value=['"]([^'"]+)['"]/i)?.[1];
      records.push({
        level,
        period: stripHtml(cells[0]),
        parallel: stripHtml(cells[1]),
        subject: (hiddenName || stripHtml(cells[2]).replace(/Ver Detalles/i, "")).trim(),
        finalGrade: stripHtml(cells[3]),
        absences: stripHtml(cells[4]),
        status: stripHtml(cells[5]),
        credits: stripHtml(cells[6]),
        hours: stripHtml(cells[7]),
        attempt: stripHtml(cells[8]),
      });
    }
  }

  return { progress, records };
}

export async function getSiutmachGrades(params: {
  scope?: "current" | "history" | "all";
  includeDetail?: boolean;
  refresh?: boolean;
}) {
  const client = SiutmachClient.fromSavedSession();
  const scope = params.scope ?? "current";
  const includeDetail = params.includeDetail ?? true;
  const user = await fetchUserSession(client);
  const cedula = user.usersignin;

  let current: { fromCache: boolean; cachedAt: string; subjects: CurrentSubjectGrade[] } | undefined;
  let history:
    | {
        fromCache: boolean;
        cachedAt: string;
        progress: ReturnType<typeof parseHistoryHtml>["progress"];
        records: HistorySubjectGrade[];
      }
    | undefined;

  if (scope === "current" || scope === "all") {
    const res = await withCache(
      `siutmach_grades_current_${cedula}_${includeDetail}`,
      CACHE_TTL_MS.siutmachCurrentGrades,
      Boolean(params.refresh),
      async () => {
        const html = await client.postHtml("/notas/notacursoregular/vernotaanticipar", {
          xumid: 1,
          cedula,
          carrera: 0,
        });
        const list = parseAnticiparList(html);
        const enriched: CurrentSubjectGrade[] = [];
        for (const item of list) {
          const { detailParams, ...base } = item;
          if (includeDetail && detailParams) {
            try {
              const detHtml = await client.postHtml(
                "/notas/notacursoregular/verdetalleanticiparnota",
                detailParams
              );
              enriched.push({ ...base, ...parseDetailHtml(detHtml) });
            } catch {
              enriched.push(base);
            }
          } else {
            enriched.push(base);
          }
        }
        return enriched;
      }
    );
    current = { fromCache: res.fromCache, cachedAt: res.cachedAt, subjects: res.data };
  }

  if (scope === "history" || scope === "all") {
    const res = await withCache(
      `siutmach_grades_history_${cedula}`,
      CACHE_TTL_MS.siutmachHistory,
      Boolean(params.refresh),
      async () => {
        const html = await client.postHtml("/notas/notacursoregular/vercalificacionescr", {
          xumid: 1,
          cedula,
          carrera: 0,
        });
        return parseHistoryHtml(html);
      }
    );
    history = {
      fromCache: res.fromCache,
      cachedAt: res.cachedAt,
      progress: res.data.progress,
      records: res.data.records,
    };
  }

  return {
    student: { name: user.name, cedula },
    scope,
    current,
    history,
  };
}
