// The approval gate for writes (docs/architecture.md, "Approval gate for
// writes"). The runner fills the form, takes a screenshot and waits here
// until a person approves or rejects in the console, or the request times out.
// Nothing an MCP client sends can answer a request: only the console can.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export type Decision = 'approved' | 'rejected' | 'timeout';

export interface ApprovalRequest {
  id: string;
  runId: string;
  tool: string;
  version: number;
  input: Record<string, unknown>;
  screenshot: string; // file path
  healedSinceLastApproval: boolean;
  heal?: string[]; // what a heal in this call changed, one line per control
  requestedAt: string;
  expiresAt: string;
}

// Opens a request and returns its id at once; `decided` settles when a person answers.
export type Approver = (req: Omit<ApprovalRequest, 'id' | 'requestedAt' | 'expiresAt'>) => { id: string; decided: Promise<{ decision: Decision; by?: string }> };

interface Pending {
  req: ApprovalRequest;
  settle: (d: { decision: Decision; by?: string }) => void;
}

export class ApprovalGate extends EventEmitter {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 5 * 60_000) {
    super();
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.req;
  }

  // Resolves when a person decides or the timeout passes.
  readonly request: Approver = (r) => {
    const now = Date.now();
    const req: ApprovalRequest = { ...r, id: randomUUID().slice(0, 8), requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.timeoutMs).toISOString() };
    const decided = new Promise<{ decision: Decision; by?: string }>((resolve) => {
      const timer = setTimeout(() => settle({ decision: 'timeout' }), this.timeoutMs);
      const settle = (d: { decision: Decision; by?: string }) => {
        if (!this.pending.delete(req.id)) return;
        clearTimeout(timer);
        this.emit('decided', req, d);
        resolve(d);
      };
      this.pending.set(req.id, { req, settle });
    });
    this.emit('requested', req);
    return { id: req.id, decided };
  };

  decide(id: string, decision: 'approved' | 'rejected', by?: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.settle({ decision, by });
    return true;
  }
}

// For the CLI and tests: approve (or reject) everything without asking.
export const autoApprover =
  (decision: 'approved' | 'rejected' = 'approved', by = 'auto'): Approver =>
  () => ({ id: 'auto', decided: Promise.resolve({ decision, by }) });
