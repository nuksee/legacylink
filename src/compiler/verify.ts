// The verify run: the draft runs once against the live app with its example
// input. A read must pass its post-condition. A write goes through the approval
// gate like any other write, commits, finds where its result appears, and must
// pass its post-condition too. Only a passing spec is returned for registering.

import type { Approver } from '../approval/gate.js';
import type { ToolSpec } from '../formats/tool.js';
import { validateToolSpec } from '../registry/registry.js';
import type { RunResult, Session } from '../runner/run.js';
import { CompileError } from './compile.js';

export interface VerifyOptions {
  session: Session;
  approve?: Approver;
  tools?: (name: string) => ToolSpec | undefined; // for readBack
}

export async function verify(draft: ToolSpec, opts: VerifyOptions): Promise<{ spec: ToolSpec; run: RunResult }> {
  const run = await opts.session.run(draft, draft.example.input, { approve: opts.approve, discover: true, tools: opts.tools, caller: 'verify' });
  if (run.outcome !== 'ok') {
    const e = run.error;
    throw new CompileError(`Verify run of ${draft.name} ${run.outcome}${e ? `: ${e.code}: ${e.message}` : ''} (run ${run.runId})`);
  }
  const spec: ToolSpec = structuredClone(draft);
  for (const [i, target] of Object.entries(run.discovered ?? {})) {
    const step = spec.steps[Number(i)];
    if (step?.op === 'extract') step.target = target;
  }
  spec.example.output = run.output;
  const v = validateToolSpec(spec);
  if (!v.ok) throw new CompileError(`${spec.name} is not a valid tool spec after the verify run:\n${v.errors.join('\n')}`);
  return { spec: v.value, run };
}
