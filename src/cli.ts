#!/usr/bin/env node
// legacylink explore --url http://localhost:5080 --user demo   (password from LEGACYLINK_PASSWORD)
// legacylink learn "Get the status of a sales order by its order number"

import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { explore } from './explorer/explore.js';
import { learn, loadGraph, writeTask } from './learner/learn.js';
import { createModel, type ModelMode } from './model/client.js';
import { RunLog } from './runlog/runlog.js';

const USAGE = `Usage: legacylink explore --url <base URL> [options]
       legacylink learn "<one-sentence task>" [options]

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
  --model <mode>         live | replay | heuristic`;

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
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
