import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectDateConflict } from "../dist/evea/dates.js";
import {
  parseAnticiparList,
  parseDetailHtml,
  parseHistoryHtml,
} from "../dist/siutmach/service.js";
import {
  normalizeSubjectName,
  parseNumericGrade,
} from "../dist/combined/service.js";
import { resolveSite, listAllSites } from "../dist/config/sites.js";

describe("EVEA date conflict detector", () => {
  it("detecta conflicto cuando la consigna menciona otra fecha", () => {
    const dueEpoch = Math.floor(new Date("2026-11-20T23:59:00Z").getTime() / 1000);
    const res = detectDateConflict(
      "Entregar el informe máximo el 18 de noviembre de 2026.",
      dueEpoch
    );
    assert.equal(res.hasConflict, true);
    assert.deepEqual(res.mentionedDates, ["2026-11-18"]);
    assert.ok(res.note?.includes("2026-11-18"));
  });

  it("no reporta conflicto cuando la fecha coincide con Moodle", () => {
    const dueEpoch = Math.floor(new Date(2026, 10, 20, 23, 59, 0).getTime() / 1000);
    const res = detectDateConflict("Fecha límite: 20/11/2026 antes de medianoche.", dueEpoch);
    assert.equal(res.hasConflict, false);
    assert.deepEqual(res.mentionedDates, ["2026-11-20"]);
  });

  it("detecta conflicto cuando Moodle no tiene fecha límite pero la consigna sí", () => {
    const res = detectDateConflict("Subir el documento el 10 de diciembre de 2026.", 0);
    assert.equal(res.hasConflict, true);
    assert.equal(res.moodleDueDate, null);
    assert.deepEqual(res.mentionedDates, ["2026-12-10"]);
  });
});

describe("SIUTMACH HTML parsers", () => {
  it("parsea lista de materias en curso (vernotaanticipar)", () => {
    const html = `
      <table class='ui-table ui-table-media' id='txttabla_1'>
        <tr><th>Periodo</th><th>Paralelo</th><th>Asignatura</th><th>Cred.</th><th>Hora</th><th>F.Obt.</th></tr>
        <tr>
          <td>SEP/26-ENE/27<input id='nombreasignatura_1' type='hidden' value='MATERIA DE PRUEBA I'/></td>
          <td>A DIU.</td>
          <td>MATERIA DE PRUEBA I <a onclick='verDetalles(1001,2002,3003,1)' class='verdetalle'>Ver Detalles</a></td>
          <td>0 / 3</td>
          <td>0 / 144</td>
          <td>1era</td>
        </tr>
      </table>
    `;
    const list = parseAnticiparList(html);
    assert.equal(list.length, 1);
    assert.equal(list[0].subject, "MATERIA DE PRUEBA I");
    assert.equal(list[0].period, "SEP/26-ENE/27");
    assert.deepEqual(list[0].detailParams, {
      distributivo: "1001",
      carcodigo: "2002",
      matcodigo: "3003",
    });
  });

  it("parsea detalle de parciales y componentes (verdetalleanticiparnota)", () => {
    const html = `
      <table><tr><td class="contenedor_img_small"><img src="data:image/jpeg;base64,AAA"></td><td>ING. DOCENTE DEMO</td></tr></table>
      <table class='ui-table' id='tablaparametros'>
        <tr>
          <th>PARCIAL</th><th>ID</th><th>Parámetro</th><th>Máx</th>
          <th>PARCIAL 1<div>ENTREGADO</div></th>
          <th>PARCIAL 2<div>PENDIENTE</div></th>
        </tr>
        <td>1, 2</td><td>N3:</td><td>Proyecto práctico</td><td>2</td><td>1.80</td><td>&nbsp;</td></tr>
        <td>1, 2</td><td>N6:</td><td>Evaluación sistemática</td><td>2</td><td>1.70</td><td>&nbsp;</td></tr>
        <tr><td colspan='4'><b>SUMA PARCIAL 70%</b></td><td><b>6.00</b></td><td>&nbsp;</td></tr>
        <tr><td colspan='4'><b>EXAMEN FINAL</b></td><td>2.90</td><td>&nbsp;</td></tr>
        <tr><td colspan='4'><b>NOTA FINAL</b></td><td><b>8.90</b></td><td>&nbsp;</td></tr>
      </table>
    `;
    const det = parseDetailHtml(html);
    assert.equal(det.teacher, "ING. DOCENTE DEMO");
    assert.equal(det.parcial1Status, "ENTREGADO");
    assert.equal(det.parcial2Status, "PENDIENTE");
    assert.equal(det.parcial1Process70, "6.00");
    assert.equal(det.parcial1Exam, "2.90");
    assert.equal(det.parcial1Final, "8.90");
    assert.equal(det.parcial2Final, null);
    assert.equal(det.components?.length, 2);
    assert.equal(det.components?.[0].code, "N3");
  });

  it("parsea progreso de malla e historial (vercalificacionescr)", () => {
    const html = `
      <img src="/siutmach/public/notas/curriculumacademico/progresomalla/malla/50/est/20/o/M/t/A/s/DIURNA">
      <img src="/siutmach/public/notas/curriculumacademico/progresomalla/malla/150/est/60/o/M/t/C/s/DIURNA">
      <img src="/siutmach/public/notas/curriculumacademico/progresomalla/malla/7200/est/2880/o/M/t/H/s/DIURNA">
      <h2>PRIMER</h2>
      <table class='ui-table ui-table-media'>
        <tr><th>Periodo</th><th>Par</th><th>Asig</th><th>Nota</th><th>Faltas</th><th>Est</th><th>Cred</th><th>Hora</th><th>F.Obt</th></tr>
        <tr>
          <td>ABR/24-AGO/24<input type='hidden' value='ALGORITMOS'/></td>
          <td>A DIU.</td>
          <td>ALGORITMOS</td>
          <td>9.25</td>
          <td>0.00</td>
          <td>APROBADA</td>
          <td>3 / 3</td>
          <td>144 / 144</td>
          <td>1era</td>
        </tr>
      </table>
    `;
    const parsed = parseHistoryHtml(html);
    assert.equal(parsed.progress.subjectsCompleted, 20);
    assert.equal(parsed.progress.subjectsTotal, 50);
    assert.equal(parsed.progress.creditsCompleted, 60);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].level, "PRIMER");
    assert.equal(parsed.records[0].subject, "ALGORITMOS");
    assert.equal(parsed.records[0].finalGrade, "9.25");
  });
});

