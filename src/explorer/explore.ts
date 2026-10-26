// The explorer: crawls a legacy web app with Playwright and writes the screen
// graph (format 1). The model names screens and controls and picks what to
// try; everything that touches the app is deterministic, and no control the
// model or the safety rules call `commit` is ever pressed.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type ElementHandle, type Page } from 'playwright';
import type { Edge, EdgeKind, Element, ElementRole, Locator, Screen, ScreenGraph } from '../formats/graph.js';
import { validateGraph } from '../formats/validate.js';
import { COMMIT_PATTERN, LOGOUT_PATTERN } from '../model/heuristic.js';
import type { ElementSummary, ExplorerModel } from '../model/types.js';
import { resolve, toPlaywright } from '../runner/locate.js';
import { capture, type CapturedSnapshot, type RawElement, type Sample } from './snapshot.js';

export interface ExploreOptions {
  baseUrl: string;
  appName?: string;
  credentials?: { user: string; password: string };
  outDir: string; // the .legacylink folder
  model: ExplorerModel;
  startPath?: string; // seed hint, e.g. "/Default.aspx"
  maxScreens?: number;
  maxActions?: number;
  headless?: boolean;
  browser?: Browser;
  log?: (msg: string) => void;
}

const ACTION_TIMEOUT = 5_000;
const SCREEN_TIMEOUT = 15_000;

// A screen element plus what the explorer needs to act on it again.
interface Built extends Element {
  sig: string;
  gridKey?: string; // gridLinks: key of their grid on the same screen
  isPassword?: boolean;
  href?: string;
}

interface BuiltScreen extends Omit<Screen, 'elements'> {
  elements: Built[];
  getUrl?: string; // a URL that loads this screen with a plain GET
}

interface Action {
  screen: string;
  via: string;
  fills: { key: string; value: string }[];
}

// How to get back to a page state: load a URL, then replay postbacks.
interface StateRef {
  url: string;
  steps: Action[];
}

interface Task {
  edge: string;
  priority: number;
  state: StateRef;
  action: Action;
  kind: EdgeKind;
  searchFields: string[];
}

const DESTRUCTIVE_LINK = /^(delete|remove|void|approve|post|cancel \w+)\b/i;

const PRIORITY: Record<EdgeKind, number> = { navigate: 0, postback: 1, search: 2, commit: 9 };

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'screen';

function signature(el: RawElement, all: RawElement[]): string {
  if (el.kind === 'gridLink') {
    const grid = all.find((g) => g.ref === el.grid);
    return `gridLink|${grid?.id ?? grid?.columns?.join(',')}|${el.column}`;
  }
  if (el.kind === 'grid') return `grid|${el.id ?? el.columns?.join(',')}`;
  if (el.kind === 'output' || el.kind === 'message') return `${el.kind}|${el.id ?? el.label ?? el.css}`;
  return `${el.kind}|${el.id ?? el.name ?? el.text ?? el.label ?? el.css}`;
}

export function summarize(el: RawElement): ElementSummary {
  const { ref, kind, tag, type, id, name, text, label, section, href, grid, columns, maxLength, required, isPassword } = el;
  const s: ElementSummary = { ref, kind, tag, type, id, name, text, label, section, href, grid, columns, maxLength, required, isPassword };
  if (el.options) s.options = el.options.slice(0, 6).map((o) => o.text);
  for (const k of Object.keys(s) as (keyof ElementSummary)[]) if (s[k] === undefined) delete s[k];
  return s;
}

const ARIA_ROLE: Partial<Record<RawElement['kind'], string>> = { input: 'textbox', textarea: 'textbox', select: 'combobox', button: 'button', link: 'link' };

