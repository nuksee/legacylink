// The scripted end-to-end demo (docs/demo.md): reset Contoso, explore, learn
// the three tasks, compile, serve MCP, call the two reads and the approved
// write from an MCP client, turn on rename drift and call again so the tools
// heal. Every stage runs the real CLI in a child process, so the audience sees
// the same output as the docs. `--repeat` runs it many times from a clean
// state and reports every failure.
//
//   legacylink demo --contoso ../contoso-order-entry           (presenter: approve in the console)
//   legacylink demo --contoso ../contoso-order-entry --repeat 20

import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const EXAMPLES = new URL('../../examples/contoso/', import.meta.url);
// Contoso prints its business date on the home page; pinned, so recorded model answers replay on any day.
export const BUSINESS_DATE = '2026-11-04';

// The demo's three tasks, as a person would say them.
export const DEMO_TASKS = [
  "Look up a customer's details, credit and orders by customer number",
  'Get the status of a sales order by its order number',
  'Create a sales order for a customer with up to three product lines',
];
const TOOL_NAMES = ['create_sales_order', 'get_customer_details', 'get_order_status'];

export interface DemoOptions {
  url: string; // Contoso's base URL
  out: string; // state folder; wiped at the start except model-cache/
  user: string;
  passwordEnv: string;
  model: ModelMode; // learn and heal: replay (recorded Muse Spark answers), live or heuristic
  fresh?: boolean; // live only: drop every recorded answer first, so each learn and heal calls Muse Spark
  exploreModel: ModelMode; // default heuristic: no recordings, and the tools were tested on its graph
  prebuilt: boolean; // fallback: skip explore + learn, use the checked-in graph and tasks
  setupOnly: boolean; // stop after compile, for a real MCP client
  autoApprove: boolean; // approve writes through the console API instead of waiting for a person
  pause: boolean; // wait for Enter between acts
  headed: boolean;
  consolePort: number;
  keepDrift: boolean; // leave rename drift on at the end
  quiet: boolean; // child output only on failure (repeat mode)
  strict?: boolean; // fail a heal that fell back to the stand-in (rehearsals); on stage it's only reported
  env: NodeJS.ProcessEnv;
}

export interface Act {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface DemoResult {
  ok: boolean;
  ms: number;
  acts: Act[];
  model: string;
  modelCalls?: { live: number; recorded: number }; // learn and heal calls in this run
  log: string[]; // everything the children printed, for failure reports
}

export type ModelMode = 'live' | 'replay' | 'heuristic';

class DemoError extends Error {}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new DemoError(msg);
}

// The learner names the inputs (Muse Spark says lines[{productId, quantity}]
// where the stand-in says lines[{product, qty}]), so the scripted client fills
// its arguments from the tool's schema, as an agent reading it would.
const ABBREV: Record<string, string> = { qty: 'quantity', no: 'number', num: 'number', id: 'id' };
const norm = (k: string) => k.toLowerCase().replace(/[^a-z]/g, '');
const sameField = (a: string, b: string) => {
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y) || y.startsWith(x) || ABBREV[x] === y || ABBREV[y] === x;
};
export function fitToSchema(value: unknown, schema: Record<string, unknown> | undefined): unknown {
  if (!schema) return value;
  if (Array.isArray(value)) return value.map((v) => fitToSchema(v, schema.items as Record<string, unknown> | undefined));
  if (!value || typeof value !== 'object' || !schema.properties) return value;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const name = k in props ? k : Object.keys(props).find((p) => !(p in value) && !(p in out) && sameField(k, p));
    if (name) out[name] = fitToSchema(v, props[name]);
  }
  return out;
}

const text = (r: CallToolResult) => (r.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '');

// src/cli.ts through tsx, or dist/cli.js once built.
function cliArgs(args: string[]): [string, string[]] {
  const ext = extname(fileURLToPath(import.meta.url));
  const cli = fileURLToPath(new URL(`../cli${ext}`, import.meta.url));
  return [process.execPath, [...(ext === '.ts' ? ['--import', import.meta.resolve('tsx')] : []), cli, ...args]];
}

async function admin(url: string, path: string, body: object = {}): Promise<void> {
  const res = await fetch(new URL(`/__admin/${path}`, url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  check(res.ok, `Contoso /__admin/${path} answered ${res.status}`);
}

export async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/__admin/state', url), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portInUse(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), r(true)));
    s.once('error', () => r(false));
  });
}

