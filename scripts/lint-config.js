import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const packageJson = JSON.parse(await readFile('package.json', 'utf-8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf-8'));
for (const metadata of [lock, lock.packages['']]) {
  assert.equal(metadata.name, packageJson.name, 'Package names must agree');
  assert.equal(metadata.version, packageJson.version, 'Package versions must agree');
}
for (const key of ['dependencies', 'devDependencies']) {
  assert.deepEqual(lock.packages[''][key], packageJson[key], `Lockfile ${key} must agree with package.json`);
}

if (!packageJson.dependencies?.['pdfjs-dist']) {
  throw new Error('pdfjs-dist dependency missing');
}

if (!packageJson.dependencies?.['pdf-lib']) {
  throw new Error('pdf-lib dependency missing');
}

console.log('Config looks good.');
