// The healer (docs/architecture.md, "Self-heal"). When a run fails on drift,
// the runner hands it the page as it is now. The healer works out which of the
// tool's controls on this screen are gone, finds each one's replacement, and
// returns a patched spec. The runner retries the call with it; only when that
// retry passes its post-condition does the patch become the tool's next version.
//
// Finding a replacement, cheapest first:
//   1. deterministic: a new control with the old id's last part or the old caption
//   2. the model (Muse Spark): picks one of the unclaimed controls, with a reason
//   3. the rule-based stand-in, when the model is off or its call fails
// Only target locators change. Steps, schemas, error rules, post-conditions and
// the commit flag stay as they were, so a heal can't change what a tool does.

import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { summarize, verifiedLocators } from '../explorer/explore.js';
import { capture, type CapturedSnapshot, type RawElement } from '../explorer/snapshot.js';
import type { Locator, ScreenGraph } from '../formats/graph.js';
import type { Step, Target, ToolSpec } from '../formats/tool.js';
import { eligible } from '../model/heal-heuristic.js';
import { heuristicModel } from '../model/heuristic.js';
import { caption } from '../model/text.js';
import type { HealerModel, HealTargetInput } from '../model/types.js';
import { validateToolSpec, type Registry } from '../registry/registry.js';
import type { FailureReason, HealChange, RunLog } from '../runlog/runlog.js';
import { resolve as resolveLocators } from '../runner/locate.js';
import type { RunResult } from '../runner/run.js';

export interface HealerOptions {
  registry: Registry;
  runLog: RunLog;
  model: HealerModel & { mode?: string };
  fallback?: HealerModel; // when the model call fails; default the rule-based stand-in
  graphFile?: string; // the explorer's graph: tells known controls from new ones, and is updated after a heal
  artifactsDir: string;
  log?: (line: string) => void; // the visible heal lines (stderr when serving)
  maxPerHour?: number; // heals per tool (default 5); past it the tool is marked broken
  now?: () => number;
}

export interface HealPlan {
  from: ToolSpec;
  spec: ToolSpec; // the patched spec, version + 1
  reason: FailureReason;
  changes: HealChange[];
  usedModel: boolean;
  note: string[]; // one line per change, shown with a healed write's approval request
  graphPatch: { screen: string; key: string; locators: Locator[]; label?: string }[];
}

export interface HealResult {
  status: 'healed' | 'unverified' | 'failed';
  fromVersion: number;
  toVersion?: number;
  failedRunId: string;
  changes: HealChange[];
  message: string;
}

// Where a step happens: the screen the last goto or waitForScreen entered.
// Steps right after a click, before its waitForScreen, belong to no screen.
function screensOf(spec: ToolSpec): (string | undefined)[] {
  let screen: string | undefined;
  return spec.steps.map((s) => {
    if (s.op === 'goto' || s.op === 'waitForScreen') screen = s.screen;
    const here = screen;
    if (s.op === 'click' || s.op === 'clickRow') screen = undefined;
    return here;
  });
}

// The targets a step acts on directly ($line row targets are left alone).
function targetsOf(step: Step): Target[] {
  const out: Target[] = [];
  if ('target' in step) out.push(step.target);
  if (step.op === 'clickRow') out.push(step.grid);
  if (step.op === 'forEach') for (const s of step.steps) out.push(s.target);
  return out.filter((t) => !t.key.includes('$line') && !JSON.stringify(t.locators).includes('$line'));
}

// The page state a failing step saw: from the screen's entry to the first click
// after it. Controls after that click belong to the next page state.
function segment(spec: ToolSpec, at: number): number[] {
  let start = at;
  while (start > 0 && !['goto', 'waitForScreen', 'click', 'clickRow'].includes(spec.steps[start - 1]!.op)) start--;
  const out: number[] = [];
  for (let i = start; i < spec.steps.length; i++) {
    out.push(i);
    if (i >= at && (spec.steps[i]!.op === 'click' || spec.steps[i]!.op === 'clickRow')) break;
  }
  return out;
}

// "\"Customer #:\" #ctl00_MainContent_txtCustomerId", for people reading the log.
export function describe(locators: Locator[], label?: string): string {
  const name = label ?? locators.map((l) => (l.by === 'role' ? l.name : l.by === 'label' || l.by === 'text' ? l.text : undefined)).find(Boolean);
  const id = locators.find((l) => l.by === 'id');
  const parts = [name && `"${name}"`, id && id.by === 'id' && `#${id.id}`].filter(Boolean);
  return parts.join(' ') || (locators[0] ? JSON.stringify(locators[0]) : '(no locators)');
}

