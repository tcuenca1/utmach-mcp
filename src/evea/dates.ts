const MONTHS_ES: Record<string, number> = {
  enero: 0, ene: 0,
  febrero: 1, feb: 1,
  marzo: 2, mar: 2,
  abril: 3, abr: 3,
  mayo: 4, may: 4,
  junio: 5, jun: 5,
  julio: 6, jul: 6,
  agosto: 7, ago: 7,
  septiembre: 8, sep: 8, setiembre: 8, set: 8,
  octubre: 9, oct: 9,
  noviembre: 10, nov: 10,
  diciembre: 11, dic: 11,
};

export interface DateConflictInfo {
  hasConflict: boolean;
  moodleDueDate: string | null;
  mentionedDates: string[];
  note?: string;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Extrae fechas escritas en español o formato DD/MM/YYYY dentro del texto de una consigna
 * y las compara contra la fecha oficial de entrega configurada en Moodle.
 */
export function detectDateConflict(text: string, moodleDueEpochSec?: number): DateConflictInfo {
  const moodleDate = moodleDueEpochSec && moodleDueEpochSec > 0 ? new Date(moodleDueEpochSec * 1000) : null;
  const refYear = moodleDate ? moodleDate.getFullYear() : new Date().getFullYear();

  const found: Date[] = [];

  // Patrón 1: DD/MM/YYYY o DD-MM-YYYY
  const numericRe = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g;
  for (const m of text.matchAll(numericRe)) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    let year = m[3] ? Number(m[3]) : refYear;
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 0 && month <= 11 && year >= 2020 && year <= 2035) {
      found.push(new Date(year, month, day));
    }
  }

  // Patrón 2: "15 de noviembre" o "15 de noviembre de 2026"
  const esRe = /\b(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+(?:de|del)\s+(\d{4}))?\b/gi;
  for (const m of text.matchAll(esRe)) {
    const day = Number(m[1]);
    const monthKey = m[2].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const month = MONTHS_ES[monthKey];
    const year = m[3] ? Number(m[3]) : refYear;
    if (month !== undefined && day >= 1 && day <= 31) {
      found.push(new Date(year, month, day));
    }
  }

  const uniqueIso = Array.from(
    new Set(found.map((d) => d.toISOString().slice(0, 10)))
  );

  if (uniqueIso.length === 0) {
    return {
      hasConflict: false,
      moodleDueDate: moodleDate ? moodleDate.toISOString() : null,
      mentionedDates: [],
    };
  }

  if (!moodleDate) {
    return {
      hasConflict: true,
      moodleDueDate: null,
      mentionedDates: uniqueIso,
      note: "La tarea no tiene fecha límite configurada en Moodle, pero la consigna menciona fechas.",
    };
  }

  const matchesMoodleDay = found.some((d) => sameCalendarDay(d, moodleDate));
  if (!matchesMoodleDay) {
    return {
      hasConflict: true,
      moodleDueDate: moodleDate.toISOString(),
      mentionedDates: uniqueIso,
      note: `La consigna menciona ${uniqueIso.join(", ")}, que difiere del límite en Moodle (${moodleDate.toISOString().slice(0, 10)}).`,
    };
  }

  return {
    hasConflict: false,
    moodleDueDate: moodleDate.toISOString(),
    mentionedDates: uniqueIso,
  };
}
