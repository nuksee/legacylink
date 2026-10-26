// One target app's state folder (docs/architecture.md, "Storage layout") and
// the pieces built from it: config, registry, run log, browser session.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import type { AppConfig } from './compiler/compile.js';
import { Healer } from './healer/heal.js';
import { createModel, type ModelMode } from './model/client.js';
import type { HealerModel } from './model/types.js';
import { Registry } from './registry/registry.js';
import { Session } from './runner/run.js';
import { RunLog } from './runlog/runlog.js';

export class Workspace {
  readonly registry: Registry;
  readonly runLog: RunLog;
  readonly artifactsDir: string;

  constructor(readonly dir: string) {
    this.registry = new Registry(join(dir, 'tools'));
    this.runLog = new RunLog(join(dir, 'runs'));
    this.artifactsDir = join(dir, 'artifacts');
  }

  get graphFile(): string {
    return join(this.dir, 'graph.json');
  }

  get configFile(): string {
    return join(this.dir, 'config.json');
  }

  async config(): Promise<AppConfig> {
    const text = await readFile(this.configFile, 'utf8').catch(() => undefined);
    if (!text) throw new Error(`No ${this.configFile}; run \`legacylink compile\` first`);
    return JSON.parse(text) as AppConfig;
  }

  async saveConfig(config: AppConfig): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.configFile, JSON.stringify(config, null, 2) + '\n');
  }

  // Muse Spark when MODEL_API_KEY is set (or LEGACYLINK_MODEL says so), else the rule-based stand-in.
  healer(opts: { model?: HealerModel; mode?: ModelMode; env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}): Healer {
    const model = opts.model ?? createModel({ mode: opts.mode, env: opts.env, cacheDir: join(this.dir, 'model-cache'), runLog: this.runLog });
    const max = Number((opts.env ?? process.env).LEGACYLINK_MAX_HEALS_PER_HOUR) || undefined;
    return new Healer({ registry: this.registry, runLog: this.runLog, model, graphFile: this.graphFile, artifactsDir: this.artifactsDir, log: opts.log, maxPerHour: max });
  }

  // The password comes from the environment variable the config names, never from a file.
  session(config: AppConfig, opts: { env?: NodeJS.ProcessEnv; browser?: Browser; headless?: boolean } = {}): Session {
    const env = opts.env ?? process.env;
    const password = config.credentials ? env[config.credentials.passwordEnv] : undefined;
    if (config.credentials && password === undefined) throw new Error(`Set $${config.credentials.passwordEnv} to the password for ${config.credentials.user}`);
    return new Session({ config, password, runLog: this.runLog, artifactsDir: this.artifactsDir, browser: opts.browser, headless: opts.headless });
  }
}