// Built from source text so the TypeScript toolchain can't inject helpers into it (see run.ts).
const INDEX_OF = new Function('n', 'return window.__llElements.indexOf(n)') as (n: Element) => number;

const idTail = (id?: string) => id?.split(/[_$]/).filter(Boolean).pop()?.toLowerCase();

export class Healer extends EventEmitter {
  private readonly recent = new Map<string, number[]>();
  private readonly healed = new Map<string, ToolSpec>();

  constructor(private readonly opts: HealerOptions) {
    super();
  }

  // A caller holding an older version (a readBack's tool list, say) gets the healed one.
  latest(spec: ToolSpec): ToolSpec {
    const h = this.healed.get(spec.name);
    return h && h.version > spec.version ? h : spec;
  }

  get model(): HealerModel & { mode?: string } {
    return this.opts.model;
  }

  private say(line: string): void {
    this.opts.log?.(line);
  }

  private async graph(): Promise<ScreenGraph | undefined> {
    if (!this.opts.graphFile) return undefined;
    const text = await readFile(this.opts.graphFile, 'utf8').catch(() => undefined);
    return text ? (JSON.parse(text) as ScreenGraph) : undefined;
  }

  private async fail(spec: ToolSpec, failed: RunResult, message: string, changes: HealChange[] = [], usedModel = false): Promise<undefined> {
    this.say(`[heal] ${spec.name} v${spec.version}: not healed. ${message}`);
    await this.opts.runLog.append({
      type: 'heal',
      runId: failed.runId,
      at: new Date().toISOString(),
      tool: spec.name,
      fromVersion: spec.version,
      reason: failed.error?.reason ?? 'failed',
      status: 'failed',
      changes,
      usedModel,
      model: this.opts.model.id,
      message,
    });
    return undefined;
  }

