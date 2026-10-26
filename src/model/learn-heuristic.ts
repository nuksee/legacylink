// A rule-based stand-in for Muse Spark's learn step: same input, same JSON
// out. It knows two task shapes, which cover the demo's three tools:
//
//   read:  search on a screen (and open a grid row if the record shows on
//          another screen), then read every output on the record's screen
//   write: fill the fields a commit control submits, then press it
//
// It picks screens and fields by word overlap with the sentence. The live
// model handles anything else; this keeps tests, CI and offline work going.

import type { JsonSchema, LearnGraph, Parse, TaskBody, TaskStep, FillStep, SelectStep } from '../formats/task.js';
import { camel, caption, snake, words } from './text.js';
import type { LearnTaskInput } from './types.js';

type Screen = LearnGraph['screens'][number];
type El = Screen['elements'][number];

const WRITE = /\b(create|add|enter|key|place|submit|record|book|new)\b/i;
const STOP = new Set(['a', 'an', 'the', 'by', 'for', 'of', 'with', 'its', 'it', 'up', 'to', 'and', 'in', 'on', 'from', 'look', 'get', 'find', 'show', 'see', 's', 'their', 'one', 'two', 'three']);

const bag = (s: string) => new Set(words(s).map((w) => w.toLowerCase().replace(/s$/, '')).filter((w) => w.length > 1 && !STOP.has(w)));
const overlap = (a: Set<string>, text: string) => [...bag(text)].filter((w) => a.has(w)).length;

const label = (el: El) => caption(el.label) || caption(el.intent);
const columnsOf = (grid: El) => /columns (.+)$/.exec(grid.intent)?.[1]?.split(', ').filter(Boolean) ?? [];

function parseOf(text: string): Parse {
  if (/\b(total|balance|credit|price|amount|extended|cost)\b/i.test(text)) return 'money';
  if (/\bdate\b/i.test(text)) return 'date';
  if (/\b(qty|quantity|count)\b/i.test(text)) return 'int';
  return 'text';
}

const outputType = (p: Parse): JsonSchema => (p === 'money' ? { type: 'number' } : p === 'int' ? { type: 'integer' } : { type: 'string' });

function best<T>(items: T[], score: (t: T) => number): T | undefined {
  let top: T | undefined;
  let topScore = -1;
  for (const t of items) {
    const s = score(t);
    if (s > topScore) [top, topScore] = [t, s];
  }
  return top;
}

export function learnTaskHeuristic({ task, graph }: LearnTaskInput): TaskBody {
  const want = bag(task);
  const screen = (id: string) => graph.screens.find((s) => s.id === id)!;
  return WRITE.test(task) ? learnWrite(task, graph, want, screen) : learnRead(task, graph, want, screen);
}

function learnRead(task: string, graph: LearnGraph, want: Set<string>, screen: (id: string) => Screen): TaskBody {
  const withOutputs = graph.screens.filter((s) => s.elements.some((e) => e.kind === 'output'));
  const target = best(withOutputs, (s) => overlap(want, s.name) * 2 + overlap(want, s.purpose));
  if (!target) throw new Error('The heuristic learner found no screen that shows a record; use the live model');

  const searchEdge = (id: string) => graph.edges.find((e) => e.from === id && e.to === id && e.kind === 'search');
  // The record's screen has its own search, or a search screen opens it from a grid row.
  let from = searchEdge(target.id) ? target : undefined;
  const rowEdge = from
    ? undefined
    : graph.edges.find((e) => e.to === target.id && e.from !== target.id && searchEdge(e.from) && screen(e.from).elements.find((el) => el.key === e.via)?.kind === 'gridLink');
  if (rowEdge) from = screen(rowEdge.from);
  if (!from) throw new Error(`The heuristic learner found no search that leads to "${target.name}"; use the live model`);

  const search = searchEdge(from.id)!;
  const fields = from.elements.filter((e) => ['input', 'textarea', 'select'].includes(e.kind));
  const field = best(fields, (e) => overlap(want, label(e)))!;
  // Name the input after the record's own field with the same label (customerId), so tools agree.
  const same = target.elements.find((e) => e.kind === 'output' && label(e).toLowerCase() === label(field).toLowerCase());
  const inputName = same ? same.key.replace(/\d+$/, '') : /^search/.test(field.key) ? camel(label(field)) : field.key;

  const steps: TaskStep[] = [
    { op: 'open', screen: from.id },
    { op: field.kind === 'select' ? 'select' : 'fill', screen: from.id, element: field.key, value: `$input.${inputName}` },
    { op: 'click', screen: from.id, element: search.via, edge: search.id },
  ];
  if (rowEdge) {
    const link = from.elements.find((e) => e.key === rowEdge.via)!;
    const grids = from.elements.filter((e) => e.kind === 'grid');
    const grid = grids.find((g) => link.key.startsWith(g.key.replace(/Grid$/, ''))) ?? grids[0];
    const column = best(grid ? columnsOf(grid) : [], (c) => overlap(bag(label(field)), c) * 2 - Number(c !== caption(field.label)));
    steps.push({ op: 'clickRow', screen: from.id, element: link.key, edge: rowEdge.id, match: { column: column ?? label(field), value: `$input.${inputName}` } });
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const el of target.elements) {
    if (el.kind === 'output') {
      let into = el.key.replace(/\d+$/, '');
      if (properties[into]) into = el.key;
      const parse = parseOf(label(el));
      steps.push({ op: 'read', screen: target.id, element: el.key, into, ...(parse !== 'text' && { parse }) });
      properties[into] = { ...outputType(parse), description: label(el) };
      if (label(el).toLowerCase() === label(field).toLowerCase()) required.push(into);
    } else if (el.kind === 'grid') {
      const columns = Object.fromEntries(columnsOf(el).map((c) => [camel(c), c]));
      if (!Object.keys(columns).length) continue;
      const into = el.key.replace(/Grid$/, '') || el.key;
      steps.push({ op: 'readTable', screen: target.id, element: el.key, into, columns });
      properties[into] = {
        type: 'array',
        description: `rows of the ${Object.values(columns).join(', ')} table`,
        items: { type: 'object', properties: Object.fromEntries(Object.entries(columns).map(([k, c]) => [k, { type: 'string', description: c }])) },
      };
    }
  }

  return {
    name: `get_${snake(target.name)}`,
    description: `Read the ${target.name} screen of ${graph.app} for one ${label(field)}. Read-only.`,
    access: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [inputName],
      properties: { [inputName]: { type: 'string', minLength: 1, ...(field.maxLength && { maxLength: field.maxLength }), description: label(field) } },
    },
    outputSchema: { type: 'object', required, properties },
    steps,
  };
}

