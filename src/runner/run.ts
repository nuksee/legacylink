// The runner: executes a tool spec against the app with Playwright and proves
// the result with its post-condition. No model call happens here.
//
// One Session holds one browser, one logged-in context and one page, and runs
// one tool at a time: legacy apps often assume one session per user, and
// serial runs keep the demo predictable.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator as PwLocator, type Page } from 'playwright';
import type { AppConfig } from '../compiler/compile.js';
import type { Locator } from '../formats/graph.js';
import type { JsonSchema, Parse } from '../formats/task.js';
import type { Check, Expr, Step, Target, ToolSpec } from '../formats/tool.js';
import { ajv, formatErrors } from '../formats/validate.js';
import type { Approver } from '../approval/gate.js';
import type { Healer, HealResult } from '../healer/heal.js';
import type { FailureReason, Outcome, RunLog } from '../runlog/runlog.js';
import { resolve as resolveLocators, toPlaywright, type Resolved } from './locate.js';

export const ACTION_TIMEOUT = 5_000;
export const SCREEN_TIMEOUT = 15_000;
const FIND_TIMEOUT = 3_000; // how long a step waits for its target to appear

export interface RunResult {
  runId: string;
  tool: string;
  version: number;
  outcome: Outcome;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; reason?: FailureReason; step?: number; key?: string };
  postcondition: 'passed' | 'failed' | 'skipped';
  // Targets the verify run found for extracts that had no locators, by step index.
  discovered?: Record<number, Target>;
  // Set when this result comes from the retry after a heal.
  healed?: HealResult;
  ms: number;
}

export interface RunOptions {
  approve?: Approver; // required for write tools
  discover?: boolean; // verify run: find targets for extracts with no locators
  healedSinceLastApproval?: boolean;
  caller?: string;
  // readBack checks call other tools through this.
  tools?: (name: string) => ToolSpec | undefined;
  // Repairs a spec after drift. Without one, a locator failure just fails.
  healer?: Healer;
  healNote?: string[]; // shown with the approval request of a healed write
}

// Ends a run early. reason says whether a heal could help: locator_failed and
// postcondition_failed can; app_error never does (the app said no).
class Stop extends Error {
  constructor(
    readonly outcome: Outcome,
    readonly code: string,
    message: string,
    readonly reason?: FailureReason,
    readonly step?: number,
    readonly key?: string,
  ) {
    super(message);
  }
}

type Vars = { input: Record<string, unknown>; output: Record<string, unknown>; item?: Record<string, unknown>; index?: number };

// "$input.customerId" -> the value, or undefined when the caller left it out.
export function evalExpr(expr: Expr, vars: Vars): unknown {
  const m = /^\$(input|item|output)\.([\w.]+)$/.exec(expr);
  if (!m) return expr.startsWith('$') ? undefined : expr;
  let v: unknown = m[1] === 'input' ? vars.input : m[1] === 'item' ? vars.item : vars.output;
  for (const k of m[2]!.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

// Legacy screens show an empty value as "-" or nothing; both mean "absent".
export function parseValue(raw: string, parse: Parse = 'text'): unknown {
  const t = clean(raw);
  if (t === '' || t === '-' || t === '—') return undefined;
  switch (parse) {
    case 'money': {
      const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
      const n = Number(t.replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) ? (neg ? -n : n) : undefined;
    }
    case 'int': {
      const n = Number.parseInt(t.replace(/,/g, ''), 10);
      return Number.isFinite(n) ? n : undefined;
    }
    default:
      return t;
  }
}

// Turns the text read off the screen into the output schema's types: "$7,500.00"
// becomes 7500 where the schema says number, "40" becomes 40 where it says
// integer. Grid cells are read as text, so this is what types them.
export function coerceToSchema(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return value;
  const type = schema.type;
  if (typeof value === 'string' && (type === 'number' || type === 'integer')) return parseValue(value, type === 'integer' ? 'int' : 'money') ?? value;
  if (Array.isArray(value)) return value.map((v) => coerceToSchema(v, schema.items as JsonSchema | undefined));
  if (value && typeof value === 'object') {
    const p = (schema.properties ?? {}) as Record<string, JsonSchema>;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, coerceToSchema(v, p[k])]));
  }
  return value;
}

// $line is the 1-based row inside forEach, $index the 0-based one.
const withLine = (target: Target, index?: number): Target =>
  index === undefined
    ? target
    : (JSON.parse(JSON.stringify(target).replaceAll('$line', String(index + 1)).replaceAll('$index', String(index))) as Target);

