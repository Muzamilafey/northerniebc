import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export interface Table {
  title: string;
  meta: Record<string, string>;
  columns: string[];
  rows: (string | number | null | undefined)[][];
}

/** Neutralises spreadsheet formula injection in exported cells. */
function safe(v: string | number | null | undefined): string | number {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function toCsv(t: Table): Buffer {
  const metaLines = [[`# ${t.title}`], ...Object.entries(t.meta).map(([k, v]) => [`# ${k}: ${v}`]), []];
  return Buffer.from(stringify([...metaLines, t.columns, ...t.rows.map((r) => r.map(safe))]), 'utf8');
}

export async function toXlsx(t: Table): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'The Northern IEBC';
  const about = wb.addWorksheet('About');
  about.addRow([t.title]).font = { bold: true, size: 14 };
  for (const [k, v] of Object.entries(t.meta)) about.addRow([k, v]);
  about.getColumn(1).width = 28;
  about.getColumn(2).width = 100;
  const data = wb.addWorksheet('Data');
  data.addRow(t.columns).font = { bold: true };
  for (const r of t.rows) data.addRow(r.map(safe));
  data.columns.forEach((c) => (c.width = 22));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(t: Table): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: t.columns.length > 6 ? 'landscape' : 'portrait', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(9).fillColor('#4b5563').text('The Northern IEBC — independent platform, not affiliated with or endorsed by the IEBC');
    doc.moveDown(0.5).fontSize(15).fillColor('#0b1f3a').text(t.title);
    doc.moveDown(0.5).fontSize(8).fillColor('#111827');
    for (const [k, v] of Object.entries(t.meta)) doc.text(`${k}: ${v}`);
    doc.moveDown(0.8);
    const width = doc.page.width - 72;
    const colW = width / t.columns.length;
    const drawRow = (cells: (string | number)[], bold = false) => {
      const y = doc.y;
      let h = 0;
      cells.forEach((c, i) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7);
        const text = String(c).slice(0, 200);
        h = Math.max(h, doc.heightOfString(text, { width: colW - 4 }));
        doc.text(text, 36 + i * colW, y, { width: colW - 4 });
      });
      doc.y = y + h + 4;
      doc.x = 36;
      if (doc.y > doc.page.height - 60) doc.addPage();
    };
    drawRow(t.columns, true);
    for (const r of t.rows.slice(0, 5000)) drawRow(r.map(safe));
    if (t.rows.length > 5000) doc.text(`… ${t.rows.length - 5000} more rows; use CSV or Excel for the full data set.`);
    doc.end();
  });
}
