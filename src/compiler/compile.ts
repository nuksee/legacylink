// The compiler's deterministic half: a learned task plus the screen graph in,
// a draft tool spec out. It copies each named element's locators and intent
// from the graph, turns screen hops into goto/waitForScreen steps, and derives
// the post-condition and error rules. The other half is the verify run
// (verify.ts), which proves the draft against the live app and fills in what
// only a real commit can show: where a write's result appears.

import type { Element, Locator, Screen, ScreenGraph } from '../formats/graph.js';
import type { JsonSchema, LearnedTask, TaskStep } from '../formats/task.js';
import type { Check, Expect, ErrorRule, ScreenRef, Step, Target, ToolSpec } from '../formats/tool.js';
import { words } from '../model/text.js';

export class CompileError extends Error {}

// How the runner logs in: the login screen and its user, password and submit
// controls, all from the graph. The password itself never goes in a file.
export interface LoginSpec {
  screen: string;
  url: string;
  user: Target;
  password: Target;
  submit: Target;
}

export interface AppConfig {
  formatVersion: 1;
  app: { name: string; baseUrl: string };
  login?: LoginSpec;
  credentials?: { user: string; passwordEnv: string };
}

const targetOf = (el: Element): Target => ({ key: el.key, intent: el.intent, locators: el.locators });

const screenRef = (s: Screen): ScreenRef => ({ url: s.urlPattern, title: s.fingerprint.title, ...(s.fingerprint.heading && { heading: s.fingerprint.heading }) });

// The login screen is the one the explorer logged in on: no login needed to see
// it, and an explored edge that submits exactly a user name and a password.
export function loginSpec(graph: ScreenGraph): LoginSpec | undefined {
  for (const e of graph.edges) {
    const s = graph.screens.find((x) => x.id === e.from);
    if (!s || s.requiresLogin || e.status !== 'explored' || e.fields?.length !== 2) continue;
    const [user, password] = e.fields.map((k) => s.elements.find((el) => el.key === k));
    const submit = s.elements.find((el) => el.key === e.via);
    if (user?.kind !== 'input' || password?.kind !== 'input' || !submit) continue;
    if (!graph.screens.some((x) => x.requiresLogin)) return undefined;
    return { screen: s.id, url: s.urlPattern, user: targetOf(user), password: targetOf(password), submit: targetOf(submit) };
  }
  return undefined;
}

export function appConfig(graph: ScreenGraph, credentials?: AppConfig['credentials']): AppConfig {
  const login = loginSpec(graph);
  return { formatVersion: 1, app: graph.app, ...(login && { login }), ...(credentials && { credentials }) };
}

// "ctl00_MainContent_ddlProduct1" and "...Product2" -> "...Product$line".
// Every row's value must come out of the template, or the field is dropped.
function lineTemplate(values: string[]): string | undefined {
  const [first] = values;
  if (first === undefined) return undefined;
  for (let at = first.lastIndexOf('1'); at >= 0; at = first.lastIndexOf('1', at - 1)) {
    const tpl = `${first.slice(0, at)}$line${first.slice(at + 1)}`;
    if (values.every((v, i) => v === tpl.replace('$line', String(i + 1)))) return tpl;
  }
  return values.every((v) => v === first) ? first : undefined;
}

// One Target for a forEach row element ("product$line"), from the graph's
// product1..productN, with $line where the row number goes.
function rowTarget(screen: Screen, key: string, rows: number): Target {
  const els = Array.from({ length: rows }, (_, i) => {
    const el = screen.elements.find((e) => e.key === key.replaceAll('$line', String(i + 1)));
    if (!el) throw new CompileError(`${key}: row ${i + 1} is not on ${screen.id}`);
    return el;
  });
  const locators: Locator[] = [];
  for (const [n, loc] of els[0]!.locators.entries()) {
    const same = els.map((e) => e.locators[n]);
    if (same.some((l) => l?.by !== loc.by)) continue;
    const out: Record<string, unknown> = {};
    let ok = true;
    for (const [field, value] of Object.entries(loc)) {
      if (typeof value !== 'string') {
        out[field] = value;
        continue;
      }
      const tpl = lineTemplate(same.map((l) => (l as Record<string, unknown>)[field] as string));
      if (tpl === undefined) ok = false;
      out[field] = tpl;
    }
    if (ok) locators.push(out as Locator);
  }
  if (!locators.some((l) => JSON.stringify(l).includes('$line'))) throw new CompileError(`${key}: no locator tells its rows apart`);
  return { key, intent: lineTemplate(els.map((e) => e.intent)) ?? els[0]!.intent, locators };
}

