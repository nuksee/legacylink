import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { explore } from '../src/explorer/explore.js';
import type { ScreenGraph } from '../src/formats/graph.js';
import { validateGraph } from '../src/formats/validate.js';
import { heuristicModel } from '../src/model/heuristic.js';
import { startFixture, type FixtureApp } from './fixture-app.js';

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

for (const basePath of ['', '/apps/books']) {
  describe(`explore the fixture app${basePath ? ` under ${basePath}` : ''}`, () => {
    let app: FixtureApp;
    let outDir: string;
    let graph: ScreenGraph;

    before(async () => {
      app = await startFixture(basePath);
      outDir = await mkdtemp(join(tmpdir(), 'legacylink-'));
      graph = await explore({ baseUrl: app.url, credentials: { user: 'demo', password: 'demo' }, outDir, model: heuristicModel, browser });
    });
    after(async () => {
      await app.close();
      await rm(outDir, { recursive: true, force: true });
    });

    const screen = (id: string) => graph.screens.find((s) => s.id === id)!;
    const edge = (id: string) => graph.edges.find((e) => e.id === id)!;

    it('writes a valid graph.json and one screenshot per screen', async () => {
      const onDisk = JSON.parse(await readFile(join(outDir, 'graph.json'), 'utf8'));
      assert.deepEqual(validateGraph(onDisk), { ok: true, value: onDisk });
      for (const s of graph.screens) assert.ok((await stat(join(outDir, s.screenshot))).size > 0, s.screenshot);
      assert.equal(graph.app.name, 'Fixture Books');
    });

    it('finds every screen, with paths relative to the base URL', () => {
      assert.deepEqual(graph.screens.map((s) => [s.id, s.urlPattern]).sort(), [
        ['archived-invoices', '/Invoice.aspx'],
        ['customer', '/Customer.aspx'],
        ['find-customer', '/Search.aspx'],
        ['home', '/Home.aspx'],
        ['new-invoice', '/Invoice.aspx'],
        ['sign-in', '/Login.aspx'],
      ]);
    });

    it('never presses a commit control, a destructive link or log out', () => {
      assert.deepEqual(app.commits, []);
      for (const id of ['new-invoice:saveInvoice', 'new-invoice:frobnicate', 'customer:deleteCustomerLink']) {
        assert.equal(edge(id).kind, 'commit', id);
        assert.equal(edge(id).status, 'unexplored', id);
      }
      assert.deepEqual(edge('new-invoice:saveInvoice').fields, ['cust', 'terms']);
      assert.equal(edge('home:logOutLink').status, 'unexplored');
    });

    it('logs in, searches, and follows a grid row postback', () => {
      assert.deepEqual(edge('sign-in:signIn'), { id: 'sign-in:signIn', from: 'sign-in', to: 'home', via: 'signIn', kind: 'postback', status: 'explored', fields: ['user', 'pass'] });
      assert.equal(edge('find-customer:find').to, 'find-customer');
      assert.equal(edge('find-customer:find').kind, 'search');
      assert.equal(edge('find-customer:resultsSelectLink').to, 'customer');
      assert.equal(edge('find-customer:resultsSelectLink').kind, 'postback');
      assert.equal(edge('new-invoice:cancel').to, 'home');
    });

    it('records ranked, verified locators and the screen fingerprint', () => {
      const cust = screen('new-invoice').elements.find((e) => e.key === 'cust')!;
      assert.deepEqual(cust.locators, [
        { by: 'role', role: 'textbox', name: 'Customer ID:' },
        { by: 'label', text: 'Customer ID:' },
        { by: 'id', id: 'txtCust' },
        { by: 'name', name: 'txtCust' },
      ]);
      assert.equal(cust.required, true);
      const name = screen('customer').elements.find((e) => e.key === 'name')!;
      assert.equal(name.kind, 'output');
      assert.deepEqual(name.locators, [{ by: 'id', id: 'lblName' }, { by: 'css', selector: 'td:text-is("Name") + td span' }]);
      const grid = screen('find-customer').elements.find((e) => e.key === 'resultsGrid')!;
      assert.equal(grid.kind, 'grid');
      assert.deepEqual(screen('find-customer').fingerprint, { title: 'Fixture Books - Find Customer', heading: 'Find Customer', landmarks: ['Criteria', 'gvResults'] });
      assert.deepEqual(screen('new-invoice').elements.find((e) => e.key === 'terms')!.options, [
        { value: '30', text: 'Net 30' },
        { value: '60', text: 'Net 60' },
      ]);
    });

    it('keeps the query string of a screen that the bare path does not show', () => {
      assert.equal(screen('archived-invoices').entryUrl, '/Invoice.aspx?view=archive');
      assert.equal(screen('new-invoice').entryUrl, undefined);
      assert.equal(screen('find-customer').entryUrl, undefined);
    });

    it('marks which screens need a login', () => {
      assert.equal(screen('sign-in').requiresLogin, false);
      for (const id of ['home', 'find-customer', 'new-invoice', 'customer']) assert.equal(screen(id).requiresLogin, true, id);
    });
  });
}
