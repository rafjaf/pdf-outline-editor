import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { detectPdfHeadings } from '../src/renderer/heading-detection.js';

// Execute the real browser worker in a Node thread with a small Web Worker
// adapter, so cancellation and the message protocol are covered by npm test.
const terminations = [];
class BrowserWorker {
  constructor(url) {
    this.worker = new NodeWorker(`
      const { parentPort } = require('node:worker_threads');
      globalThis.self = { postMessage: data => parentPort.postMessage(data) };
      import(${JSON.stringify(url.href)}).then(() => {
        parentPort.on('message', data => self.onmessage({ data }));
      });
    `, { eval: true });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(data) { this.worker.postMessage(data); }
  terminate() { terminations.push(this.worker.terminate()); }
}

const pdf = {
  numPages: 5,
  getPage: async number => ({
    getViewport: () => ({ height: 1000, transform: [1, 0, 0, -1, 0, 1000] }),
    getTextContent: async () => ({ items: [
      { str: 'Section 1. Conditions', width: 180, transform: [16, 0, 0, 16, 40, 800] },
      { str: 'A line of body text.', width: 200, transform: [10, 0, 0, 10, 40, 750] },
      { str: 'Another line of body text.', width: 200, transform: [10, 0, 0, 10, 40, 736] },
      { str: String(number + 9), width: 10, transform: [8, 0, 0, 8, 230, 100] }
    ] })
  })
};

test('background detection delivers correct destinations and yields to the UI event loop', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = BrowserWorker;
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 5);
  try {
    const results = await detectPdfHeadings(pdf, [{ title: 'Section 1. Conditions', page: 11, level: 1 }]);
    assert.equal(results[0].pageIndex, 1);
    assert.equal(results[0].confidence, 'verified');
    assert.ok(ticks > 0, 'main-thread timers must run during background detection');
  } finally {
    clearInterval(heartbeat);
    globalThis.Worker = previousWorker;
    await Promise.all(terminations.splice(0));
  }
});

test('cancellation terminates background indexing and rejects without applying results', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = BrowserWorker;
  const controller = new AbortController();
  try {
    await assert.rejects(detectPdfHeadings(pdf, [{ title: 'Section 1. Conditions', page: 11, level: 1 }], {
      signal: controller.signal,
      log: message => { if (message.includes('Indexing page layouts')) controller.abort(); }
    }), { name: 'AbortError' });
    assert.ok(terminations.length > 0, 'cancellation must terminate the worker');
  } finally {
    globalThis.Worker = previousWorker;
    await Promise.all(terminations.splice(0));
  }
});

test('Cancel does not wait for an outstanding PDF.js text read', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = BrowserWorker;
  const controller = new AbortController();
  let readingText = false;
  const waitingPdf = { numPages: 1, getPage: async () => ({ getTextContent: () => {
    readingText = true;
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } }) };
  try {
    const detection = detectPdfHeadings(waitingPdf, [], { signal: controller.signal });
    await assert.rejects(detection, { name: 'AbortError' });
    assert.equal(readingText, true, 'cancel must interrupt a text read already in progress');
  } finally {
    globalThis.Worker = previousWorker;
    await Promise.all(terminations.splice(0));
  }
});
