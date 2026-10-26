// Self-heal on the fixture app: compile a read and a write, rename their
// controls the way a vendor patch would, and call them through MCP. The heal
// must re-locate the controls, prove the patch with the post-condition, keep
// the approval gate in front of the write, and leave a record.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium, type Browser } from 'playwright';
import { ApprovalGate, autoApprover, type ApprovalRequest } from '../src/approval/gate.js';
import { build } from '../src/compiler/build.js';
import { appConfig } from '../src/compiler/compile.js';
import { startConsole, type ConsoleServer } from '../src/console/console.js';
import { explore } from '../src/explorer/explore.js';
import type { ScreenGraph } from '../src/formats/graph.js';
import type { Healer } from '../src/healer/heal.js';
import { learn } from '../src/learner/learn.js';
import { createMcpServer } from '../src/mcp/server.js';
import { eligible, healTargetHeuristic } from '../src/model/heal-heuristic.js';
import { heuristicModel } from '../src/model/heuristic.js';
import type { HealTargetInput } from '../src/model/types.js';
import type { RunEvent } from '../src/runlog/runlog.js';
import type { Session } from '../src/runner/run.js';
import { Workspace } from '../src/workspace.js';
import { startFixture, type FixtureApp } from './fixture-app.js';

describe('the rule-based heal stand-in', () => {
  const base: HealTargetInput = {
    tool: 't',
    access: 'write',
    screen: { name: 'New Order', url: '/New.aspx', title: 'New Order' },
    missing: { key: 'customerId', intent: 'the value for "Customer #"', op: 'fill', label: 'Customer #:', oldLocators: [{ by: 'id', id: 'txtCustomerId' }] },
    candidates: [],
  };

  it('takes the only new control of the right kind', () => {
    const out = healTargetHeuristic({ ...base, candidates: [{ ref: 'e1', kind: 'input', tag: 'input', id: 'txtAccountNo', label: 'Account No.:' }, { ref: 'e2', kind: 'button', tag: 'input', text: 'Go' }] });
    assert.equal(out.ref, 'e1');
  });

  it('says null when two new controls could be it', () => {
    const out = healTargetHeuristic({ ...base, candidates: [{ ref: 'e1', kind: 'input', tag: 'input', label: 'Account:' }, { ref: 'e2', kind: 'input', tag: 'input', label: 'Region:' }] });
    assert.equal(out.ref, null);
  });

  it('a commit stays a commit, and nothing else becomes one', () => {
    const save = { ref: 'e1', kind: 'button' as const, tag: 'input', text: 'Submit Order' };
    const find = { ref: 'e2', kind: 'button' as const, tag: 'input', text: 'Find' };
    const commitStep = { ...base.missing, op: 'click', commit: true as const };
    const searchStep = { ...base.missing, op: 'click' };
    assert.equal(eligible(commitStep, save), undefined);
    assert.ok(eligible(commitStep, find));
    assert.ok(eligible(searchStep, save), 'a read can never be healed onto a Save button');
    assert.equal(healTargetHeuristic({ ...base, missing: searchStep, candidates: [save] }).ref, null);
  });
});