// Same check as the explorer's: the visible words of the screen's title or main heading.
const PAGE_FACTS = String.raw`(() => ({
  title: document.title.replace(/\s+/g, ' ').trim(),
  headings: Array.from(document.querySelectorAll('h1, h2')).map((h) => h.textContent.replace(/\s+/g, ' ').trim()),
}))()`;

// Finds the element an extract with no locators should read after a commit:
// the visible element with an id whose words best match the output's name and
// intent ("orderNumber" -> ctl00_MainContent_lblOrderNumber).
const CANDIDATES = String.raw`(() => Array.from(document.querySelectorAll('[id]')).filter((el) => {
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  const text = (el.textContent || '').trim();
  return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && text && text.length <= 80 && !el.querySelector('[id]')
    && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'OPTION', 'SCRIPT'].includes(el.tagName);
}).map((el) => ({ id: el.id, text: (el.textContent || '').trim() })))()`;

const NOISE = new Set(['ctl00', 'main', 'content', 'lbl', 'txt', 'the', 'of', 'a', 'an', 'just', 'span', 'label']);
const wordsOf = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !NOISE.has(w) && !/^ctl\d+$/.test(w));

// Grid helpers, run in the page. Built from source text, like the explorer's
// capture, so the TypeScript toolchain can't inject helpers into them.
const inPage = (body: string) => new Function('t', 'arg', body) as (t: Element, arg: unknown) => unknown;

const FIND_ROW = inPage(String.raw`
  const { column, value } = arg;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const rows = Array.from(t.rows);
  const header = rows.find((r) => r.querySelector('th'));
  const col = header ? Array.from(header.cells).findIndex((c) => norm(c.textContent) === column) : -1;
  if (col < 0) return { missing: 'no column "' + column + '"' };
  const hits = rows.map((r, i) => ({ r, i })).filter(({ r }) => r !== header && norm(r.cells[col] ? r.cells[col].textContent : '').toLowerCase() === value.toLowerCase());
  return hits.length === 1 ? { index: hits[0].i } : { count: hits.length };`);

const READ_TABLE = inPage(String.raw`
  const columns = arg;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const all = Array.from(t.rows);
  const header = all.find((row) => row.querySelector('th'));
  if (!header) return [];
  const heads = Array.from(header.cells).map((c) => norm(c.textContent));
  return all
    .filter((row) => row !== header && !row.querySelector('th'))
    .map((row) => {
      const out = {};
      for (const [prop, caption] of Object.entries(columns)) {
        const cell = row.cells[heads.indexOf(caption)];
        const v = cell && heads.includes(caption) ? norm(cell.textContent) : '';
        if (v && v !== '-') out[prop] = v;
      }
      return out;
    });`);

export function pickDiscovered(cands: { id: string; text: string }[], into: string, intent: string): { id: string; text: string } | undefined {
  const key = new Set(wordsOf(into));
  const why = new Set(wordsOf(intent));
  const scored = cands
    .map((c) => {
      const w = new Set(wordsOf(c.id));
      const k = [...key].filter((x) => w.has(x)).length;
      return { c, k, score: k * 2 + [...why].filter((x) => w.has(x)).length };
    })
    .filter((s) => s.k > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0]!.score)) return undefined;
  return scored[0]!.c;
}

export interface SessionOptions {
  config: AppConfig;
  password?: string;
  runLog: RunLog;
  artifactsDir: string;
  browser?: Browser; // shared with tests; otherwise the session launches its own
  headless?: boolean;
}

export class Session {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private loggedIn = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly base: URL;
  private readonly basePath: string;

  constructor(private readonly opts: SessionOptions) {
    this.base = new URL(opts.config.app.baseUrl);
    if (!this.base.pathname.endsWith('/')) this.base.pathname += '/';
    this.basePath = this.base.pathname.slice(0, -1);
  }

  private abs(path: string): string {
    return new URL(path.replace(/^\//, ''), this.base).href;
  }

  private relPath(url: string): string {
    const p = new URL(url).pathname;
    return p.startsWith(this.basePath + '/') ? p.slice(this.basePath.length) : p;
  }

  private async open(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser) this.browser = this.opts.browser ?? (await chromium.launch({ headless: this.opts.headless ?? true }));
    this.context = await this.browser.newContext({ viewport: { width: 1100, height: 900 } });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT);
    this.page.setDefaultNavigationTimeout(SCREEN_TIMEOUT);
    this.loggedIn = false;
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    if (this.browser && this.browser !== this.opts.browser) await this.browser.close().catch(() => {});
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }

