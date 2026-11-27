import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import TurndownService from "turndown";
import { listAllSites, resolveSite } from "../config/sites.js";
import { CACHE_TTL_MS, withCache } from "../storage/cache.js";
import { getFilesDir, getSnapshotsDir } from "../storage/paths.js";
import { loadSession, saveSession, type EveaSession } from "../storage/session.js";
import { MoodleClient } from "./client.js";
import { detectDateConflict, type DateConflictInfo } from "./dates.js";
import { parseLocalDocument, type ParsedDocument } from "./documents.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function htmlToMarkdown(html?: string | null): string {
  if (!html || !html.trim()) return "";
  const trimmed = html.trim();
  // Si no contiene etiquetas HTML, devolver texto plano sin escapar guiones
  if (!/<[a-z][\s\S]*>/i.test(trimmed)) {
    return trimmed;
  }
  try {
    return turndown.turndown(trimmed).trim();
  } catch {
    return trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function epochToIso(epoch?: number | null): string | null {
  if (!epoch || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString();
}

function getAuthenticatedClient(siteAlias?: string): { client: MoodleClient; session: EveaSession } {
  const site = resolveSite(siteAlias);
  const session = loadSession(site.alias);
  if (!session) {
    throw new Error(
      `No hay sesión guardada para "${site.alias}" (${site.label}). Ejecuta en tu terminal: utmach login --site ${site.alias}`
    );
  }
  return { client: new MoodleClient(session), session };
}

async function ensureUserId(client: MoodleClient, session: EveaSession): Promise<number> {
  if (session.userId) return session.userId;
  const info = await client.getSiteInfo();
  session.userId = info.userid;
  session.username = info.username;
  session.fullName = info.fullname;
  session.siteName = info.sitename;
  session.updatedAt = new Date().toISOString();
  saveSession(session);
  return info.userid;
}

// ---------- Tipos de respuestas Moodle ----------

interface RawCourse {
  id: number;
  shortname: string;
  fullname: string;
  displayname?: string;
  startdate?: number;
  enddate?: number;
  progress?: number | null;
  completed?: boolean;
  isfavourite?: boolean;
  hidden?: boolean;
  category?: number;
}

interface RawAssignFile {
  filename: string;
  filepath?: string;
  filesize?: number;
  fileurl: string;
  mimetype?: string;
  timemodified?: number;
}

interface RawAssignment {
  id: number;
  cmid: number;
  course: number;
  name: string;
  intro?: string;
  duedate?: number;
  allowsubmissionsfromdate?: number;
  cutoffdate?: number;
  grade?: number;
  timemodified?: number;
  introattachments?: RawAssignFile[];
}

interface RawAssignCoursesResponse {
  courses: Array<{
    id: number;
    fullname: string;
    shortname: string;
    assignments: RawAssignment[];
  }>;
}

interface RawSubmissionStatus {
  lastattempt?: {
    submission?: {
      status?: string;
      timemodified?: number;
      plugins?: Array<{
        type: string;
        fileareas?: Array<{
          area: string;
          files?: RawAssignFile[];
        }>;
      }>;
    };
    gradingstatus?: string;
    submissionsenabled?: boolean;
    locked?: boolean;
  };
  feedback?: {
    gradefordisplay?: string;
    gradeddate?: number;
    plugins?: Array<{
      type: string;
      editorfields?: Array<{ text?: string }>;
    }>;
  };
}

interface RawCourseSection {
  id: number;
  name: string;
  section?: number;
  summary?: string;
  modules: Array<{
    id: number;
    name: string;
    modname: string;
    url?: string;
    description?: string;
    contents?: Array<{
      type: string;
      filename: string;
      fileurl: string;
      filesize?: number;
      mimetype?: string;
      timemodified?: number;
    }>;
  }>;
}

interface RawGradeItem {
  id: number;
  itemname?: string | null;
  itemtype?: string;
  itemmodule?: string | null;
  cmid?: number;
  graderaw?: number | null;
  gradeformatted?: string;
  grademin?: number;
  grademax?: number;
  percentageformatted?: string;
  feedback?: string;
  weightformatted?: string;
}

// ---------- 1. evea_status ----------

export async function getEveaStatus(siteAlias?: string) {
  const site = resolveSite(siteAlias);
  const session = loadSession(site.alias);
  const allSites = listAllSites().map((s) => ({
    alias: s.alias,
    label: s.label,
    baseUrl: s.baseUrl,
    hasSession: Boolean(loadSession(s.alias)),
  }));

  if (!session) {
    return {
      authenticated: false as const,
      site,
      message: `No hay sesión activa para "${site.alias}". Ejecuta: utmach login --site ${site.alias}`,
      availableSites: allSites,
    };
  }

  try {
    const client = new MoodleClient(session);
    const info = await client.getSiteInfo();
    return {
      authenticated: true as const,
      site,
      user: {
        id: info.userid,
        username: info.username,
        fullName: info.fullname,
      },
      moodleRelease: info.release,
      siteName: info.sitename,
      sessionUpdatedAt: session.updatedAt,
      availableSites: allSites,
    };
  } catch (err) {
    return {
      authenticated: false as const,
      site,
      error: err instanceof Error ? err.message : String(err),
      availableSites: allSites,
    };
  }
}

// ---------- 2. evea_list_courses ----------

export async function listEveaCourses(params: {
  site?: string;
  classification?: "inprogress" | "past" | "future" | "all";
  refresh?: boolean;
}) {
  const { client, session } = getAuthenticatedClient(params.site);
  const userId = await ensureUserId(client, session);
  const classification = params.classification ?? "inprogress";

  const { data: rawCourses, fromCache, cachedAt } = await withCache<RawCourse[]>(
    `courses_${session.siteAlias}_${userId}`,
    CACHE_TTL_MS.courses,
    Boolean(params.refresh),
    () => client.call<RawCourse[]>("core_enrol_get_users_courses", { userid: userId })
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const mapped = rawCourses.map((c) => {
    let status: "inprogress" | "past" | "future" = "inprogress";
    if (c.enddate && c.enddate > 0 && c.enddate < nowSec) {
      status = "past";
    } else if (c.startdate && c.startdate > nowSec) {
      status = "future";
    }
    return {
      id: c.id,
      shortName: c.shortname,
      fullName: c.displayname || c.fullname,
      status,
      startDate: epochToIso(c.startdate),
      endDate: epochToIso(c.enddate),
      progress: c.progress ?? null,
      favourite: Boolean(c.isfavourite),
      url: `${session.baseUrl}/course/view.php?id=${c.id}`,
    };
  });

  const filtered =
    classification === "all"
      ? mapped
      : mapped.filter((c) => c.status === classification);

  return {
    site: session.siteAlias,
    classification,
    totalCourses: filtered.length,
    fromCache,
    cachedAt,
    courses: filtered,
  };
}

// ---------- 3. evea_list_tasks ----------

export interface EveaTaskSummary {
  assignId: number;
  cmid: number;
  courseId: number;
  courseName: string;
  name: string;
  dueDate: string | null;
  cutoffDate: string | null;
  submissionStatus: string;
  gradingStatus: string;
  isHiddenFromTimeline: boolean;
  isOverdue: boolean;
  dateConflict: DateConflictInfo;
  url: string;
}

export async function listEveaTasks(params: {
  site?: string;
  courseId?: number;
  includeSubmitted?: boolean;
  onlyHidden?: boolean;
  refresh?: boolean;
}) {
  const { client, session } = getAuthenticatedClient(params.site);
  const includeSubmitted = params.includeSubmitted ?? false;
  const onlyHidden = params.onlyHidden ?? false;

  const coursesRes = await listEveaCourses({
    site: session.siteAlias,
    classification: params.courseId ? "all" : "inprogress",
    refresh: params.refresh,
  });

  const targetCourseIds = params.courseId
    ? [params.courseId]
    : coursesRes.courses.map((c) => c.id);

  if (targetCourseIds.length === 0) {
    return {
      site: session.siteAlias,
      totalTasks: 0,
      pendingCount: 0,
      hiddenCount: 0,
      tasks: [] as EveaTaskSummary[],
    };
  }

  const cacheKey = `tasks_${session.siteAlias}_${targetCourseIds.join("-")}`;
  const { data: allTasks, fromCache, cachedAt } = await withCache<EveaTaskSummary[]>(
    cacheKey,
    CACHE_TTL_MS.tasks,
    Boolean(params.refresh),
    async () => {
      const assignResp = await client.call<RawAssignCoursesResponse>("mod_assign_get_assignments", {
        courseids: targetCourseIds,
      });

      // Obtener eventos del timeline para saber cuáles tareas son "ocultas" (no aparecen en timeline)
      const timelineAssignIds = new Set<number>();
      try {
        const cal = await client.call<{ events?: Array<{ modulename?: string; instance?: number }> }>(
          "core_calendar_get_action_events_by_timesort",
          { limitnum: 50 }
        );
        for (const ev of cal.events ?? []) {
          if (ev.modulename === "assign" && ev.instance) {
            timelineAssignIds.add(ev.instance);
          }
        }
      } catch {
        // Si el endpoint de calendario falla, continuamos igual
      }

      const nowMs = Date.now();
      const tasks: EveaTaskSummary[] = [];

      for (const course of assignResp.courses ?? []) {
        for (const a of course.assignments ?? []) {
          let submissionStatus = "unknown";
          let gradingStatus = "unknown";

          try {
            const st = await client.call<RawSubmissionStatus>("mod_assign_get_submission_status", {
              assignid: a.id,
            });
            submissionStatus = st.lastattempt?.submission?.status ?? "new";
            gradingStatus = st.lastattempt?.gradingstatus ?? "notgraded";
          } catch {
            // Si no se puede leer estado puntual, dejamos unknown
          }

          const dueIso = epochToIso(a.duedate);
          const isOverdue = Boolean(a.duedate && a.duedate > 0 && a.duedate * 1000 < nowMs && submissionStatus !== "submitted");
          const isHiddenFromTimeline = !timelineAssignIds.has(a.id);
          const plainIntro = htmlToMarkdown(a.intro);
          const dateConflict = detectDateConflict(`${a.name}\n${plainIntro}`, a.duedate);

          tasks.push({
            assignId: a.id,
            cmid: a.cmid,
            courseId: course.id,
            courseName: course.fullname,
            name: a.name,
            dueDate: dueIso,
            cutoffDate: epochToIso(a.cutoffdate),
            submissionStatus,
            gradingStatus,
            isHiddenFromTimeline,
            isOverdue,
            dateConflict,
            url: `${session.baseUrl}/mod/assign/view.php?id=${a.cmid}`,
          });
        }
      }

      // Ordenar: 1) pendientes futuras (más urgentes primero), 2) pendientes sin fecha, 3) pendientes vencidas (más recientes primero), 4) entregadas
      const rankTask = (t: EveaTaskSummary): number => {
        if (t.submissionStatus === "submitted") return 3;
        if (t.dueDate && !t.isOverdue) return 0;
        if (!t.dueDate) return 1;
        return 2;
      };
      tasks.sort((a, b) => {
        const ra = rankTask(a);
        const rb = rankTask(b);
        if (ra !== rb) return ra - rb;
        if (ra === 0 && a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (ra === 2 && a.dueDate && b.dueDate) return b.dueDate.localeCompare(a.dueDate);
        return a.name.localeCompare(b.name);
      });

      return tasks;
    }
  );

  let filtered = allTasks;
  if (!includeSubmitted) {
    filtered = filtered.filter((t) => t.submissionStatus !== "submitted");
  }
  if (onlyHidden) {
    filtered = filtered.filter((t) => t.isHiddenFromTimeline);
  }

  return {
    site: session.siteAlias,
    fromCache,
    cachedAt,
    totalTasks: filtered.length,
    pendingCount: allTasks.filter((t) => t.submissionStatus !== "submitted").length,
    hiddenCount: filtered.filter((t) => t.isHiddenFromTimeline).length,
    tasks: filtered,
  };
}

// ---------- 4. evea_get_task_detail ----------

export async function getEveaTaskDetail(params: {
  site?: string;
  assignId?: number;
  cmid?: number;
  courseId?: number;
  refresh?: boolean;
}) {
  if (!params.assignId && !params.cmid) {
    throw new Error("Debes proporcionar assignId o cmid.");
  }

  const { client, session } = getAuthenticatedClient(params.site);
  const coursesRes = await listEveaCourses({
    site: session.siteAlias,
    classification: params.courseId ? "all" : "inprogress",
    refresh: params.refresh,
  });

  const targetIds = params.courseId ? [params.courseId] : coursesRes.courses.map((c) => c.id);
  const cacheKey = `task_detail_${session.siteAlias}_${params.assignId ?? "cm" + params.cmid}`;

  const { data, fromCache, cachedAt } = await withCache(
    cacheKey,
    CACHE_TTL_MS.taskDetail,
    Boolean(params.refresh),
    async () => {
      const assignResp = await client.call<RawAssignCoursesResponse>("mod_assign_get_assignments", {
        courseids: targetIds,
      });

      let foundAssign: RawAssignment | undefined;
      let foundCourseName = "";

      for (const c of assignResp.courses ?? []) {
        for (const a of c.assignments ?? []) {
          if (
            (params.assignId && a.id === params.assignId) ||
            (params.cmid && a.cmid === params.cmid)
          ) {
            foundAssign = a;
            foundCourseName = c.fullname;
            break;
          }
        }
        if (foundAssign) break;
      }

      if (!foundAssign) {
        throw new Error(`No se encontró la tarea (assignId=${params.assignId ?? "-"}, cmid=${params.cmid ?? "-"}).`);
      }

      const status = await client.call<RawSubmissionStatus>("mod_assign_get_submission_status", {
        assignid: foundAssign.id,
      });

      const instructionsMarkdown = htmlToMarkdown(foundAssign.intro);
      const dateConflict = detectDateConflict(`${foundAssign.name}\n${instructionsMarkdown}`, foundAssign.duedate);

      const submittedFiles: Array<{ fileName: string; fileUrl: string; sizeBytes?: number }> = [];
      for (const plugin of status.lastattempt?.submission?.plugins ?? []) {
        for (const area of plugin.fileareas ?? []) {
          for (const f of area.files ?? []) {
            submittedFiles.push({
              fileName: f.filename,
              fileUrl: f.fileurl,
              sizeBytes: f.filesize,
            });
          }
        }
      }

      const feedbackComments = (status.feedback?.plugins ?? [])
        .flatMap((p) => p.editorfields ?? [])
        .map((ef) => htmlToMarkdown(ef.text))
        .filter(Boolean)
        .join("\n\n");

      return {
        assignId: foundAssign.id,
        cmid: foundAssign.cmid,
        courseId: foundAssign.course,
        courseName: foundCourseName,
        name: foundAssign.name,
        url: `${session.baseUrl}/mod/assign/view.php?id=${foundAssign.cmid}`,
        allowSubmissionsFrom: epochToIso(foundAssign.allowsubmissionsfromdate),
        dueDate: epochToIso(foundAssign.duedate),
        cutoffDate: epochToIso(foundAssign.cutoffdate),
        maxGrade: foundAssign.grade ?? null,
        dateConflict,
        instructionsMarkdown,
        attachments: (foundAssign.introattachments ?? []).map((f) => ({
          fileName: f.filename,
          fileUrl: f.fileurl,
          mimeType: f.mimetype,
          sizeBytes: f.filesize,
        })),
        submission: {
          status: status.lastattempt?.submission?.status ?? "new",
          gradingStatus: status.lastattempt?.gradingstatus ?? "notgraded",
          lastModified: epochToIso(status.lastattempt?.submission?.timemodified),
          submittedFiles,
        },
        feedback: {
          grade: status.feedback?.gradefordisplay ? htmlToMarkdown(status.feedback.gradefordisplay) : null,
          gradedDate: epochToIso(status.feedback?.gradeddate),
          comments: feedbackComments || null,
        },
      };
    }
  );

  return { site: session.siteAlias, fromCache, cachedAt, task: data };
}

// ---------- 5. evea_get_grades ----------

export async function getEveaGrades(params: {
  site?: string;
  courseId?: number;
  refresh?: boolean;
}) {
  const { client, session } = getAuthenticatedClient(params.site);
  const userId = await ensureUserId(client, session);

  if (params.courseId) {
    const { data, fromCache, cachedAt } = await withCache(
      `grades_course_${session.siteAlias}_${params.courseId}_${userId}`,
      CACHE_TTL_MS.grades,
      Boolean(params.refresh),
      async () => {
        const res = await client.call<{
          usergrades?: Array<{
            courseid: number;
            userfullname?: string;
            gradeitems?: RawGradeItem[];
          }>;
        }>("gradereport_user_get_grade_items", {
          courseid: params.courseId,
          userid: userId,
        });

        const items = (res.usergrades?.[0]?.gradeitems ?? []).map((gi) => ({
          id: gi.id,
          name: gi.itemname || (gi.itemtype === "course" ? "Total del curso" : "Categoría"),
          type: gi.itemtype ?? "mod",
          module: gi.itemmodule ?? null,
          cmid: gi.cmid ?? null,
          gradeRaw: gi.graderaw ?? null,
          gradeFormatted: gi.gradeformatted ? htmlToMarkdown(gi.gradeformatted) : "-",
          range: `${gi.grademin ?? 0} - ${gi.grademax ?? 100}`,
          percentage: gi.percentageformatted ?? null,
          weight: gi.weightformatted ?? null,
          feedback: gi.feedback ? htmlToMarkdown(gi.feedback) : null,
        }));

        return { courseId: params.courseId, items };
      }
    );

    return { site: session.siteAlias, fromCache, cachedAt, ...data };
  }

  // Resumen global de todos los cursos
  const coursesRes = await listEveaCourses({
    site: session.siteAlias,
    classification: "all",
    refresh: params.refresh,
  });
  const courseMap = new Map(coursesRes.courses.map((c) => [c.id, c]));

  const { data, fromCache, cachedAt } = await withCache(
    `grades_overview_${session.siteAlias}_${userId}`,
    CACHE_TTL_MS.grades,
    Boolean(params.refresh),
    async () => {
      const res = await client.call<{
        grades?: Array<{ courseid: number; grade?: string; rawgrade?: string }>;
      }>("gradereport_overview_get_course_grades", { userid: userId });

      return (res.grades ?? []).map((g) => {
        const c = courseMap.get(g.courseid);
        return {
          courseId: g.courseid,
          courseName: c?.fullName ?? `Curso #${g.courseid}`,
          status: c?.status ?? "unknown",
          grade: g.grade ? htmlToMarkdown(g.grade) : "-",
          rawGrade: g.rawgrade ?? null,
        };
      });
    }
  );

  return { site: session.siteAlias, fromCache, cachedAt, courses: data };
}

// ---------- 6. evea_list_materials ----------

export async function listEveaMaterials(params: {
  site?: string;
  courseId: number;
  sectionQuery?: string;
  refresh?: boolean;
}) {
  const { client, session } = getAuthenticatedClient(params.site);

  const { data: sections, fromCache, cachedAt } = await withCache(
    `materials_${session.siteAlias}_${params.courseId}`,
    CACHE_TTL_MS.materials,
    Boolean(params.refresh),
    async () => {
      const raw = await client.call<RawCourseSection[]>("core_course_get_contents", {
        courseid: params.courseId,
      });

      return raw.map((sec) => ({
        sectionNumber: sec.section ?? sec.id,
        name: sec.name,
        summary: htmlToMarkdown(sec.summary),
        items: (sec.modules ?? [])
          .filter((m) =>
            ["resource", "folder", "url", "page", "book", "assign", "forum", "quiz"].includes(m.modname)
          )
          .map((m) => ({
            cmid: m.id,
            name: m.name,
            type: m.modname,
            url: m.url ?? null,
            description: htmlToMarkdown(m.description),
            files: (m.contents ?? []).map((f) => ({
              fileName: f.filename,
              fileUrl: f.fileurl,
              mimeType: f.mimetype ?? null,
              sizeBytes: f.filesize ?? null,
              modifiedAt: epochToIso(f.timemodified),
            })),
          })),
      }));
    }
  );

  const q = params.sectionQuery?.trim().toLowerCase();
  const filtered = q
    ? sections.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.items.some((i) => i.name.toLowerCase().includes(q))
      )
    : sections;

  return {
    site: session.siteAlias,
    courseId: params.courseId,
    fromCache,
    cachedAt,
    sections: filtered,
  };
}

// ---------- 7. evea_read_material ----------

export async function readEveaMaterial(params: {
  site?: string;
  fileUrl: string;
  fileName?: string;
  startPage?: number;
  endPage?: number;
  maxChars?: number;
  refresh?: boolean;
}): Promise<{ site: string; downloadedFromCache: boolean; document: ParsedDocument }> {
  const { client, session } = getAuthenticatedClient(params.site);

  const urlObj = new URL(params.fileUrl);
  const inferredName = params.fileName || decodeURIComponent(basename(urlObj.pathname)) || "archivo.bin";
  const safeName = inferredName.replace(/[<>:"/\\|?*]/g, "_");
  const hash = createHash("sha256").update(params.fileUrl).digest("hex").slice(0, 12);
  const destPath = join(getFilesDir(), session.siteAlias, `${hash}_${safeName}`);

  let downloadedFromCache = true;
  if (params.refresh || !existsSync(destPath)) {
    await client.downloadFile(params.fileUrl, destPath);
    downloadedFromCache = false;
  }

  const document = await parseLocalDocument(destPath, {
    startPage: params.startPage,
    endPage: params.endPage,
    maxChars: params.maxChars,
  });

  return {
    site: session.siteAlias,
    downloadedFromCache,
    document,
  };
}

// ---------- 8. evea_list_announcements ----------

export async function listEveaAnnouncements(params: {
  site?: string;
  courseId?: number;
  limit?: number;
  includeAllForums?: boolean;
  refresh?: boolean;
}) {
  const { client, session } = getAuthenticatedClient(params.site);
  const limit = params.limit ?? 15;
  const includeAllForums = params.includeAllForums ?? false;

  const coursesRes = await listEveaCourses({
    site: session.siteAlias,
    classification: params.courseId ? "all" : "inprogress",
    refresh: params.refresh,
  });

  const targetIds = params.courseId ? [params.courseId] : coursesRes.courses.map((c) => c.id);
  const courseMap = new Map(coursesRes.courses.map((c) => [c.id, c.fullName]));

  if (targetIds.length === 0) {
    return { site: session.siteAlias, announcements: [] };
  }

  const cacheKey = `announcements_${session.siteAlias}_${targetIds.join("-")}_${includeAllForums}`;
  const { data, fromCache, cachedAt } = await withCache(
    cacheKey,
    CACHE_TTL_MS.announcements,
    Boolean(params.refresh),
    async () => {
      const forums = await client.call<
        Array<{ id: number; course: number; type: string; name: string; cmid: number }>
      >("mod_forum_get_forums_by_courses", { courseids: targetIds });

      const targetForums = includeAllForums
        ? forums
        : forums.filter((f) => f.type === "news");

      const items: Array<{
        discussionId: number;
        courseId: number;
        courseName: string;
        forumName: string;
        subject: string;
        author: string;
        createdAt: string | null;
        modifiedAt: string | null;
        messageMarkdown: string;
      }> = [];

      for (const f of targetForums) {
        try {
          const disc = await client.call<{
            discussions?: Array<{
              discussion: number;
              name: string;
              subject: string;
              message: string;
              userfullname: string;
              created: number;
              timemodified: number;
            }>;
          }>("mod_forum_get_forum_discussions", {
            forumid: f.id,
            perpage: 10,
          });

          for (const d of disc.discussions ?? []) {
            items.push({
              discussionId: d.discussion,
              courseId: f.course,
              courseName: courseMap.get(f.course) ?? `Curso #${f.course}`,
              forumName: f.name,
              subject: d.subject || d.name,
              author: d.userfullname,
              createdAt: epochToIso(d.created),
              modifiedAt: epochToIso(d.timemodified),
              messageMarkdown: htmlToMarkdown(d.message),
            });
          }
        } catch {
          // ignore individual forum permission issues
        }
      }

      items.sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));
      return items;
    }
  );

  return {
    site: session.siteAlias,
    fromCache,
    cachedAt,
    total: data.slice(0, limit).length,
    announcements: data.slice(0, limit),
  };
}

// ---------- 9. evea_check_changes ----------

interface EveaSnapshot {
  capturedAt: string;
  tasks: Record<string, { name: string; courseName: string; dueDate: string | null; submissionStatus: string }>;
  grades: Record<string, { courseName: string; grade: string }>;
  announcements: Record<string, { subject: string; courseName: string; modifiedAt: string | null }>;
}

export async function checkEveaChanges(params: { site?: string; refresh?: boolean }) {
  const { session } = getAuthenticatedClient(params.site);
  const refresh = params.refresh ?? true;

  const [tasksRes, gradesRes, annRes] = await Promise.all([
    listEveaTasks({ site: session.siteAlias, includeSubmitted: true, refresh }),
    getEveaGrades({ site: session.siteAlias, refresh }),
    listEveaAnnouncements({ site: session.siteAlias, limit: 25, refresh }),
  ]);

  const current: EveaSnapshot = {
    capturedAt: new Date().toISOString(),
    tasks: {},
    grades: {},
    announcements: {},
  };

  for (const t of tasksRes.tasks) {
    current.tasks[String(t.assignId)] = {
      name: t.name,
      courseName: t.courseName,
      dueDate: t.dueDate,
      submissionStatus: t.submissionStatus,
    };
  }

  if ("courses" in gradesRes && Array.isArray(gradesRes.courses)) {
    for (const g of gradesRes.courses) {
      current.grades[String(g.courseId)] = {
        courseName: g.courseName,
        grade: g.grade,
      };
    }
  }

  for (const a of annRes.announcements) {
    current.announcements[String(a.discussionId)] = {
      subject: a.subject,
      courseName: a.courseName,
      modifiedAt: a.modifiedAt,
    };
  }

  const snapPath = join(getSnapshotsDir(), `${session.siteAlias}.json`);
  let previous: EveaSnapshot | null = null;
  if (existsSync(snapPath)) {
    try {
      previous = JSON.parse(readFileSync(snapPath, "utf8")) as EveaSnapshot;
    } catch {
      previous = null;
    }
  }

  writeFileSync(snapPath, JSON.stringify(current, null, 2), "utf8");

  if (!previous) {
    return {
      site: session.siteAlias,
      firstRun: true,
      message: "Snapshot inicial guardado. En la próxima ejecución se reportarán tareas, notas o anuncios nuevos/modificados.",
      summary: {
        tasksTracked: Object.keys(current.tasks).length,
        coursesTracked: Object.keys(current.grades).length,
        announcementsTracked: Object.keys(current.announcements).length,
      },
    };
  }

  const newTasks: Array<{ assignId: string; name: string; courseName: string; dueDate: string | null }> = [];
  const changedTaskDates: Array<{ assignId: string; name: string; courseName: string; oldDueDate: string | null; newDueDate: string | null }> = [];

  for (const [id, t] of Object.entries(current.tasks)) {
    const prev = previous.tasks[id];
    if (!prev) {
      newTasks.push({ assignId: id, name: t.name, courseName: t.courseName, dueDate: t.dueDate });
    } else if (prev.dueDate !== t.dueDate) {
      changedTaskDates.push({
        assignId: id,
        name: t.name,
        courseName: t.courseName,
        oldDueDate: prev.dueDate,
        newDueDate: t.dueDate,
      });
    }
  }

  const changedGrades: Array<{ courseId: string; courseName: string; oldGrade: string; newGrade: string }> = [];
  for (const [id, g] of Object.entries(current.grades)) {
    const prev = previous.grades[id];
    if (!prev || prev.grade !== g.grade) {
      changedGrades.push({
        courseId: id,
        courseName: g.courseName,
        oldGrade: prev?.grade ?? "-",
        newGrade: g.grade,
      });
    }
  }

  const newAnnouncements: Array<{ discussionId: string; subject: string; courseName: string; modifiedAt: string | null }> = [];
  for (const [id, a] of Object.entries(current.announcements)) {
    if (!previous.announcements[id]) {
      newAnnouncements.push({
        discussionId: id,
        subject: a.subject,
        courseName: a.courseName,
        modifiedAt: a.modifiedAt,
      });
    }
  }

  const hasChanges =
    newTasks.length > 0 ||
    changedTaskDates.length > 0 ||
    changedGrades.length > 0 ||
    newAnnouncements.length > 0;

  return {
    site: session.siteAlias,
    firstRun: false,
    previousSnapshotAt: previous.capturedAt,
    currentSnapshotAt: current.capturedAt,
    hasChanges,
    newTasks,
    changedTaskDates,
    changedGrades,
    newAnnouncements,
  };
}