  // Called by the runner with the page still on the failing screen. A heal
  // that crashes is logged and leaves the call's original failure in place.
  async plan(page: Page, spec: ToolSpec, failed: RunResult): Promise<HealPlan | undefined> {
    try {
      return await this.tryPlan(page, spec, failed);
    } catch (e) {
      return this.fail(spec, failed, `The healer crashed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  private async tryPlan(page: Page, spec: ToolSpec, failed: RunResult): Promise<HealPlan | undefined> {
    const reason = failed.error!.reason!;
    const at = failed.error?.step ?? spec.steps.length - 1;
    if (reason === 'locator_failed' && !failed.error?.key) return this.fail(spec, failed, `The page itself is not the expected screen: ${failed.error?.message}`);

    // A write that failed after its commit may already have saved the record.
    // Retrying it could save it twice, so that one goes to a person.
    const commit = spec.steps.findIndex((s) => s.op === 'click' && s.commit);
    if (spec.access === 'write' && (failed.error?.step === undefined || at >= commit))
      return this.fail(spec, failed, 'The write failed after its commit step, so the record may already be saved. A person needs to check before it runs again.');

    const now = (this.opts.now ?? Date.now)();
    const recent = (this.recent.get(spec.name) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= (this.opts.maxPerHour ?? 5)) {
      await this.opts.registry.markBroken(spec.name);
      return this.fail(spec, failed, `${recent.length} heals in the last hour; marked broken until someone looks at it.`);
    }

    const screens = screensOf(spec);
    const screenId = screens[at];
    const ref = screenId ? spec.screens[screenId] : undefined;
    if (!screenId || !ref) return this.fail(spec, failed, `Step ${at} is not on a known screen.`);

    const snap = await capture(page);
    const shot = await page.screenshot({ fullPage: true }).catch(() => undefined);
    if (shot) {
      await mkdir(join(this.opts.artifactsDir, failed.runId), { recursive: true });
      await writeFile(join(this.opts.artifactsDir, failed.runId, 'heal.png'), shot);
    }
    const graph = await this.graph();
    const gScreen = graph?.screens.find((s) => s.id === screenId);

    // Every control this screen is known to have: the tool's own targets on it
    // and the graph's elements. The ones that still resolve claim their element.
    const known = new Map<string, Target>();
    screens.forEach((s, i) => {
      if (s === screenId) for (const t of targetsOf(spec.steps[i]!)) if (!known.has(t.key)) known.set(t.key, t);
    });
    const ownKeys = new Set(known.keys());
    for (const el of gScreen?.elements ?? []) if (!known.has(el.key)) known.set(el.key, { key: el.key, intent: el.intent, locators: el.locators });

    const claimed = new Set<string>();
    const resolved = new Set<string>();
    for (const t of known.values()) {
      const r = await resolveLocators(page, t.locators);
      if (!r) continue;
      resolved.add(t.key);
      const i = await r.locator.evaluate(INDEX_OF).catch(() => -1);
      if (i >= 0) claimed.add(snap.elements[i]!.ref);
    }

    // What to heal: the failing control, then any other control of the same page state that is gone too.
    const inSegment = new Set(segment(spec, at).flatMap((i) => targetsOf(spec.steps[i]!).map((t) => t.key)));
    const failedKey = failed.error?.key;
    if (failedKey && !ownKeys.has(failedKey)) return this.fail(spec, failed, `${failedKey} is a repeated row control; those aren't healed yet.`);
    const broken = [...ownKeys].filter((k) => !resolved.has(k) && (inSegment.has(k) || k === failedKey));
    if (failedKey && !broken.includes(failedKey)) broken.unshift(failedKey);
    broken.sort((a, b) => Number(b === failedKey) - Number(a === failedKey));
    if (!broken.length) return this.fail(spec, failed, 'Every control on this screen still resolves; nothing to re-locate.');

    const stepOf = (key: string) => spec.steps.findIndex((s, i) => screens[i] === screenId && targetsOf(s).some((t) => t.key === key));
    const changes: HealChange[] = [];
    const graphPatch: HealPlan['graphPatch'] = [];
    const replace = new Map<string, Target>();
    let usedModel = false;

    for (const key of broken) {
      const old = known.get(key)!;
      const idx = stepOf(key);
      const step = spec.steps[idx]!;
      const gEl = gScreen?.elements.find((e) => e.key === key);
      const oldLabel = old.locators.flatMap((l) => (l.by === 'label' ? [l.text] : [])).at(0);
      const oldText = old.locators.map((l) => (l.by === 'role' ? l.name : l.by === 'text' ? l.text : undefined)).find(Boolean);
      const missing: HealTargetInput['missing'] = {
        key,
        intent: old.intent,
        op: step.op === 'forEach' ? (step.steps.find((s) => s.target.key === key)?.op ?? 'fill') : step.op === 'clickRow' ? 'clickRow' : step.op,
        oldLocators: old.locators,
        ...(gEl && { kind: gEl.kind }),
        ...(step.op === 'click' && step.commit && { commit: true }),
        ...((oldLabel ?? gEl?.label) && { label: (oldLabel ?? gEl?.label)! }),
        ...(oldText && { text: oldText }),
      };
      const candidates = snap.elements.filter((e) => !claimed.has(e.ref) && e.kind !== 'message').map(summarize);
      const input: HealTargetInput = {
        tool: spec.name,
        access: spec.access,
        screen: { name: gScreen?.name ?? ref.heading ?? screenId, url: ref.url, title: ref.title },
        missing,
        candidates,
        ...(shot && { screenshot: shot.toString('base64') }),
      };

      const pick = await this.choose(input);
      if (pick.via === 'model') usedModel = true;
      const el = pick.ref ? snap.elements.find((e) => e.ref === pick.ref) : undefined;
      if (!el) {
        if (key === failedKey) return this.fail(spec, failed, `No replacement for ${key} (${describe(old.locators, missing.label)}): ${pick.why}`, changes, usedModel);
        continue; // another gone control; the retry will say if it matters
      }
      const locators = await this.locatorsFor(page, snap, el);
      claimed.add(el.ref);
      replace.set(key, { ...old, locators });
      changes.push({ step: idx, key, before: describe(old.locators, missing.label), after: describe(locators, el.label ?? el.text), via: pick.via, why: pick.why });
      graphPatch.push({ screen: screenId, key, locators, ...(el.label && { label: el.label }) });
    }

    // The patch: same spec, new locators for the replaced keys on this screen.
    const patched = JSON.parse(JSON.stringify(spec)) as ToolSpec;
    patched.steps.forEach((s, i) => {
      if (screens[i] !== screenId) return;
      const swap = (t: Target) => (replace.has(t.key) ? { ...t, locators: replace.get(t.key)!.locators } : t);
      if ('target' in s) s.target = swap(s.target);
      if (s.op === 'clickRow') s.grid = swap(s.grid);
      if (s.op === 'forEach') for (const inner of s.steps) inner.target = swap(inner.target);
    });
    patched.version = await this.opts.registry.nextVersion(spec.name);
    patched.provenance = { ...patched.provenance, healedFrom: spec.version };
    const valid = validateToolSpec(patched);
    if (!valid.ok) return this.fail(spec, failed, `The patched spec is invalid: ${valid.errors.join('; ')}`, changes, usedModel);

    const who = (c: HealChange) => (c.via === 'model' ? this.opts.model.id : c.via === 'heuristic' ? 'rule-based stand-in' : 'exact match');
    const note = changes.map((c) => `${c.key}: ${c.before} -> ${c.after} (${who(c)}: ${c.why})`);
    this.say(`[heal] ${spec.name} v${spec.version} broke at step ${at} (${failed.error?.message})`);
    for (const line of note) this.say(`[heal]   ${line}`);
    this.say(`[heal]   retrying as v${patched.version}; it is kept only if its post-condition passes`);
    return { from: spec, spec: patched, reason, changes, usedModel, note, graphPatch };
  }

  // Deterministic first, then the model, then the stand-in if the model call fails.
  private async choose(input: HealTargetInput): Promise<{ ref: string | null; why: string; via: HealChange['via'] }> {
    const m = input.missing;
    const ok = input.candidates.filter((c) => !eligible(m, c));
    const oldId = idTail(m.oldLocators.find((l) => l.by === 'id')?.id);
    const sameCaption = (c: (typeof ok)[number]) => (m.label && c.label === m.label) || (m.text && caption(c.text) === caption(m.text));
    const exact = ok.filter((c) => (oldId && idTail(c.id) === oldId) || sameCaption(c));
    if (exact.length === 1) return { ref: exact[0]!.ref, why: 'same id or caption as before', via: 'deterministic' };

    const isStandIn = this.opts.model.id === heuristicModel.id;
    try {
      const out = await this.opts.model.healTarget(input);
      const el = out.ref === null ? undefined : input.candidates.find((c) => c.ref === out.ref);
      const bad = out.ref !== null && (!el || eligible(m, el));
      if (!bad) return { ref: out.ref, why: out.reason, via: isStandIn ? 'heuristic' : 'model' };
      this.say(`[heal]   ${this.opts.model.id} picked ${out.ref}, which the heal rules refuse; using the rule-based stand-in`);
    } catch (e) {
      if (isStandIn) throw e;
      this.say(`[heal]   ${this.opts.model.id} call failed (${(e as Error).message.split('\n')[0]}); using the rule-based stand-in`);
    }
    const out = await (this.opts.fallback ?? heuristicModel).healTarget(input);
    return { ref: out.ref, why: out.reason, via: 'heuristic' };
  }

  private async locatorsFor(page: Page, snap: CapturedSnapshot, el: RawElement): Promise<Locator[]> {
    return verifiedLocators(page, el, snap.handles.get(el.ref));
  }

  // Called by the runner after the retry. Only a passing retry is registered.
  async settle(plan: HealPlan, failed: RunResult, retry: RunResult): Promise<HealResult> {
    const { from, spec, changes } = plan;
    const base = { fromVersion: from.version, failedRunId: failed.runId, changes };
    let result: HealResult;
    if (retry.outcome === 'ok') {
      await this.opts.registry.register(spec);
      this.healed.set(spec.name, spec);
      await this.patchGraph(plan);
      const now = (this.opts.now ?? Date.now)();
      this.recent.set(from.name, [...(this.recent.get(from.name) ?? []).filter((t) => now - t < 3_600_000), now]);
      result = { ...base, status: 'healed', toVersion: spec.version, message: `${from.name} healed: v${from.version} -> v${spec.version}, post-condition passed on run ${retry.runId}` };
    } else if (retry.outcome === 'rejected' || retry.outcome === 'approval_timeout') {
      result = { ...base, status: 'unverified', message: `The healed ${from.name} was not approved (${retry.outcome}), so it was not saved; the next call heals again` };
    } else {
      result = { ...base, status: 'failed', message: `The healed ${from.name} failed too (${retry.error?.code}: ${retry.error?.message})` };
    }
    await this.opts.runLog.append({
      type: 'heal',
      runId: failed.runId,
      at: new Date().toISOString(),
      tool: from.name,
      fromVersion: from.version,
      ...(result.toVersion && { toVersion: result.toVersion }),
      reason: plan.reason,
      status: result.status,
      changes,
      usedModel: plan.usedModel,
      model: this.opts.model.id,
      retryRunId: retry.runId,
      message: result.message,
    });
    this.say(`[heal] ${result.message}`);
    if (result.status === 'healed') this.emit('healed', spec);
    return result;
  }

  // The graph learns the new locators too, so the next compile starts from them.
  private async patchGraph(plan: HealPlan): Promise<void> {
    const graph = await this.graph();
    if (!graph || !this.opts.graphFile) return;
    for (const p of plan.graphPatch) {
      const el = graph.screens.find((s) => s.id === p.screen)?.elements.find((e) => e.key === p.key);
      if (!el) continue;
      el.locators = p.locators;
      if (p.label && ['input', 'select', 'textarea'].includes(el.kind)) el.label = p.label;
    }
    await writeFile(this.opts.graphFile, JSON.stringify(graph, null, 2) + '\n');
  }
}
