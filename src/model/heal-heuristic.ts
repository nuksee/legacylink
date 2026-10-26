// A rule-based stand-in for Muse Spark's heal answer: same input, same JSON
// out. It only answers when the choice is clear: the one new control of the
// right kind, or the one whose words match best. Otherwise it says null and
// the tool stays failed, which is safer than guessing.

import { COMMIT_PATTERN } from './heuristic.js';
import { caption, words } from './text.js';
import type { ElementSummary, HealTargetInput, HealTargetOutput } from './types.js';

// Which element kinds a step can act on.
const KINDS: Record<string, string[]> = {
  fill: ['input', 'textarea'],
  select: ['select'],
  click: ['button', 'link'],
  extract: ['output'],
  extractTable: ['grid'],
  clickRow: ['grid'],
};

const shown = (el: Pick<ElementSummary, 'label' | 'text' | 'id'>) => caption(el.label) || caption(el.text) || el.id || '';

// The rules every heal answer must pass, the model's included: the right kind
// of control, and a commit stays a commit. A heal can never turn a read's
// click into a Save, or point a write's Save at another button.
export function eligible(missing: HealTargetInput['missing'], el: ElementSummary): string | undefined {
  const kinds = KINDS[missing.op];
  if (kinds && !kinds.includes(el.kind)) return `${el.ref} is a ${el.kind}, but ${missing.op} needs ${kinds.join(' or ')}`;
  if (missing.op === 'click') {
    const commits = COMMIT_PATTERN.test(caption(el.text));
    if (missing.commit && (el.kind !== 'button' || !commits)) return `${el.ref} ("${caption(el.text)}") doesn't look like a commit button`;
    if (!missing.commit && commits) return `${el.ref} ("${caption(el.text)}") looks like a commit button, and this step must not save anything`;
  }
  return undefined;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'value', 'button', 'ctl00', 'main', 'content', 'txt', 'btn', 'ddl', 'lbl', 'shows', 'opens']);
const bag = (...parts: (string | undefined)[]) =>
  new Set(
    parts
      .filter(Boolean)
      .flatMap((p) => words(p!))
      .map((w) => w.toLowerCase())
      .filter((w) => !STOP.has(w)),
  );

export function healTargetHeuristic(input: HealTargetInput): HealTargetOutput {
  const m = input.missing;
  const was = caption(m.label) || caption(m.text) || m.key;
  const pool = input.candidates.filter((c) => !eligible(m, c));
  if (!pool.length) return { ref: null, reason: `No new control on ${input.screen.name} can take the place of "${was}".` };
  if (pool.length === 1) {
    const c = pool[0]!;
    return { ref: c.ref, reason: `"${shown(c)}" is the only new ${c.kind} on ${input.screen.name}, so it replaces "${was}".` };
  }
  const old = bag(m.key, m.label, m.text, m.intent);
  const scored = pool
    .map((c) => {
      const w = bag(c.label, c.text, c.id?.split(/[_$]/).pop());
      return { c, score: [...w].filter((x) => old.has(x)).length + (m.section && c.section === m.section ? 0.5 : 0) };
    })
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best!.score || (next && next.score === best!.score))
    return { ref: null, reason: `${pool.length} new controls could replace "${was}" and nothing tells them apart.` };
  return { ref: best!.c.ref, reason: `"${shown(best!.c)}" shares the most words with "${was}" of the ${pool.length} new ${best!.c.kind}s.` };
}