function inputSchemaFor(el: El): JsonSchema {
  if (el.kind === 'select') return { enum: (el.options ?? []).map((o) => o.value).filter(Boolean), description: label(el) };
  if (parseOf(label(el)) === 'int') return { type: 'integer', minimum: 1, ...(el.maxLength && { maximum: 10 ** el.maxLength - 1 }), description: label(el) };
  return { type: 'string', ...(el.required && { minLength: 1 }), ...(el.maxLength && { maxLength: el.maxLength }), description: label(el) };
}

function learnWrite(task: string, graph: LearnGraph, want: Set<string>, screen: (id: string) => Screen): TaskBody {
  const commits = graph.edges.filter((e) => e.kind === 'commit');
  const edge = best(commits, (e) => overlap(want, screen(e.from).name) * 2 + overlap(want, screen(e.from).purpose));
  if (!edge) throw new Error('The heuristic learner found no form that saves anything; use the live model');
  const form = screen(edge.from);
  const el = (key: string) => form.elements.find((e) => e.key === key)!;
  const fields = (edge.fields ?? form.elements.filter((e) => ['input', 'textarea', 'select'].includes(e.kind)).map((e) => e.key)).map(el);

  // Grid rows ("Product (row 2)" keyed product2) become one array input.
  const rowOf = (e: El) => (/\(row \d+\)/.test(e.label ?? '') ? /^(.*?)(\d+)$/.exec(e.key) : null);
  const groups = new Map<string, El[]>();
  for (const f of fields) {
    const m = rowOf(f);
    if (m) groups.set(m[1]!, [...(groups.get(m[1]!) ?? []), f]);
  }
  const bases = [...groups.keys()];
  const rows = Math.min(...[...groups.values()].map((g) => g.length));
  const columnOf = (base: string) => caption(groups.get(base)![0]!.label).replace(/\s*\(row \d+\)$/, '');
  const grid = form.elements.find((g) => g.kind === 'grid' && bases.every((b) => columnsOf(g).includes(columnOf(b))));
  const arrayName = grid?.key.replace(/Grid$/, '') || 'items';

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const steps: TaskStep[] = [{ op: 'open', screen: form.id }];
  const put = (f: El, value: string, key = f.key): FillStep | SelectStep =>
    f.kind === 'select' ? { op: 'select', screen: form.id, element: key, value } : { op: 'fill', screen: form.id, element: key, value };

  for (const f of fields) {
    const m = rowOf(f);
    if (!m) {
      properties[f.key] = inputSchemaFor(f);
      if (f.required) required.push(f.key);
      steps.push(put(f, `$input.${f.key}`));
    } else if (m[1] === bases[0] && m[2] === '1') {
      const items = Object.fromEntries(bases.map((b) => [b, { ...inputSchemaFor(groups.get(b)![0]!), description: columnOf(b) }]));
      properties[arrayName] = {
        type: 'array',
        minItems: 1,
        maxItems: rows,
        description: `${grid ? 'rows of the line grid' : 'repeated rows'}, up to ${rows}`,
        items: { type: 'object', additionalProperties: false, required: bases, properties: items },
      };
      required.push(arrayName);
      steps.push({ op: 'forEach', items: `$input.${arrayName}`, steps: bases.map((b) => put(groups.get(b)![0]!, `$item.${b}`, `${b}$line`)) });
    }
  }

  const thing = form.name.replace(/^(new|add|create|enter)\s+/i, '');
  const noun = words(thing).pop()?.toLowerCase() ?? 'record';
  const into = `${noun}Number`;
  steps.push({ op: 'click', screen: form.id, element: edge.via, edge: edge.id });
  steps.push({ op: 'readAfterCommit', into, intent: `the number of the ${thing.toLowerCase()} just saved` });

  return {
    name: `create_${snake(thing)}`,
    description: `Key a new ${thing.toLowerCase()} into ${graph.app}. A person must approve it before it is saved.`,
    access: 'write',
    inputSchema: { type: 'object', additionalProperties: false, required, properties },
    outputSchema: { type: 'object', required: [into], properties: { [into]: { type: 'string', minLength: 1, description: `number of the ${thing.toLowerCase()} just saved` } } },
    steps,
  };
}
