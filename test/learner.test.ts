import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ScreenGraph } from '../src/formats/graph.js';
import { learnGraph, type LearnGraph, type TaskBody } from '../src/formats/task.js';
import { checkTaskBody, validateLearnedTask } from '../src/formats/validate.js';
import { learn, LearnError, loadGraph, writeTask } from '../src/learner/learn.js';
import { createModel } from '../src/model/client.js';
import { heuristicModel } from '../src/model/heuristic.js';

const CONTOSO = new URL('../examples/contoso/graph.json', import.meta.url).pathname;
const TASKS = {
  customer: "Look up a customer's details, credit and orders by customer number",
  status: 'Get the status of a sales order by its order number',
  order: 'Create a sales order for a customer with up to three product lines',
};

let graph: ScreenGraph;
let view: LearnGraph;
before(async () => {
  graph = await loadGraph(CONTOSO);
  view = learnGraph(graph);
});

const learnIt = (task: string) => learn({ graph, task, model: heuristicModel, now: () => new Date('2026-10-27T10:00:00Z') });
const ops = (t: TaskBody) => t.steps.map((s) => s.op);

describe('learn the demo tasks from the Contoso graph (heuristic)', () => {
  it('get_customer_details: search, open the row, read the details and orders', async () => {
    const t = await learnIt(TASKS.customer);
    assert.equal(t.name, 'get_customer_details');
    assert.equal(t.access, 'read');
    assert.deepEqual(t.inputSchema.required, ['customerId']);
    assert.deepEqual(ops(t).slice(0, 4), ['open', 'fill', 'click', 'clickRow']);
    assert.deepEqual(t.steps[3], {
      op: 'clickRow',
      screen: 'customer-inquiry',
      element: 'customersSelectLink',
      edge: 'customer-inquiry:customersSelectLink',
      match: { column: 'Customer #', value: '$input.customerId' },
    });
    const props = t.outputSchema.properties as Record<string, { type: string }>;
    assert.deepEqual(Object.keys(props), ['customerId', 'name', 'contact', 'phone', 'cityState', 'creditLimit', 'balance', 'available', 'orders']);
    assert.equal(props.available!.type, 'number');
    assert.equal(props.orders!.type, 'array');
    assert.deepEqual(t.provenance, { task: TASKS.customer, graphExploredAt: graph.exploredAt, learnedAt: '2026-10-27T10:00:00.000Z', model: 'heuristic' });
  });

  it('get_order_status: look up on the same screen and read the result', async () => {
    const t = await learnIt(TASKS.status);
    assert.equal(t.name, 'get_order_status');
    assert.deepEqual(ops(t).slice(0, 3), ['open', 'fill', 'click']);
    assert.deepEqual(t.steps[2], { op: 'click', screen: 'order-status', element: 'lookUp', edge: 'order-status:lookUp' });
    assert.deepEqual(t.outputSchema.required, ['orderNumber']);
    assert.ok(t.steps.some((s) => s.op === 'read' && s.element === 'status' && s.into === 'status'));
  });

  it('create_sales_order: fill the form, loop the lines, one commit, result after it', async () => {
    const t = await learnIt(TASKS.order);
    assert.equal(t.name, 'create_sales_order');
    assert.equal(t.access, 'write');
    assert.deepEqual(ops(t), ['open', 'fill', 'fill', 'fill', 'select', 'forEach', 'click', 'readAfterCommit']);
    assert.deepEqual(t.inputSchema.required, ['customerId', 'shipTo', 'lines']);
    const lines = (t.inputSchema.properties as any).lines;
    assert.equal(lines.maxItems, 3);
    assert.deepEqual(lines.items.properties.product.enum, ['P-100', 'P-110', 'P-200', 'P-300', 'P-400']);
    assert.equal(lines.items.properties.qty.type, 'integer');
    assert.deepEqual(t.steps[6], { op: 'click', screen: 'new-sales-order', element: 'saveOrder', edge: 'new-sales-order:saveOrder' });
    assert.deepEqual(t.outputSchema.required, ['orderNumber']);
  });

  it('matches the checked-in examples', async () => {
    for (const [file, task] of [['get_customer_details', TASKS.customer], ['get_order_status', TASKS.status], ['create_sales_order', TASKS.order]] as const) {
      const example = JSON.parse(await readFile(new URL(`../examples/contoso/tasks/${file}.json`, import.meta.url), 'utf8'));
      const learned = await learn({ graph, task, model: heuristicModel, now: () => new Date(example.provenance.learnedAt) });
      assert.deepEqual(learned, example, file);
    }
  });

  it('writes the task to tasks/<name>.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legacylink-learn-'));
    try {
      const t = await learnIt(TASKS.status);
      const file = await writeTask(dir, t);
      assert.equal(file, join(dir, 'tasks', 'get_order_status.json'));
      assert.deepEqual(validateLearnedTask(JSON.parse(await readFile(file, 'utf8')), view), { ok: true, value: t });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('learned task checks against the graph', () => {
  let order: TaskBody;
  let status: TaskBody;
  before(async () => {
    const { formatVersion: _, provenance: __, ...o } = await learnIt(TASKS.order);
    const { formatVersion: ___, provenance: ____, ...s } = await learnIt(TASKS.status);
    order = o;
    status = s;
  });
  const copy = (t: TaskBody): TaskBody => structuredClone(t);

  it('rejects names that are not in the graph', () => {
    const t = copy(status);
    t.steps[1] = { op: 'fill', screen: 'order-status', element: 'txtOrderNumber', value: '$input.orderNumber' };
    t.steps.splice(1, 0, { op: 'open', screen: 'order-search' });
    const errors = checkTaskBody(t, view);
    assert.ok(errors.includes('/steps/1 unknown screen "order-search"'), errors.join('\n'));
    assert.ok(errors.some((e) => e.includes('element "txtOrderNumber" is not on "order-status"')), errors.join('\n'));
  });

  it('rejects a step on a screen the app is not on', () => {
    const t = copy(status);
    t.steps[0] = { op: 'open', screen: 'main-menu' };
    assert.ok(checkTaskBody(t, view).some((e) => e.startsWith('/steps/1 is on "order-status", but the steps before it leave the app on "main-menu"')));
  });

  it('rejects an edge that does not start from the clicked control', () => {
    const t = copy(status);
    t.steps[2] = { op: 'click', screen: 'order-status', element: 'lookUp', edge: 'order-status:homeLink' };
    assert.ok(checkTaskBody(t, view).some((e) => e.includes('starts from "order-status" via "homeLink"')));
  });

  it('never lets a read task press a commit control', () => {
    const t = copy(order);
    t.access = 'read';
    const errors = checkTaskBody(t, view);
    assert.ok(errors.includes('/steps/6 a read task must never press a commit control'), errors.join('\n'));
  });

  it('needs exactly one commit in a write, with nothing but reads after it', () => {
    const none = copy(order);
    none.steps.splice(6, 1);
    assert.ok(checkTaskBody(none, view).includes('a write task needs exactly one commit click, found 0'));
    const after = copy(order);
    after.steps.push({ op: 'fill', screen: 'new-sales-order', element: 'poNumber', value: 'X' });
    assert.ok(checkTaskBody(after, view).includes('/steps/8 comes after the commit; only readAfterCommit may follow it'));
  });

  it('checks inputs are used, outputs produced and schemas compile', () => {
    const t = copy(status);
    (t.inputSchema.properties as any).extra = { type: 'string' };
    (t.outputSchema.properties as any).missing = { type: 'strng' };
    const errors = checkTaskBody(t, view);
    assert.ok(errors.includes('input "extra" is never used'));
    assert.ok(errors.includes('output "missing" is never produced'));
    assert.ok(errors.some((e) => e.startsWith('/outputSchema is not a valid JSON Schema')));
  });

  it('checks forEach rows exist and select enums are real options', () => {
    const t = copy(order);
    const lines = (t.inputSchema.properties as any).lines;
    lines.maxItems = 4;
    lines.items.properties.product.enum.push('P-999');
    const errors = checkTaskBody(t, view);
    assert.ok(errors.includes('/steps/5/steps/0 element "product4" is not on "new-sales-order"'), errors.join('\n'));
    assert.ok(errors.includes('/steps/5/steps/0 enum values ["P-999"] are not options of "product1"'), errors.join('\n'));
  });
});

describe('learn with the live model client', () => {
  let dir: string;
  let answers: unknown[];
  let calls: any[];
  const realFetch = globalThis.fetch;
  const env = { MODEL_API_KEY: 'test-key', MUSE_BASE_URL: 'https://muse.test/v1' };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legacylink-learn-'));
    answers = [];
    calls = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }], usage: {} }));
    }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it('sends the graph without locators, retries once with graph errors, then replays', async () => {
    const good = await heuristicModel.learnTask({ task: TASKS.status, graph: view });
    const bad = structuredClone(good);
    bad.steps[2] = { op: 'click', screen: 'order-status', element: 'lookUp', edge: 'order-status:find' };
    answers.push(bad, good);
    const model = createModel({ cacheDir: dir, env });
    const t = await learn({ graph, task: TASKS.status, model });
    assert.equal(t.provenance.model, 'muse-spark-1.3');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].response_format.json_schema.name, 'learned_task');
    assert.doesNotMatch(calls[0].messages[1].content, /"locators"/);
    assert.match(calls[1].messages[1].content, /unknown edge "order-status:find"/);

    const replay = await learn({ graph, task: TASKS.status, model: createModel({ cacheDir: dir, mode: 'replay', env: {} }) });
    assert.deepEqual(replay.steps, good.steps);
    assert.equal(calls.length, 2);
  });

  it('fails the stage when the answer is still wrong after the retry', async () => {
    const good = await heuristicModel.learnTask({ task: TASKS.order, graph: view });
    const bad = { ...good, access: 'read' };
    answers.push(bad, bad);
    await assert.rejects(learn({ graph, task: TASKS.order, model: createModel({ cacheDir: dir, env }) }), /failed validation twice.*commit control/s);
  });

  it('rejects a bad graph file', async () => {
    const file = join(dir, 'graph.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(file, JSON.stringify({ ...graph, edges: [{ ...graph.edges[0], to: 'nowhere' }] })));
    await assert.rejects(loadGraph(file), LearnError);
  });
});
