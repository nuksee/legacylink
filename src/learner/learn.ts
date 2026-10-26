// The learner: one sentence plus the screen graph in, a learned task out.
// The model proposes the task; checkTaskBody (src/formats/validate.ts) makes
// sure it only names screens, controls and edges that exist and walks a path
// the app can take. Nothing here touches the app.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScreenGraph } from '../formats/graph.js';
import { learnGraph, type LearnedTask } from '../formats/task.js';
import { validateGraph, validateLearnedTask } from '../formats/validate.js';
import type { LearnerModel } from '../model/types.js';

export interface LearnOptions {
  graph: ScreenGraph;
  task: string;
  model: LearnerModel;
  name?: string; // force the tool name
  now?: () => Date;
}

export class LearnError extends Error {}

export async function loadGraph(file: string): Promise<ScreenGraph> {
  const v = validateGraph(JSON.parse(await readFile(file, 'utf8')));
  if (!v.ok) throw new LearnError(`${file} is not a valid screen graph:\n${v.errors.join('\n')}`);
  return v.value;
}

export async function learn(opts: LearnOptions): Promise<LearnedTask> {
  const view = learnGraph(opts.graph);
  const body = await opts.model.learnTask({ task: opts.task.trim(), graph: view });
  const learned: LearnedTask = {
    formatVersion: 1,
    ...body,
    ...(opts.name && { name: opts.name }),
    provenance: { task: opts.task.trim(), graphExploredAt: opts.graph.exploredAt, learnedAt: (opts.now?.() ?? new Date()).toISOString(), model: opts.model.id },
  };
  const v = validateLearnedTask(learned, view);
  if (!v.ok) throw new LearnError(`The learned task for "${opts.task}" is invalid:\n${v.errors.join('\n')}`);
  return v.value;
}

export async function writeTask(outDir: string, task: LearnedTask): Promise<string> {
  const dir = join(outDir, 'tasks');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${task.name}.json`);
  await writeFile(file, JSON.stringify(task, null, 2) + '\n');
  return file;
}
