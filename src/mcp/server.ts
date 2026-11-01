// The MCP server: every registered tool becomes an MCP tool with its input and
// output schemas. A call validates its input, runs the spec, checks the
// post-condition and returns the output. A healthy tool makes no model call;
// only a heal after drift may ask the model.
// Writes wait in the approval gate; only the console can answer them.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
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
  consoleUrl?: string; // named in the "waiting for approval" progress
}

export function createMcpServer({ workspace, session, gate, healer, consoleUrl }: McpOptions): Server {
  const server = new Server({ name: 'legacylink', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
  const { registry } = workspace;
  // A heal registers a new version: tell the client its tool list changed.
  const onHealed = () => void server.sendToolListChanged().catch(() => {});
  healer?.on('healed', onHealed);
  server.onclose = () => void healer?.off('healed', onHealed);

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
                params: { progressToken: token, progress: ++progress, message: pending ? `Waiting for approval in the LegacyLink console${consoleUrl ? ` at ${consoleUrl}` : ''}` : `Running ${spec.name}` },
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
  http?: boolean; // MCP over Streamable HTTP at <console>/mcp instead of stdio; runs until stopped
}

// stdio transport: stdout belongs to the protocol, so everything else goes to stderr.
// With --http, MCP is served next to the console and the process runs until stopped.
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
  // A newer serve may ask this one to give up the console port. Only a serve
  // no client ever initialized (a leftover probe) steps down; one you started
  // with --http never does.
  let clientConnected = opts.http === true;
  const onQuit = () => {
    if (clientConnected) return false;
    setImmediate(() => void shutdown());
    return true;
  };
  const tools = async () => (await workspace.registry.current()).map((s) => `${s.name}@${s.version}`).join(', ') || 'no tools registered';
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (opts.http) {
    // One MCP session per client, all sharing one browser session, gate and healer.
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    let consoleUrl: string | undefined;
    const mcp = async (req: IncomingMessage, res: ServerResponse) => {
      const id = req.headers['mcp-session-id'];
      const known = typeof id === 'string' ? sessions.get(id) : undefined;
      if (known) return known.handleRequest(req, res);
      if (req.method !== 'POST') return void res.writeHead(typeof id === 'string' ? 404 : 400).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return void res.writeHead(400).end();
      }
      if (typeof id === 'string' || !isInitializeRequest(body)) return void res.writeHead(typeof id === 'string' ? 404 : 400).end();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => void sessions.set(sid, transport),
      });
      transport.onclose = () => void (transport.sessionId && sessions.delete(transport.sessionId));
      await createMcpServer({ workspace, session, gate, healer, consoleUrl }).connect(transport);
      await transport.handleRequest(req, res, body);
    };
    const c = await startConsole({ workspace, gate, port: opts.consolePort ?? 5180, onQuit, mcp });
    consoleUrl = c.url;
    gate.on('requested', (r) => console.error(`Approval needed for ${r.tool} (${r.id}): ${c.url}`));
    console.error(`LegacyLink console: ${c.url}`);
    console.error(`LegacyLink MCP server: ${await tools()} at ${new URL('mcp', c.url)} (Streamable HTTP; Ctrl+C stops it)`);
    return;
  }

  let consoleUrl: string | undefined;
  if (opts.consolePort !== undefined) {
    const c = await startConsole({ workspace, gate, port: opts.consolePort, onQuit });
    consoleUrl = c.url;
    console.error(`LegacyLink console: ${c.url}`);
    gate.on('requested', (r) => console.error(`Approval needed for ${r.tool} (${r.id}): ${c.url}`));
  }
  const server = createMcpServer({ workspace, session, gate, healer, consoleUrl });
  server.oninitialized = () => {
    clientConnected = true;
  };
  server.onclose = () => void shutdown();
  // The client went away. 'close' too: on Windows a killed pipe may not end cleanly.
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
  await server.connect(new StdioServerTransport());
  console.error(`LegacyLink MCP server: ${await tools()}`);
}
