import { readFile, writeFile, stat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { applyOutlineToPdf } from '../src/shared/outline.js';
import { PDFDocument, PDFName } from 'pdf-lib';

const fixturePath = new URL('./fixtures/nist-outline.pdf', import.meta.url);
const outputPath = new URL('./fixtures/nist-outline-output.pdf', import.meta.url);

const run = async () => {
  const input = await readFile(fixturePath);

  const outline = [
    { id: 'root-1', title: 'Cover', pageIndex: 0, level: 0 },
    { id: 'root-2', title: 'Introduction', pageIndex: 2, level: 0 },
    { id: 'child-1', title: 'Goals', pageIndex: 3, level: 1 },
    { id: 'root-3', title: 'Appendix', pageIndex: 10, level: 0 }
  ];

  const output = await applyOutlineToPdf(input, outline);
  await writeFile(outputPath, Buffer.from(output));

  const stats = await stat(outputPath);
  assert.ok(stats.size > 0, 'Output PDF should not be empty');

  const pdfDoc = await PDFDocument.load(output);
  const outlinesRef = pdfDoc.catalog.get(PDFName.of('Outlines'));
  assert.ok(outlinesRef, 'PDF should have an Outlines entry');

  const outlinesDict = pdfDoc.context.lookup(outlinesRef);
  const count = outlinesDict.get(PDFName.of('Count'));
  assert.equal(Number(count?.numberValue ?? 0), 4, 'Outline count should match entries');

  console.log('Outline test passed.');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
