// The whole pipeline on the fixture app: explore, learn, compile (verify run),
// then call the tools through the MCP server with the approval gate in front
// of the write.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium, type Browser } from 'playwright';
import { ApprovalGate, autoApprover } from '../src/approval/gate.js';
import { build } from '../src/compiler/build.js';
import { appConfig } from '../src/compiler/compile.js';
import { startConsole, type ConsoleServer } from '../src/console/console.js';
import { explore } from '../src/explorer/explore.js';
import type { ScreenGraph } from '../src/formats/graph.js';
import { learn } from '../src/learner/learn.js';
import { createMcpServer } from '../src/mcp/server.js';
import { heuristicModel } from '../src/model/heuristic.js';
import type { Session } from '../src/runner/run.js';
import { Workspace } from '../src/workspace.js';
import { startFixture, type FixtureApp } from './fixture-app.js';

const ENV = { FIXTURE_PASSWORD: 'demo' };

describe('compile and serve the fixture app', () => {
  let browser: Browser;
  let app: FixtureApp;
  let dir: string;
  let ws: Workspace;
  let graph: ScreenGraph;
  let session: Session;

  before(async () => {
    browser = await chromium.launch();
    app = await startFixture();
    dir = await mkdtemp(join(tmpdir(), 'legacylink-run-'));
    ws = new Workspace(dir);
    graph = await explore({ baseUrl: app.url, credentials: { user: 'demo', password: 'demo' }, outDir: dir, model: heuristicModel, browser });
    const config = appConfig(graph, { user: 'demo', passwordEnv: 'FIXTURE_PASSWORD' });
    await ws.saveConfig(config);
    session = ws.session(config, { env: ENV, browser });
  });
  after(async () => {
    await session.close();
    await browser.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('compiles a read and a write, each proven by a verify run', async () => {
    const tasks = [
      await learn({ graph, task: 'Look up a customer by name', model: heuristicModel }),
      await learn({ graph, task: 'Create an invoice for a customer', model: heuristicModel }),
    ];
    const write = tasks[1]!.name;
    const built = await build({
      graph,
      tasks,
      examples: { [tasks[0]!.name]: { name: 'Fabrikam' }, [write]: { cust: 'C1', terms: '60' } },
      registry: ws.registry,
      session,
      approve: autoApprover(),
    });
    assert.deepEqual(
      built.map((b) => [b.spec.name, b.spec.version, b.run.outcome]),
      [
        [tasks[0]!.name, 1, 'ok'],
        [write, 1, 'ok'],
      ],
    );
    assert.deepEqual(built[0]!.spec.example.output, { id: 'C2', name: 'Fabrikam' });
    // The verify run found where the new invoice number shows up.
    const extract = built[1]!.spec.steps.at(-1)!;
    assert.deepEqual(extract.op === 'extract' && extract.target.locators, [{ by: 'id', id: 'lblInvoiceNo' }]);
    assert.deepEqual(app.invoices, [{ number: 'INV-1001', customer: 'C1', terms: '60' }]);
    assert.equal((await ws.registry.entries())[write]?.lastApprovedVersion, 1);
  });

  describe('through MCP', () => {
    let gate: ApprovalGate;
    let client: Client;
    let console_: ConsoleServer;

    before(async () => {
      gate = new ApprovalGate(10_000);
      console_ = await startConsole({ workspace: ws, gate, port: 0 });
      const server = createMcpServer({ workspace: ws, session, gate });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      client = new Client({ name: 'test', version: '0' });
      await client.connect(b);
    });
    after(async () => {
      await client.close();
      await console_.close();
    });

    it('lists the tools with their schemas and read/write hints', async () => {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      const read = tools.find((t) => t.annotations?.readOnlyHint)!;
      const write = tools.find((t) => !t.annotations?.readOnlyHint)!;
      assert.equal(tools.length, 2);
      assert.deepEqual(read.inputSchema.required, ['name']);
      assert.ok(write.outputSchema);
      assert.match(write.description!, /approves or rejects it in the LegacyLink console/);
      assert.ok(byName[read.name]);
    });

    it('a read returns typed output', async () => {
      const read = (await client.listTools()).tools.find((t) => t.annotations?.readOnlyHint)!;
      const res = await client.callTool({ name: read.name, arguments: { name: 'Northwind' } });
      assert.equal(res.isError, undefined);
      assert.deepEqual(res.structuredContent, { id: 'C1', name: 'Northwind' });
    });

    it("an app's own error comes back as a tool error, not a crash", async () => {
      const read = (await client.listTools()).tools.find((t) => t.annotations?.readOnlyHint)!;
      const res = await client.callTool({ name: read.name, arguments: { name: 'Nobody' } });
      assert.equal(res.isError, true);
      assert.match((res.content as { text: string }[])[0]!.text, /The app said no \(not_found\): No row in resultsGrid with Name "Nobody"/);
    });

    it('bad input is refused before the app is touched', async () => {
      const read = (await client.listTools()).tools.find((t) => t.annotations?.readOnlyHint)!;
      const res = await client.callTool({ name: read.name, arguments: { name: 'x'.repeat(30) } });
      assert.equal(res.isError, true);
      assert.match((res.content as { text: string }[])[0]!.text, /invalid_input/);
    });

    it('a write waits for the console; a request without the header cannot approve it', async () => {
      const write = (await client.listTools()).tools.find((t) => !t.annotations?.readOnlyHint)!;
      const call = client.callTool({ name: write.name, arguments: { cust: 'C2', terms: '30' } });
      let req;
      for (let i = 0; i < 100 && !(req = gate.list()[0]); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(req, 'an approval request appears');
      assert.equal(req.healedSinceLastApproval, false);
      assert.equal(app.invoices.length, 1, 'nothing saved before approval');

      const forged = await fetch(`${console_.url}api/approvals/${req.id}/approve`, { method: 'POST' });
      assert.equal(forged.status, 403);
      const shot = await fetch(`${console_.url}api/approvals/${req.id}/screenshot`);
      assert.equal(shot.headers.get('content-type'), 'image/png');
      const state = (await (await fetch(`${console_.url}api/state`)).json()) as { approvals: { id: string; screenshot?: string }[] };
      assert.equal(state.approvals[0]!.id, req.id);
      assert.equal(state.approvals[0]!.screenshot, undefined, 'file paths stay on the server');

      const ok = await fetch(`${console_.url}api/approvals/${req.id}/approve`, { method: 'POST', headers: { 'X-LegacyLink': '1' } });
      assert.equal(ok.status, 200);
      const res = await call;
      assert.deepEqual(res.structuredContent, { invoiceNumber: 'INV-1002' });
      assert.equal(app.invoices.length, 2);
    });

    it('a rejected write saves nothing', async () => {
      const write = (await client.listTools()).tools.find((t) => !t.annotations?.readOnlyHint)!;
      const call = client.callTool({ name: write.name, arguments: { cust: 'C1', terms: '30' } });
      let req;
      for (let i = 0; i < 100 && !(req = gate.list()[0]); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(gate.decide(req!.id, 'rejected', 'test'));
      const res = await call;
      assert.equal(res.isError, true);
      assert.match((res.content as { text: string }[])[0]!.text, /rejected/);
      assert.equal(app.invoices.length, 2);
    });

    it('a write the app refuses comes back with the app\'s words', async () => {
      const write = (await client.listTools()).tools.find((t) => !t.annotations?.readOnlyHint)!;
      const call = client.callTool({ name: write.name, arguments: { cust: 'C9', terms: '30' } });
      let req;
      for (let i = 0; i < 100 && !(req = gate.list()[0]); i++) await new Promise((r) => setTimeout(r, 50));
      gate.decide(req!.id, 'approved', 'test');
      const res = await call;
      assert.equal(res.isError, true);
      assert.match((res.content as { text: string }[])[0]!.text, /The app said no \(app_error\): Customer C9 was not found/);
    });

    it('logs every run, step and decision', async () => {
      const events = await ws.runLog.tail(1000);
      const types = new Set(events.map((e) => e.type));
      for (const t of ['run_started', 'step', 'approval_requested', 'approval_decided', 'run_finished']) assert.ok(types.has(t as never), t);
      const decided = events.filter((e) => e.type === 'approval_decided').map((e) => e.type === 'approval_decided' && e.decision);
      assert.deepEqual(decided.slice(-3), ['approved', 'rejected', 'approved']);
    });
  });
});
