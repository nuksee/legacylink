// Format 2: the tool spec. The compiler writes it, the registry stores it, the
// runner executes it. docs/architecture.md ("Format 2: the tool spec") is the
// spec; the types and the JSON Schema below must match it.

import type { Locator } from './graph.js';
import { PARSES, type JsonSchema, type Parse } from './task.js';

// What a step acts on: the element's key and intent from the graph, and its
// ranked locators. Inside forEach, keys and locators may use $line (1-based row).
export interface Target {
  key: string;
  intent: string;
  locators: Locator[];
}

// Expr: "$input.customerId", "$item.qty", "$output.orderNumber", or a literal.
export type Expr = string;

export type FillStep = { op: 'fill'; target: Target; value: Expr };
export type SelectStep = { op: 'select'; target: Target; value: Expr };

export type Step =
  | { op: 'ensureLogin' }
  | { op: 'goto'; screen: string; url: string }
  | FillStep
  | SelectStep
  | { op: 'click'; target: Target; commit?: true }
  | { op: 'clickRow'; grid: Target; match: { column: string; value: Expr }; link: Target }
  | { op: 'waitForScreen'; screen: string }
  | { op: 'extract'; target: Target; into: string; parse?: Parse }
  | { op: 'extractTable'; target: Target; into: string; columns: Record<string, string> }
  | { op: 'forEach'; items: Expr; steps: (FillStep | SelectStep)[] };

// How a readBack compares one field of the read tool's output: equal, or
// starting with the value as a whole word ("C1003" matches "C1003 - Adventure Works").
export type Expect = { equals: Expr } | { prefix: Expr };

export type Check =
  | { check: 'onScreen'; screen: string }
  | { check: 'visible'; target: Target }
  | { check: 'textMatches'; target: Target; pattern: string }
  | { check: 'outputMatches'; path: string; equals?: Expr; pattern?: string }
  | { check: 'readBack'; tool: string; input: Record<string, Expr>; expect: Record<string, Expect> };

export interface Postcondition {
  checks: Check[];
}

// An app-level failure that is not drift: the app worked and said no.
export interface ErrorRule {
  when: { target: Target; pattern?: string };
  code: string;
  message: Expr; // "$text" is the matched element's text
}

// Where a screen lives and how to recognise it, for goto and waitForScreen.
export interface ScreenRef {
  url: string;
  title: string;
  heading?: string;
}

export interface ToolSpec {
  formatVersion: 1;
  name: string;
  version: number;
  description: string;
  access: 'read' | 'write';
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  screens: Record<string, ScreenRef>;
  steps: Step[];
  postcondition: Postcondition;
  errors: ErrorRule[];
  provenance: {
    task: string;
    graphExploredAt: string;
    learnedAt: string;
    compiledAt: string;
    model: string;
    healedFrom?: number;
  };
  example: { input: Record<string, unknown>; output?: Record<string, unknown> };
}

const str = { type: 'string', minLength: 1 } as const;
const anyStr = { type: 'string' } as const;

// Locators are checked against the graph's schema shape, loosely: the graph
// validator owns the strict version.
const locator = { type: 'object', required: ['by'], properties: { by: { enum: ['role', 'label', 'id', 'name', 'text', 'css'] } } } as const;
const target = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'intent', 'locators'],
  properties: { key: str, intent: str, locators: { type: 'array', minItems: 1, items: locator } },
} as const;

const step = (op: string, required: string[], properties: object) => ({
  type: 'object',
  additionalProperties: false,
  required: ['op', ...required],
  properties: { op: { const: op }, ...properties },
});
const fill = step('fill', ['target', 'value'], { target, value: anyStr });
const select = step('select', ['target', 'value'], { target, value: anyStr });
const check = (name: string, required: string[], properties: object) => ({
  type: 'object',
  additionalProperties: false,
  required: ['check', ...required],
  properties: { check: { const: name }, ...properties },
});
const expect = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['equals'], properties: { equals: anyStr } },
    { type: 'object', additionalProperties: false, required: ['prefix'], properties: { prefix: anyStr } },
  ],
} as const;

export const toolSpecSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://legacylink.dev/schemas/tool-spec-1.json',
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'name', 'version', 'description', 'access', 'inputSchema', 'outputSchema', 'screens', 'steps', 'postcondition', 'errors', 'provenance', 'example'],
  properties: {
    formatVersion: { const: 1 },
    name: { type: 'string', pattern: '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' },
    version: { type: 'integer', minimum: 1 },
    description: str,
    access: { enum: ['read', 'write'] },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    screens: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title'],
        properties: { url: { type: 'string', pattern: '^/' }, title: anyStr, heading: anyStr },
      },
    },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        anyOf: [
          step('ensureLogin', [], {}),
          step('goto', ['screen', 'url'], { screen: str, url: { type: 'string', pattern: '^/' } }),
          fill,
          select,
          step('click', ['target'], { target, commit: { const: true } }),
          step('clickRow', ['grid', 'match', 'link'], {
            grid: target,
            match: { type: 'object', additionalProperties: false, required: ['column', 'value'], properties: { column: str, value: anyStr } },
            link: target,
          }),
          step('waitForScreen', ['screen'], { screen: str }),
          step('extract', ['target', 'into'], { target, into: str, parse: { enum: PARSES } }),
          step('extractTable', ['target', 'into', 'columns'], { target, into: str, columns: { type: 'object', minProperties: 1, additionalProperties: str } }),
          step('forEach', ['items', 'steps'], { items: str, steps: { type: 'array', minItems: 1, items: { anyOf: [fill, select] } } }),
        ],
      },
    },
    postcondition: {
      type: 'object',
      additionalProperties: false,
      required: ['checks'],
      properties: {
        checks: {
          type: 'array',
          minItems: 1,
          items: {
            anyOf: [
              check('onScreen', ['screen'], { screen: str }),
              check('visible', ['target'], { target }),
              check('textMatches', ['target', 'pattern'], { target, pattern: str }),
              check('outputMatches', ['path'], { path: str, equals: anyStr, pattern: str }),
              check('readBack', ['tool', 'input', 'expect'], {
                tool: str,
                input: { type: 'object', additionalProperties: anyStr },
                expect: { type: 'object', additionalProperties: expect },
              }),
            ],
          },
        },
      },
    },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['when', 'code', 'message'],
        properties: {
          when: { type: 'object', additionalProperties: false, required: ['target'], properties: { target, pattern: str } },
          code: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          message: anyStr,
        },
      },
    },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['task', 'graphExploredAt', 'learnedAt', 'compiledAt', 'model'],
      properties: { task: str, graphExploredAt: str, learnedAt: str, compiledAt: str, model: str, healedFrom: { type: 'integer', minimum: 1 } },
    },
    example: {
      type: 'object',
      additionalProperties: false,
      required: ['input'],
      properties: { input: { type: 'object' }, output: { type: 'object' } },
    },
  },
} as const;
