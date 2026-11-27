import { readFileSync } from "node:fs";
import { extname } from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";

const DEFAULT_MAX_CHARS = 30_000;

export interface ParsedDocument {
  format: "pdf" | "docx" | "pptx" | "text" | "unsupported";
  localPath: string;
  totalPages?: number;
  returnedRange?: { start: number; end: number };
  isScannedPdf?: boolean;
  truncated: boolean;
  charCount: number;
  content: string;
  warning?: string;
}

export interface ReadDocOptions {
  startPage?: number;
  endPage?: number;
  maxChars?: number;
}

function decodeXmlEntities(xml: string): string {
  return xml
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n\n[... Contenido truncado a ${maxChars} caracteres. Usa startPage/endPage para leer las siguientes páginas/diapositivas.]`,
    truncated: true,
  };
}

async function parsePdf(filePath: string, opts: ReadDocOptions): Promise<ParsedDocument> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const totalPages = doc.numPages;
  const start = Math.max(1, opts.startPage ?? 1);
  const end = Math.min(totalPages, opts.endPage ?? totalPages);

  const chunks: string[] = [];
  let nonWhitespaceChars = 0;

  for (let p = start; p <= end; p++) {
    const page = await doc.getPage(p);
    const textContent = await page.getTextContent();
    const lines = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    nonWhitespaceChars += lines.replace(/\s/g, "").length;
    chunks.push(`## Página ${p}\n\n${lines}`);

    if (chunks.join("\n\n").length > maxChars + 2000) {
      break;
    }
  }

  await doc.destroy();

  const pagesSampled = Math.max(1, end - start + 1);
  const avgCharsPerPage = nonWhitespaceChars / pagesSampled;
  const isScannedPdf = nonWhitespaceChars < 40 || (totalPages >= 2 && avgCharsPerPage < 25);

  if (isScannedPdf) {
    return {
      format: "pdf",
      localPath: filePath,
      totalPages,
      returnedRange: { start, end },
      isScannedPdf: true,
      truncated: false,
      charCount: nonWhitespaceChars,
      content: chunks.join("\n\n").trim(),
      warning: `Este PDF parece estar escaneado (imágenes sin texto seleccionable). El archivo quedó descargado en: ${filePath}`,
    };
  }

  const combined = chunks.join("\n\n");
  const { text, truncated } = truncateText(combined, maxChars);

  return {
    format: "pdf",
    localPath: filePath,
    totalPages,
    returnedRange: { start, end },
    isScannedPdf: false,
    truncated,
    charCount: text.length,
    content: text,
  };
}

async function parseDocx(filePath: string, opts: ReadDocOptions): Promise<ParsedDocument> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const result = await mammoth.extractRawText({ path: filePath });
  const raw = result.value.trim();
  const { text, truncated } = truncateText(raw, maxChars);

  return {
    format: "docx",
    localPath: filePath,
    truncated,
    charCount: text.length,
    content: text,
  };
}

async function parsePptx(filePath: string, opts: ReadDocOptions): Promise<ParsedDocument> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const zip = await JSZip.loadAsync(readFileSync(filePath));

  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
      return na - nb;
    });

  const totalPages = slideNames.length;
  const start = Math.max(1, opts.startPage ?? 1);
  const end = Math.min(totalPages, opts.endPage ?? totalPages);

  const chunks: string[] = [];
  for (let i = start; i <= end; i++) {
    const file = zip.files[slideNames[i - 1]];
    if (!file) continue;
    const xml = await file.async("string");
    const texts = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
      .map((m) => decodeXmlEntities(m[1]).trim())
      .filter(Boolean);
    chunks.push(`## Diapositiva ${i}\n\n${texts.join("\n")}`);
  }

  const combined = chunks.join("\n\n");
  const { text, truncated } = truncateText(combined, maxChars);

  return {
    format: "pptx",
    localPath: filePath,
    totalPages,
    returnedRange: { start, end },
    truncated,
    charCount: text.length,
    content: text,
  };
}

export async function parseLocalDocument(filePath: string, opts: ReadDocOptions = {}): Promise<ParsedDocument> {
  const ext = extname(filePath).toLowerCase();
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  if (ext === ".pdf") {
    return parsePdf(filePath, opts);
  }
  if (ext === ".docx") {
    return parseDocx(filePath, opts);
  }
  if (ext === ".pptx") {
    return parsePptx(filePath, opts);
  }
  if ([".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".py", ".js", ".ts", ".java", ".c", ".cpp", ".sql"].includes(ext)) {
    const raw = readFileSync(filePath, "utf8");
    const { text, truncated } = truncateText(raw, maxChars);
    return {
      format: "text",
      localPath: filePath,
      truncated,
      charCount: text.length,
      content: text,
    };
  }

  return {
    format: "unsupported",
    localPath: filePath,
    truncated: false,
    charCount: 0,
    content: "",
    warning: `Formato "${ext || "desconocido"}" no soportado para extracción de texto. Archivo guardado en: ${filePath}`,
  };
}
