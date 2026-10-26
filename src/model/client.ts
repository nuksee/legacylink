// Picks the model for the explorer and learner and wraps every call in validation, one retry,
// the record/replay cache and the run log.
//
//   LEGACYLINK_MODEL=live       call Muse Spark; answers are recorded, and a recorded answer is reused
//   LEGACYLINK_MODEL=replay     answer only from recordings; a miss is an error (for rehearsals)
//   LEGACYLINK_MODEL=heuristic  no model: the rule-based stand-in (tests, CI, offline)
// Default: live when MODEL_API_KEY is set, heuristic otherwise.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkTaskBody, validator } from '../formats/validate.js';
import type { RunLog } from '../runlog/runlog.js';
import { heuristicModel } from './heuristic.js';
import { chat, museConfigFromEnv, type MuseConfig } from './muse.js';
import {
  analyzeScreenSchema,
  learnTaskSchema,
  searchValuesSchema,
  type AnalyzeScreenInput,
  type AnalyzeScreenOutput,
  type LearnTaskInput,
  type LearnTaskOutput,
  type Model,
  type SearchValuesInput,
  type SearchValuesOutput,
} from './types.js';

export type ModelMode = 'live' | 'replay' | 'heuristic';

export interface ModelOptions {
  mode?: ModelMode;
  cacheDir: string;
  runLog?: RunLog;
  env?: NodeJS.ProcessEnv;
}

const PROMPTS = new URL('../../prompts/', import.meta.url);
const prompts = new Map<string, string>();
async function prompt(id: string): Promise<string> {
  if (!prompts.has(id)) prompts.set(id, await readFile(new URL(`${id}.md`, PROMPTS), 'utf8'));
  return prompts.get(id)!;
}

// Key order must not change the hash.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

export class ModelError extends Error {}

const validAnalyze = validator<AnalyzeScreenOutput>(analyzeScreenSchema);
const validSearch = validator<SearchValuesOutput>(searchValuesSchema);
const validLearn = validator<LearnTaskOutput>(learnTaskSchema);

function checkAnalyze(input: AnalyzeScreenInput, out: AnalyzeScreenOutput): string[] {
  const refs = new Set(input.elements.map((e) => e.ref));
  const errors: string[] = [];
  const seenRefs = new Set<string>();
  const keys = new Set<string>();
  for (const e of out.elements) {
    if (!refs.has(e.ref)) errors.push(`elements: unknown ref "${e.ref}"`);
    if (seenRefs.has(e.ref)) errors.push(`elements: ref "${e.ref}" named twice`);
    if (keys.has(e.key)) errors.push(`elements: key "${e.key}" used twice`);
    seenRefs.add(e.ref);
    keys.add(e.key);
  }
  for (const r of refs) if (!seenRefs.has(r)) errors.push(`elements: ref "${r}" was not named`);
  for (const a of out.nextActions) if (!refs.has(a.ref)) errors.push(`nextActions: unknown ref "${a.ref}"`);
  return errors;
}

function checkSearch(input: SearchValuesInput, out: SearchValuesOutput): string[] {
  const keys = new Set(input.fields.map((f) => f.key));
  return out.values.filter((v) => !keys.has(v.key)).map((v) => `values: unknown field "${v.key}"`);
}

export function createModel(opts: ModelOptions): Model & { mode: ModelMode } {
  const env = opts.env ?? process.env;
  const cfg = museConfigFromEnv(env);
  const mode: ModelMode = opts.mode ?? (env.LEGACYLINK_MODEL as ModelMode | undefined) ?? (cfg ? 'live' : 'heuristic');
  if (!['live', 'replay', 'heuristic'].includes(mode)) throw new ModelError(`Unknown LEGACYLINK_MODEL "${mode}"`);
  if (mode === 'heuristic') return { ...heuristicModel, mode };
  if (mode === 'live' && !cfg) throw new ModelError('LEGACYLINK_MODEL=live needs MODEL_API_KEY');
  const modelId = cfg?.model ?? env.MUSE_MODEL ?? 'muse-spark-1.3';

  async function call<I extends object, O>(
    stage: 'explore' | 'learn',
    promptId: string,
    schemaName: string,
    schema: object,
    input: I & { screenshot?: string },
    valid: (v: unknown) => { ok: true; value: O } | { ok: false; errors: string[] },
    check: (input: I, out: O) => string[],
  ): Promise<O> {
    const { screenshot, ...keyed } = input;
    // The screenshot is sent but not hashed, so pixel noise (a clock, a date) can't break replay.
    const inputHash = createHash('sha256').update(stable({ prompt: promptId, model: modelId, input: keyed })).digest('hex').slice(0, 32);
    const file = join(opts.cacheDir, `${inputHash}.json`);
    const started = Date.now();
    const log = (tokensIn: number, tokensOut: number, cached: boolean) =>
      opts.runLog?.append({ type: 'model_call', at: new Date().toISOString(), stage, prompt: promptId, inputHash, tokensIn, tokensOut, ms: Date.now() - started, cached });

    const recorded = await readFile(file, 'utf8').then(
      (t) => JSON.parse(t) as { output: unknown },
      () => undefined,
    );
    if (recorded) {
      const v = valid(recorded.output);
      if (v.ok && !check(input, v.value).length) {
        await log(0, 0, true);
        return v.value;
      }
    }
    if (mode === 'replay') throw new ModelError(`No recorded answer for ${promptId} (${inputHash}); record one with LEGACYLINK_MODEL=live`);

    const system = await prompt(promptId);
    let user = JSON.stringify(keyed, null, 1);
    let tokensIn = 0;
    let tokensOut = 0;
    let lastErrors: string[] = [];
    let raw = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await chat(cfg as MuseConfig, { system, user, image: screenshot, schemaName, schema });
      tokensIn += res.tokensIn;
      tokensOut += res.tokensOut;
      raw = res.content;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        lastErrors = ['the answer is not valid JSON'];
      }
      if (parsed !== undefined) {
        const v = valid(parsed);
        lastErrors = v.ok ? check(input, v.value) : v.errors;
        if (v.ok && !lastErrors.length) {
          await mkdir(opts.cacheDir, { recursive: true });
          await writeFile(file, JSON.stringify({ prompt: promptId, model: modelId, inputHash, at: new Date().toISOString(), input: keyed, output: v.value }, null, 2));
          await log(tokensIn, tokensOut, false);
          return v.value;
        }
      }
      user = `${JSON.stringify(keyed, null, 1)}\n\nYour previous answer was rejected:\n${lastErrors.map((e) => `- ${e}`).join('\n')}\nAnswer again with corrected JSON only.`;
    }
    await log(tokensIn, tokensOut, false);
    throw new ModelError(`${promptId}: model answer failed validation twice: ${lastErrors.join('; ')}\nRaw answer: ${raw.slice(0, 2000)}`);
  }

  return {
    id: modelId,
    mode,
    analyzeScreen: (input: AnalyzeScreenInput) => call('explore', 'explore-screen', 'screen_analysis', analyzeScreenSchema, input, validAnalyze, checkAnalyze),
    searchValues: (input: SearchValuesInput) => call('explore', 'explore-search-values', 'search_values', searchValuesSchema, input, validSearch, checkSearch),
    learnTask: (input: LearnTaskInput) => call('learn', 'learn-task', 'learned_task', learnTaskSchema, input, validLearn, (i, out) => checkTaskBody(out, i.graph)),
  };
}
