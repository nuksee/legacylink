// A rule-based stand-in for Muse Spark: same inputs, same JSON out. It names
// controls from their ids and captions and picks every safe action. Used for
// tests, CI and offline runs; the live model gives better names and intents.

import type { ElementRole } from '../formats/graph.js';
import { healTargetHeuristic } from './heal-heuristic.js';
import { learnTaskHeuristic } from './learn-heuristic.js';
import { camel, caption, words } from './text.js';
import type { AnalyzeScreenInput, AnalyzeScreenOutput, ElementSummary, Model, SearchValuesInput, SearchValuesOutput } from './types.js';

export const COMMIT_PATTERN = /^(save|submit|post|delete|remove|update|create|add|apply|approve|confirm|send|process|place|cancel \w+|void|ok)\b/i;
const CANCEL_PATTERN = /^(cancel|close|back|clear|reset)$/i;
const SEARCH_PATTERN = /\b(search|find|look ?up|go|filter|query|retrieve|refresh)\b/i;
export const LOGOUT_PATTERN = /\b(log ?out|log ?off|sign ?out|sign ?off)\b/i;

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

// "ctl00_MainContent_txtCustomerId" -> "customerId"
function keyFromId(id: string): string | undefined {
  const last = id.split(/[_$]/).filter(Boolean).pop() ?? '';
  const bare = last.replace(/^(txt|ddl|btn|lbl|lnk|hl|gv|dv|chk|rbl|pnl|lit|cbo|lst|img)(?=[A-Z0-9])/, '');
  return bare ? camel(bare) : undefined;
}


function baseKey(el: ElementSummary, gridKeys: Map<string, string>): string {
  switch (el.kind) {
    case 'button':
    case 'link':
      return camel(caption(el.text) || (el.id && keyFromId(el.id)) || el.kind) + (el.kind === 'link' ? 'Link' : '');
    case 'grid':
      return ((el.id && keyFromId(el.id)) || 'results') + 'Grid';
    case 'gridLink': {
      const grid = (el.grid && gridKeys.get(el.grid)?.replace(/Grid$/, '')) || 'row';
      return grid + cap(camel(caption(el.label) || caption(el.text) || 'row')) + 'Link';
    }
    default:
      return (el.id && keyFromId(el.id)) || camel(caption(el.label) || el.kind);
  }
}

function roleOf(el: ElementSummary, hasPassword: boolean): ElementRole | undefined {
  const text = caption(el.text);
  if (el.kind === 'link' || el.kind === 'gridLink') return 'navigate';
  if (el.kind !== 'button') return undefined;
  if (hasPassword) return 'navigate'; // the sign-in button
  if (CANCEL_PATTERN.test(text)) return 'cancel';
  if (COMMIT_PATTERN.test(text)) return 'commit';
  if (SEARCH_PATTERN.test(text)) return 'search';
  return 'commit'; // unknown buttons are treated as unsafe
}

function intentOf(el: ElementSummary): string {
  const label = caption(el.label);
  switch (el.kind) {
    case 'input':
    case 'textarea':
      return el.isPassword ? 'the password to sign in with' : `the value for "${label || el.name || el.id}"`;
    case 'select':
      return `a choice for "${label || el.name || el.id}"${el.options?.length ? ` (${el.options.slice(0, 3).join(', ')}, ...)` : ''}`;
    case 'button':
      return `the "${caption(el.text)}" button`;
    case 'link':
      return `opens "${caption(el.text)}"`;
    case 'gridLink':
      return `opens the selected row from the "${label || caption(el.text)}" column`;
    case 'grid':
      return `table with columns ${(el.columns ?? []).filter(Boolean).join(', ')}`;
    case 'output':
      return label ? `shows the ${label}` : `shows "${el.text ?? ''}"`;
    case 'message':
      return 'status or error message for the last action';
  }
}

