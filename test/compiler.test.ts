import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { compileDraft, loginSpec, pendingTargets } from '../src/compiler/compile.js';
import type { ScreenGraph } from '../src/formats/graph.js';
import type { LearnedTask } from '../src/formats/task.js';
import type { Step, ToolSpec } from '../src/formats/tool.js';
import { loadGraph } from '../src/learner/learn.js';
import { validateToolSpec } from '../src/registry/registry.js';
import { evalExpr, parseValue, pickDiscovered } from '../src/runner/run.js';

const EXAMPLES = new URL('../examples/contoso/', import.meta.url);
const task = async (name: string) => JSON.parse(await readFile(new URL(`tasks/${name}.json`, EXAMPLES), 'utf8')) as LearnedTask;
const NOW = () => new Date('2026-10-27T10:00:00Z');

let graph: ScreenGraph;
let examples: Record<string, Record<string, unknown>>;
before(async () => {
  graph = await loadGraph(fileURLToPath(new URL('graph.json', EXAMPLES)));
  examples = JSON.parse(await readFile(new URL('examples.json', EXAMPLES), 'utf8'));
});

const draft = async (name: string, readTools: ToolSpec[] = []) => compileDraft({ task: await task(name), graph, example: examples[name]!, readTools, now: NOW });
const ops = (s: ToolSpec) => s.steps.map((x) => x.op);

describe('compile the Contoso tasks (draft, no browser)', () => {
  it('finds the login form in the graph', () => {
    const login = loginSpec(graph)!;
    assert.equal(login.url, '/Login.aspx');
    assert.deepEqual([login.user.key, login.password.key, login.submit.key], ['userName', 'password', 'logIn']);
  });

  it('get_customer_details: login, search, open the matching row, wait for the details, read', async () => {
    const s = await draft('get_customer_details');
    assert.deepEqual(ops(s).slice(0, 7), ['ensureLogin', 'goto', 'fill', 'click', 'waitForScreen', 'clickRow', 'waitForScreen']);
    const row = s.steps.find((x) => x.op === 'clickRow') as Extract<Step, { op: 'clickRow' }>;
    assert.equal(row.grid.key, 'customersGrid');
    assert.equal(row.link.key, 'customersSelectLink');
    assert.deepEqual(row.match, { column: 'Customer #', value: '$input.customerId' });
    assert.equal(s.steps[s.steps.indexOf(row) + 1]!.op, 'waitForScreen');
    assert.deepEqual(Object.keys(s.screens).sort(), ['customer-details', 'customer-inquiry']);
    assert.deepEqual(s.postcondition.checks, [
      { check: 'onScreen', screen: 'customer-details' },
      { check: 'outputMatches', path: 'customerId', equals: '$input.customerId' },
    ]);
    assert.deepEqual(s.errors.map((e) => e.code), ['app_error']);
    assert.equal(pendingTargets(s), 0);
    assert.deepEqual(validateToolSpec(s), { ok: true, value: s });
  });

  it('get_order_status: money and dates keep their parse, the output must echo the order number', async () => {
    const s = await draft('get_order_status');
    const total = s.steps.find((x) => x.op === 'extract' && x.into === 'total');
    assert.deepEqual(total && 'parse' in total && total.parse, 'money');
    assert.ok(s.postcondition.checks.some((c) => c.check === 'outputMatches' && c.path === 'orderNumber'));
  });

  it('create_sales_order: one commit click, row locators templated by $line, result found in the verify run', async () => {
    const reads = [await draft('get_customer_details'), await draft('get_order_status')];
    const s = await draft('create_sales_order', reads);
    assert.equal(s.access, 'write');
    const commits = s.steps.filter((x) => x.op === 'click' && x.commit);
    assert.equal(commits.length, 1);
    assert.equal((commits[0] as Extract<Step, { op: 'click' }>).target.key, 'saveOrder');

    const loop = s.steps.find((x) => x.op === 'forEach') as Extract<Step, { op: 'forEach' }>;
    assert.deepEqual(
      loop.steps.map((x) => [x.op, x.target.key, x.value, x.target.locators[0]]),
      [
        ['select', 'product$line', '$item.product', { by: 'id', id: 'ctl00_MainContent_ddlProduct$line' }],
        ['fill', 'qty$line', '$item.qty', { by: 'id', id: 'ctl00_MainContent_txtQty$line' }],
      ],
    );

    // The new order number is only on screen after a real save.
    assert.equal(pendingTargets(s), 1);
    assert.equal(validateToolSpec(s).ok, false);

    // Proves itself by reading the order back; Contoso shows "C1003 - Adventure Works".
    assert.deepEqual(s.postcondition.checks[0], {
      check: 'readBack',
      tool: 'get_order_status',
      input: { orderNumber: '$output.orderNumber' },
      expect: { customer: { prefix: '$input.customerId' }, poNumber: { equals: '$input.poNumber' }, shipVia: { equals: '$input.shipVia' } },
    });
  });

  it('opens a screen at its entryUrl when the query picks the screen', async () => {
    const withQuery = { ...graph, screens: graph.screens.map((sc) => (sc.id === 'customer-inquiry' ? { ...sc, entryUrl: '/Customers/Search.aspx?mode=all' } : sc)) };
    const s = await compileDraft({ task: await task('get_customer_details'), graph: withQuery, example: examples.get_customer_details!, readTools: [], now: NOW });
    const go = s.steps.find((x) => x.op === 'goto') as Extract<Step, { op: 'goto' }>;
    assert.equal(go.url, '/Customers/Search.aspx?mode=all');
    assert.equal(s.screens['customer-inquiry']!.url, '/Customers/Search.aspx');
  });

  it('without a matching read tool a write still checks its output', async () => {
    const s = await draft('create_sales_order');
    assert.deepEqual(s.postcondition.checks, [{ check: 'outputMatches', path: 'orderNumber', pattern: '\\S' }]);
  });
});

