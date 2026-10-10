// PDF.js text reads do not accept AbortSignal. Stop waiting immediately on
// cancellation; PDF.js may finish its current read, but no result is applied.
const abortableRead = (promise, signal) => {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Import cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
};

// Keep the renderer free to paint progress, accept input and cancel an import.
export const detectPdfHeadings = async (pdf, entries, { signal, log = () => {} } = {}) => {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('../shared/heading-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let sequence = 0;
  let failure = null;
  const rejectPending = error => {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    if (data.log) { log(data.log); return; }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  worker.onerror = event => {
    event.preventDefault();
    rejectPending(new Error(event.message || 'Background heading detection failed'));
  };
  const abort = () => {
    worker.terminate();
    rejectPending(signal.reason || new DOMException('Import cancelled', 'AbortError'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  const request = data => {
    signal?.throwIfAborted();
    if (failure) throw failure;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...data });
    });
  };
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      signal?.throwIfAborted();
      if (pageNumber === 1 || pageNumber % 50 === 0) log(`  Scanning page ${pageNumber}/${pdf.numPages} locally...`);
      const page = await abortableRead(pdf.getPage(pageNumber), signal);
      const content = await abortableRead(page.getTextContent(), signal);
      const viewport = page.getViewport({ scale: 1 });
      // Waiting for each worker reply also yields the renderer event loop,
      // even when PDF.js serves text from its cache immediately.
      await request({ operation: 'page', content, viewport: { height: viewport.height, transform: viewport.transform } });
    }
    return await request({ operation: 'match', entries });
  } finally {
    signal?.removeEventListener('abort', abort);
    worker.terminate();
    pending.clear();
  }
};