const props = (s: JsonSchema) => (s.properties ?? {}) as Record<string, JsonSchema>;

// Words of a property name, singular and lower-case: "customerId" -> customer, id.
const stem = (s: string) => words(s).map((w) => w.toLowerCase().replace(/s$/, ''));

// readBack: a write proves itself by reading its record back with a read tool
// that takes one of its outputs as input (create_sales_order's orderNumber ->
// get_order_status). Each write input that the read tool also returns is
// expected back; "customerId" is matched to "customer" by prefix, since a
// read often shows "C1003 - Adventure Works".
function readBack(task: LearnedTask, readTools: ToolSpec[]): Check | undefined {
  const outputs = Object.keys(props(task.outputSchema));
  for (const tool of readTools) {
    const required = (tool.inputSchema.required as string[] | undefined) ?? Object.keys(props(tool.inputSchema));
    if (required.length !== 1 || !outputs.includes(required[0]!)) continue;
    const readOut = props(tool.outputSchema);
    const expect: Record<string, Expect> = {};
    for (const [name, schema] of Object.entries(props(task.inputSchema))) {
      if (schema.type === 'array' || schema.type === 'object') continue;
      if (name in readOut) expect[name] = { equals: `$input.${name}` };
      else {
        const w = stem(name);
        const match = Object.keys(readOut).find((o) => {
          const ow = stem(o);
          return ow.length < w.length && ow.every((x, i) => x === w[i]);
        });
        if (match) expect[match] = { prefix: `$input.${name}` };
      }
    }
    return { check: 'readBack', tool: tool.name, input: { [required[0]!]: `$output.${required[0]}` }, expect };
  }
  return undefined;
}

// Legacy apps say no in an alert: a validation summary, "not found", a credit
// limit. Any visible role=alert after a search or commit is the app's answer,
// not drift, and comes back to the caller with the app's own words.
const ALERT_RULE: ErrorRule = {
  code: 'app_error',
  message: '$text',
  when: { target: { key: 'alert', intent: "the app's error or validation message", locators: [{ by: 'css', selector: '[role="alert"]' }] } },
};

export interface CompileOptions {
  task: LearnedTask;
  graph: ScreenGraph;
  readTools?: ToolSpec[]; // registered read tools, for a write's readBack
  example: Record<string, unknown>;
  version?: number;
  now?: () => Date;
}