function candidateLocators(el: RawElement): Locator[] {
  const out: Locator[] = [];
  const isField = el.kind === 'input' || el.kind === 'select' || el.kind === 'textarea';
  const accName = isField ? (el.labelFrom === 'label' || el.labelFrom === 'aria' ? el.label : undefined) : el.text;
  const role = el.kind === 'input' && el.type === 'number' ? 'spinbutton' : ARIA_ROLE[el.kind];
  if (role && accName) out.push({ by: 'role', role, name: accName });
  if (isField && el.label && (el.labelFrom === 'label' || el.labelFrom === 'aria')) out.push({ by: 'label', text: el.label });
  if (el.id) out.push({ by: 'id', id: el.id });
  if (el.name) out.push({ by: 'name', name: el.name });
  if ((el.kind === 'button' || el.kind === 'link') && el.text) out.push({ by: 'text', text: el.text, exact: true });
  // Label-relative: survives an id rename, which is what the healer needs for outputs.
  if (el.labelFrom === 'cell' && el.label) out.push({ by: 'css', selector: `${el.labelCellTag}:text-is(${JSON.stringify(el.label)}) + ${el.valueCellTag} ${el.tag}` });
  if (el.css) out.push({ by: 'css', selector: el.css });
  return out;
}

// gridLinks are located inside a grid row, the way the runner's clickRow uses them.
function gridLinkLocators(el: RawElement): Locator[] {
  if (el.constantText && el.text) return [{ by: 'role', role: 'link', name: el.text }, { by: 'text', text: el.text, exact: true }];
  return [{ by: 'css', selector: `td:nth-child(${el.column}) a` }];
}

// Keep only the locators that pick out exactly this element right now.
export async function verifiedLocators(page: Page, el: RawElement, handle: ElementHandle | undefined): Promise<Locator[]> {
  if (el.kind === 'gridLink') return gridLinkLocators(el);
  const all = candidateLocators(el);
  if (!handle) return all;
  const ok: Locator[] = [];
  for (const loc of all) {
    const pw = toPlaywright(page, loc);
    if ((await pw.count()) !== 1) continue;
    if (await pw.evaluate((node, target) => node === target, handle)) ok.push(loc);
  }
  return ok.length ? ok : all.slice(-1);
}

function edgeKind(el: Built): EdgeKind {
  if (el.role === 'commit') return 'commit';
  if (el.role === 'search') return 'search';
  if ((el.kind === 'link' || el.kind === 'gridLink') && el.href && el.href !== 'postback') return 'navigate';
  return 'postback';
}

// Some apps start with a loader page that redirects from script; let it finish.
async function settle(page: Page): Promise<void> {
  for (let i = 0, url = ''; i < 5 && url !== page.url(); i++) {
    url = page.url();
    await page.waitForLoadState('networkidle', { timeout: SCREEN_TIMEOUT }).catch(() => {});
    await page.waitForLoadState('load');
  }
}

const isField = (el: { kind: string }) => el.kind === 'input' || el.kind === 'select' || el.kind === 'textarea';

