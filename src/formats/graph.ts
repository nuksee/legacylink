// Format 1: the screen graph. The explorer writes it, the learner reads it.
// docs/architecture.md is the spec; the types and the JSON Schema below must
// match it, and changes go through that doc first.

export interface ScreenGraph {
  formatVersion: 1;
  app: { name: string; baseUrl: string };
  exploredAt: string; // ISO 8601
  screens: Screen[];
  edges: Edge[];
}

export interface Screen {
  id: string; // stable slug, e.g. "new-sales-order"
  name: string; // "New Sales Order" (model-named)
  purpose: string; // one sentence (model-written)
  urlPattern: string; // "/Orders/New.aspx"
  entryUrl?: string; // when the query picks the screen: "/wp-admin/edit.php?post_type=product"
  fingerprint: Fingerprint;
  requiresLogin: boolean;
  elements: Element[];
  screenshot: string; // path under artifacts/
}

export interface Fingerprint {
  title: string;
  heading?: string;
  landmarks: string[]; // fieldset legends, grid ids
}

export const ELEMENT_KINDS = ['input', 'select', 'textarea', 'button', 'link', 'gridLink', 'output', 'grid', 'message'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export const ELEMENT_ROLES = ['commit', 'cancel', 'navigate', 'search'] as const;
export type ElementRole = (typeof ELEMENT_ROLES)[number];

export interface Element {
  key: string; // semantic name, unique per screen
  kind: ElementKind;
  label?: string;
  intent: string;
  locators: Locator[]; // ranked, best first
  role?: ElementRole; // buttons and links
  required?: boolean;
  options?: { value: string; text: string }[]; // selects
  maxLength?: number;
}

export type Locator =
  | { by: 'role'; role: string; name: string }
  | { by: 'label'; text: string }
  | { by: 'id'; id: string }
  | { by: 'name'; name: string }
  | { by: 'text'; text: string; exact?: boolean }
  | { by: 'css'; selector: string };

export const EDGE_KINDS = ['navigate', 'search', 'postback', 'commit'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Edge {
  id: string;
  from: string; // screen id
  to: string | null; // null while unexplored
  via: string; // element key on `from`
  kind: EdgeKind;
  fields?: string[]; // element keys the action submits
  status: 'explored' | 'unexplored';
}

const str = { type: 'string' } as const;
const nonEmpty = { type: 'string', minLength: 1 } as const;

const locatorSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['by', 'role', 'name'], properties: { by: { const: 'role' }, role: nonEmpty, name: str } },
    { type: 'object', additionalProperties: false, required: ['by', 'text'], properties: { by: { const: 'label' }, text: nonEmpty } },
    { type: 'object', additionalProperties: false, required: ['by', 'id'], properties: { by: { const: 'id' }, id: nonEmpty } },
    { type: 'object', additionalProperties: false, required: ['by', 'name'], properties: { by: { const: 'name' }, name: nonEmpty } },
    { type: 'object', additionalProperties: false, required: ['by', 'text'], properties: { by: { const: 'text' }, text: nonEmpty, exact: { type: 'boolean' } } },
    { type: 'object', additionalProperties: false, required: ['by', 'selector'], properties: { by: { const: 'css' }, selector: nonEmpty } },
  ],
} as const;

const elementSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'kind', 'intent', 'locators'],
  properties: {
    key: { type: 'string', pattern: '^[a-z][A-Za-z0-9]*$' },
    kind: { enum: ELEMENT_KINDS },
    label: str,
    intent: nonEmpty,
    locators: { type: 'array', minItems: 1, items: locatorSchema },
    role: { enum: ELEMENT_ROLES },
    required: { type: 'boolean' },
    options: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['value', 'text'], properties: { value: str, text: str } },
    },
    maxLength: { type: 'integer', minimum: 0 },
  },
} as const;

const slug = { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' } as const;

export const screenGraphSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://legacylink.dev/schemas/screen-graph-1.json',
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'app', 'exploredAt', 'screens', 'edges'],
  properties: {
    formatVersion: { const: 1 },
    app: { type: 'object', additionalProperties: false, required: ['name', 'baseUrl'], properties: { name: nonEmpty, baseUrl: nonEmpty } },
    exploredAt: nonEmpty,
    screens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'purpose', 'urlPattern', 'fingerprint', 'requiresLogin', 'elements', 'screenshot'],
        properties: {
          id: slug,
          name: nonEmpty,
          purpose: nonEmpty,
          urlPattern: { type: 'string', pattern: '^/' },
          entryUrl: { type: 'string', pattern: '^/' },
          fingerprint: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'landmarks'],
            properties: { title: str, heading: str, landmarks: { type: 'array', items: str } },
          },
          requiresLogin: { type: 'boolean' },
          elements: { type: 'array', items: elementSchema },
          screenshot: nonEmpty,
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'from', 'to', 'via', 'kind', 'status'],
        properties: {
          id: nonEmpty,
          from: slug,
          to: { oneOf: [slug, { type: 'null' }] },
          via: nonEmpty,
          kind: { enum: EDGE_KINDS },
          fields: { type: 'array', items: nonEmpty },
          status: { enum: ['explored', 'unexplored'] },
        },
      },
    },
  },
} as const;