function purposeOf(name: string, els: ElementSummary[], roles: Map<string, ElementRole | undefined>): string {
  const has = (r: ElementRole) => els.some((e) => roles.get(e.ref) === r);
  const fields = els.filter((e) => ['input', 'select', 'textarea'].includes(e.kind));
  if (els.some((e) => e.isPassword)) return 'Sign-in screen for the application.';
  if (has('commit')) return `Form to enter and save a record on the ${name} screen.`;
  if (has('search')) return `Search by ${fields.map((f) => caption(f.label)).filter(Boolean).join(' or ') || 'criteria'} and view the matching records.`;
  const outputs = els.filter((e) => e.kind === 'output').map((e) => caption(e.label)).filter(Boolean);
  if (outputs.length) return `Shows ${outputs.slice(0, 4).join(', ')}${outputs.length > 4 ? ' and more' : ''} for one record.`;
  const links = els.filter((e) => e.kind === 'link' && !LOGOUT_PATTERN.test(e.text ?? ''));
  const content = links.filter((e) => e.id); // menu bars rarely carry ids; links in the page body do
  return `Menu screen that links to ${(content.length ? content : links).map((e) => caption(e.text)).slice(0, 4).join(', ')}.`;
}

export { camel };

export const heuristicModel: Model = {
  id: 'heuristic',

  async analyzeScreen(input: AnalyzeScreenInput): Promise<AnalyzeScreenOutput> {
    const name = input.heading || input.title.split(' - ').pop() || input.title;
    const hasPassword = input.elements.some((e) => e.isPassword);
    const used = new Set(input.elements.map((e) => e.knownKey).filter((k): k is string => !!k));
    const gridKeys = new Map<string, string>();
    const roles = new Map<string, ElementRole | undefined>();
    const elements: AnalyzeScreenOutput['elements'] = [];

    // Grids first, so their links can be named after them.
    const ordered = [...input.elements].sort((a, b) => Number(b.kind === 'grid') - Number(a.kind === 'grid'));
    for (const el of ordered) {
      let key = el.knownKey;
      if (!key) {
        const base = baseKey(el, gridKeys);
        key = base;
        for (let n = 2; used.has(key); n++) key = `${base}${n}`;
        used.add(key);
      }
      if (el.kind === 'grid') gridKeys.set(el.ref, key);
      const role = roleOf(el, hasPassword);
      roles.set(el.ref, role);
      elements.push({ ref: el.ref, key, intent: intentOf(el), ...(role && { role }), ...(el.required && { required: true }) });
    }

    const nextActions = input.elements
      .filter((el) => {
        const role = roles.get(el.ref);
        if (el.kind === 'link' || el.kind === 'gridLink') return !LOGOUT_PATTERN.test(el.text ?? '');
        return el.kind === 'button' && (role === 'search' || role === 'cancel');
      })
      .map((el) => ({ ref: el.ref }));

    return { name, purpose: purposeOf(name, input.elements, roles), elements, nextActions };
  },

  async searchValues(input: SearchValuesInput): Promise<SearchValuesOutput> {
    // Fill the one field whose label best matches where a sample was seen;
    // searching on one field keeps the result set from going empty.
    let best: { key: string; value: string; score: number } | undefined;
    for (const f of input.fields) {
      const fw = new Set(words(caption(f.label) || f.key).map((w) => w.toLowerCase()));
      for (const s of input.samples) {
        if (f.maxLength && s.value.length > f.maxLength) continue;
        const sw = words(s.label).map((w) => w.toLowerCase());
        const score = sw.filter((w) => fw.has(w)).length / Math.max(sw.length, fw.size);
        if (score > 0 && (!best || score > best.score)) best = { key: f.key, value: s.value, score };
      }
    }
    return { values: best ? [{ key: best.key, value: best.value }] : [] };
  },

  learnTask: async (input) => learnTaskHeuristic(input),

  healTarget: async (input) => healTargetHeuristic(input),
};