export async function explore(opts: ExploreOptions): Promise<ScreenGraph> {
  const log = opts.log ?? (() => {});
  const maxScreens = opts.maxScreens ?? 30;
  const maxActions = opts.maxActions ?? 200;
  const base = new URL(opts.baseUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const basePath = base.pathname.slice(0, -1); // "" or "/contoso-order-entry"
  const abs = (rel: string) => new URL(rel.replace(/^\//, ''), base).href;
  const rel = (url: string) => {
    const u = new URL(url);
    const p = u.pathname.startsWith(basePath + '/') ? u.pathname.slice(basePath.length) : u.pathname;
    return { path: p, full: p + u.search };
  };

  const screens: BuiltScreen[] = [];
  const edges = new Map<string, Edge>();
  const samples = new Map<string, Sample>();
  const visited = new Set<string>();
  const queue: Task[] = [];
  const queued = new Set<string>();
  let loginScreen: string | undefined;
  let appName = opts.appName;

  await mkdir(join(opts.outDir, 'artifacts', 'explore'), { recursive: true });

  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? true }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(ACTION_TIMEOUT);
  context.setDefaultNavigationTimeout(SCREEN_TIMEOUT);
  const page = await context.newPage();

  const findScreen = (snap: CapturedSnapshot) => {
    const { path } = rel(snap.url);
    return screens.find(
      (s) =>
        s.urlPattern.toLowerCase() === path.toLowerCase() &&
        (s.fingerprint.title === snap.fingerprint.title || (!!snap.fingerprint.heading && s.fingerprint.heading === snap.fingerprint.heading)),
    );
  };

  const ensureEdge = (from: string, el: Built, fields?: string[]): Edge => {
    const id = `${from}:${el.key}`;
    let e = edges.get(id);
    if (!e) {
      e = { id, from, to: null, via: el.key, kind: edgeKind(el), status: 'unexplored' };
      if (fields?.length) e.fields = fields;
      edges.set(id, e);
    }
    return e;
  };

  // Capture the page, merge it into the graph and plan what to try from here.
  async function visit(state: StateRef): Promise<BuiltScreen | null> {
    const snap = await capture(page);
    const { path, full } = rel(snap.url);
    let screen = findScreen(snap);
    if (!screen && screens.length >= maxScreens) {
      log(`  page budget reached, not adding ${path}`);
      return null;
    }
    const sigs = new Map(snap.elements.map((el) => [el.ref, signature(el, snap.elements)]));
    const stateSig = `${screen?.id ?? `new:${path}:${snap.title}`}|${[...sigs.values()].sort().join(';')}`;
    if (screen && visited.has(stateSig)) return screen;
    visited.add(stateSig);
    for (const s of snap.samples) samples.set(`${s.label}\u0000${s.value}`, s);

    const known = new Map(screen?.elements.map((e) => [e.sig, e.key]));
    const summaries = snap.elements.map((el) => {
      const s = summarize(el);
      const k = known.get(sigs.get(el.ref)!);
      if (k) s.knownKey = k;
      return s;
    });
    const shot = await page.screenshot({ fullPage: true });
    const analysis = await opts.model.analyzeScreen({
      url: full,
      title: snap.title,
      heading: snap.fingerprint.heading,
      landmarks: snap.fingerprint.landmarks,
      elements: summaries,
      knownScreens: screens.map((s) => ({ id: s.id, name: s.name })),
      screenshot: shot.toString('base64'),
    });
    const named = new Map(analysis.elements.map((e) => [e.ref, e]));

    if (!screen) {
      let id = slugify(analysis.name);
      for (let n = 2; screens.some((s) => s.id === id); n++) id = `${slugify(analysis.name)}-${n}`;
      const screenshot = `artifacts/explore/${id}.png`;
      await writeFile(join(opts.outDir, screenshot), shot);
      screen = {
        id,
        name: analysis.name,
        purpose: analysis.purpose,
        urlPattern: path,
        fingerprint: { ...snap.fingerprint, landmarks: [...snap.fingerprint.landmarks] },
        requiresLogin: !snap.hasPassword && !!loginScreen,
        elements: [],
        screenshot,
      };
      screens.push(screen);
      appName ??= snap.title.includes(' - ') ? snap.title.split(' - ')[0]!.trim() : base.hostname;
      log(`+ screen ${id} (${path})`);
    } else {
      for (const l of snap.fingerprint.landmarks) if (!screen.fingerprint.landmarks.includes(l)) screen.fingerprint.landmarks.push(l);
    }
    if (!state.steps.length && !screen.getUrl) screen.getUrl = full;
    if (snap.hasPassword) loginScreen = screen.id;

    // Merge this state's elements into the screen.
    const here = new Map<string, Built>(); // ref -> element
    for (const raw of snap.elements) {
      const sig = sigs.get(raw.ref)!;
      let el = screen.elements.find((e) => e.sig === sig);
      if (!el) {
        const n = named.get(raw.ref);
        let key = n?.key ?? `${raw.kind}${raw.ref}`;
        for (let i = 2; screen.elements.some((e) => e.key === key); i++) key = `${n?.key ?? raw.kind}${i}`;
        let role: ElementRole | undefined = n?.role;
        // Safety rules, whatever the model said: a button that reads like a commit is one, a
        // button with no role is treated as one, and so is a link that deletes or approves.
        // The sign-in button is the exception.
        if (raw.kind === 'button') {
          if (snap.hasPassword) role = 'navigate';
          else if (!role || COMMIT_PATTERN.test(raw.text ?? '')) role = 'commit';
        } else if (raw.kind === 'link' || raw.kind === 'gridLink') {
          if (DESTRUCTIVE_LINK.test(raw.text ?? '')) role = 'commit';
          else role ??= 'navigate';
        }
        el = {
          sig,
          key,
          kind: raw.kind,
          intent: n?.intent ?? raw.label ?? raw.text ?? raw.kind,
          locators: await verifiedLocators(page, raw, snap.handles.get(raw.ref)),
        };
        if (raw.label && raw.kind !== 'button' && raw.kind !== 'link') el.label = raw.label;
        if (role) el.role = role;
        if (n?.required ?? raw.required) el.required = true;
        if (raw.options) el.options = raw.options;
        if (raw.maxLength) el.maxLength = raw.maxLength;
        if (raw.isPassword) el.isPassword = true;
        if (raw.href) el.href = raw.href;
        screen.elements.push(el);
      }
      here.set(raw.ref, el);
    }
    for (const raw of snap.elements) {
      if (raw.kind === 'gridLink' && raw.grid) here.get(raw.ref)!.gridKey = here.get(raw.grid)?.key;
    }

    // Plan. Commit controls only get an unexplored edge with the fields they would submit.
    const chosen = new Set(analysis.nextActions.map((a) => a.ref));
    const fieldKeys = snap.elements.filter((r) => isField(r) && !r.isPassword).map((r) => here.get(r.ref)!.key);
    for (const raw of snap.elements) {
      const el = here.get(raw.ref)!;
      if (el.kind !== 'button' && el.kind !== 'link' && el.kind !== 'gridLink') continue;
      if (el.role === 'commit') {
        ensureEdge(screen.id, el, snap.elements.filter(isField).map((r) => here.get(r.ref)!.key));
        continue;
      }
      const edge = ensureEdge(screen.id, el);
      const safe = chosen.has(raw.ref) && !LOGOUT_PATTERN.test(raw.text ?? '') && !snap.hasPassword;
      if (!safe || edge.status === 'explored' || queued.has(edge.id)) continue;
      const kind = edgeKind(el);
      const searchFields =
        kind === 'search'
          ? snap.elements.filter((r) => (r.kind === 'input' || r.kind === 'textarea') && !r.isPassword && r.section === raw.section).map((r) => here.get(r.ref)!.key)
          : [];
      queued.add(edge.id);
      queue.push({ edge: edge.id, priority: PRIORITY[kind], kind, state, action: { screen: screen.id, via: el.key, fills: [] }, searchFields: searchFields.length ? searchFields : fieldKeys });
    }
    return screen;
  }

  const screenById = (id: string) => screens.find((s) => s.id === id)!;

  async function find(action: Action, key: string) {
    const screen = screenById(action.screen);
    const el = screen.elements.find((e) => e.key === key);
    if (!el) throw new Error(`no element ${key} on ${action.screen}`);
    if (el.kind === 'gridLink' && el.gridKey) {
      const grid = screen.elements.find((e) => e.key === el.gridKey)!;
      const g = await resolve(page, grid.locators);
      if (!g) throw new Error(`grid ${grid.key} not found`);
      const row = g.locator.locator('tr').filter({ has: page.locator('td') }).first();
      const r = await resolve(row, el.locators);
      return r && { el, locator: r.locator };
    }
    const r = await resolve(page, el.locators);
    return r && { el, locator: r.locator };
  }

  // Fill, click, and wait for the full-page postback or navigation a legacy app does.
  async function perform(action: Action): Promise<void> {
    for (const f of action.fills) {
      const t = await find(action, f.key);
      if (!t) throw new Error(`field ${f.key} not found on ${action.screen}`);
      if (t.el.kind === 'select') await t.locator.selectOption(f.value);
      else await t.locator.fill(f.value);
    }
    const t = await find(action, action.via);
    if (!t) throw new Error(`${action.via} not found on ${action.screen}`);
    const nav = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: SCREEN_TIMEOUT }).catch(() => null);
    await t.locator.click();
    await nav;
    await page.waitForLoadState('load');
  }

  async function goto(state: StateRef): Promise<void> {
    await page.goto(abs(state.url), { waitUntil: 'load' });
    for (const step of state.steps) await perform(step);
  }

  async function logIn(screen: BuiltScreen): Promise<BuiltScreen | null> {
    if (!opts.credentials) throw new Error(`The app asks for a login at ${screen.urlPattern}; pass credentials`);
    const pass = screen.elements.find((e) => e.isPassword);
    const user = screen.elements.find((e) => e.kind === 'input' && !e.isPassword);
    const button = screen.elements.find((e) => e.kind === 'button');
    if (!pass || !user || !button) throw new Error(`Can't find the login form on ${screen.id}`);
    const action: Action = { screen: screen.id, via: button.key, fills: [{ key: user.key, value: opts.credentials.user }, { key: pass.key, value: opts.credentials.password }] };
    await perform(action);
    const landed = await visit({ url: rel(page.url()).full, steps: [] });
    if (!landed || landed.id === screen.id) throw new Error('Login failed: still on the login screen');
    Object.assign(ensureEdge(screen.id, button, [user.key, pass.key]), { to: landed.id, status: 'explored', fields: [user.key, pass.key] });
    log(`  logged in as ${opts.credentials.user}`);
    return landed;
  }

  try {
    await page.goto(abs(opts.startPath ?? '/'), { waitUntil: 'load' });
    await settle(page);
    let first = await visit({ url: rel(page.url()).full, steps: [] });
    if (first && first.id === loginScreen) first = await logIn(first);
    if (!first) throw new Error('Could not load the start page');

    let actions = 0;
    while (queue.length && actions < maxActions) {
      queue.sort((a, b) => a.priority - b.priority); // stable: FIFO within a priority
      const task = queue.shift()!;
      const edge = edges.get(task.edge)!;
      actions++;
      try {
        await goto(task.state);
        const action = { ...task.action };
        if (task.kind === 'search') {
          const screen = screenById(action.screen);
          const fields = task.searchFields
            .map((k) => screen.elements.find((e) => e.key === k)!)
            .map((e) => ({ key: e.key, label: e.label, intent: e.intent, ...(e.maxLength && { maxLength: e.maxLength }) }));
          const { values } = await opts.model.searchValues({ screen: screen.name, fields, samples: [...samples.values()].slice(0, 200) });
          action.fills = values.filter((v) => task.searchFields.includes(v.key));
        }
        const before = page.url();
        await perform(action);
        const after = page.url();
        // A postback that renders in place is only reachable by replaying it.
        const sameUrl = new URL(after).pathname.toLowerCase() === new URL(before).pathname.toLowerCase() && new URL(after).search === new URL(before).search;
        const next: StateRef = task.kind === 'navigate' || !sameUrl ? { url: rel(after).full, steps: [] } : { url: task.state.url, steps: [...task.state.steps, action] };
        const landed = await visit(next);
        if (landed) {
          edge.to = landed.id;
          edge.status = 'explored';
          if (action.fills.length) edge.fields = action.fills.map((f) => f.key);
          log(`  ${edge.from} --${edge.via}--> ${landed.id}`);
        }
      } catch (err) {
        log(`  ! ${task.edge}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    if (queue.length) log(`action budget reached, ${queue.length} actions left untried`);

    // requiresLogin: load each screen in a fresh, logged-out context and see where it lands.
    if (loginScreen) {
      const anon = await browser.newContext();
      const p = await anon.newPage();
      for (const s of screens) {
        if (s.id === loginScreen) {
          s.requiresLogin = false;
          continue;
        }
        if (!s.getUrl) continue;
        try {
          await p.goto(abs(s.getUrl), { waitUntil: 'commit' });
          await settle(p);
          s.requiresLogin = (await p.locator('input[type=password]').count()) > 0;
        } catch (err) {
          log(`  ! could not check whether ${s.id} needs a login: ${(err as Error).message.split('\n')[0]}`);
        }
      }
      await anon.close();
    }
  } finally {
    await context.close();
    if (!opts.browser) await browser.close();
  }

  const graph: ScreenGraph = {
    formatVersion: 1,
    app: { name: appName ?? base.hostname, baseUrl: opts.baseUrl },
    exploredAt: new Date().toISOString(),
    screens: screens.map(({ getUrl: _g, elements, ...s }) => ({
      ...s,
      elements: elements.map(({ sig: _s, gridKey: _k, isPassword: _p, href: _h, ...e }) => e),
    })),
    edges: [...edges.values()],
  };
  const v = validateGraph(graph);
  if (!v.ok) {
    await writeFile(join(opts.outDir, 'graph.invalid.json'), JSON.stringify(graph, null, 2));
    throw new Error(`Explorer produced an invalid graph:\n${v.errors.join('\n')}`);
  }
  await writeFile(join(opts.outDir, 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  return graph;
}
