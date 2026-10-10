// Layout-aware TOC matching. All PDF scanning and scoring happens locally.
const checkAbort = (signal) => signal?.throwIfAborted();

export const normalizeHeading = (text) => String(text || '')
  .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[œ]/g, 'oe').replace(/[æ]/g, 'ae')
  .replace(/[^\p{L}\p{N}]/gu, '');

const headingPrefix = /^(?:(?:sous[\s-]*)?(?:partie|titre|chapitre|section)|chapter|part|title|section)\s+(?:\d+|[ivxlcdm]+)(?:er|re|e)?\s*[.\-–—:]?\s*/i;
const smallPrefix = /^(?:[A-Z]|[IVXLCDM]+|\d+)\s*[.)°]\s*/;
const titleBody = (text) => text.trim().replace(headingPrefix, '').replace(smallPrefix, '');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 10;

// Use geometry instead of adding spaces between every PDF.js fragment (small
// capitals often arrive as "C" + "HAPITRE"). Coordinates are viewport-relative.
export const extractPageLayout = (content, viewport) => {
  const fragments = content.items.filter(i => i.str?.trim()).map(item => {
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return { text: item.str, x, y, width: item.width, height: Math.hypot(item.transform[2], item.transform[3]), font: item.fontName };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const item of fragments) {
    // Include raised ordinals/footnote markers with their baseline, when close.
    let line = lines.findLast(l => Math.abs(l.y - item.y) <= Math.max(2, Math.min(l.height, item.height) * 0.5));
    if (!line) {
      line = { y: item.y, height: item.height, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.height = Math.max(line.height, item.height);
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = '';
    let previous = null;
    for (const item of line.items) {
      const gap = previous ? item.x - previous.x - previous.width : 0;
      const separator = previous && gap > Math.min(previous.height, item.height) * 0.12 ? ' ' : '';
      line.text += separator + item.text;
      previous = item;
    }
    line.text = line.text.replace(/\s+/g, ' ').trim();
    line.fonts = [...new Set(line.items.map(i => i.font))];
  }
  lines.sort((a, b) => a.y - b.y);
  const bodyHeight = median(fragments.filter(i => i.y > viewport.height * 0.15 && i.y < viewport.height * 0.8).map(i => i.height));
  const numbers = [];
  for (const line of lines) {
    const position = line.y < viewport.height * 0.18 ? 'top' : line.y > viewport.height * 0.82 ? 'bottom' : null;
    if (!position) continue;
    // Dates, reference numbers inside prose, and superscripts are not folios.
    for (const item of line.items) {
      if (!/^\d{1,4}$/.test(item.text.trim()) || item.height < bodyHeight * 0.65) continue;
      const isolated = line.items.length === 1 || line.items.every(other => other === item ||
        other.x + other.width < item.x - item.height || other.x > item.x + item.width + item.height);
      if (isolated) numbers.push({ number: Number(item.text), position, slot: `${position}:${Math.round(line.y / viewport.height * 100)}` });
    }
    const decorated = line.text.match(/^[\s—–\-|.·•*_~]*(\d{1,4})[\s—–\-|.·•*_~]*$/);
    const edge = line.text.length < 120 && !/[\/@]|\d[./]\d/.test(line.text)
      ? line.text.match(/^(\d{1,4})\s|\s(\d{1,4})$/) : null;
    if (decorated || edge) numbers.push({ number: Number(decorated?.[1] || edge?.[1] || edge?.[2]), position, slot: `${position}:${Math.round(line.y / viewport.height * 100)}` });
  }
  // A TOC has a title and/or many short rows ending in a page number.
  const tocRows = lines.filter(l => l.text.length < 180 && /\s\d{1,4}$/.test(l.text)).length;
  const tocTitle = lines.some(l => /^(tabledesmatieres|tableofcontents|contents|sommaire)$/.test(normalizeHeading(l.text)));
  return { lines, numbers, bodyHeight, height: viewport.height, isToc: tocRows >= 6 || (tocTitle && tocRows >= 3) };
};

export const extractHeadingPages = async (pdf, { signal, log = () => {} } = {}) => {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    checkAbort(signal);
    if (n === 1 || n % 50 === 0) log(`  Scanning page ${n}/${pdf.numPages} locally...`);
    const page = await pdf.getPage(n);
    pages.push(extractPageLayout(await page.getTextContent(), page.getViewport({ scale: 1 })));
    if (n % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return prepareHeadingPages(pages);
};

export const prepareHeadingPages = (pages) => {
  // Repeated margin text includes publisher headers and per-chapter watermarks.
  const margins = new Map();
  for (const page of pages) {
    const keys = new Set(page.lines.filter(l => l.y < page.height * 0.2 || l.y > page.height * 0.84).map(l => normalizeHeading(l.text)));
    for (const key of keys) margins.set(key, (margins.get(key) || 0) + 1);
  }
  for (const page of pages) {
    page.bodyLines = page.lines.filter(l => {
      if (l.y > page.height * 0.94) return false;
      const margin = l.y < page.height * 0.2 || l.y > page.height * 0.84;
      if (margin && (margins.get(normalizeHeading(l.text)) || 0) >= 3 && l.height < page.bodyHeight * 0.95) return false;
      if (margin && /^\d{1,4}$/.test(l.text)) return false;
      return true;
    });
    page.candidates = buildCandidates(page);
  }
  return pages;
};

// Trust folios using local number sequences and recurrent printed baselines.
// This handles reordered sections and missing pages without a global offset.
export const buildPrintedPageMap = (pages, log = () => {}) => {
  const map = new Map();
  const anchors = new Map();
  const slots = new Map();
  for (let i = 0; i < pages.length; i++) {
    const consistent = pages[i].numbers.filter(candidate => [-2, -1, 1, 2].filter(delta =>
      pages[i + delta]?.numbers.some(c => c.slot === candidate.slot && c.number === candidate.number + delta)).length >= 2);
    for (const slot of new Set(consistent.map(c => c.slot).filter(Boolean))) slots.set(slot, (slots.get(slot) || 0) + 1);
  }
  const reliableSlots = new Set();
  // A recurrent folio baseline provides evidence even at a section break or
  // beside missing pages, where there are no consecutive-number neighbours.
  for (const position of ['top', 'bottom']) {
    const ranked = [...slots].filter(([slot]) => slot.startsWith(position + ':')).sort((a, b) => b[1] - a[1]);
    for (const [slot, count] of ranked.slice(0, 2)) if (count >= Math.max(3, pages.length * 0.1)) reliableSlots.add(slot);
  }
  for (let index = 0; index < pages.length; index++) {
    const supported = pages[index].numbers.map(candidate => {
      let support = 0;
      for (const delta of [-2, -1, 1, 2]) {
        if (pages[index + delta]?.numbers.some(c => c.position === candidate.position && c.number === candidate.number + delta)) support++;
      }
      return { ...candidate, support, spatial: reliableSlots.has(candidate.slot) };
    }).sort((a, b) => Number(b.spatial) - Number(a.spatial) || b.support - a.support);
    if (!supported[0] || (supported[0].support < 2 && !supported[0].spatial) || supported[0].number <= 0) continue;
    if (supported[0].spatial && new Set(supported.filter(c => c.slot === supported[0].slot).map(c => c.number)).size > 1) continue;
    anchors.set(index, supported[0].number);
    // Prefer body pages to a duplicate folio on a TOC page.
    if (!map.has(supported[0].number) || pages[map.get(supported[0].number)].isToc) map.set(supported[0].number, index);
  }
  const ordered = [...anchors];
  for (let n = 1; n < ordered.length; n++) {
    const [left, a] = ordered[n - 1];
    const [right, b] = ordered[n];
    if (right - left !== b - a || right - left > 10) continue;
    for (let i = left + 1; i < right; i++) if (!map.has(a + i - left)) map.set(a + i - left, i);
  }
  log(`[System] Mapped ${map.size} printed pages using locally consistent folios (including bounded gaps).`);
  return map;
};

const buildCandidates = (page) => {
  if (page.isToc) return [];
  const lines = page.bodyLines || page.lines;
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    let text = '';
    for (let span = 0; span < 4 && i + span < lines.length; span++) {
      const line = lines[i + span];
      if (span && line.y - lines[i + span - 1].y > Math.max(line.height, lines[i + span - 1].height) * 2.8) break;
      text = text.endsWith('-') ? text.slice(0, -1) + line.text : text + (text ? ' ' : '') + line.text;
      if (text.length > 320) break;
      const explicit = headingPrefix.test(text) || smallPrefix.test(text);
      const large = lines[i].height >= page.bodyHeight * 1.08;
      const standalone = lines[i].text.length < 180 && (i === 0 || lines[i].y - lines[i - 1].y > lines[i].height * 1.4);
      // Keep short windows for literal matching; typography helps distinguish
      // a heading from the same words in a paragraph or a footnote.
      candidates.push({ text, norm: normalizeHeading(text), body: normalizeHeading(titleBody(text)), explicit, heading: explicit || large || standalone, y: lines[i].y });
    }
  }
  return candidates;
};

const dice = (a, b) => {
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  for (let i = 1; i < a.length; i++) { const gram = a.slice(i - 1, i + 1); counts.set(gram, (counts.get(gram) || 0) + 1); }
  let common = 0;
  for (let i = 1; i < b.length; i++) {
    const gram = b.slice(i - 1, i + 1), count = counts.get(gram) || 0;
    if (count) { common++; counts.set(gram, count - 1); }
  }
  return 2 * common / (a.length + b.length - 2);
};

export const scoreHeading = (title, candidate) => {
  const norm = normalizeHeading(title), body = normalizeHeading(titleBody(title));
  if (!norm) return 0;
  // Do not erase numbering: "Section 1" must not verify "Section 2".
  const prefixA = title.match(headingPrefix)?.[0], prefixB = candidate.text.match(headingPrefix)?.[0];
  if (prefixA && prefixB && normalizeHeading(prefixA) !== normalizeHeading(prefixB)) return 0;
  const smallA = title.match(smallPrefix)?.[0], smallB = candidate.text.match(smallPrefix)?.[0];
  if (smallA && smallB && normalizeHeading(smallA) !== normalizeHeading(smallB)) return 0;
  const numbersA = title.match(/\d+/g), numbersB = candidate.text.match(/\d+/g);
  if (numbersA && numbersB && numbersA.some((n, i) => numbersB[i] !== n)) return 0;
  if (norm === candidate.norm) return 1;
  if (candidate.norm.startsWith(norm) && candidate.norm.length <= norm.length * 1.25) return 0.97;
  if (body.length >= 8 && body === candidate.body && candidate.heading) return 0.96;
  return Math.max(dice(norm, candidate.norm), body.length >= 12 && candidate.heading ? dice(body, candidate.body) * 0.97 : 0);
};

const shortlist = (title, pages, indices) => {
  const ranked = [];
  for (const pageIndex of indices) {
    for (const candidate of pages[pageIndex]?.candidates || []) {
      const score = scoreHeading(title, candidate);
      if (score >= 0.55) ranked.push({ pageIndex, score, ...candidate });
    }
  }
  ranked.sort((a, b) => b.score - a.score || Number(b.heading) - Number(a.heading));
  const unique = [];
  for (const item of ranked) {
    if (unique.some(c => c.pageIndex === item.pageIndex && (c.norm.includes(item.norm) || item.norm.includes(c.norm)))) continue;
    unique.push(item);
    if (unique.length === 3) break;
  }
  return unique;
};

export const matchHeadings = (entries, pages, printedToPdf, log = () => {}) => {
  const results = entries.map(entry => {
    const target = printedToPdf.get(entry.page);
    if (target === undefined) return null;
    const indices = [target, target - 1, target + 1, target - 2, target + 2].filter(i => i >= 0 && i < pages.length);
    const candidates = shortlist(entry.title, pages, indices);
    // Prefer the printed page when it has strong evidence; a repeated heading
    // on an adjacent page must not move a correctly mapped destination.
    const onTarget = candidates.find(c => c.pageIndex === target && c.score >= 0.9);
    const best = onTarget || candidates[0];
    const verified = best && best.score >= (normalizeHeading(entry.title).length < 14 ? 0.96 : 0.9) && best.heading;
    return { pageIndex: verified ? best.pageIndex : target, confidence: verified ? 'verified' : 'uncertain', method: 'printed-page', candidates };
  });
  for (let index = 0; index < entries.length; index++) {
    if (results[index]) continue;
    // Only confirmed matches constrain searches. A failed fallback never
    // becomes an anchor for the entries that follow it.
    let lower = 0, upper = pages.length - 1, hasPrevious = false;
    for (let i = index - 1; i >= 0; i--) if (results[i]?.confidence === 'verified') { lower = results[i].pageIndex; hasPrevious = true; break; }
    for (let i = index + 1; i < results.length; i++) if (results[i]?.confidence === 'verified') { upper = results[i].pageIndex; break; }
    if (upper < lower) [lower, upper] = [0, pages.length - 1];
    const candidates = shortlist(entries[index].title, pages, Array.from({ length: upper - lower + 1 }, (_, i) => lower + i));
    const best = candidates[0];
    const strong = best?.heading && best.score >= 0.96;
    const unique = strong && !candidates.some(c => c.pageIndex !== best.pageIndex && c.score >= best.score - 0.02);
    // A numberless parent often shares its first child's opening page.
    const child = entries[index + 1]?.level > entries[index].level ? results[index + 1] : null;
    results[index] = { pageIndex: strong ? best.pageIndex : child?.pageIndex ?? (hasPrevious ? lower : upper), confidence: unique ? 'verified' : strong || child ? 'uncertain' : 'unverified', method: strong ? 'title' : 'fallback', candidates };
  }
  // Resolve missing parent sheets from their descendants, in reverse order so
  // several missing levels all land on the first available child destination.
  for (let i = entries.length - 2; i >= 0; i--) {
    if (results[i].method === 'fallback' && entries[i + 1].level > entries[i].level && results[i + 1].confidence !== 'unverified') {
      results[i].pageIndex = results[i + 1].pageIndex;
      results[i].confidence = 'uncertain';
      results[i].method = 'first-child';
    }
  }
  log(`[System] Local heading matches: ${results.filter(r => r.confidence === 'verified').length}/${entries.length} verified.`);
  return results;
};
