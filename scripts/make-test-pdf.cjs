// Test PDF üretici — direk listesi içeren minimal geçerli PDF
const text = 'KALYON ENH DIREK LISTESI\nD-14  39.801234, 32.500123\nD-15  39.812345 32.511234\nD-16 39.823456,32.522345\n';
const stream = 'BT /F1 10 Tf 50 750 Td (' + text.replace(/\n/g, ') Tj 0 -14 Td (') + ') Tj ET';
const objs = [
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
  '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  '5 0 obj << /Length ' + stream.length + ' >> stream\n' + stream + '\nendstream endobj',
];
let pdf = '%PDF-1.4\n';
const offs = [];
objs.forEach((o) => { offs.push(Buffer.byteLength(pdf)); pdf += o + '\n'; });
const xref = Buffer.byteLength(pdf);
pdf += 'xref\n0 6\n0000000000 65535 f \n';
offs.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
pdf += 'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
require('fs').writeFileSync(process.argv[2] || '/tmp/direkler.pdf', Buffer.from(pdf, 'latin1'));
console.log('PDF yazildi:', process.argv[2] || '/tmp/direkler.pdf');