  // Runs are serialized: each waits for the one before it.
  run(spec: ToolSpec, input: Record<string, unknown>, opts: RunOptions = {}): Promise<RunResult> {
    const next = this.queue.then(() => this.attempt(spec, input, opts));
    this.queue = next.catch(() => {});
    return next;
  }

  // One run, and at most one heal: if the run failed on drift, the healer
  // re-locates the broken controls on the page as it is now, and the call runs
  // again with the patched spec. A write's retry goes through the approval gate
  // like any other run, flagged as changed.
  private async attempt(spec: ToolSpec, input: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
    if (opts.healer) spec = opts.healer.latest(spec);
    const first = await this.execute(spec, input, opts);
    const reason = first.error?.reason;
    if (!opts.healer || !this.page || first.outcome !== 'failed' || (reason !== 'locator_failed' && reason !== 'postcondition_failed')) return first;
    const plan = await opts.healer.plan(this.page, spec, first);
    if (!plan) return first;
    const retry = await this.execute(plan.spec, input, {
      ...opts,
      caller: `heal:${first.runId}`,
      healedSinceLastApproval: spec.access === 'write' ? true : opts.healedSinceLastApproval,
      healNote: plan.note,
    });
    retry.healed = await opts.healer.settle(plan, first, retry);
    return retry;
  }

