#!/usr/bin/env node
// legacylink explore --url http://localhost:5080 --user demo   (password from LEGACYLINK_PASSWORD)
// legacylink learn "Get the status of a sales order by its order number"
// legacylink compile --examples examples/contoso/examples.json --user demo
// legacylink run get_order_status '{"orderNumber":"SO-10042"}'
// legacylink serve                       (MCP over stdio, console on http://127.0.0.1:5180)

import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { autoApprover, type Approver } from './approval/gate.js';
import { build } from './compiler/build.js';
import { appConfig } from './compiler/compile.js';
import type { LearnedTask } from './formats/task.js';
import { validateLearnedTask } from './formats/validate.js';
import { learnGraph } from './formats/task.js';
import { serve } from './mcp/server.js';
import { Workspace } from './workspace.js';
import { explore } from './explorer/explore.js';
import { learn, loadGraph, writeTask } from './learner/learn.js';
import { createModel, type ModelMode } from './model/client.js';
import { RunLog } from './runlog/runlog.js';

const USAGE = `Usage: legacylink explore --url <base URL> [options]
       legacylink learn "<one-sentence task>" [options]
       legacylink compile [task.json ...] --examples <file> [options]
       legacylink run <tool> '<input JSON>' [--approve]
       legacylink serve [--console-port 5180] [--no-console]

Options:
  --url <url>            the app's base URL, e.g. http://localhost:5080
  --user <name>          login user name; the password is read from $LEGACYLINK_PASSWORD
  --password-env <var>   read the password from this variable instead
  --out <dir>            state folder (default .legacylink)
  --start <path>         page to start from (default /)
  --name <name>          app name (default: taken from the page titles)
  --max-screens <n>      page budget (default 30)
  --model <mode>         live | replay | heuristic (default: live with MODEL_API_KEY, else heuristic)
  --headed               show the browser

Learn options:
  --graph <file>         screen graph to learn from (default <out>/graph.json)
  --out <dir>            state folder; writes <out>/tasks/<tool name>.json (default .legacylink)
  --name <tool_name>     tool name to use instead of the learned one
  --model <mode>         live | replay | heuristic

Compile options (default tasks: <out>/tasks/*.json):
  --examples <file>      JSON object: tool name -> example input for its verify run
  --graph <file>         screen graph (default <out>/graph.json)
  --url <url>            the app's base URL (default: the graph's)
  --user <name>          login user name; the password is read from $LEGACYLINK_PASSWORD
  --password-env <var>   read the password from this variable instead
  --approve              approve the verify run of a write without asking
  --headed               show the browser

Run and serve read <out>/config.json, which compile writes, and the same password variable.
  --approve              run: approve a write without asking (otherwise asks on the terminal)
  --console-port <n>     serve: approval console port (default 5180, 0 for any free port)
  --headed               show the browser`;

// Asks on the terminal. Used by compile and run when --approve isn't given.
const terminalApprover: Approver = (req) => ({
  id: 'terminal',
  decided: (async () => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const changed = req.healedSinceLastApproval ? ' (CHANGED since last approval)' : '';
    const answer = await rl.question(`\nApprove ${req.tool}@${req.version}${changed} with ${JSON.stringify(req.input)}?\nThe filled form is in ${req.screenshot}\n[y/N] `);
    rl.close();
    return { decision: /^y(es)?$/i.test(answer.trim()) ? ('approved' as const) : ('rejected' as const), by: process.env.USER ?? 'terminal' };
  })(),
});

async function compileCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string', default: '.legacylink' },
      graph: { type: 'string' },
      examples: { type: 'string' },
      url: { type: 'string' },
      user: { type: 'string' },
      'password-env': { type: 'string', default: 'LEGACYLINK_PASSWORD' },
      approve: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (!values.examples) {
    console.error(USAGE);
    return 2;
  }
  const ws = new Workspace(resolve(values.out!));
  const graph = await loadGraph(resolve(values.graph ?? join(ws.dir, 'graph.json')));
  if (values.url) graph.app = { ...graph.app, baseUrl: values.url };
  const taskDir = join(ws.dir, 'tasks');
  const files = positionals.length ? positionals.map((p) => resolve(p)) : (await readdir(taskDir)).filter((f) => f.endsWith('.json')).map((f) => join(taskDir, f));
  const view = learnGraph(graph);
  const tasks: LearnedTask[] = [];
  for (const f of files) {
    const v = validateLearnedTask(JSON.parse(await readFile(f, 'utf8')), view);
    if (!v.ok) throw new Error(`${f} is not a valid learned task for this graph:\n${v.errors.join('\n')}`);
    tasks.push(v.value);
  }
  const examples = JSON.parse(await readFile(resolve(values.examples), 'utf8')) as Record<string, Record<string, unknown>>;
  const config = appConfig(graph, values.user ? { user: values.user, passwordEnv: values['password-env']! } : undefined);
  if (config.login && !config.credentials) {
    console.error(`${graph.app.name} has a login screen; pass --user`);
    return 2;
  }
  await ws.saveConfig(config);
  const session = ws.session(config, { headless: !values.headed });
  try {
    console.log(`Compiling ${tasks.map((t) => t.name).join(', ')} against ${graph.app.baseUrl}`);
    const built = await build({ graph, tasks, examples, registry: ws.registry, session, approve: values.approve ? autoApprover('approved', 'cli --approve') : terminalApprover, log: (m) => console.log(m) });
    console.log(`\n${built.length} tools registered in ${ws.registry.dir}`);
  } finally {
    await session.close();
  }
  return 0;
}

