import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf-8'));

if (!packageJson.dependencies?.['pdfjs-dist']) {
  throw new Error('pdfjs-dist dependency missing');
}

if (!packageJson.dependencies?.['pdf-lib']) {
  throw new Error('pdf-lib dependency missing');
}

console.log('Config looks good.');
