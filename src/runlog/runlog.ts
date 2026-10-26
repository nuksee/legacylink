// Append-only run log: JSON Lines, one file per day (docs/architecture.md, "Run log").

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Outcome = 'ok' | 'app_error' | 'rejected' | 'approval_timeout' | 'failed';
export type FailureReason = 'invalid_input' | 'locator_failed' | 'postcondition_failed' | 'app_unreachable' | 'failed';

export type RunEvent =
  | {
      type: 'model_call';
      runId?: string;
      at: string;
      stage: 'explore' | 'learn' | 'compile' | 'heal';
      prompt: string;
      inputHash: string;
      tokensIn: number;
      tokensOut: number;
      ms: number;
      cached: boolean;
    }
  | { type: 'run_started'; runId: string; at: string; tool: string; version: number; access: 'read' | 'write'; input: object; caller?: string }
  | { type: 'step'; runId: string; at: string; index: number; op: string; key?: string; matchedLocator?: number; ms: number; ok: boolean; error?: string }
  | { type: 'approval_requested'; runId: string; at: string; approvalId: string; screenshot: string; healedSinceLastApproval: boolean }
  | { type: 'approval_decided'; runId: string; at: string; approvalId: string; decision: 'approved' | 'rejected' | 'timeout'; by?: string }
  | {
      type: 'run_finished';
      runId: string;
      at: string;
      tool: string;
      outcome: Outcome;
      output?: object;
      error?: { code: string; message: string; reason?: FailureReason; step?: number };
      postcondition: 'passed' | 'failed' | 'skipped';
      ms: number;
    };

export class RunLog {
  constructor(readonly dir: string) {}

  async append(event: RunEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, `${event.at.slice(0, 10)}.jsonl`), JSON.stringify(event) + '\n');
  }

  // The most recent events of one day (today by default), newest last.
  async tail(limit = 100, day = new Date().toISOString().slice(0, 10)): Promise<RunEvent[]> {
    const text = await readFile(join(this.dir, `${day}.jsonl`), 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as RunEvent);
  }
}