async function runCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { out: { type: 'string', default: '.legacylink' }, approve: { type: 'boolean', default: false }, headed: { type: 'boolean', default: false } },
  });
  const [name, json] = positionals;
  if (!name) {
    console.error(USAGE);
    return 2;
  }
  const ws = new Workspace(resolve(values.out!));
  const spec = await ws.registry.get(name);
  if (!spec) throw new Error(`No tool ${name} in ${ws.registry.dir}`);
  const tools = new Map((await ws.registry.current()).map((s) => [s.name, s]));
  const session = ws.session(await ws.config(), { headless: !values.headed });
  try {
    const entry = (await ws.registry.entries())[name];
    const res = await session.run(spec, JSON.parse(json ?? '{}'), {
      approve: values.approve ? autoApprover('approved', 'cli --approve') : terminalApprover,
      healedSinceLastApproval: spec.access === 'write' && entry?.lastApprovedVersion !== spec.version,
      tools: (n) => tools.get(n),
      caller: 'cli',
    });
    if (res.outcome === 'ok' && spec.access === 'write') await ws.registry.markApproved(name, spec.version);
    console.log(JSON.stringify(res, null, 2));
    return res.outcome === 'ok' ? 0 : 1;
  } finally {
    await session.close();
  }
}

async function serveCommand(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string', default: '.legacylink' },
      'console-port': { type: 'string', default: '5180' },
      'no-console': { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  await serve({
    workspace: new Workspace(resolve(values.out!)),
    consolePort: values['no-console'] ? undefined : Number(values['console-port']),
    headless: !values.headed,
  });
  return -1; // keeps running until the client disconnects
}

async function learnCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { graph: { type: 'string' }, out: { type: 'string', default: '.legacylink' }, name: { type: 'string' }, model: { type: 'string' } },
  });
  const task = positionals.join(' ').trim();
  if (!task) {
    console.error(USAGE);
    return 2;
  }
  const outDir = resolve(values.out!);
  const graph = await loadGraph(resolve(values.graph ?? join(outDir, 'graph.json')));
  const model = createModel({ mode: values.model as ModelMode | undefined, cacheDir: join(outDir, 'model-cache'), runLog: new RunLog(join(outDir, 'runs')) });
  console.log(`Learning "${task}" with model ${model.id} (${model.mode})`);
  const learned = await learn({ graph, task, model, name: values.name });
  const file = await writeTask(outDir, learned);
  const commit = learned.access === 'write' ? ', stops for approval before the commit' : '';
  console.log(`${learned.name} (${learned.access}${commit}): ${learned.steps.length} steps, inputs ${Object.keys(learned.inputSchema.properties as object).join(', ')}. Wrote ${file}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'learn') return learnCommand(rest);
  if (command === 'compile') return compileCommand(rest);
  if (command === 'run') return runCommand(rest);
  if (command === 'serve') return serveCommand(rest);
  if (command !== 'explore') {
    console.error(USAGE);
    return command ? 2 : 0;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: 'string' },
      user: { type: 'string' },
      'password-env': { type: 'string', default: 'LEGACYLINK_PASSWORD' },
      out: { type: 'string', default: '.legacylink' },
      start: { type: 'string' },
      name: { type: 'string' },
      'max-screens': { type: 'string' },
      model: { type: 'string' },
      headed: { type: 'boolean', default: false },
    },
  });
  if (!values.url) {
    console.error(USAGE);
    return 2;
  }
  const password = process.env[values['password-env']!];
  if (values.user && password === undefined) {
    console.error(`Set $${values['password-env']} to the password for ${values.user}`);
    return 2;
  }
  const outDir = resolve(values.out!);
  const model = createModel({ mode: values.model as ModelMode | undefined, cacheDir: join(outDir, 'model-cache'), runLog: new RunLog(join(outDir, 'runs')) });
  console.log(`Exploring ${values.url} with model ${model.id} (${model.mode})`);

  const graph = await explore({
    baseUrl: values.url,
    appName: values.name,
    credentials: values.user ? { user: values.user, password: password! } : undefined,
    outDir,
    model,
    startPath: values.start,
    maxScreens: values['max-screens'] ? Number(values['max-screens']) : undefined,
    headless: !values.headed,
    log: (m) => console.log(m),
  });
  const explored = graph.edges.filter((e) => e.status === 'explored').length;
  console.log(`\n${graph.screens.length} screens, ${graph.edges.length} edges (${explored} explored). Wrote ${join(outDir, 'graph.json')}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => code >= 0 && process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
