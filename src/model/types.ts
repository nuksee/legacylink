// What the explorer and learner ask the model, and the JSON it must answer with. Each
// call has a JSON Schema; answers are validated before they're used.

import { ELEMENT_ROLES, type ElementKind, type ElementRole, type Locator } from '../formats/graph.js';
import { taskBodySchema, type LearnGraph, type TaskBody } from '../formats/task.js';

// One element as the model sees it: the facts, no locators.
export interface ElementSummary {
  ref: string;
  kind: ElementKind;
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  label?: string;
  section?: string;
  href?: string;
  grid?: string;
  columns?: string[];
  options?: string[]; // option captions, trimmed to a few
  maxLength?: number;
  required?: boolean;
  isPassword?: boolean;
  knownKey?: string; // already named on an earlier visit: keep this key
}

export interface AnalyzeScreenInput {
  url: string; // path and query, relative to the app's base URL
  title: string;
  heading?: string;
  landmarks: string[];
  elements: ElementSummary[];
  knownScreens: { id: string; name: string }[];
  screenshot?: string; // base64 PNG; sent to the model, left out of the cache key
}

export interface AnalyzeScreenOutput {
  name: string;
  purpose: string;
  elements: { ref: string; key: string; intent: string; role?: ElementRole; required?: boolean }[];
  nextActions: { ref: string }[];
}

export const analyzeScreenSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'purpose', 'elements', 'nextActions'],
  properties: {
    name: { type: 'string', minLength: 1 },
    purpose: { type: 'string', minLength: 1 },
    elements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'key', 'intent'],
        properties: {
          ref: { type: 'string' },
          key: { type: 'string', pattern: '^[a-z][A-Za-z0-9]*$' },
          intent: { type: 'string', minLength: 1 },
          role: { enum: ELEMENT_ROLES },
          required: { type: 'boolean' },
        },
      },
    },
    nextActions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: { type: 'string' } } },
    },
  },
} as const;

export interface SearchValuesInput {
  screen: string; // screen name
  fields: { key: string; label?: string; intent: string; maxLength?: number }[];
  samples: { label: string; value: string }[]; // values seen elsewhere in the app
}

export interface SearchValuesOutput {
  values: { key: string; value: string }[]; // fields to fill; leave a field out to keep it empty
}

export const searchValuesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['values'],
  properties: {
    values: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value'],
        properties: { key: { type: 'string' }, value: { type: 'string' } },
      },
    },
  },
} as const;

export interface ExplorerModel {
  readonly id: string; // recorded as the model name in logs and provenance
  analyzeScreen(input: AnalyzeScreenInput): Promise<AnalyzeScreenOutput>;
  searchValues(input: SearchValuesInput): Promise<SearchValuesOutput>;
}

export interface LearnTaskInput {
  task: string; // the one-sentence description
  graph: LearnGraph;
}

export type LearnTaskOutput = TaskBody;
export const learnTaskSchema = taskBodySchema;

export interface LearnerModel {
  readonly id: string;
  learnTask(input: LearnTaskInput): Promise<LearnTaskOutput>;
}

// The healer's question: a control the tool used is gone. Which element on the
// screen now is the same control? The model picks a ref from the candidates
// (elements no other known control claims) or null; it never writes locators.
export interface HealTargetInput {
  tool: string;
  access: 'read' | 'write';
  screen: { name: string; url: string; title: string };
  missing: {
    key: string;
    kind?: string; // from the graph, when known
    intent: string;
    op: string; // the step that uses it: fill, select, click, extract, ...
    commit?: boolean; // the step is the write's commit click
    label?: string;
    text?: string;
    section?: string;
    oldLocators: Locator[];
  };
  candidates: ElementSummary[];
  screenshot?: string; // base64 PNG; sent to the model, left out of the cache key
}

export interface HealTargetOutput {
  ref: string | null;
  reason: string; // one sentence, shown in the console and the run log
}

export const healTargetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ref', 'reason'],
  properties: {
    ref: { type: ['string', 'null'] },
    reason: { type: 'string', minLength: 1 },
  },
} as const;

export interface HealerModel {
  readonly id: string;
  healTarget(input: HealTargetInput): Promise<HealTargetOutput>;
}

export type Model = ExplorerModel & LearnerModel & HealerModel;