// Starts Contoso from a checkout of nuksee/contoso-order-entry when it isn't already up.
export async function startContoso(dir: string, url: string, log: (l: string) => void): Promise<ChildProcess | undefined> {
  if (await reachable(url)) return undefined;
  const server = join(resolve(dir), 'server.js');
  if (!existsSync(server)) throw new DemoError(`${url} is not reachable and ${server} doesn't exist`);
  const port = new URL(url).port || '80';
  const child = spawn(process.execPath, [server], { cwd: resolve(dir), env: { ...process.env, PORT: port, DRIFT: '', BUSINESS_DATE: process.env.BUSINESS_DATE ?? BUSINESS_DATE }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => log(`[contoso] ${String(d).trim()}`));
  child.stderr!.on('data', (d) => log(`[contoso] ${String(d).trim()}`));
  for (let i = 0; i < 100; i++) {
    if (await reachable(url)) return child;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill();
  throw new DemoError(`Contoso didn't start on ${url}`);
}

// Wipes the state folder but keeps the recorded model answers, and adds the
// checked-in ones (live Muse Spark answers for the demo's learn and heal calls).
// Fresh drops the recorded answers too, so live mode really calls the model.
async function cleanState(out: string, seedCache: boolean, fresh = false): Promise<void> {
  await mkdir(out, { recursive: true });
  for (const f of await readdir(out)) if (fresh || f !== 'model-cache') await rm(join(out, f), { recursive: true, force: true });
  if (seedCache && !fresh) await cp(new URL('model-cache', EXAMPLES), join(out, 'model-cache'), { recursive: true, force: false });
}

// Counts this run's model calls from the run log: answered by Muse Spark now, or from a recording.
async function countModelCalls(out: string): Promise<{ live: number; recorded: number }> {
  const n = { live: 0, recorded: 0 };
  const dir = join(out, 'runs');
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of (await readFile(join(dir, f), 'utf8')).split('\n')) {
      if (!line.includes('"model_call"')) continue;
      const e = JSON.parse(line) as { type: string; cached?: boolean };
      if (e.type === 'model_call') n[e.cached ? 'recorded' : 'live']++;
    }
  }
  return n;
}

