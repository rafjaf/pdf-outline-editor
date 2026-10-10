import test from 'node:test';
import assert from 'node:assert/strict';
import { planHeadingAi, refineHeadingsWithAi, applyHeadingAiResponse, HEADING_AI_LIMITS, HEADING_AI_SYSTEM_PROMPT } from '../src/shared/heading-ai.js';

const fixture = (count = 1) => ({
  entries: Array.from({ length: count }, () => ({ title: 'Section 1. Contract formation', page: 11, level: 1 })),
  results: Array.from({ length: count }, () => ({ pageIndex: 10, confidence: 'uncertain', method: 'printed-page', candidates: [{ text: 'Section 1. Formation of a contract', heading: true, pageIndex: 11, score: 0.7 }] }))
});

test('AI input and request budgets stay bounded even for a thousand entries', () => {
  const { entries, results } = fixture(1000);
  entries[0].title = 'A'.repeat(10000); // oversized entries cannot defeat a cap
  const plan = planHeadingAi(entries, results);
  assert.ok(plan.batches.length <= HEADING_AI_LIMITS.requests);
  assert.ok(plan.promptBytes <= HEADING_AI_LIMITS.promptBytes);
  assert.ok(plan.batches.every(b => b.promptBytes <= HEADING_AI_LIMITS.batchBytes));
  assert.ok(plan.batches.every(b => b.entries.length <= HEADING_AI_LIMITS.entriesPerBatch));
  assert.equal(plan.promptBytes, plan.batches.reduce((sum, b) => sum + new TextEncoder().encode(HEADING_AI_SYSTEM_PROMPT + b.text).length, 0));
});

test('verified matches, absent parent sheets and weak candidates cost no AI calls', async () => {
  const { entries, results } = fixture(3);
  results[0].confidence = 'verified';
  results[1].method = 'first-child';
  results[2].candidates[0].score = 0.2;
  await refineHeadingsWithAi(entries, results, { request: () => assert.fail('AI should be skipped') });
});

test('identical headings on several pages do not justify an AI request', () => {
  const { entries, results } = fixture();
  results[0].candidates.push({ ...results[0].candidates[0], pageIndex: 12 });
  assert.equal(planHeadingAi(entries, results).batches.length, 0);
});

test('AI may select only an offered candidate with a real supporting quote', () => {
  const { entries, results } = fixture();
  const batch = planHeadingAi(entries, results).batches[0];
  const apply = match => applyHeadingAiResponse(JSON.stringify({ matches: [match] }), batch, results);
  assert.equal(apply({ entryId: 0, candidateId: 'invented', quote: 'Section 1' }), 0);
  assert.equal(apply({ entryId: 0, candidateId: '0:0', quote: 'Imaginary heading text' }), 0);
  assert.equal(apply({ entryId: 99, candidateId: '0:0', quote: 'Formation of a contract' }), 0);
  assert.equal(apply({ entryId: 0, candidateId: '0:0', pageIndex: 9999, quote: 'Formation of a contract' }), 1);
  assert.equal(results[0].pageIndex, 11, 'model-supplied page index is ignored');
  assert.equal(results[0].confidence, 'uncertain');
  assert.equal(results[0].method, 'ai');
});

test('AI responses cannot cross verified neighbours', () => {
  const { entries, results } = fixture(3);
  results[0] = { confidence: 'verified', pageIndex: 12 };
  results[2] = { confidence: 'verified', pageIndex: 15 };
  const batch = planHeadingAi(entries, results).batches[0];
  assert.equal(applyHeadingAiResponse(JSON.stringify({ matches: [{ entryId: 1, candidateId: '1:0', quote: 'Formation of a contract' }] }), batch, results), 0);
});

test('provider failure and malformed output retain local matches without retries', async () => {
  for (const request of [async () => { throw new Error('Provider unavailable'); }, async () => 'invalid JSON']) {
    const { entries, results } = fixture(100);
    const before = structuredClone(results);
    let calls = 0;
    await refineHeadingsWithAi(entries, results, { request: async args => { calls++; assert.equal(args.maxOutputTokens, 1500); return request(); } });
    assert.equal(calls, 1);
    assert.deepEqual(results, before);
  }
});

test('AI cancellation propagates before the first call and after an outstanding call', async () => {
  const { entries, results } = fixture();
  const controller = new AbortController();
  await assert.rejects(refineHeadingsWithAi(entries, results, { signal: controller.signal, request: async () => { controller.abort(); return '{"matches":[]}'; } }), { name: 'AbortError' });
  await assert.rejects(refineHeadingsWithAi(entries, results, { signal: controller.signal, request: () => assert.fail('Already aborted') }), { name: 'AbortError' });
});
