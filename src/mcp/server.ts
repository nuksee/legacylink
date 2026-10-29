// The MCP server: every registered tool becomes an MCP tool with its input and
// output schemas. A call validates its input, runs the spec, checks the
// post-condition and returns the output. A healthy tool makes no model call;
// only a heal after drift may ask the model.
// Writes wait in the approval gate; only the console can answer them.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalGate } from '../approval/gate.js';
import { startConsole } from '../console/console.js';
import type { ToolSpec } from '../formats/tool.js';
import type { Healer } from '../healer/heal.js';
import type { ModelMode } from '../model/client.js';
import type { Session } from '../runner/run.js';
import type { Workspace } from '../workspace.js';

const PROGRESS_EVERY = 10_000; // keeps a client's request timer alive while a write waits for approval

export function toMcpTool(spec: ToolSpec): Tool {
  const write = spec.access === 'write';
  return {
    name: spec.name,
    description: write ? `${spec.description} The call waits until a person approves or rejects it in the LegacyLink console.` : spec.description,
    inputSchema: spec.inputSchema as Tool['inputSchema'],
    outputSchema: spec.outputSchema as Tool['outputSchema'],
    annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: !write, openWorldHint: false },
    _meta: { 'legacylink/version': spec.version },
  };
}

export interface McpOptions {
  workspace: Workspace;
  session: Session;
  gate: ApprovalGate;
  healer?: Healer; // without one, drift just fails the call
}

export function createMcpServer({ workspace, session, gate, healer }: McpOptions): Server {
  const server = new Server({ name: 'legacylink', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
  const { registry } = workspace;
  // A heal registers a new version: tell the client its tool list changed.
  healer?.on('healed', () => void server.sendToolListChanged().catch(() => {}));

  // Read from disk on every call, so a recompile or a heal shows up at once.
  const usable = async () => {
    const entries = await registry.entries();
    return (await registry.current()).filter((s) => entries[s.name]?.status === 'ok');
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await usable()).map(toMcpTool) }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const tools = new Map((await usable()).map((s) => [s.name, s]));
    const spec = tools.get(req.params.name);
    if (!spec) return { isError: true, content: [{ type: 'text', text: `Unknown or unavailable tool: ${req.params.name}` }] };
    const entry = (await registry.entries())[spec.name];

    const token = req.params._meta?.progressToken;
    let progress = 0;
    const timer =
      token !== undefined
        ? setInterval(() => {
            const pending = gate.list().some((a) => a.tool === spec.name);
            void extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: ++progress, message: pending ? 'Waiting for approval in the LegacyLink console' : `Running ${spec.name}` },
              })
              .catch(() => {});
          }, PROGRESS_EVERY)
        : undefined;
    try {
      const res = await session.run(spec, (req.params.arguments ?? {}) as Record<string, unknown>, {
        approve: gate.request,
        healedSinceLastApproval: spec.access === 'write' && entry?.lastApprovedVersion !== spec.version,
        tools: (n) => tools.get(n),
        healer,
        caller: 'mcp',
      });
      // The client sees a heal too: one line next to the result.
      const healed: CallToolResult['content'] = res.healed
        ? [{ type: 'text', text: `[LegacyLink self-heal] ${res.healed.message}. ${res.healed.changes.map((c) => `${c.key}: ${c.before} -> ${c.after}`).join('; ')}` }]
        : [];
      if (res.outcome === 'ok') {
        if (spec.access === 'write') await registry.markApproved(spec.name, res.version);
        return { content: [{ type: 'text', text: JSON.stringify(res.output) }, ...healed], structuredContent: res.output };
      }
      const e = res.error;
      const text =
        res.outcome === 'app_error'
          ? `The app said no (${e?.code}): ${e?.message}`
          : res.outcome === 'rejected' || res.outcome === 'approval_timeout'
            ? (e?.message ?? res.outcome)
            : `${spec.name} failed (${e?.code}): ${e?.message}`;
      return { isError: true, content: [{ type: 'text', text: `${text} [run ${res.runId}]` }, ...healed] };
    } finally {
      if (timer) clearInterval(timer);
    }
  });

  return server;
}

export interface ServeOptions {
  workspace: Workspace;
  consolePort?: number; // undefined: no console (writes can then only time out)
  headless?: boolean;
  model?: ModelMode; // the healer's model mode; default live with MODEL_API_KEY, else heuristic
}

// stdio transport: stdout belongs to the protocol, so everything else goes to stderr.
export async function serve(opts: ServeOptions): Promise<void> {
  const { workspace } = opts;
  const session = workspace.session(await workspace.config(), { headless: opts.headless });
  const gate = new ApprovalGate();
  const healer = workspace.healer({ mode: opts.model, log: (line) => console.error(line) });
  console.error(`LegacyLink self-heal: ${healer.model.id}${healer.model.mode ? ` (${healer.model.mode})` : ''}`);
  const shutdown = async () => {
    await session.close();
    process.exit(0);
  };
  if (opts.consolePort !== undefined) {
    const c = await startConsole({ workspace, gate, port: opts.consolePort, onQuit: () => void shutdown() });
    console.error(`LegacyLink console: ${c.url}`);
    gate.on('requested', (r) => console.error(`Approval needed for ${r.tool} (${r.id}): ${c.url}`));
  }
  const server = createMcpServer({ workspace, session, gate, healer });
  server.onclose = () => void shutdown();
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // The client went away. 'close' too: on Windows a killed pipe may not end cleanly.
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
  await server.connect(new StdioServerTransport());
  console.error(`LegacyLink MCP server: ${(await workspace.registry.current()).map((s) => `${s.name}@${s.version}`).join(', ') || 'no tools registered'}`);
}
