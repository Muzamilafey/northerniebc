import PDFDocument from 'pdfkit';

export interface ReceiptSnapshot {
  receiptNumber: string;
  donationReference: string;
  amount: number;
  currency: string;
  confirmedAt: string;
  paymentMethod: string;
  providerReceipt?: string | null;
  paymentStatus: string;
  donorName?: string | null;
  operator: { legalName: string; email?: string; phone?: string; address?: string; registration?: string };
  taxWording: string;
}

const fmt = (n: number, c: string) => `${c} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function renderReceiptPdf(s: ReceiptSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Donation receipt ${s.receiptNumber}`, Author: s.operator.legalName } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor('#0b1f3a').fontSize(20).text('The Northern IEBC', { continued: false });
    doc.fontSize(10).fillColor('#4b5563').text('Follow the Vote. Follow the Money.');
    doc.moveDown(0.3).fontSize(8).text('Independent platform. Not affiliated with or endorsed by the Independent Electoral and Boundaries Commission (IEBC).');
    doc.moveDown(1.2).fillColor('#111827').fontSize(16).text('Donation receipt');
    doc.moveDown(0.8).fontSize(11);
    const rows: [string, string][] = [
      ['Receipt number', s.receiptNumber],
      ['Donation reference', s.donationReference],
      ['Amount', fmt(s.amount, s.currency)],
      ['Date and time (EAT)', new Date(s.confirmedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })],
      ['Payment method', s.paymentMethod],
      ['Provider transaction reference', s.providerReceipt ?? '—'],
      ['Payment status', s.paymentStatus],
      ...(s.donorName ? ([['Received from', s.donorName]] as [string, string][]) : [])
    ];
    for (const [k, v] of rows) {
      doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(v);
      doc.moveDown(0.2);
    }
    doc.moveDown(1).font('Helvetica-Bold').text('Received by');
    doc.font('Helvetica').text(s.operator.legalName);
    if (s.operator.registration) doc.text(s.operator.registration);
    if (s.operator.address) doc.text(s.operator.address);
    if (s.operator.email) doc.text(`Email: ${s.operator.email}`);
    if (s.operator.phone) doc.text(`Phone: ${s.operator.phone}`);
    doc.moveDown(1).fontSize(9).fillColor('#374151').text(s.taxWording);
    doc.end();
  });
}