export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const out = resolve(opts.out);
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    if (!opts.quiet) console.error(line);
  };
  const env = { ...opts.env, LEGACYLINK_MODEL: opts.model };
  const model = opts.model;
  const acts: Act[] = [];
  const started = Date.now();

  const pause = async (next: string) => {
    if (!opts.pause) return;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    await new Promise<void>((r) => rl.question(`\n  -- press Enter for: ${next} `, () => r()));
    rl.close();
  };

  const act = async <T>(name: string, fn: () => Promise<T>, detail?: (v: T) => string): Promise<T> => {
    await pause(name);
    say(`\n== ${name}`);
    const t = Date.now();
    try {
      const v = await fn();
      const d = detail?.(v);
      acts.push({ name, ok: true, ms: Date.now() - t, detail: d });
      say(`   ok in ${Date.now() - t} ms${d ? `: ${d}` : ''}`);
      return v;
    } catch (e) {
      const msg = (e as Error).message;
      acts.push({ name, ok: false, ms: Date.now() - t, detail: msg });
      say(`   FAILED after ${Date.now() - t} ms: ${msg}`);
      throw e;
    }
  };

  // One CLI stage in a child process. Fails the act on a non-zero exit.
  const cli = (args: string[]) =>
    new Promise<string>((res, rej) => {
      const [cmd, a] = cliArgs(args);
      const child = spawn(cmd, a, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let all = '';
      const onData = (d: Buffer) => {
        all += d;
        for (const l of String(d).split('\n')) if (l.trim()) say(`   ${l}`);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', rej);
      child.on('close', (code) => (code === 0 ? res(all) : rej(new DemoError(`legacylink ${args[0]} exited with ${code}`))));
    });

  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const how = opts.prebuilt ? 'prebuilt graph and tasks' : `explorer: ${opts.exploreModel}`;
    const learnHeal = model === 'replay' ? 'recorded Muse Spark answers (replay)' : model === 'live' ? (opts.fresh ? 'Muse Spark, live (no recordings)' : 'Muse Spark, live (recorded answers reused)') : model;
    say(`LegacyLink demo against ${opts.url}; learn and heal: ${learnHeal}; ${how}`);

    await act('Reset Contoso: seed data, no drift', async () => {
      check(await reachable(opts.url), `Contoso is not reachable at ${opts.url} (npm start in nuksee/contoso-order-entry, or pass --contoso <dir>)`);
      await admin(opts.url, 'reset');
      await cleanState(out, model !== 'heuristic', opts.fresh);
    });

    if (opts.prebuilt) {
      await act('Use the checked-in screen graph and learned tasks', async () => {
        const graph = JSON.parse(await readFile(new URL('graph.json', EXAMPLES), 'utf8'));
        graph.app.baseUrl = opts.url;
        await writeFile(join(out, 'graph.json'), JSON.stringify(graph, null, 2));
        await cp(new URL('tasks', EXAMPLES), join(out, 'tasks'), { recursive: true });
      });
    } else {
      await act(
        'Explore: map every screen, never save anything',
        () => cli(['explore', '--url', opts.url, '--user', opts.user, '--password-env', opts.passwordEnv, '--out', out, '--model', opts.exploreModel, ...(opts.headed ? ['--headed'] : [])]),
        (o) => /(\d+ screens, \d+ edges[^.]*)/.exec(o)?.[1] ?? '',
      );
      for (const sentence of DEMO_TASKS) await act(`Learn: "${sentence}"`, () => cli(['learn', sentence, '--out', out]), (o) => /^(\w+ \([^)]*\))/m.exec(o)?.[1] ?? '');
    }
    await act('Check the learned tasks', async () => {
      const files = (await readdir(join(out, 'tasks'))).sort();
      check(files.join() === TOOL_NAMES.map((n) => `${n}.json`).join(), `expected tasks ${TOOL_NAMES.join(', ')}, got ${files.join(', ')}`);
    });

    const examples = join(out, 'examples.json');
    await writeFile(
      examples,
      JSON.stringify(
        Object.fromEntries(
          await Promise.all(
            Object.entries(JSON.parse(await readFile(new URL('examples.json', EXAMPLES), 'utf8')) as Record<string, unknown>).map(async ([name, input]) => {
              const task = JSON.parse(await readFile(join(out, 'tasks', `${name}.json`), 'utf8')) as { inputSchema: Record<string, unknown> };
              return [name, fitToSchema(input, task.inputSchema)];
            }),
          ),
        ),
        null,
        2,
      ),
    );
    await act(
      'Compile: verify each tool once against the app, register it',
      () => cli(['compile', '--examples', examples, '--user', opts.user, '--password-env', opts.passwordEnv, '--out', out, '--approve', ...(opts.headed ? ['--headed'] : [])]),
      (o) => /(\d+ tools registered)/.exec(o)?.[1] ?? '',
    );
    if (opts.setupOnly) {
      say(`\nSet up: three v1 tools in ${out}. Start a client on \`legacylink serve --out ${out}\` (docs/demo.md).`);
      return { ok: true, ms: Date.now() - started, acts, model, log };
    }

    // The console port must be free: a server from an earlier run may still be closing.
    for (let i = 0; opts.consolePort && (await portInUse(opts.consolePort)); i++) {
      check(i < 50, `port ${opts.consolePort} is in use (another legacylink serve?)`);
      await sleep(100);
    }

    let consoleUrl = '';
    const serveLines: string[] = [];
    let schemas = new Map<string, Record<string, unknown>>();
    let listChanged = 0;
    await act('Serve: MCP over stdio, approval console', async () => {
      const [cmd, args] = cliArgs(['serve', '--out', out, '--console-port', String(opts.consolePort), ...(opts.headed ? ['--headed'] : [])]);
      transport = new StdioClientTransport({ command: cmd, args, env: env as Record<string, string>, stderr: 'pipe' });
      const seen = new Promise<string>((res, rej) => {
        const timer = setTimeout(() => rej(new DemoError('serve printed no console URL in 30 s')), 30_000);
        createInterface({ input: transport!.stderr as unknown as NodeJS.ReadableStream }).on('line', (l) => {
          say(`   ${l}`);
          serveLines.push(l);
          const m = /LegacyLink console: (http\S+)/.exec(l);
          if (m) {
            clearTimeout(timer);
            res(m[1]!);
          }
        });
      });
      client = new Client({ name: 'legacylink-demo', version: '0.1.0' });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        listChanged++;
      });
      await client.connect(transport);
      consoleUrl = await seen;
      const { tools } = await client.listTools();
      schemas = new Map(tools.map((t) => [t.name, t.inputSchema as Record<string, unknown>]));
      check(tools.map((t) => t.name).sort().join() === TOOL_NAMES.join(), `MCP lists ${tools.map((t) => t.name).join(', ')}`);
      return tools;
    }, (tools) => `${tools.map((t) => `${t.name}@${(t._meta as Record<string, unknown>)?.['legacylink/version']}`).join(', ')}; console ${consoleUrl}`);

    // Approves the next request for `tool` the way the console's button does.
    // Without --auto-approve it only reports what the person should look at.
    const approval = async (tool: string, expectHeal: boolean, done: () => boolean) => {
      const api = new URL('api/state', consoleUrl);
      for (let i = 0; i < 1200 && !done(); i++) {
        const state = (await (await fetch(api)).json()) as { approvals: { id: string; tool: string; healedSinceLastApproval: boolean; heal?: string[] }[] };
        const req = state.approvals.find((a) => a.tool === tool);
        if (req) {
          check(!expectHeal || (req.healedSinceLastApproval && req.heal?.length), `the approval request for ${tool} should be flagged changed and list the heal`);
          if (!opts.autoApprove) {
            say(`   >> Approve ${tool} in the console: ${consoleUrl}${req.heal?.length ? ` (flagged: ${req.heal.join('; ')})` : ''}`);
            return;
          }
          const res = await fetch(new URL(`api/approvals/${req.id}/approve`, consoleUrl), { method: 'POST', headers: { 'X-LegacyLink': '1' } });
          check(res.ok, `approve answered ${res.status}`);
          say(`   approved ${tool} (${req.id}) in the console`);
          return;
        }
        await sleep(250);
      }
      if (!done()) throw new DemoError(`no approval request for ${tool} after 5 minutes`);
    };

    const call = async (name: string, wanted: Record<string, unknown>, expectHeal?: boolean) => {
      const args = fitToSchema(wanted, schemas.get(name)) as Record<string, unknown>;
      say(`   call ${name} ${JSON.stringify(args)}`);
      let returned = false;
      let approvalError: Error | undefined;
      const pending = name === 'create_sales_order' ? approval(name, !!expectHeal, () => returned).catch((e: Error) => void (approvalError = e)) : undefined;
      const r = (await client!
        .callTool({ name, arguments: args }, undefined, {
          timeout: 60_000,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: 6 * 60_000,
          onprogress: (p) => say(`   ... ${p.message ?? 'working'}`),
        })
        .finally(() => (returned = true))) as CallToolResult;
      await pending;
      if (approvalError) throw approvalError;
      for (const t of text(r)) say(`   <- ${t.length > 400 ? `${t.slice(0, 400)}...` : t}`);
      check(!r.isError, `${name} failed: ${text(r)[0]}`);
      const healLine = text(r).find((t) => t.startsWith('[LegacyLink self-heal]'));
      if (expectHeal !== undefined) check(!!healLine === expectHeal, expectHeal ? `${name} should have healed` : `${name} healed but nothing drifted: ${healLine}`);
      // In replay and live, Muse Spark must make the picks: a stand-in fallback means a missed recording or a failed call.
      const fallback = serveLines.splice(0).find((l) => l.startsWith('[heal]') && /stand-in/.test(l));
      if (healLine && model !== 'heuristic' && fallback) {
        check(!opts.strict, `the heal fell back to the rule-based stand-in: ${fallback}`);
        say(`   !! the heal used the rule-based stand-in, not Muse Spark (rehearse with --repeat to find out why)`);
      }
      return r.structuredContent as Record<string, unknown>;
    };

    await act('Read: get_customer_details C1003', async () => {
      const o = await call('get_customer_details', { customerId: 'C1003' }, false);
      // A live learn may type the credit limit as text ("7500"); the tool's own schema decides.
      const credit = Number(String(o.creditLimit ?? '').replace(/[$,]/g, ''));
      check(o.name === 'Adventure Works' && o.creditLimit !== '' && Number.isFinite(credit), `unexpected output ${JSON.stringify(o)}`);
      return o;
    }, (o) => `${o.name}, credit limit ${o.creditLimit}, ${(o.orders as unknown[] | undefined)?.length ?? 0} orders`);

    await act('Read: get_order_status SO-10042', async () => {
      const o = await call('get_order_status', { orderNumber: 'SO-10042' }, false);
      check(o.orderNumber === 'SO-10042' && typeof o.status === 'string', `unexpected output ${JSON.stringify(o)}`);
      return o;
    }, (o) => `${o.status}, ${o.customer}, total ${o.total}`);

    const order = { customerId: 'C1003', shipTo: 'Adventure Works\n22 Harbor Way\nPortland, OR 97209', poNumber: 'PO-8800', shipVia: '2nd Day Air', lines: [{ product: 'P-200', qty: 3 }] };
    const created = await act('Write behind the approval gate: create_sales_order', async () => {
      const o = await call('create_sales_order', order, false);
      check(/^SO-\d+$/.test(String(o.orderNumber)), `no order number in ${JSON.stringify(o)}`);
      return o;
    }, (o) => `saved ${o.orderNumber}, read back with get_order_status`);

    await act('Vendor patch: turn on Rename + Move drift in Contoso', () => admin(opts.url, 'drift', { rename: true, move: true }));

    await act('Read after drift: get_order_status heals', async () => {
      const before = listChanged;
      const o = await call('get_order_status', { orderNumber: created.orderNumber }, true);
      check(o.orderNumber === created.orderNumber, `read back ${JSON.stringify(o)}`);
      for (let i = 0; listChanged === before && i < 20; i++) await sleep(100);
      check(listChanged > before, 'the client got no tools/list_changed after the heal');
      const v = (await client!.listTools()).tools.find((t) => t.name === 'get_order_status')?._meta?.['legacylink/version'];
      check(v === 2, `get_order_status should be v2 now, is v${v}`);
      return o;
    }, (o) => `${o.orderNumber} ${o.status}; get_order_status is v2`);

    await act('Write after drift: create_sales_order heals before its approval', async () => {
      const o = await call('create_sales_order', { ...order, poNumber: 'PO-8801' }, true);
      check(/^SO-\d+$/.test(String(o.orderNumber)), `no order number in ${JSON.stringify(o)}`);
      return o;
    }, (o) => `saved ${o.orderNumber}; create_sales_order is v2`);

    const modelCalls = await countModelCalls(out);
    if (model !== 'heuristic') say(`\nMuse Spark calls this run: ${modelCalls.live} live, ${modelCalls.recorded} from recordings`);
    return { ok: true, ms: Date.now() - started, acts, model, modelCalls, log };
  } catch (e) {
    if (!(e instanceof DemoError) && !acts.some((a) => !a.ok)) acts.push({ name: 'demo', ok: false, ms: Date.now() - started, detail: (e as Error).stack ?? String(e) });
    return { ok: false, ms: Date.now() - started, acts, model, log };
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    if (!opts.keepDrift) await admin(opts.url, 'drift', { rename: false, move: false }).catch(() => {});
  }
}

