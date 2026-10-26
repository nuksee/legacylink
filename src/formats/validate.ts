import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { screenGraphSchema, type ScreenGraph } from './graph.js';

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
