// The demo tools against a real Contoso Order Entry. Skipped unless
// CONTOSO_URL points at one (npm start in nuksee/contoso-order-entry):
//
//   CONTOSO_URL=http://localhost:5080 npm test
//
// It resets the app's data and drift switches before and after. The last
// tests turn on rename drift and check the heal.

import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { autoApprover, type Approver } from '../src/approval/gate.js';
import { build } from '../src/compiler/build.js';
import { appConfig } from '../src/compiler/compile.js';
import type { LearnedTask } from '../src/formats/task.js';
import type { ToolSpec } from '../src/formats/tool.js';
import { loadGraph } from '../src/learner/learn.js';
import type { Session } from '../src/runner/run.js';
import { Workspace } from '../src/workspace.js';

const URL_ = process.env.CONTOSO_URL;
const EXAMPLES = new URL('../examples/contoso/', import.meta.url);

const admin = (path: string, body: object = {}) =>
  fetch(new URL(`/__admin/${path}`, URL_), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Contoso Order Entry: compile and run the three demo tools', { skip: !URL_ && 'set CONTOSO_URL to run' }, () => {
  let dir: string;
  let ws: Workspace;
  let session: Session;
  let tools: Map<string, ToolSpec>;

  before(async () => {
    await admin('reset');
    dir = await mkdtemp(join(tmpdir(), 'legacylink-contoso-'));
    await cp(new URL('tasks', EXAMPLES), join(dir, 'tasks'), { recursive: true });
    ws = new Workspace(dir);
    const graph = await loadGraph(new URL('graph.json', EXAMPLES).pathname);
    graph.app.baseUrl = URL_!;
    await writeFile(ws.graphFile, JSON.stringify(graph)); // the healer reads it
    const config = appConfig(graph, { user: 'demo', passwordEnv: 'CONTOSO_PASSWORD' });
    session = ws.session(config, { env: { CONTOSO_PASSWORD: 'demo' } });
    const tasks = await Promise.all(
      ['get_customer_details', 'get_order_status', 'create_sales_order'].map(async (n) => JSON.parse(await readFile(join(dir, 'tasks', `${n}.json`), 'utf8')) as LearnedTask),
    );
    const examples = JSON.parse(await readFile(new URL('examples.json', EXAMPLES), 'utf8'));
    await build({ graph, tasks, examples, registry: ws.registry, session, approve: autoApprover() });
    tools = new Map((await ws.registry.current()).map((s) => [s.name, s]));
  });
  after(async () => {
    await session?.close();
    await admin('reset');
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const run = (name: string, input: Record<string, unknown>) => session.run(tools.get(name)!, input, { approve: autoApprover(), tools: (n) => tools.get(n) });

  it('get_customer_details reads C1003 with money parsed and its orders', async () => {
    const r = await run('get_customer_details', { customerId: 'C1003' });
    assert.equal(r.outcome, 'ok');
    assert.equal(r.output!.name, 'Adventure Works');
    assert.equal(typeof r.output!.creditLimit, 'number');
    assert.ok(Array.isArray(r.output!.orders));
  });

  it('get_order_status leaves "-" fields out and reads the customer as shown', async () => {
    const r = await run('get_order_status', { orderNumber: 'SO-10044' });
    assert.equal(r.outcome, 'ok', JSON.stringify(r.error));
    assert.match(String(r.output!.customer), /^C\d{4} - /);
    assert.equal(typeof r.output!.total, 'number');
  });

  it('create_sales_order saves after approval and proves it by reading the order back', async () => {
    const r = await run('create_sales_order', { customerId: 'C1001', shipTo: 'Northwind Traders\nDock 4', lines: [{ product: 'P-300', qty: 2 }] });
    assert.equal(r.outcome, 'ok', JSON.stringify(r.error));
    assert.match(String(r.output!.orderNumber), /^SO-\d+$/);
    assert.equal(r.postcondition, 'passed');
  });

  it("the app's own errors come back typed: unknown order, unknown customer, credit limit", async () => {
    assert.deepEqual((await run('get_order_status', { orderNumber: 'SO-1' })).error?.message, 'Order SO-1 was not found.');
    const nf = await run('create_sales_order', { customerId: 'C9999', shipTo: 'x', lines: [{ product: 'P-100', qty: 1 }] });
    assert.equal(nf.outcome, 'app_error');
    assert.match(nf.error!.message, /Customer C9999 was not found/);
    const credit = await run('create_sales_order', { customerId: 'C1003', shipTo: 'x', lines: [{ product: 'P-400', qty: 999 }] });
    assert.equal(credit.outcome, 'app_error');
    assert.match(credit.error!.message, /Credit limit exceeded/);
  });

  it('a rejected order saves nothing', async () => {
    const r = await session.run(tools.get('create_sales_order')!, { customerId: 'C1002', shipTo: 'x', lines: [{ product: 'P-100', qty: 1 }] }, { approve: autoApprover('rejected') });
    assert.equal(r.outcome, 'rejected');
  });

  it('move drift needs no heal: buttons are found by role and id, not position', async () => {
    await admin('drift', { move: true });
    const r = await run('create_sales_order', { customerId: 'C1002', shipTo: 'x', lines: [{ product: 'P-100', qty: 1 }] });
    assert.equal(r.outcome, 'ok', JSON.stringify(r.error));
  });

  it('rename drift fails with locator_failed on the renamed control when nothing heals it', async () => {
    await admin('drift', { rename: true, move: false });
    const r = await run('get_order_status', { orderNumber: 'SO-10041' });
    assert.equal(r.outcome, 'failed');
    assert.deepEqual([r.error?.reason, r.error?.key], ['locator_failed', 'orderNumber']);
  });

  it('rename + move: the write heals before its approval, and its readBack heals the read', async () => {
    await admin('drift', { rename: true, move: true });
    const healer = ws.healer({ mode: 'heuristic' });
    const asked: { healed: boolean; heal?: string[] }[] = [];
    const approve: Approver = (req) => {
      asked.push({ healed: req.healedSinceLastApproval, heal: req.heal });
      return autoApprover()(req);
    };
    const r = await session.run(tools.get('create_sales_order')!, { customerId: 'C1002', shipTo: 'x', lines: [{ product: 'P-100', qty: 1 }] }, { approve, tools: (n) => tools.get(n), healer });
    assert.equal(r.outcome, 'ok', JSON.stringify(r.error));
    assert.equal(r.healed?.status, 'healed');
    assert.deepEqual(r.healed?.changes.map((c) => [c.key, c.after]), [
      ['customerId', '"Account No.:" #ctl00_MainContent_txtAccountNo'],
      ['saveOrder', '"Submit Order" #ctl00_MainContent_btnSubmit'],
    ]);
    // One approval, after the heal, flagged and annotated.
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.healed, true);
    assert.equal(asked[0]!.heal?.length, 2);
    const entries = await ws.registry.entries();
    assert.equal(entries.create_sales_order?.version, 2);
    assert.equal(entries.get_order_status?.version, 2, 'the readBack healed get_order_status on the way');

    const read = await session.run((await ws.registry.get('get_order_status'))!, { orderNumber: 'SO-10041' }, { healer });
    assert.equal(read.outcome, 'ok');
    assert.equal(read.healed, undefined, 'v2 needs no heal');
  });

  it('undoing the rename heals back to the original controls', async () => {
    await admin('drift', { rename: false, move: false });
    const r = await session.run((await ws.registry.get('get_order_status'))!, { orderNumber: 'SO-10041' }, { healer: ws.healer({ mode: 'heuristic' }) });
    assert.equal(r.outcome, 'ok', JSON.stringify(r.error));
    assert.deepEqual(r.healed?.changes.map((c) => c.after), ['"Order #:" #ctl00_MainContent_txtOrderNumber', '"Look Up" #ctl00_MainContent_btnLookup']);
  });
});
