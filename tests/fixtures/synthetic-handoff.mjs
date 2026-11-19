import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zip } from './office-zip.mjs';

const pdfEscape = line => line.replace(/[\\()]/g, '\\$&');
const xmlEscape = line => line.replace(/[<>&]/g, char => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[char]);

export function syntheticPdf(...lines) {
  const stream = 'BT /F1 12 Tf 40 740 Td ' + lines.map(line => '(' + pdfEscape(line) + ') Tj').join(' 0 -16 Td ') + ' ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream'];
  let result = '%PDF-1.7\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = Buffer.byteLength(result);
  return Buffer.from(result + 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

export function syntheticDocx(...lines) {
  const paragraphs = lines.map(line => '<w:p><w:r><w:t>' + xmlEscape(line) + '</w:t></w:r></w:p>').join('');
  return zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '</w:body></w:document>',
  });
}

const answerForm = 'Report exactly the dispatch code recorded in the PDF, the ticket code recorded in the DOCX, and the discrepancy in the review slot with each document’s value. Return only a JSON object with keys dispatchCode, ticketCode, and discrepancy with nested keys pdf and docx. Do not choose one source as correct.';

export async function writeHandoffFixture(directory, seed) {
  if (!seed) throw new Error('A shared A/B fixture seed is required.');
  const hash = createHash('sha256').update(String(seed)).digest('hex');
  const expected = {
    dispatchCode: 'DSP-' + hash.slice(0, 8).toUpperCase(),
    ticketCode: 'TKT-' + hash.slice(8, 16).toUpperCase(),
    discrepancy: {pdf:'P-' + hash.slice(16, 22).toUpperCase(),docx:'W-' + hash.slice(22, 28).toUpperCase()},
  };
  const pdf = ['Orchard handoff snapshot', 'Dispatch code: ' + expected.dispatchCode, 'Review slot: ' + expected.discrepancy.pdf];
  const docx = ['Orchard handoff revision', 'Ticket code: ' + expected.ticketCode, 'Review slot: ' + expected.discrepancy.docx];
  const folder = path.join(directory,'workbench','handoffs','october');
  await mkdir(folder, {recursive:true});
  const targets = {pdf:path.join(folder,'Orchard handoff snapshot.pdf'),docx:path.join(folder,'Orchard handoff revision.docx')};
  await Promise.all([
    writeFile(targets.pdf, syntheticPdf(...pdf), {flag:'wx'}),
    writeFile(targets.docx, syntheticDocx(...docx), {flag:'wx'}),
  ]);
  return {
    expected, targets,
    filePrompt: 'There are two Orchard handoff documents somewhere in this workspace, one PDF and one DOCX. Find and compare them. ' + answerForm,
    inlinePrompt: 'The complete text of both Orchard handoff documents is pasted below. No other source is needed.\nPDF:\n' +
      pdf.join('\n') + '\nDOCX:\n' + docx.join('\n') + '\n' + answerForm,
  };
}
