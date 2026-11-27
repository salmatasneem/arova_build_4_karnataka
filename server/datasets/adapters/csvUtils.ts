import path from "node:path";
import { DatasetValidationError } from "./types.ts";

export const MISSING_TOKENS = new Set([
  "",
  "na",
  "n/a",
  "nan",
  "null",
  "none",
  "--",
  "-",
  "?",
  "inf",
  "-inf",
]);

export function sanitizeFilename(raw: string): string {
  const base = path.basename((raw || "").trim()).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || "uploaded_dataset.csv";
}

export function checkUnsupportedBinaryOrArchive(filename: string, content: string): void {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".edf")) {
    throw new DatasetValidationError(
      `Direct EDF binary files ('${filename}') are not parsed directly in this Node runtime. Export the EDF signals to CSV first using Python MNE (e.g. mne.io.read_raw_edf(...).to_data_frame().to_csv(...)) or PhysioNet EDF tools.`,
      "UNSUPPORTED_EDF_BINARY"
    );
  }
  if (lower.endsWith(".dat") || lower.endsWith(".hea") || lower.endsWith(".atr") || lower.endsWith(".apn")) {
    throw new DatasetValidationError(
      `Direct WFDB binary files ('${filename}') are not parsed directly without a native WFDB reader. Export records to CSV first using PhysioNet LightWAVE ('Export as CSV') or Python wfdb (sig, fields = wfdb.rdsamp(...); pandas.DataFrame(sig, columns=fields['sig_name']).to_csv(...)).`,
      "UNSUPPORTED_WFDB_BINARY"
    );
  }
  if (lower.endsWith(".pkl") || lower.endsWith(".pickle")) {
    throw new DatasetValidationError(
      `Python pickle files ('${filename}') are not parsed in Node for safety and compatibility. Export subject signals to CSV in Python first (e.g. extract wrist/chest channels with numpy/pandas and call df.to_csv(..., index=False)).`,
      "UNSUPPORTED_PKL_BINARY"
    );
  }
  // Detect obvious binary content (NUL bytes or EDF header magic "0       ")
  if (content.includes("\u0000")) {
    throw new DatasetValidationError(
      `File '${filename}' appears to contain binary bytes rather than UTF-8 CSV/TXT text. Convert EDF/WFDB/PKL files to UTF-8 CSV before importing.`,
      "BINARY_CONTENT_DETECTED"
    );
  }
}

