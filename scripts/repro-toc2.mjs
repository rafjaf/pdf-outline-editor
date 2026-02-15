import fs from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfPath = '/Users/rafjaf/Downloads/Wéry - Livre 5 Les obligations - 2024.pdf';
const tocPath = '/Users/rafjaf/Downloads/toc2.json';

const normalizeText = (text) => String(text || '')
  .normalize('NFKD')
  .replace(/[^a-zA-Z]/g, '')
  .toLowerCase();

const buildLetterBigrams = (text) => {
  const cleaned = normalizeText(text);
  if (cleaned.length < 2) return [];
  const grams = [];
  for (let i = 0; i < cleaned.length - 1; i++) grams.push(cleaned.slice(i, i + 2));
  return grams;
};

const diceSimilarity = (left, right) => {
  const a = buildLetterBigrams(left);
  const b = buildLetterBigrams(right);
  if (a.length === 0 || b.length === 0) return 0;

  const counts = new Map();
  a.forEach((gram) => counts.set(gram, (counts.get(gram) || 0) + 1));

  let intersection = 0;
  b.forEach((gram) => {
    const current = counts.get(gram) || 0;
    if (current > 0) {
      intersection += 1;
      counts.set(gram, current - 1);
    }
  });

  return (2 * intersection) / (a.length + b.length);
};

const titleMatchesPage = (title, pageText) => {
  const normTitle = normalizeText(title);
  const normPage = normalizeText(pageText);

  if (!normTitle || !normPage) return false;

  if (normPage.includes(normTitle)) return true;

  const stopWords = new Set([
    'les', 'des', 'une', 'dans', 'pour', 'avec', 'sans', 'dont', 'entre', 'sous',
    'sur', 'aux', 'du', 'de', 'la', 'le', 'et', 'ou', 'en', 'au', 'par', 'l', 'd',
    'the', 'and', 'for', 'from', 'with', 'that', 'this'
  ]);

  const words = String(title || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  const pageWordsBlob = String(pageText || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .toLowerCase();

  if (words.length >= 2) {
    const matchedWords = words.filter((w) => pageWordsBlob.includes(w)).length;
    const coverage = matchedWords / words.length;
    const minCoverage = words.length >= 6 ? 0.5 : 0.67;
    if (coverage >= minCoverage) return true;
  }

  const pageTokens = pageWordsBlob.split(/\s+/).filter(Boolean);
  const titleTokenCount = Math.max(
    1,
    String(title || '')
      .normalize('NFKD')
      .replace(/[^a-zA-Z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean).length
  );

  let best = 0;
  for (let start = 0; start < pageTokens.length; start++) {
    for (let span = Math.max(2, titleTokenCount - 6); span <= titleTokenCount + 8; span++) {
      const end = start + span;
      if (end > pageTokens.length) continue;
      const windowText = pageTokens.slice(start, end).join(' ');
      const score = diceSimilarity(title, windowText);
      if (score > best) best = score;
    }
  }

  const threshold = normTitle.length > 40 ? 0.78 : 0.88;
  return best >= threshold;
};

const verifyTitleAroundPage = (title, pageTexts, pageIdx, maxDistance = 2) => {
  if (pageIdx < 0 || pageIdx >= pageTexts.length) return false;
  if (titleMatchesPage(title, pageTexts[pageIdx])) return true;

  for (let distance = 1; distance <= maxDistance; distance++) {
    const left = pageIdx - distance;
    const right = pageIdx + distance;
    if (left >= 0 && titleMatchesPage(title, pageTexts[left])) return true;
    if (right < pageTexts.length && titleMatchesPage(title, pageTexts[right])) return true;
  }

  return false;
};

const fromRoman = (text) => {
  if (!text) return null;
  const roman = text.toUpperCase().trim();
  if (!/^[IVXLCDM]+$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const curr = values[roman[i]];
    const next = values[roman[i + 1]] || 0;
    total += curr < next ? -curr : curr;
  }
  return total > 0 ? total : null;
};

const extractPrintedPageLabels = async (pdfDoc) => {
  const labelsPerPage = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const lineMap = new Map();

    for (const item of textContent.items) {
      const text = String(item.str || '').trim();
      if (!text) continue;

      const y = Math.round((item.transform?.[5] || 0) / 3) * 3;
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push(text);
    }

    const sortedLines = Array.from(lineMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, lineItems]) => lineItems.join(' ').trim())
      .filter(Boolean);

    const candidateLines = [];
    if (sortedLines[0]) candidateLines.push(sortedLines[0]);
    if (sortedLines.length > 1) candidateLines.push(sortedLines[sortedLines.length - 1]);

    const pageLabels = new Set();
    for (const line of candidateLines) {
      const nums = line.match(/\b\d{1,4}\b/g) || [];
      nums.forEach((n) => pageLabels.add(parseInt(n, 10)));

      const romans = line.match(/\b[ivxlcdmIVXLCDM]{1,10}\b/g) || [];
      romans.forEach((romanToken) => {
        const romanValue = fromRoman(romanToken);
        if (romanValue) pageLabels.add(romanValue);
      });
    }

    labelsPerPage.push(pageLabels);
  }

  return labelsPerPage;
};

