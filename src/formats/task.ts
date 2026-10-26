// The learned task: the learner's output and the compiler's input. It names a
// path through the screen graph by screen ids, element keys and edge ids, plus
// draft input and output schemas. It carries no locators; the compiler copies
// those from the graph. docs/architecture.md ("The learned task") is the spec.

import type { Edge, ElementKind, ElementRole, ScreenGraph } from './graph.js';

export type JsonSchema = { [key: string]: unknown };

export const PARSES = ['text', 'money', 'date', 'int'] as const;
export type Parse = (typeof PARSES)[number];

// Expr: "$input.customerId", "$item.qty", or a literal.
// Element keys inside forEach may use "$line" (1-based row), e.g. "product$line".
export type FillStep = { op: 'fill'; screen: string; element: string; value: string };
export type SelectStep = { op: 'select'; screen: string; element: string; value: string };

export type TaskStep =
  | { op: 'open'; screen: string }
  | FillStep
  | SelectStep
  | { op: 'click'; screen: string; element: string; edge: string }
  | { op: 'clickRow'; screen: string; element: string; edge: string; match: { column: string; value: string } }
  | { op: 'forEach'; items: string; steps: (FillStep | SelectStep)[] }
  | { op: 'read'; screen: string; element: string; into: string; parse?: Parse }
  | { op: 'readTable'; screen: string; element: string; into: string; columns: Record<string, string> }
  | { op: 'readAfterCommit'; into: string; intent: string; parse?: Parse };

// What the model (or the heuristic stand-in) returns.
export interface TaskBody {
  name: string; // snake_case MCP tool name
  description: string; // shown to MCP clients
  access: 'read' | 'write';
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  steps: TaskStep[];
}

export interface LearnedTask extends TaskBody {
  formatVersion: 1;
  provenance: { task: string; graphExploredAt: string; learnedAt: string; model: string };
}

// The graph as the learner sees it: no locators, screenshots or fingerprints,
// and only edges a task can follow (explored ones, plus commits).
export interface LearnGraph {
  app: string;
  exploredAt: string;
  screens: {
    id: string;
    name: string;
    purpose: string;
    url: string;
    requiresLogin: boolean;
    elements: { key: string; kind: ElementKind; label?: string; intent: string; role?: ElementRole; required?: boolean; maxLength?: number; options?: { value: string; text: string }[] }[];
  }[];
  edges: Pick<Edge, 'id' | 'from' | 'to' | 'via' | 'kind' | 'fields'>[];
}

export function learnGraph(graph: ScreenGraph): LearnGraph {
  return {
    app: graph.app.name,
    exploredAt: graph.exploredAt,
    screens: graph.screens.map((s) => ({
      id: s.id,
      name: s.name,
      purpose: s.purpose,
      url: s.urlPattern,
      requiresLogin: s.requiresLogin,
      elements: s.elements.map(({ locators: _, ...e }) => e),
    })),
    edges: graph.edges
      .filter((e) => e.status === 'explored' || e.kind === 'commit')
      .map((e) => ({ id: e.id, from: e.from, to: e.to, via: e.via, kind: e.kind, ...(e.fields && { fields: e.fields }) })),
  };
}

const str = { type: 'string', minLength: 1 } as const;
const on = { screen: str, element: str } as const;
const step = (op: string, required: string[], properties: object) => ({
  type: 'object',
  additionalProperties: false,
  required: ['op', ...required],
  properties: { op: { const: op }, ...properties },
});
const fill = step('fill', ['screen', 'element', 'value'], { ...on, value: str });
const select = step('select', ['screen', 'element', 'value'], { ...on, value: str });
const parse = { enum: PARSES } as const;

export const taskBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'access', 'inputSchema', 'outputSchema', 'steps'],
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' },
    description: str,
    access: { enum: ['read', 'write'] },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        anyOf: [
          step('open', ['screen'], { screen: str }),
          fill,
          select,
          step('click', ['screen', 'element', 'edge'], { ...on, edge: str }),
          step('clickRow', ['screen', 'element', 'edge', 'match'], {
            ...on,
            edge: str,
            match: { type: 'object', additionalProperties: false, required: ['column', 'value'], properties: { column: str, value: str } },
          }),
          step('forEach', ['items', 'steps'], { items: str, steps: { type: 'array', minItems: 1, items: { anyOf: [fill, select] } } }),
          step('read', ['screen', 'element', 'into'], { ...on, into: str, parse }),
          step('readTable', ['screen', 'element', 'into', 'columns'], { ...on, into: str, columns: { type: 'object', minProperties: 1, additionalProperties: str } }),
          step('readAfterCommit', ['into', 'intent'], { into: str, intent: str, parse }),
        ],
      },
    },
  },
} as const;

export const learnedTaskSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://legacylink.dev/schemas/learned-task-1.json',
  ...taskBodySchema,
  required: ['formatVersion', ...taskBodySchema.required, 'provenance'],
  properties: {
    formatVersion: { const: 1 },
    ...taskBodySchema.properties,
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['task', 'graphExploredAt', 'learnedAt', 'model'],
      properties: { task: str, graphExploredAt: str, learnedAt: str, model: str },
    },
  },
} as const;