describe("Combined helpers & sites config", () => {
  it("normaliza nombres de asignaturas entre EVEA y SIUTMACH", () => {
    const evea = normalizeSubjectName("INGENIERÍA DE SOFTWARE II - SEXTO A DIURNA - DOCENTE DEMO");
    const siu = normalizeSubjectName("[ 6A - MATU. ] INGENIERÍA DE SOFTWARE II");
    assert.equal(evea, "ingenieria de software ii");
    assert.equal(siu, "ingenieria de software ii");
  });

  it("parsea notas con coma y punto decimal", () => {
    assert.equal(parseNumericGrade("7,53"), 7.53);
    assert.equal(parseNumericGrade("9.02"), 9.02);
    assert.equal(parseNumericGrade("-"), null);
    assert.equal(parseNumericGrade(null), null);
  });

  it("resuelve los 5 presets de instancias EVEA UTMACH", () => {
    const all = listAllSites();
    const aliases = all.map((s) => s.alias);
    for (const expected of ["presencial", "cec", "enlinea", "ir", "nivelacion"]) {
      assert.ok(aliases.includes(expected), `Falta preset ${expected}`);
    }
    assert.equal(
      resolveSite("presencial").baseUrl,
      "https://moodle.utmachala.edu.ec/cursosvirtuales"
    );
    assert.equal(resolveSite("cec").baseUrl, "https://eveacec.utmachala.edu.ec/main");
  });
});

describe("Disk cache with TTL", () => {
  it("almacena, lee desde caché y respeta refresh=true en directorio aislado", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "utmach-mcp-test-"));
    const prevEnv = process.env.UTMACH_DATA_DIR;
    process.env.UTMACH_DATA_DIR = tmpDir;
    try {
      const { withCache, clearCache } = await import("../dist/storage/cache.js");
      let calls = 0;
      const first = await withCache("unit_test_key", 60_000, false, async () => {
        calls++;
        return { ok: true, n: calls };
      });
      assert.equal(first.fromCache, false);
      assert.equal(first.data.n, 1);

      const second = await withCache("unit_test_key", 60_000, false, async () => {
        calls++;
        return { ok: true, n: calls };
      });
      assert.equal(second.fromCache, true);
      assert.equal(second.data.n, 1);

      const third = await withCache("unit_test_key", 60_000, true, async () => {
        calls++;
        return { ok: true, n: calls };
      });
      assert.equal(third.fromCache, false);
      assert.equal(third.data.n, 2);

      const cleared = clearCache();
      assert.ok(cleared.deletedFiles >= 1);
    } finally {
      if (prevEnv === undefined) delete process.env.UTMACH_DATA_DIR;
      else process.env.UTMACH_DATA_DIR = prevEnv;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