// Runs the demo `times` times in a row, each from a clean state, and keeps the
// state folder and child output of every failed run under <out>-failures/.
export async function repeatDemo(opts: DemoOptions, times: number, report?: string): Promise<DemoResult[]> {
  const results: DemoResult[] = [];
  const failures = `${resolve(opts.out)}-failures`;
  await rm(failures, { recursive: true, force: true });
  for (let i = 1; i <= times; i++) {
    const r = await runDemo({ ...opts, quiet: true, autoApprove: true, pause: false, strict: true });
    results.push(r);
    const failed = r.acts.find((a) => !a.ok);
    console.error(`run ${String(i).padStart(3)}/${times}: ${r.ok ? 'pass' : 'FAIL'} in ${(r.ms / 1000).toFixed(1)} s${failed ? ` at "${failed.name}": ${failed.detail?.split('\n')[0]}` : ''}`);
    if (!r.ok) {
      const dir = join(failures, `run-${i}`);
      await cp(resolve(opts.out), join(dir, 'state'), { recursive: true }).catch(() => {});
      await writeFile(join(dir, 'output.log'), r.log.join('\n') + '\n');
    }
  }
  const passed = results.filter((r) => r.ok).length;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const slowest = new Map<string, number>();
  for (const r of results) for (const a of r.acts) slowest.set(a.name, Math.max(slowest.get(a.name) ?? 0, a.ms));
  const calls = results.reduce((n, r) => ({ live: n.live + (r.modelCalls?.live ?? 0), recorded: n.recorded + (r.modelCalls?.recorded ?? 0) }), { live: 0, recorded: 0 });
  console.error(`\n${passed}/${times} passed (model ${results[0]?.model}; Muse Spark calls ${calls.live} live, ${calls.recorded} from recordings); run time median ${((ms[Math.floor(ms.length / 2)] ?? 0) / 1000).toFixed(1)} s, max ${((ms.at(-1) ?? 0) / 1000).toFixed(1)} s`);
  console.error('Slowest time per act:');
  for (const [name, t] of slowest) console.error(`  ${String(t).padStart(6)} ms  ${name}`);
  if (passed < times) console.error(`Failed runs are kept in ${failures}/`);
  if (report) await writeFile(resolve(report), JSON.stringify(results.map(({ log: _, ...r }) => r), null, 2) + '\n');
  return results;
}
