import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const url = 'https://www.nist.gov/system/files/documents/2025/07/15/Outline_%20Proposed%20Zero%20Draft%20for%20a%20Standard%20on%20AI%20TEVV-for-web.pdf';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const targetDir = join(__dirname, '../tests/fixtures');
const targetPath = join(targetDir, 'nist-outline.pdf');

if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true });
}

if (existsSync(targetPath)) {
  console.log('Fixture already exists:', targetPath);
  process.exit(0);
}

https.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Failed to download fixture: ${res.statusCode}`);
    process.exit(1);
  }

  const fileStream = createWriteStream(targetPath);
  res.pipe(fileStream);
  fileStream.on('finish', () => {
    fileStream.close();
    console.log('Downloaded fixture to', targetPath);
  });
}).on('error', (err) => {
  console.error('Download error', err);
  process.exit(1);
});