describe('the checked-in Contoso tools (examples/contoso/tools)', () => {
  it('are valid specs that the current compiler still produces', async () => {
    const tool = async (n: string) => JSON.parse(await readFile(new URL(`tools/${n}@1.json`, EXAMPLES), 'utf8')) as ToolSpec;
    const onDisk = await Promise.all(['get_customer_details', 'get_order_status', 'create_sales_order'].map(tool));
    for (const spec of onDisk) {
      assert.deepEqual(validateToolSpec(spec), { ok: true, value: spec }, spec.name);
      const fresh = await draft(spec.name, onDisk.filter((s) => s.access === 'read'));
      // What only the verify run fills in: when, the example's output, and a write's result locator.
      fresh.provenance.compiledAt = spec.provenance.compiledAt;
      fresh.example.output = spec.example.output;
      fresh.steps = fresh.steps.map((st, i) => (st.op === 'extract' && !st.target.locators.length ? spec.steps[i]! : st));
      assert.deepEqual(spec, fresh, `${spec.name}: recompile examples/contoso/tools (see docs/compiler.md)`);
    }
  });
});

describe('runner helpers', () => {
  it('parses legacy values: money, "-" as empty, ints', () => {
    assert.equal(parseValue('$7,500.00', 'money'), 7500);
    assert.equal(parseValue(' ($12.50) ', 'money'), -12.5);
    assert.equal(parseValue('-'), undefined);
    assert.equal(parseValue('  '), undefined);
    assert.equal(parseValue('1,204', 'int'), 1204);
    assert.equal(parseValue(' C1003 -  Adventure Works '), 'C1003 - Adventure Works');
  });

  it('evaluates expressions; an omitted optional input is undefined', () => {
    const vars = { input: { a: 'x', lines: [{ q: 2 }] }, output: { n: 'SO-1' }, item: { q: 3 } };
    assert.equal(evalExpr('$input.a', vars), 'x');
    assert.equal(evalExpr('$item.q', vars), 3);
    assert.equal(evalExpr('$output.n', vars), 'SO-1');
    assert.equal(evalExpr('$input.missing', vars), undefined);
    assert.equal(evalExpr('Ground', vars), 'Ground');
  });

  it("finds a write's result by the words of its name and intent", () => {
    const cands = [
      { id: 'ctl00_MainContent_lblMessage', text: 'Order SO-10045 saved for customer C1003.' },
      { id: 'ctl00_MainContent_lblOrderNumber', text: 'SO-10045' },
      { id: 'HeadLoginView_HeadLoginStatus', text: 'Log Out' },
    ];
    assert.equal(pickDiscovered(cands, 'orderNumber', 'the number of the sales order just saved')?.id, 'ctl00_MainContent_lblOrderNumber');
    assert.equal(pickDiscovered(cands, 'invoiceTotal', 'the total'), undefined);
  });
});
