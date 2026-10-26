// Append-only run log: JSON Lines, one file per day (docs/architecture.md, "Run log").
// Only the events the explorer emits so far.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type RunEvent = {
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
};

export class RunLog {
  constructor(private readonly dir: string) {}

  async append(event: RunEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, `${event.at.slice(0, 10)}.jsonl`), JSON.stringify(event) + '\n');
  }
}
