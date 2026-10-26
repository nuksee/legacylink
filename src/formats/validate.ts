import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { screenGraphSchema, type ElementKind, type ScreenGraph } from './graph.js';
import { learnedTaskSchema, taskBodySchema, type JsonSchema, type LearnGraph, type LearnedTask, type TaskBody, type TaskStep } from './task.js';

export const ajv = new Ajv2020({ allErrors: true, strict: true });

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const formatErrors = (errors: ErrorObject[] | null | undefined): string[] =>
  (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);

export function validator<T>(schema: object): (value: unknown) => Validation<T> {
  const fn = ajv.compile(schema) as ValidateFunction<T>;
  return (value) => (fn(value) ? { ok: true, value } : { ok: false, errors: formatErrors(fn.errors) });
}

const graphShape = validator<ScreenGraph>(screenGraphSchema);

// Schema checks plus the cross-references a schema can't express: unique
// screen ids and element keys, and edges that point at things that exist.
export function validateGraph(value: unknown): Validation<ScreenGraph> {
  const shape = graphShape(value);
  if (!shape.ok) return shape;
  const graph = shape.value;
  const errors: string[] = [];

  if (Number.isNaN(Date.parse(graph.exploredAt))) errors.push(`/exploredAt is not an ISO 8601 date: ${graph.exploredAt}`);

  const screens = new Map<string, Set<string>>();
  for (const [i, s] of graph.screens.entries()) {
    if (screens.has(s.id)) errors.push(`/screens/${i} duplicate screen id "${s.id}"`);
    const keys = new Set<string>();
    for (const el of s.elements) {
      if (keys.has(el.key)) errors.push(`/screens/${i} duplicate element key "${el.key}" on "${s.id}"`);
      keys.add(el.key);
    }
    screens.set(s.id, keys);
  }

  const edgeIds = new Set<string>();
  for (const [i, e] of graph.edges.entries()) {
    if (edgeIds.has(e.id)) errors.push(`/edges/${i} duplicate edge id "${e.id}"`);
    edgeIds.add(e.id);
    const from = screens.get(e.from);
    if (!from) errors.push(`/edges/${i} unknown "from" screen "${e.from}"`);
    else {
      if (!from.has(e.via)) errors.push(`/edges/${i} "via" element "${e.via}" is not on "${e.from}"`);
      for (const f of e.fields ?? []) if (!from.has(f)) errors.push(`/edges/${i} field "${f}" is not on "${e.from}"`);
    }
    if (e.to !== null && !screens.has(e.to)) errors.push(`/edges/${i} unknown "to" screen "${e.to}"`);
    if ((e.status === 'explored') !== (e.to !== null)) errors.push(`/edges/${i} explored edges need a "to" screen, unexplored ones must not have one`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: graph };
}

const taskShape = validator<LearnedTask>(learnedTaskSchema);
const bodyShape = validator<TaskBody>(taskBodySchema);

const FILLABLE: Record<string, ElementKind[]> = {
  fill: ['input', 'textarea'],
  select: ['select'],
  click: ['button', 'link'],
  clickRow: ['gridLink'],
  read: ['output', 'message'],
  readTable: ['grid'],
};

const props = (s: JsonSchema) => (s.properties && typeof s.properties === 'object' ? (s.properties as Record<string, JsonSchema>) : {});

// The learner's guard: every screen, element and edge a task names must exist
// in the graph, the steps must be a walk the app can actually take, every
// input must be used and every output produced, and only a write task may
// press a commit control, exactly once, with nothing but reads after it.
export function checkTaskBody(task: TaskBody, graph: LearnGraph): string[] {
  const errors: string[] = [];
  const screens = new Map(graph.screens.map((s) => [s.id, new Map(s.elements.map((e) => [e.key, e]))]));
  const edges = new Map(graph.edges.map((e) => [e.id, e]));

  for (const which of ['inputSchema', 'outputSchema'] as const) {
    const s = task[which];
    if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object') errors.push(`/${which} must be an object schema with properties`);
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in props(s))) errors.push(`/${which} requires "${r}", which is not a property`);
    try {
      ajv.compile(s);
    } catch (e) {
      errors.push(`/${which} is not a valid JSON Schema: ${(e as Error).message}`);
    }
  }
  const inputs = props(task.inputSchema);
  const outputs = props(task.outputSchema);
  const used = new Set<string>();
  const produced = new Set<string>();
  let current: string | undefined;
  let commits = 0;

  type Loop = { prop: string; items: Record<string, JsonSchema>; max: number };

  const expr = (v: string, at: string, loop?: Loop): JsonSchema | undefined => {
    let m = /^\$input\.([A-Za-z_]\w*)$/.exec(v);
    if (m) {
      used.add(m[1]!);
      if (!inputs[m[1]!]) errors.push(`${at} uses $input.${m[1]}, which is not in inputSchema`);
      return inputs[m[1]!];
    }
    m = /^\$item\.([A-Za-z_]\w*)$/.exec(v);
    if (m) {
      if (!loop) errors.push(`${at} uses $item outside forEach`);
      else {
        used.add(`${loop.prop}.${m[1]}`);
        if (!loop.items[m[1]!]) errors.push(`${at} uses $item.${m[1]}, which is not an item property of "${loop.prop}"`);
        return loop.items[m[1]!];
      }
      return undefined;
    }
    if (v.startsWith('$')) errors.push(`${at} has an unknown expression "${v}"`);
    return undefined;
  };

  const elementsFor = (screen: string, key: string, at: string, loop?: Loop) => {
    const els = screens.get(screen)!;
    if (key.includes('$line') && !loop) errors.push(`${at} uses $line outside forEach`);
    const keys = loop && key.includes('$line') ? Array.from({ length: loop.max }, (_, i) => key.replaceAll('$line', String(i + 1))) : [key];
    return keys.flatMap((k) => {
      const el = els.get(k);
      if (!el) errors.push(`${at} element "${k}" is not on "${screen}"`);
      return el ? [el] : [];
    });
  };

  const visit = (s: TaskStep, at: string, loop?: Loop) => {
    if (commits && s.op !== 'readAfterCommit') errors.push(`${at} comes after the commit; only readAfterCommit may follow it`);
    if (s.op === 'open') {
      if (!screens.has(s.screen)) errors.push(`${at} unknown screen "${s.screen}"`);
      current = s.screen;
      return;
    }
    if (s.op === 'forEach') {
      if (loop) errors.push(`${at} forEach cannot be nested`);
      const m = /^\$input\.([A-Za-z_]\w*)$/.exec(s.items);
      const arr = m && inputs[m[1]!];
      const items = arr && (arr.items as JsonSchema | undefined);
      if (!m || !arr || arr.type !== 'array' || !items || typeof arr.maxItems !== 'number') {
        errors.push(`${at} items must be an $input array property with maxItems and object items`);
        return;
      }
      used.add(m[1]!);
      const l: Loop = { prop: m[1]!, items: props(items), max: arr.maxItems };
      s.steps.forEach((inner, j) => visit(inner, `${at}/steps/${j}`, l));
      for (const p of Object.keys(l.items)) if (!used.has(`${l.prop}.${p}`)) errors.push(`${at} never uses item property "${p}"`);
      return;
    }
    if (s.op === 'readAfterCommit') {
      if (task.access !== 'write' || !commits) errors.push(`${at} readAfterCommit needs a write task, after its commit`);
      if (produced.has(s.into)) errors.push(`${at} output "${s.into}" is produced twice`);
      produced.add(s.into);
      return;
    }

    if (!screens.has(s.screen)) return void errors.push(`${at} unknown screen "${s.screen}"`);
    if (current === undefined) errors.push(`${at} needs an open step before it`);
    else if (s.screen !== current) errors.push(`${at} is on "${s.screen}", but the steps before it leave the app on "${current}"`);
    const els = elementsFor(s.screen, s.element, at, loop);
    for (const el of els) if (!FILLABLE[s.op]!.includes(el.kind)) errors.push(`${at} ${s.op} cannot target ${el.kind} "${el.key}"`);

    switch (s.op) {
      case 'fill':
      case 'select': {
        const schema = expr(s.value, at, loop);
        const allowed = schema?.enum as unknown[] | undefined;
        if (s.op === 'select' && allowed)
          for (const el of els) {
            const values = new Set((el.options ?? []).map((o) => o.value));
            const missing = allowed.filter((v) => !values.has(String(v)));
            if (missing.length) errors.push(`${at} enum values ${JSON.stringify(missing)} are not options of "${el.key}"`);
          }
        return;
      }
      case 'click':
      case 'clickRow': {
        const edge = edges.get(s.edge);
        if (!edge) return void errors.push(`${at} unknown edge "${s.edge}"`);
        if (edge.from !== s.screen || edge.via !== s.element) errors.push(`${at} edge "${s.edge}" starts from "${edge.from}" via "${edge.via}", not "${s.screen}" via "${s.element}"`);
        if (s.op === 'clickRow') expr(s.match.value, at, loop);
        if (edge.kind === 'commit') {
          if (task.access !== 'write') errors.push(`${at} a read task must never press a commit control`);
          commits++;
          return; // the screen after a commit is only seen in the compiler's verify run
        }
        if (els[0]?.role === 'commit') errors.push(`${at} "${s.element}" is a commit control but "${s.edge}" is not a commit edge`);
        current = edge.to ?? undefined;
        return;
      }
      case 'read':
      case 'readTable':
        if (produced.has(s.into)) errors.push(`${at} output "${s.into}" is produced twice`);
        produced.add(s.into);
        return;
    }
  };

  task.steps.forEach((s, i) => visit(s, `/steps/${i}`));
  if (task.steps[0]?.op !== 'open') errors.push('/steps/0 must be an open step');
  if (task.access === 'write' && commits !== 1) errors.push(`a write task needs exactly one commit click, found ${commits}`);
  for (const p of Object.keys(inputs)) if (!used.has(p)) errors.push(`input "${p}" is never used`);
  for (const p of Object.keys(outputs)) if (!produced.has(p)) errors.push(`output "${p}" is never produced`);
  for (const p of produced) if (!outputs[p]) errors.push(`output "${p}" is produced but not in outputSchema`);
  if (!produced.size) errors.push('the task produces no output');
  return errors;
}

export function validateTaskBody(value: unknown, graph: LearnGraph): Validation<TaskBody> {
  const shape = bodyShape(value);
  if (!shape.ok) return shape;
  const errors = checkTaskBody(shape.value, graph);
  return errors.length ? { ok: false, errors } : shape;
}

export function validateLearnedTask(value: unknown, graph: LearnGraph): Validation<LearnedTask> {
  const shape = taskShape(value);
  if (!shape.ok) return shape;
  const errors = checkTaskBody(shape.value, graph);
  return errors.length ? { ok: false, errors } : shape;
}
