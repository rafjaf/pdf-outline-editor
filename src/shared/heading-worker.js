import { extractPageLayout, prepareHeadingPages, buildPrintedPageMap, matchHeadings } from './heading-matcher.js';

// PDF.js already extracts text in its own worker. Layout indexing and matching
// also belong off the UI thread, especially when importing hundreds of titles.
const pages = [];
self.onmessage = ({ data: { id, operation, content, viewport, entries } }) => {
  try {
    let result;
    if (operation === 'page') {
      const [a, b, c, d, e, f] = viewport.transform;
      pages.push(extractPageLayout(content, {
        height: viewport.height,
        convertToViewportPoint: (x, y) => [a * x + c * y + e, b * x + d * y + f]
      }));
    } else if (operation === 'match') {
      const log = message => self.postMessage({ log: message });
      log('[System] Indexing page layouts in the background...');
      prepareHeadingPages(pages);
      const map = buildPrintedPageMap(pages, log);
      log('[System] Matching headings in the background...');
      result = matchHeadings(entries, pages, map, log);
    } else {
      throw new Error(`Unknown heading worker operation: ${operation}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
