import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { badRequest } from '../../lib/errors.js';

export const MAX_ROWS = 50_000;

const normHeader = (h: unknown) => String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Parses a CSV or XLSX buffer into rows keyed by normalised header names. */
export async function parseTable(buf: Buffer, mime: string): Promise<Record<string, string>[]> {
  let rows: Record<string, string>[];
  if (mime === 'text/csv') {
    const raw = parseCsv(buf, { columns: (h: string[]) => h.map(normHeader), bom: true, skip_empty_lines: true, trim: true, relax_column_count: false }) as Record<string, string>[];
    rows = raw;
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('Workbook has no sheets');
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => (headers[i - 1] = normHeader(c.text)));
    rows = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const o: Record<string, string> = {};
      let any = false;
      headers.forEach((h, i) => {
        if (!h) return;
        const cell = row.getCell(i + 1);
        const v = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : cell.text?.trim() ?? '';
        if (v) any = true;
        o[h] = v;
      });
      if (any) rows.push(o);
    });
  }
  if (rows.length > MAX_ROWS) throw badRequest(`Too many rows (max ${MAX_ROWS})`);
  // Defend against formula/operator-like keys.
  for (const r of rows) for (const k of Object.keys(r)) if (k.startsWith('$')) throw badRequest('Invalid column name');
  return rows;
}

export const num = (v: string | undefined) => {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v.replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
};
export const date = (v: string | undefined) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
export const str = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
export const bool = (v: string | undefined) => (v ? ['true', 'yes', '1', 'y'].includes(v.trim().toLowerCase()) : false);
