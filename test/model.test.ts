import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createModel, ModelError } from '../src/model/client.js';
import type { AnalyzeScreenInput } from '../src/model/types.js';
import { RunLog } from '../src/runlog/runlog.js';

const input: AnalyzeScreenInput = {
  url: '/Orders/Status.aspx',
  title: 'Contoso Order Entry - Order Status',
  heading: 'Order Status',
  landmarks: ['Find Order'],
  elements: [
    { ref: 'e1', kind: 'input', tag: 'input', id: 'ctl00_MainContent_txtOrderNumber', label: 'Order #:' },
    { ref: 'e2', kind: 'button', tag: 'input', text: 'Look Up' },
  ],
  knownScreens: [],
  screenshot: 'iVBORw0KGgo=',
};

const good = {
  name: 'Order Status',
  purpose: 'Look up a sales order by number.',
  elements: [
    { ref: 'e1', key: 'orderNumber', intent: 'the sales order number to look up' },
    { ref: 'e2', key: 'lookUp', intent: 'runs the lookup', role: 'search' },
  ],
  nextActions: [{ ref: 'e2' }],
};

describe('model client', () => {
  let dir: string;
  let calls: { body: any; auth: string | null }[];
  let answers: unknown[];
  const realFetch = globalThis.fetch;
  const env = { MODEL_API_KEY: 'test-key', MUSE_BASE_URL: 'https://muse.test/v1' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legacylink-model-'));
    calls = [];
    answers = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
      const content = answers.shift();
      return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to the heuristic stand-in without an API key', () => {
    assert.equal(createModel({ cacheDir: dir, env: {} }).mode, 'heuristic');
    assert.equal(createModel({ cacheDir: dir, env }).mode, 'live');
  });

  it('retries once with the validation errors, then records the answer', async () => {
    answers.push({ ...good, elements: good.elements.slice(0, 1) }, good);
    const model = createModel({ cacheDir: join(dir, 'cache'), env, runLog: new RunLog(join(dir, 'runs')) });
    assert.deepEqual(await model.analyzeScreen(input), good);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.auth, 'Bearer test-key');
    assert.equal(calls[0]!.body.response_format.type, 'json_schema');
    assert.equal(calls[0]!.body.messages[1].content[1].type, 'image_url');
    assert.match(calls[1]!.body.messages[1].content[0].text, /ref "e2" was not named/);

    const [log] = await readdir(join(dir, 'runs'));
    const event = JSON.parse((await readFile(join(dir, 'runs', log!), 'utf8')).trim());
    assert.equal(event.type, 'model_call');
    assert.equal(event.prompt, 'explore-screen');
    assert.equal(event.tokensIn, 200);
    assert.equal(event.cached, false);
  });

  it('replays a recorded answer with no API call, even with a new screenshot', async () => {
    answers.push(good);
    await createModel({ cacheDir: dir, env }).analyzeScreen(input);
    const replay = createModel({ cacheDir: dir, mode: 'replay', env: {} });
    assert.deepEqual(await replay.analyzeScreen({ ...input, screenshot: 'different' }), good);
    assert.equal(calls.length, 1);
    await assert.rejects(replay.analyzeScreen({ ...input, title: 'Other' }), ModelError);
  });

  it('fails the stage after two invalid answers', async () => {
    answers.push('not json', { name: 'x' });
    await assert.rejects(createModel({ cacheDir: dir, env }).analyzeScreen(input), /failed validation twice/);
  });
});