export function splitDelimitedLine(line: string, delimiter: string): string[] {
  if (delimiter !== ",") {
    return line.split(delimiter).map((c) => c.trim());
  }
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

export function normalizeHeaderName(name: string): string {
  return name
    .replace(/^\uFEFF/, "")
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseNullableNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/^['"]+|['"]+$/g, "").replace(/;$/, "").trim();
  if (MISSING_TOKENS.has(cleaned.toLowerCase())) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function detectDelimiter(sampleLine: string): string {
  const commas = (sampleLine.match(/,/g) ?? []).length;
  const semis = (sampleLine.match(/;/g) ?? []).length;
  const tabs = (sampleLine.match(/\t/g) ?? []).length;
  if (semis > commas && semis >= tabs) return ";";
  if (tabs > commas && tabs > semis) return "\t";
  return ",";
}

export interface ParsedCsvTable {
  headers: string[];
  rawHeaders: string[];
  rows: string[][];
  delimiter: string;
}

export function parseCsvWithHeaders(content: string, filename: string, commentPrefix?: string): ParsedCsvTable {
  const cleanContent = content.replace(/^\uFEFF/, "");
  const allLines = cleanContent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const rawLine of allLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (commentPrefix && trimmed.startsWith(commentPrefix)) continue;
    if (trimmed.startsWith("#")) continue;
    dataLines.push(trimmed);
  }

  if (dataLines.length < 2) {
    throw new DatasetValidationError(
      `CSV file '${filename}' must contain a header row and at least one data row.`,
      "EMPTY_OR_MISSING_ROWS"
    );
  }

  const delimiter = detectDelimiter(dataLines[0]);
  const rawHeaders = splitDelimitedLine(dataLines[0], delimiter);
  const headers = rawHeaders.map(normalizeHeaderName);
  const rows: string[][] = [];

  for (let i = 1; i < dataLines.length; i++) {
    const line = dataLines[i];
    // Skip PhysioNet LightWAVE unit subheader rows if immediately after header (e.g. "'hh:mm:ss','mV','mV'")
    const cols = splitDelimitedLine(line, delimiter);
    if (
      i === 1 &&
      cols.some((c) => /^'?(\(?sec|s|mv|bpm|%|degc|celsius|hh:mm:ss)\)?'?$/i.test(c.trim()))
    ) {
      continue;
    }
    if (cols.length === 1 && cols[0] === "") continue;
    rows.push(cols);
  }

  if (rows.length === 0) {
    throw new DatasetValidationError(
      `CSV file '${filename}' contains headers (${rawHeaders.join(", ")}) but zero data rows.`,
      "NO_DATA_ROWS"
    );
  }

  return { headers, rawHeaders, rows, delimiter };
}

export function findColumnIndex(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Parses timestamps supporting:
 * - ISO-8601 date strings
 * - Numeric seconds or milliseconds (returns seconds-based relative or epoch ms)
 * - HH:MM:SS(.sss) elapsed strings
 */
export function parseTimeValueMs(raw: string | undefined): { ms: number; isAbsoluteEpoch: boolean } | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/^['"]+|['"]+$/g, "").trim();
  if (!cleaned || MISSING_TOKENS.has(cleaned.toLowerCase())) return null;

  // HH:MM:SS(.sss) or MM:SS.sss
  const hmsMatch = /^(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(cleaned);
  if (hmsMatch) {
    if (hmsMatch[3] !== undefined) {
      const h = Number(hmsMatch[1]);
      const m = Number(hmsMatch[2]);
      const s = Number(hmsMatch[3]);
      return { ms: Math.round((h * 3600 + m * 60 + s) * 1000), isAbsoluteEpoch: false };
    }
    const m = Number(hmsMatch[1]);
    const s = Number(hmsMatch[2]);
    return { ms: Math.round((m * 60 + s) * 1000), isAbsoluteEpoch: false };
  }

  const num = Number(cleaned);
  if (Number.isFinite(num)) {
    // Distinguish Unix epoch ms (> 1e12), Unix epoch sec (> 1e9), vs relative seconds
    if (num >= 1e12) return { ms: Math.round(num), isAbsoluteEpoch: true };
    if (num >= 1e9) return { ms: Math.round(num * 1000), isAbsoluteEpoch: true };
    return { ms: Math.round(num * 1000), isAbsoluteEpoch: false };
  }

  const parsedIso = Date.parse(cleaned);
  if (Number.isFinite(parsedIso)) {
    return { ms: parsedIso, isAbsoluteEpoch: true };
  }

  return null;
}

export const DETERMINISTIC_PLAYBACK_ANCHOR_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

export function buildRelativeAndIsoTimestamp(
  parsedTimes: Array<{ ms: number; isAbsoluteEpoch: boolean } | null>,
  index: number,
  fallbackStepMs: number
): { relativeOffsetMs: number; timestampIso: string } {
  const firstValid = parsedTimes.find((t) => t !== null) ?? null;
  const current = parsedTimes[index];
  if (firstValid && current) {
    const relativeOffsetMs = Math.max(0, Math.round(current.ms - firstValid.ms));
    const epochMs = current.isAbsoluteEpoch
      ? current.ms
      : DETERMINISTIC_PLAYBACK_ANCHOR_MS + relativeOffsetMs;
    return {
      relativeOffsetMs,
      timestampIso: new Date(epochMs).toISOString(),
    };
  }
  const relativeOffsetMs = Math.round(index * fallbackStepMs);
  return {
    relativeOffsetMs,
    timestampIso: new Date(DETERMINISTIC_PLAYBACK_ANCHOR_MS + relativeOffsetMs).toISOString(),
  };
}

export function inferSamplingRateHz(
  parsedTimes: Array<{ ms: number; isAbsoluteEpoch: boolean } | null>,
  defaultHz: number,
  minHz = 1,
  maxHz = 1000
): number {
  const validIndices: number[] = [];
  for (let i = 0; i < Math.min(parsedTimes.length, 60); i++) {
    if (parsedTimes[i] !== null) validIndices.push(i);
  }
  if (validIndices.length < 2) return defaultHz;
  const firstIdx = validIndices[0];
  const lastIdx = validIndices[validIndices.length - 1];
  const spanMs = parsedTimes[lastIdx]!.ms - parsedTimes[firstIdx]!.ms;
  const steps = lastIdx - firstIdx;
  if (spanMs <= 0 || steps <= 0) return defaultHz;
  const avgDtMs = spanMs / steps;
  const hz = Math.round(1000 / avgDtMs);
  if (hz < minHz || hz > maxHz) return defaultHz;
  return hz;
}