const inferMissingPrintedLabels = (labelsPerPage) => {
  const inferred = labelsPerPage.map((set) => new Set(set));
  const anchors = [];

  for (let pageIdx = 0; pageIdx < inferred.length; pageIdx++) {
    const numericLabels = Array.from(inferred[pageIdx]).filter((v) => Number.isInteger(v) && v > 0);
    if (numericLabels.length > 0) anchors.push({ pageIdx, label: Math.min(...numericLabels) });
  }

  if (anchors.length === 0) return inferred;

  for (let i = 0; i < anchors.length - 1; i++) {
    const left = anchors[i];
    const right = anchors[i + 1];
    const pageDistance = right.pageIdx - left.pageIdx;
    const labelDistance = right.label - left.label;

    if (pageDistance <= 0 || labelDistance !== pageDistance) continue;

    for (let pageIdx = left.pageIdx; pageIdx <= right.pageIdx; pageIdx++) {
      inferred[pageIdx].add(left.label + (pageIdx - left.pageIdx));
    }
  }

  const first = anchors[0];
  for (let pageIdx = first.pageIdx - 1; pageIdx >= 0; pageIdx--) {
    const guessed = first.label - (first.pageIdx - pageIdx);
    if (guessed > 0) inferred[pageIdx].add(guessed);
  }

  const last = anchors[anchors.length - 1];
  for (let pageIdx = last.pageIdx + 1; pageIdx < inferred.length; pageIdx++) {
    inferred[pageIdx].add(last.label + (pageIdx - last.pageIdx));
  }

  return inferred;
};

const detectPrintedPageOffset = (entries, labelsPerPage) => {
  const offsetVotes = new Map();

  for (const entry of entries) {
    if (!entry.page || entry.page <= 0) continue;

    for (let pageIndex = 0; pageIndex < labelsPerPage.length; pageIndex++) {
      if (!labelsPerPage[pageIndex].has(entry.page)) continue;
      const offset = pageIndex + 1 - entry.page;
      offsetVotes.set(offset, (offsetVotes.get(offset) || 0) + 1);
    }
  }

  let bestOffset = null;
  let bestVotes = 0;
  for (const [offset, votes] of offsetVotes.entries()) {
    if (votes > bestVotes) {
      bestVotes = votes;
      bestOffset = offset;
    }
  }

  return bestVotes > 0 ? { offset: bestOffset, votes: bestVotes } : null;
};

const toc = JSON.parse(await fs.readFile(tocPath, 'utf8')).entries;
const uint8 = new Uint8Array(await fs.readFile(pdfPath));
const pdf = await getDocument({ data: uint8 }).promise;

const pageTexts = [];
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const textContent = await page.getTextContent();
  pageTexts.push(textContent.items.map((it) => it.str).join(' '));
}

const labels = inferMissingPrintedLabels(await extractPrintedPageLabels(pdf));
const offsetResult = detectPrintedPageOffset(toc, labels);
const offset = offsetResult?.offset ?? 0;

const startTitle = 'PARTIE I. LES ACTES JURIDIQUES INTRODUCTION. LES DISPOSITIONS DU LIVRE 1ER RELATIVES À L ’ACTE JURIDIQUE';
const endTitle = 'SOUS-TITRE II. LA CONCLUSION DU CONTRAT';
const start = toc.findIndex((e) => e.title === startTitle);
const end = toc.findIndex((e) => e.title === endTitle);

console.log('pdfPages=', pdf.numPages, 'offset=', offsetResult);
console.log('startIdx=', start, 'endIdx=', end, 'count=', end - start + 1);

let okCount = 0;
for (let i = start; i <= end; i++) {
  const e = toc[i];
  let pageIdx = Math.max(0, Math.min(pdf.numPages - 1, e.page > 0 ? e.page + offset - 1 : 0));

  if (e.page > 0 && !labels[pageIdx]?.has(e.page)) {
    for (let distance = 1; distance <= 5; distance++) {
      const left = pageIdx - distance;
      const right = pageIdx + distance;
      if (left >= 0 && labels[left]?.has(e.page)) {
        pageIdx = left;
        break;
      }
      if (right < labels.length && labels[right]?.has(e.page)) {
        pageIdx = right;
        break;
      }
    }
  }

  const ok = verifyTitleAroundPage(e.title, pageTexts, pageIdx, 2);
  if (ok) okCount += 1;
  console.log(JSON.stringify({
    i,
    page: e.page,
    targetPdfPage: pageIdx + 1,
    ok,
    title: e.title
  }));
}

console.log('verifiedInRange=', okCount, '/', end - start + 1);
