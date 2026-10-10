import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHeadingPages, buildPrintedPageMap, matchHeadings, normalizeHeading, scoreHeading } from '../src/shared/heading-matcher.js';

const item = (str, top, x = 40, size = 10, width = str.length * size * 0.5) => ({ str, width, fontName: 'test', transform: [size, 0, 0, size, x, 1000 - top] });
const viewport = { height: 1000, convertToViewportPoint: (x, y) => [x, 1000 - y] };
const scan = (items) => extractHeadingPages({
  numPages: items.length,
  getPage: async n => ({ getTextContent: async () => ({ items: items[n - 1] }), getViewport: () => viewport })
});
const page = (number, heading = 'An actual heading') => [
  item('Repeated running header', 90, 40, 7), item(heading, 200, 40, 16),
  item('Some body text which provides the usual font size.', 250),
  item('More body text for comparison.', 264), item(String(number), 900, 230, 8),
  item('Publisher', 900, 40, 6),
  item('Institution / user@example.com', 965, 40, 6),
  item(heading, 975, 40, 6), item('example.com - 17/02/2024', 985, 40, 6)
];

test('folios above watermarks, reordered pages and omitted sheets do not need a global offset', async () => {
  const pages = await scan([1063, 1064, 1065, 9, 10, 11, 16, 19, 20, 21].map(n => page(n)));
  const map = buildPrintedPageMap(pages);
  assert.equal(map.get(1063), 0);
  assert.equal(map.get(9), 3);
  assert.equal(map.get(16), 6);
  assert.equal(map.get(19), 7);
  assert.equal(map.has(17), false, 'missing sheets must not be invented');
  assert.equal(map.has(2024), false, 'watermark dates are not page numbers');
  assert.ok(pages.every(p => !p.bodyLines.some(l => l.text.includes('@'))));
});

test('missing folios are interpolated only between consistent anchors', async () => {
  const data = [10, 11, 12, 13, 14].map(n => page(n));
  data[2] = data[2].filter(i => i.str !== '12');
  const map = buildPrintedPageMap(await scan(data));
  assert.equal(map.get(12), 2);
});

test('small capitals, multiline headings, ligatures, accents and hyphenated words match', async () => {
  const data = [1, 2, 3].map(n => page(n, 'Unrelated heading'));
  data[1].splice(1, 1, item('C', 200, 40, 18, 9), item('HAPITRE', 200, 49, 14, 49), item('1', 200, 103, 18),
    item('La notion d’obligation et les concepts', 224, 40, 18), item('voisins', 248, 40, 18));
  const pages = await scan(data);
  const result = matchHeadings([{ title: 'CHAPITRE 1. La notion d’obligation et les concepts voisins', page: 2, level: 1 }], pages, buildPrintedPageMap(pages));
  assert.equal(result[0].confidence, 'verified');
  assert.equal(result[0].pageIndex, 1);
  assert.equal(normalizeHeading('Les œuvres réalisées'), normalizeHeading('Les oeuvres realisees'));
  const hyphenated = [1, 2, 3].map(n => page(n, 'La respon-'));
  hyphenated[1].splice(2, 0, item('sabilité civile', 220, 40, 16));
  const split = await scan(hyphenated);
  assert.equal(matchHeadings([{ title: 'La responsabilité civile', page: 2, level: 1 }], split, buildPrintedPageMap(split))[0].confidence, 'verified');
});

test('different section numbers, letter labels and references cannot verify each other', () => {
  const candidate = text => ({ text, norm: normalizeHeading(text), body: normalizeHeading(text), heading: true });
  assert.equal(scoreHeading('Section 1. Les conditions', candidate('Section 2. Les conditions')), 0);
  assert.equal(scoreHeading('A. Les conditions', candidate('B. Les conditions')), 0);
  assert.equal(scoreHeading('La structure du livre 5', candidate('La structure du livre 6')), 0);
});

test('the TOC and repeated running headings are excluded from title searches', async () => {
  const toc = [item('Table des matières', 100, 40, 16), ...Array.from({ length: 8 }, (_, i) => item(`Section ${i + 1}. A heading ${i + 10}`, 200 + i * 20))];
  const pages = await scan([toc, ...[10, 11, 12].map(n => page(n, 'An actual heading'))]);
  assert.equal(pages[0].isToc, true);
  const results = matchHeadings([{ title: 'Section 1. A heading', page: 0, level: 1 }, { title: 'Repeated running header', page: 11, level: 1 }], pages, buildPrintedPageMap(pages));
  assert.equal(results[0].confidence, 'unverified');
  assert.equal(results[1].confidence, 'uncertain');
});

test('a heading on its mapped page wins over duplicates on adjacent pages', async () => {
  const pages = await scan([10, 11, 12].map(n => page(n, 'Section 1. Les conditions')));
  const result = matchHeadings([{ title: 'Section 1. Les conditions', page: 11, level: 1 }], pages, buildPrintedPageMap(pages))[0];
  assert.equal(result.confidence, 'verified');
  assert.equal(result.pageIndex, 1);
});

test('missing parents share their first available descendant while remaining uncertain', async () => {
  const pages = await scan([19, 20, 21].map(n => page(n, 'CHAPITRE 1. Les conditions')));
  const entries = [
    { title: 'PARTIE INTRODUCTIVE', page: 0, level: 1 },
    { title: 'TITRE 1. L’obligation', page: 17, level: 2 },
    { title: 'CHAPITRE 1. Les conditions', page: 19, level: 3 }
  ];
  const results = matchHeadings(entries, pages, buildPrintedPageMap(pages));
  assert.deepEqual(results.map(r => r.pageIndex), [0, 0, 0]);
  assert.deepEqual(results.map(r => r.confidence), ['uncertain', 'uncertain', 'verified']);
});

test('scattered words in prose are not a verified heading', async () => {
  const data = [1, 2, 3].map(n => page(n, 'Unrelated heading'));
  data[1].splice(2, 2, item('Les conditions sont discutées dans ce paragraphe très détaillé.', 260), item('La réforme est évoquée à un autre endroit de cette longue discussion.', 274));
  const pages = await scan(data);
  assert.equal(matchHeadings([{ title: 'Les conditions de la réforme', page: 2, level: 1 }], pages, buildPrintedPageMap(pages))[0].confidence, 'uncertain');
});

test('scanning honors cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractHeadingPages({ numPages: 100 }, { signal: controller.signal }), { name: 'AbortError' });
});