describe('self-heal on the fixture app', () => {
  let browser: Browser;
  let app: FixtureApp;
  let dir: string;
  let ws: Workspace;
  let graph: ScreenGraph;
  let session: Session;
  let healer: Healer;
  let gate: ApprovalGate;
  let client: Client;
  let console_: ConsoleServer;
  let read: string;
  let write: string;
  const lines: string[] = [];
  let listChanged = 0;

  const text = (res: Record<string, unknown>) => (res.content as { text: string }[]).map((c) => c.text).join('\n');
  const nextApproval = async (): Promise<ApprovalRequest> => {
    let req: ApprovalRequest | undefined;
    for (let i = 0; i < 200 && !(req = gate.list()[0]); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(req, 'an approval request appears');
    return req;
  };
  const heals = async () => (await ws.runLog.tail(2000)).filter((e): e is Extract<RunEvent, { type: 'heal' }> => e.type === 'heal');

  before(async () => {
    browser = await chromium.launch();
    app = await startFixture();
    dir = await mkdtemp(join(tmpdir(), 'legacylink-heal-'));
    ws = new Workspace(dir);
    graph = await explore({ baseUrl: app.url, credentials: { user: 'demo', password: 'demo' }, outDir: dir, model: heuristicModel, browser });
    const config = appConfig(graph, { user: 'demo', passwordEnv: 'FIXTURE_PASSWORD' });
    await ws.saveConfig(config);
    session = ws.session(config, { env: { FIXTURE_PASSWORD: 'demo' }, browser });
    const tasks = [
      await learn({ graph, task: 'Look up a customer by name', model: heuristicModel }),
      await learn({ graph, task: 'Create an invoice for a customer', model: heuristicModel }),
    ];
    [read, write] = [tasks[0]!.name, tasks[1]!.name];
    await build({ graph, tasks, examples: { [read]: { name: 'Fabrikam' }, [write]: { cust: 'C1', terms: '60' } }, registry: ws.registry, session, approve: autoApprover() });

    gate = new ApprovalGate(10_000);
    healer = ws.healer({ model: heuristicModel, log: (l) => lines.push(l) });
    console_ = await startConsole({ workspace: ws, gate, port: 0 });
    const server = createMcpServer({ workspace: ws, session, gate, healer });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: 'test', version: '0' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void listChanged++);
    await client.connect(b);
  });
  after(async () => {
    await client.close();
    await console_.close();
    await session.close();
    await browser.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('a read whose search box and button were renamed heals, and the patch is kept as v2', async () => {
    app.drift.rename = true;
    const res = await client.callTool({ name: read, arguments: { name: 'Northwind' } });
    assert.equal(res.isError, undefined, text(res));
    assert.deepEqual(res.structuredContent, { id: 'C1', name: 'Northwind' });
    assert.match(text(res), /\[LegacyLink self-heal\] .* healed: v1 -> v2/);
    assert.match(text(res), /"Name:" #txtName -> "Company:" #txtCompany/);

    assert.equal((await ws.registry.entries())[read]?.version, 2);
    const v2 = (await ws.registry.get(read))!;
    assert.equal(v2.provenance.healedFrom, 1);
    const [heal] = await heals();
    assert.equal(heal?.status, 'healed');
    assert.deepEqual(heal?.changes.map((c) => [c.key, c.after]), [
      ['name', '"Company:" #txtCompany'],
      ['find', '"Search" #btnSearch'],
    ]);
    // The graph learned the new locators, and the client heard the tool list changed.
    const g = JSON.parse(await readFile(ws.graphFile, 'utf8')) as ScreenGraph;
    assert.ok(JSON.stringify(g).includes('txtCompany'));
    for (let i = 0; i < 50 && !listChanged; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(listChanged, 1);
    assert.ok(lines.some((l) => /^\[heal\] .* healed: v1 -> v2/.test(l)), lines.join('\n'));

    // v2 now runs with no heal at all.
    const again = await client.callTool({ name: read, arguments: { name: 'Fabrikam' } });
    assert.deepEqual(again.structuredContent, { id: 'C2', name: 'Fabrikam' });
    assert.equal((await heals()).length, 1);
  });

  it('a healed write still waits for a person, flagged as changed; rejecting it saves nothing and keeps v1', async () => {
    const saved = app.invoices.length;
    const call = client.callTool({ name: write, arguments: { cust: 'C2', terms: '30' } });
    const req = await nextApproval();
    assert.equal(req.healedSinceLastApproval, true);
    assert.ok(req.heal?.some((l) => l.startsWith('cust: "Customer ID:" #txtCust -> "Account:" #txtAccount')), JSON.stringify(req.heal));
    assert.ok(req.heal?.some((l) => l.includes('-> "Submit Invoice" #btnSubmit')));
    gate.decide(req.id, 'rejected', 'test');
    const res = await call;
    assert.equal(res.isError, true);
    assert.equal(app.invoices.length, saved);
    assert.equal((await ws.registry.entries())[write]?.version, 1);
    assert.equal((await heals()).at(-1)?.status, 'unverified');
  });

  it('approving the healed write saves once and registers v2', async () => {
    const saved = app.invoices.length;
    const call = client.callTool({ name: write, arguments: { cust: 'C2', terms: '30' } });
    const req = await nextApproval();
    assert.equal(app.invoices.length, saved, 'nothing saved before approval');
    gate.decide(req.id, 'approved', 'test');
    const res = await call;
    assert.equal(res.isError, undefined, text(res));
    assert.equal(app.invoices.length, saved + 1);
    const entry = (await ws.registry.entries())[write];
    assert.deepEqual([entry?.version, entry?.lastApprovedVersion], [2, 2]);
  });

  it('drift after the commit is not healed: the record may exist, so a person decides', async () => {
    app.drift.result = true;
    const saved = app.invoices.length;
    const call = client.callTool({ name: write, arguments: { cust: 'C1', terms: '30' } });
    gate.decide((await nextApproval()).id, 'approved', 'test');
    const res = await call;
    assert.equal(res.isError, true);
    assert.equal(app.invoices.length, saved + 1, 'saved exactly once, no retry');
    const last = (await heals()).at(-1)!;
    assert.equal(last.status, 'failed');
    assert.match(last.message, /after its commit step/);
    assert.equal((await ws.registry.entries())[write]?.version, 2);
    app.drift.result = false;
  });

  it('undoing the rename heals back, and the console shows every heal', async () => {
    app.drift.rename = false;
    const res = await client.callTool({ name: read, arguments: { name: 'Northwind' } });
    assert.deepEqual(res.structuredContent, { id: 'C1', name: 'Northwind' });
    assert.equal((await ws.registry.entries())[read]?.version, 3);
    const state = (await (await fetch(`${console_.url}api/state`)).json()) as { heals: { tool: string; status: string }[]; runs: { type: string }[] };
    assert.deepEqual(
      state.heals.map((h) => h.status),
      ['healed', 'unverified', 'healed', 'failed', 'healed'],
    );
    assert.ok(state.runs.some((e) => e.type === 'heal'));
  });

  it("uses the model's pick and reason, and falls back to the stand-in when the model call fails", async () => {
    const tools = (_: string) => undefined;
    const muse = {
      id: 'muse-spark-test',
      healTarget: async (i: HealTargetInput) => ({ ref: i.candidates.find((c) => c.kind === i.candidates[0]!.kind && /Company|Search/.test(`${c.label}${c.text}`))?.ref ?? null, reason: 'Same job, new caption.' }),
    };
    app.drift.rename = true;
    const byModel = await session.run((await ws.registry.get(read))!, { name: 'Northwind' }, { tools, healer: ws.healer({ model: muse }) });
    assert.equal(byModel.outcome, 'ok', JSON.stringify(byModel.error));
    assert.deepEqual(byModel.healed?.changes.map((c) => [c.via, c.why]), [
      ['model', 'Same job, new caption.'],
      ['model', 'Same job, new caption.'],
    ]);
    assert.equal((await heals()).at(-1)?.usedModel, true);

    app.drift.rename = false;
    const down = { id: 'muse-spark-test', healTarget: async () => Promise.reject(new Error('Muse Spark API 503')) };
    const said: string[] = [];
    const byStandIn = await session.run((await ws.registry.get(read))!, { name: 'Northwind' }, { tools, healer: ws.healer({ model: down, log: (l) => said.push(l) }) });
    assert.equal(byStandIn.outcome, 'ok', JSON.stringify(byStandIn.error));
    assert.ok(byStandIn.healed?.changes.every((c) => c.via === 'heuristic'));
    assert.ok(said.some((l) => /muse-spark-test call failed \(Muse Spark API 503\); using the rule-based stand-in/.test(l)), said.join('\n'));
  });
});