// The draft: every step resolved against the graph. A write's readAfterCommit
// becomes an extract with no locators yet; the verify run finds them.
export function compileDraft(opts: CompileOptions): ToolSpec {
  const { task, graph } = opts;
  const screenById = new Map(graph.screens.map((s) => [s.id, s]));
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  const screens: Record<string, ScreenRef> = {};
  const useScreen = (id: string) => {
    const s = screenById.get(id);
    if (!s) throw new CompileError(`unknown screen "${id}"`);
    screens[id] = screenRef(s);
    return s;
  };
  const element = (screen: string, key: string) => {
    const el = useScreen(screen).elements.find((e) => e.key === key);
    if (!el) throw new CompileError(`element "${key}" is not on "${screen}"`);
    return el;
  };

  const inputs = props(task.inputSchema);
  const steps: Step[] = [];
  if (loginSpec(graph)) steps.push({ op: 'ensureLogin' });
  let current: string | undefined;

  const convert = (s: TaskStep): Step[] => {
    switch (s.op) {
      case 'open': {
        const screen = useScreen(s.screen);
        current = s.screen;
        return [{ op: 'goto', screen: s.screen, url: screen.urlPattern }];
      }
      case 'fill':
      case 'select':
        return [{ op: s.op, target: targetOf(element(s.screen, s.element)), value: s.value }];
      case 'forEach': {
        const m = /^\$input\.(\w+)$/.exec(s.items);
        const rows = m && (inputs[m[1]!]?.maxItems as number | undefined);
        if (!rows) throw new CompileError(`forEach over ${s.items} needs an array input with maxItems`);
        return [
          {
            op: 'forEach',
            items: s.items,
            steps: s.steps.map((inner) => ({ op: inner.op, target: rowTarget(useScreen(inner.screen), inner.element, rows), value: inner.value })),
          },
        ];
      }
      case 'click':
      case 'clickRow': {
        const edge = edgeById.get(s.edge);
        if (!edge) throw new CompileError(`unknown edge "${s.edge}"`);
        const out: Step[] =
          s.op === 'click'
            ? [{ op: 'click', target: targetOf(element(s.screen, s.element)), ...(edge.kind === 'commit' && { commit: true as const }) }]
            : [{ op: 'clickRow', grid: gridOf(s.screen, s.element), match: s.match, link: targetOf(element(s.screen, s.element)) }];
        if (edge.to && edge.kind !== 'commit') {
          useScreen(edge.to);
          out.push({ op: 'waitForScreen', screen: edge.to });
          current = edge.to;
        }
        return out;
      }
      case 'read':
        return [{ op: 'extract', target: targetOf(element(s.screen, s.element)), into: s.into, ...(s.parse && { parse: s.parse }) }];
      case 'readTable':
        return [{ op: 'extractTable', target: targetOf(element(s.screen, s.element)), into: s.into, columns: s.columns }];
      case 'readAfterCommit':
        return [{ op: 'extract', target: { key: s.into, intent: s.intent, locators: [] }, into: s.into, ...(s.parse && { parse: s.parse }) }];
    }
  };

  // The grid a gridLink belongs to: the screen's grid whose rows hold it. The
  // graph doesn't record that link, so take the only grid, or the one whose
  // key shares the link's prefix ("customersSelectLink" -> "customersGrid").
  const gridOf = (screen: string, link: string): Target => {
    const grids = useScreen(screen).elements.filter((e) => e.kind === 'grid');
    const grid = grids.length === 1 ? grids[0] : grids.find((g) => link.startsWith(g.key.replace(/Grid$/, '')));
    if (!grid) throw new CompileError(`can't tell which grid "${link}" on "${screen}" belongs to`);
    return targetOf(grid);
  };

  for (const s of task.steps) steps.push(...convert(s));

  const checks: Check[] = [];
  if (task.access === 'read') {
    if (current) checks.push({ check: 'onScreen', screen: current });
    // A read of one record must come back with the record that was asked for.
    for (const name of Object.keys(props(task.outputSchema)))
      if (inputs[name] && inputs[name]!.type === 'string') checks.push({ check: 'outputMatches', path: name, equals: `$input.${name}` });
  } else {
    const rb = readBack(task, opts.readTools ?? []);
    if (rb) checks.push(rb);
    for (const name of (task.outputSchema.required as string[] | undefined) ?? []) checks.push({ check: 'outputMatches', path: name, pattern: '\\S' });
  }

  return {
    formatVersion: 1,
    name: task.name,
    version: opts.version ?? 1,
    description: task.description,
    access: task.access,
    inputSchema: task.inputSchema,
    outputSchema: task.outputSchema,
    screens,
    steps,
    postcondition: { checks },
    errors: [ALERT_RULE],
    provenance: {
      task: task.provenance.task,
      graphExploredAt: task.provenance.graphExploredAt,
      learnedAt: task.provenance.learnedAt,
      compiledAt: (opts.now?.() ?? new Date()).toISOString(),
      model: task.provenance.model,
    },
    example: { input: opts.example },
  };
}

// Steps a draft still needs the verify run for: extracts with no locators.
export const pendingTargets = (spec: ToolSpec) => spec.steps.filter((s) => s.op === 'extract' && !s.target.locators.length).length;
