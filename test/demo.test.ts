// The pieces the scripted demo relies on that don't need a running Contoso.
// The demo itself: `legacylink demo --contoso ../contoso-order-entry --repeat 10`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { DEMO_TASKS, fitToSchema } from '../src/demo/demo.js';
import { learn } from '../src/learner/learn.js';
import { createModel } from '../src/model/client.js';
import { learnGraph } from '../src/formats/task.js';
import { coerceToSchema } from '../src/runner/run.js';

const examples = new URL('../examples/contoso/', import.meta.url);

describe('demo', () => {
  it('fits the example input to the names the learner chose', () => {
    const muse = {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        lines: { type: 'array', items: { type: 'object', properties: { productId: { type: 'string' }, quantity: { type: 'integer' } } } },
      },
    };
    assert.deepEqual(fitToSchema({ customerId: 'C1003', lines: [{ product: 'P-200', qty: 3 }] }, muse), { customerId: 'C1003', lines: [{ productId: 'P-200', quantity: 3 }] });
    const heuristic = { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: { product: {}, qty: {} } } } } };
    assert.deepEqual(fitToSchema({ lines: [{ product: 'P-200', qty: 3 }] }, heuristic), { lines: [{ product: 'P-200', qty: 3 }] });
  });

  it('types grid cells by the output schema', () => {
    const schema = { type: 'object', properties: { total: { type: 'number' }, lines: { type: 'array', items: { type: 'object', properties: { qty: { type: 'integer' }, unitPrice: { type: 'number' }, sku: { type: 'string' } } } } } };
    assert.deepEqual(coerceToSchema({ total: '$1,720.00', lines: [{ qty: '40', unitPrice: '$18.00', sku: 'P-200' }] }, schema), { total: 1720, lines: [{ qty: 40, unitPrice: 18, sku: 'P-200' }] });
  });

  it("the learner's view has no exploration date, so recorded learn answers replay after a fresh explore", async () => {
    const graph = JSON.parse(await readFile(new URL('graph.json', examples), 'utf8'));
    const a = learnGraph(graph);
    const b = learnGraph({ ...graph, exploredAt: '2026-11-04T09:00:00.000Z' });
    assert.deepEqual(a, b);
  });

  it('the checked-in Muse Spark recordings answer all three demo tasks in replay', async () => {
    const graph = JSON.parse(await readFile(new URL('graph.json', examples), 'utf8'));
    const model = createModel({ mode: 'replay', cacheDir: new URL('model-cache', examples).pathname });
    const names = [];
    for (const task of DEMO_TASKS) names.push((await learn({ graph, task, model })).name);
    assert.deepEqual(names, ['get_customer_details', 'get_order_status', 'create_sales_order']);
  });
});
