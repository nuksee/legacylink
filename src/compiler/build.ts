// compile = draft + verify run + register, for a set of learned tasks. Reads
// go first so a write's readBack can use them.

import type { Approver } from '../approval/gate.js';
import type { ScreenGraph } from '../formats/graph.js';
import type { LearnedTask } from '../formats/task.js';
import type { ToolSpec } from '../formats/tool.js';
import type { Registry } from '../registry/registry.js';
import type { RunResult, Session } from '../runner/run.js';
import { CompileError, compileDraft } from './compile.js';
import { verify } from './verify.js';

export interface BuildOptions {
  graph: ScreenGraph;
  tasks: LearnedTask[];
  examples: Record<string, Record<string, unknown>>; // tool name -> example input for its verify run
  registry: Registry;
  session: Session;
  approve?: Approver;
  log?: (msg: string) => void;
  now?: () => Date;
}

export async function build(opts: BuildOptions): Promise<{ spec: ToolSpec; file: string; run: RunResult }[]> {
  const log = opts.log ?? (() => {});
  const order = [...opts.tasks].sort((a, b) => (a.access === b.access ? 0 : a.access === 'read' ? -1 : 1));
  const built: { spec: ToolSpec; file: string; run: RunResult }[] = [];
  const known = new Map((await opts.registry.current()).map((s) => [s.name, s]));

  for (const task of order) {
    const example = opts.examples[task.name];
    if (!example) throw new CompileError(`No example input for ${task.name}; its verify run needs one`);
    const reads = [...known.values()].filter((s) => s.access === 'read');
    const draft = compileDraft({ task, graph: opts.graph, readTools: reads, example, version: await opts.registry.nextVersion(task.name), now: opts.now });
    log(`${task.name}: ${draft.steps.length} steps, verifying with ${JSON.stringify(example)}`);
    const { spec, run } = await verify(draft, { session: opts.session, approve: opts.approve, tools: (n) => known.get(n) });
    const file = await opts.registry.register(spec);
    if (spec.access === 'write') await opts.registry.markApproved(spec.name, spec.version);
    known.set(spec.name, spec);
    log(`  passed in ${run.ms} ms -> ${JSON.stringify(run.output).slice(0, 160)}`);
    log(`  registered ${spec.name}@${spec.version}`);
    built.push({ spec, file, run });
  }
  return built;
}
