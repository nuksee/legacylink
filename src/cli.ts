#!/usr/bin/env node
// legacylink explore --url http://localhost:5080 --user demo   (password from LEGACYLINK_PASSWORD)

import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { explore } from './explorer/explore.js';
import { createExplorerModel, type ModelMode } from './model/client.js';
import { RunLog } from './runlog/runlog.js';

const USAGE = `Usage: legacylink explore --url <base URL> [options]

Options:
  --url <url>            the app's base URL, e.g. http://localhost:5080
  --user <name>          login user name; the password is read from $LEGACYLINK_PASSWORD
  --password-env <var>   read the password from this variable instead
  --out <dir>            state folder (default .legacylink)
  --start <path>         page to start from (default /)
  --name <name>          app name (default: taken from the page titles)
  --max-screens <n>      page budget (default 30)
  --model <mode>         live | replay | heuristic (default: live with MODEL_API_KEY, else heuristic)
  --headed               show the browser`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
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
  const model = createExplorerModel({ mode: values.model as ModelMode | undefined, cacheDir: join(outDir, 'model-cache'), runLog: new RunLog(join(outDir, 'runs')) });
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