  private async execute(spec: ToolSpec, input: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
    const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`;
    const started = Date.now();
    const log = this.opts.runLog;
    const at = () => new Date().toISOString();
    await log.append({ type: 'run_started', runId, at: at(), tool: spec.name, version: spec.version, access: spec.access, input, ...(opts.caller && { caller: opts.caller }) });

    const result: RunResult = { runId, tool: spec.name, version: spec.version, outcome: 'ok', postcondition: 'skipped', ms: 0 };
    const vars: Vars = { input, output: {} };
    let stepIndex = -1;
    let page: Page | undefined;

    const finish = async () => {
      result.ms = Date.now() - started;
      await log.append({
        type: 'run_finished',
        runId,
        at: at(),
        tool: spec.name,
        outcome: result.outcome,
        ...(result.output && { output: result.output }),
        ...(result.error && { error: result.error }),
        postcondition: result.postcondition,
        ms: result.ms,
      });
      return result;
    };

    try {
      const valid = ajv.compile(spec.inputSchema);
      if (!valid(input)) throw new Stop('failed', 'invalid_input', `Invalid input: ${formatErrors(valid.errors).join('; ')}`, 'invalid_input');
      if (spec.access === 'write' && !opts.approve) throw new Stop('failed', 'no_approver', `${spec.name} writes to the app and needs an approver`);
      page = await this.open().catch((e: Error) => {
        throw new Stop('failed', 'browser_failed', e.message, 'failed');
      });

      // One step, logged with how long it took and which locator matched.
      const timed = async (index: number, step: Step, fn: () => Promise<number | void>) => {
        const t0 = Date.now();
        const key = 'target' in step ? step.target.key : 'grid' in step ? step.grid.key : undefined;
        try {
          const matched = await fn();
          await log.append({ type: 'step', runId, at: at(), index, op: step.op, ...(key && { key }), ...(typeof matched === 'number' && { matchedLocator: matched }), ms: Date.now() - t0, ok: true });
        } catch (e) {
          await log.append({ type: 'step', runId, at: at(), index, op: step.op, ...(key && { key }), ms: Date.now() - t0, ok: false, error: (e as Error).message.split('\n')[0] });
          throw e;
        }
      };

      for (const [i, step] of spec.steps.entries()) {
        stepIndex = i;
        if (step.op === 'click' && step.commit) {
          await this.checkErrors(spec, page, i);
          // Never ask a person to approve a form that can't be submitted.
          await this.find(page, step.target, i);
          const decision = await this.approval(spec, input, runId, page, opts);
          if (decision !== 'approved') {
            await page.goto(this.abs('/'), { waitUntil: 'load' }).catch(() => {});
            const outcome = decision === 'rejected' ? 'rejected' : 'approval_timeout';
            throw new Stop(outcome, outcome, decision === 'rejected' ? 'A person rejected this write; nothing was saved.' : 'Nobody approved this write in time; nothing was saved.');
          }
        }
        await timed(i, step, () => this.step(spec, step, i, vars, opts, result));
        if (step.op === 'click' || step.op === 'clickRow') await this.checkErrors(spec, page, i);
      }

      stepIndex = -1;
      await this.checkErrors(spec, page, spec.steps.length);
      vars.output = coerceToSchema(vars.output, spec.outputSchema) as Record<string, unknown>;
      result.output = vars.output;
      const failed = await this.postcondition(spec, page, vars, opts, runId);
      result.postcondition = failed ? 'failed' : 'passed';
      if (failed) throw new Stop('failed', 'postcondition_failed', failed, 'postcondition_failed');
      const validOut = ajv.compile(spec.outputSchema);
      if (!validOut(vars.output)) {
        result.postcondition = 'failed';
        throw new Stop('failed', 'postcondition_failed', `Output does not match outputSchema: ${formatErrors(validOut.errors).join('; ')}`, 'postcondition_failed');
      }
    } catch (e) {
      if (e instanceof Stop) {
        result.outcome = e.outcome;
        result.error = { code: e.code, message: e.message, ...(e.reason && { reason: e.reason }), ...(e.step !== undefined && { step: e.step }), ...(e.key && { key: e.key }) };
      } else {
        const msg = (e as Error).message ?? String(e);
        const unreachable = /net::ERR_|ECONNREFUSED/.test(msg);
        result.outcome = 'failed';
        result.error = { code: unreachable ? 'app_unreachable' : 'step_failed', message: msg.split('\n')[0]!, reason: unreachable ? 'app_unreachable' : 'failed', ...(stepIndex >= 0 && { step: stepIndex }) };
      }
      if (page && result.outcome === 'failed') await this.screenshot(page, runId, 'failure');
    }
    return finish();
  }

  private async screenshot(page: Page, runId: string, name: string): Promise<string> {
    const dir = join(this.opts.artifactsDir, runId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    return file;
  }

  private async approval(spec: ToolSpec, input: Record<string, unknown>, runId: string, page: Page, opts: RunOptions) {
    const screenshot = await this.screenshot(page, runId, 'approval');
    const healed = opts.healedSinceLastApproval ?? false;
    const log = this.opts.runLog;
    const { id, decided } = opts.approve!({ runId, tool: spec.name, version: spec.version, input, screenshot, healedSinceLastApproval: healed, ...(opts.healNote && { heal: opts.healNote }) });
    await log.append({ type: 'approval_requested', runId, at: new Date().toISOString(), approvalId: id, screenshot, healedSinceLastApproval: healed });
    const { decision, by } = await decided;
    await log.append({ type: 'approval_decided', runId, at: new Date().toISOString(), approvalId: id, decision, ...(by && { by }) });
    return decision;
  }

  // Tries the ranked locators until one resolves to exactly one visible
  // element, waiting a little for a slow page.
  private async find(scope: Page | PwLocator, target: Target, step: number): Promise<Resolved> {
    if (!target.locators.length) throw new Stop('failed', 'locator_failed', `${target.key} has no locators`, 'locator_failed', step, target.key);
    const deadline = Date.now() + FIND_TIMEOUT;
    for (;;) {
      const r = await resolveLocators(scope, target.locators as Locator[]);
      if (r) return r;
      if (Date.now() > deadline)
        throw new Stop('failed', 'locator_failed', `Can't find ${target.key} (${target.intent}): no locator matched exactly one visible element`, 'locator_failed', step, target.key);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Clicks and waits for the full-page postback or navigation a legacy app does.
  private async clickAndSettle(page: Page, locator: PwLocator): Promise<void> {
    const nav = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: SCREEN_TIMEOUT }).catch(() => null);
    await locator.click();
    await nav;
    await page.waitForLoadState('load');
  }

  private async onScreen(page: Page, spec: ToolSpec, screen: string): Promise<string | undefined> {
    const ref = spec.screens[screen];
    if (!ref) return `unknown screen ${screen}`;
    const path = this.relPath(page.url());
    const facts = (await page.evaluate(PAGE_FACTS)) as { title: string; headings: string[] };
    const titleOk = facts.title === ref.title || (ref.heading !== undefined && facts.headings.includes(ref.heading));
    if (path.toLowerCase() === ref.url.toLowerCase() && titleOk) return undefined;
    return `expected screen ${screen} (${ref.url}, "${ref.title}"), but the page is ${path} ("${facts.title}")`;
  }

  private async logIn(page: Page): Promise<void> {
    const login = this.opts.config.login;
    if (!login) return;
    const creds = this.opts.config.credentials;
    if (!creds || this.opts.password === undefined) throw new Stop('failed', 'login_failed', 'The app asks for a login, but no credentials are configured', 'failed');
    if (this.relPath(page.url()).toLowerCase() !== login.url.toLowerCase()) await page.goto(this.abs(login.url), { waitUntil: 'load' });
    await (await this.find(page, login.user, -1)).locator.fill(creds.user);
    await (await this.find(page, login.password, -1)).locator.fill(this.opts.password);
    await this.clickAndSettle(page, (await this.find(page, login.submit, -1)).locator);
    if (this.relPath(page.url()).toLowerCase() === login.url.toLowerCase()) throw new Stop('failed', 'login_failed', `Login as ${creds.user} failed: still on the login screen`, 'failed');
    this.loggedIn = true;
  }

  private onLoginScreen(page: Page): boolean {
    const login = this.opts.config.login;
    return !!login && this.relPath(page.url()).toLowerCase() === login.url.toLowerCase();
  }

  private async step(spec: ToolSpec, step: Step, index: number, vars: Vars, opts: RunOptions, result: RunResult): Promise<number | void> {
    const page = this.page!;
    switch (step.op) {
      case 'ensureLogin':
        if (!this.loggedIn) await this.logIn(page);
        return;
      case 'goto': {
        await page.goto(this.abs(step.url), { waitUntil: 'load' });
        if (this.onLoginScreen(page)) {
          // The session expired or never started: log in and go again.
          await this.logIn(page);
          await page.goto(this.abs(step.url), { waitUntil: 'load' });
        }
        const wrong = await this.onScreen(page, spec, step.screen);
        if (wrong) throw new Stop('failed', 'wrong_screen', wrong, 'locator_failed', index);
        return;
      }
      case 'waitForScreen': {
        const deadline = Date.now() + SCREEN_TIMEOUT;
        for (;;) {
          const wrong = await this.onScreen(page, spec, step.screen);
          if (!wrong) return;
          if (Date.now() > deadline) throw new Stop('failed', 'wrong_screen', wrong, 'locator_failed', index);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      case 'fill':
      case 'select':
        return this.fillOne(page, step, index, vars);
      case 'forEach': {
        const items = evalExpr(step.items, vars);
        if (!Array.isArray(items)) throw new Stop('failed', 'invalid_input', `${step.items} is not a list`, 'invalid_input', index);
        let worst = 0;
        for (const [i, item] of items.entries())
          for (const inner of step.steps) {
            const m = await this.fillOne(page, { ...inner, target: withLine(inner.target, i) }, index, { ...vars, item: item as Record<string, unknown>, index: i });
            worst = Math.max(worst, m ?? 0);
          }
        return worst;
      }
      case 'click': {
        const r = await this.find(page, step.target, index);
        await this.clickAndSettle(page, r.locator);
        return r.index;
      }
      case 'clickRow': {
        const grid = await this.find(page, step.grid, index);
        const value = String(evalExpr(step.match.value, vars) ?? '');
        const row = (await grid.locator.evaluate(FIND_ROW, { column: step.match.column, value })) as { index?: number; missing?: string; count?: number };
        // A missing column is drift; no row (or several) for the value is the app's answer.
        if (row.missing) throw new Stop('failed', 'locator_failed', `${step.grid.key}: ${row.missing}`, 'locator_failed', index, step.grid.key);
        if (row.index === undefined)
          throw new Stop('app_error', row.count ? 'ambiguous' : 'not_found', `${row.count ? `${row.count} rows` : 'No row'} in ${step.grid.key} with ${step.match.column} "${value}"`, undefined, index);
        const link = await this.find(grid.locator.locator('tr').nth(row.index), step.link, index);
        await this.clickAndSettle(page, link.locator);
        return Math.max(grid.index, link.index);
      }
      case 'extract': {
        let target = step.target;
        if (!target.locators.length && opts.discover) {
          const cands = (await page.evaluate(CANDIDATES)) as { id: string; text: string }[];
          const hit = pickDiscovered(cands, step.into, target.intent);
          if (!hit) throw new Stop('failed', 'locator_failed', `Can't tell which element holds ${step.into} (${target.intent}) after the commit`, 'locator_failed', index, target.key);
          target = { ...target, locators: [{ by: 'id', id: hit.id }] };
          (result.discovered ??= {})[index] = target;
        }
        const r = await this.find(page, target, index);
        const v = parseValue(await r.locator.innerText(), step.parse);
        if (v !== undefined) vars.output[step.into] = v;
        return r.index;
      }
      case 'extractTable': {
        const r = await this.find(page, step.target, index);
        const rows = (await r.locator.evaluate(READ_TABLE, step.columns)) as Record<string, string>[];
        vars.output[step.into] = rows;
        return r.index;
      }
    }
  }

  private async fillOne(page: Page, step: { op: 'fill' | 'select'; target: Target; value: Expr }, index: number, vars: Vars): Promise<number | void> {
    const value = evalExpr(step.value, vars);
    if (value === undefined || value === null) return; // an optional input the caller left out
    const r = await this.find(page, step.target, index);
    if (step.op === 'select') await r.locator.selectOption(String(value));
    else await r.locator.fill(String(value));
    return r.index;
  }

  // Error rules: a matched rule means the app said no. Ends the run as app_error.
  private async checkErrors(spec: ToolSpec, page: Page, step: number): Promise<void> {
    for (const rule of spec.errors) {
      for (const loc of rule.when.target.locators) {
        const all = toPlaywright(page, loc as Locator);
        for (let i = 0; i < (await all.count()); i++) {
          const el = all.nth(i);
          if (!(await el.isVisible())) continue;
          const text = clean(await el.innerText());
          if (!text || (rule.when.pattern && !new RegExp(rule.when.pattern).test(text))) continue;
          const message = rule.message.replaceAll('$text', text);
          throw new Stop('app_error', rule.code, message, undefined, step);
        }
      }
    }
  }

  // Returns why the post-condition failed, or undefined when every check passed.
  private async postcondition(spec: ToolSpec, page: Page, vars: Vars, opts: RunOptions, runId: string): Promise<string | undefined> {
    for (const c of spec.postcondition.checks) {
      const why = await this.check(c, spec, page, vars, opts, runId);
      if (why) return `${c.check}: ${why}`;
    }
    return undefined;
  }

  private async check(c: Check, spec: ToolSpec, page: Page, vars: Vars, opts: RunOptions, runId: string): Promise<string | undefined> {
    switch (c.check) {
      case 'onScreen':
        return this.onScreen(page, spec, c.screen);
      case 'visible':
        return (await resolveLocators(page, c.target.locators as Locator[])) ? undefined : `${c.target.key} is not visible`;
      case 'textMatches': {
        const r = await resolveLocators(page, c.target.locators as Locator[]);
        if (!r) return `${c.target.key} is not visible`;
        const text = clean(await r.locator.innerText());
        return new RegExp(c.pattern).test(text) ? undefined : `${c.target.key} reads "${text}", which does not match /${c.pattern}/`;
      }
      case 'outputMatches': {
        const actual = evalExpr(`$output.${c.path}`, vars);
        if (c.equals !== undefined) {
          const want = evalExpr(c.equals, vars);
          if (want !== undefined && String(actual ?? '') !== String(want)) return `${c.path} is "${actual ?? ''}", expected "${want}"`;
        }
        if (c.pattern !== undefined && !new RegExp(c.pattern).test(String(actual ?? ''))) return `${c.path} is "${actual ?? ''}", expected /${c.pattern}/`;
        return undefined;
      }
      case 'readBack': {
        const tool = opts.tools?.(c.tool);
        if (!tool) return `read-back tool ${c.tool} is not registered`;
        const input: Record<string, unknown> = {};
        for (const [k, e] of Object.entries(c.input)) input[k] = evalExpr(e, vars);
        // Same page and session, inside this run's turn: no queueing.
        const back = await this.attempt(tool, input, { caller: `readBack:${runId}`, tools: opts.tools, healer: opts.healer });
        if (back.outcome !== 'ok') return `${c.tool}(${JSON.stringify(input)}) ${back.outcome}: ${back.error?.message ?? ''}`;
        for (const [path, exp] of Object.entries(c.expect)) {
          const want = evalExpr('equals' in exp ? exp.equals : exp.prefix, vars);
          if (want === undefined) continue;
          const got = String(back.output?.[path] ?? '');
          const w = String(want);
          const ok = 'equals' in exp ? got === w : got === w || (got.startsWith(w) && !/[A-Za-z0-9_]/.test(got[w.length]!));
          if (!ok) return `${c.tool} shows ${path} "${got}", expected ${'equals' in exp ? '' : 'it to start with '}"${w}"`;
        }
        return undefined;
      }
    }
  }
}
