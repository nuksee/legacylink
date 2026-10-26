// The registry: tool specs on disk, one file per version, plus registry.json
// with the current version and status of each tool (docs/architecture.md,
// "Storage layout"). Only specs that passed a verify run get registered.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolSpecSchema, type ToolSpec } from '../formats/tool.js';
import { validator } from '../formats/validate.js';

export interface ToolEntry {
  version: number;
  status: 'ok' | 'broken';
  access: 'read' | 'write';
  lastApprovedVersion?: number; // writes: the version a person last approved a run of
}

interface RegistryFile {
  formatVersion: 1;
  tools: Record<string, ToolEntry>;
}

export class RegistryError extends Error {}

export const validateToolSpec = validator<ToolSpec>(toolSpecSchema);

export class Registry {
  constructor(readonly dir: string) {}

  private async index(): Promise<RegistryFile> {
    const text = await readFile(join(this.dir, 'registry.json'), 'utf8').catch(() => undefined);
    return text ? (JSON.parse(text) as RegistryFile) : { formatVersion: 1, tools: {} };
  }

  private async save(index: RegistryFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, 'registry.json'), JSON.stringify(index, null, 2) + '\n');
  }

  async entries(): Promise<Record<string, ToolEntry>> {
    return (await this.index()).tools;
  }

  async get(name: string, version?: number): Promise<ToolSpec | undefined> {
    const v = version ?? (await this.index()).tools[name]?.version;
    if (v === undefined) return undefined;
    const text = await readFile(join(this.dir, `${name}@${v}.json`), 'utf8').catch(() => undefined);
    if (!text) return undefined;
    const spec = validateToolSpec(JSON.parse(text));
    if (!spec.ok) throw new RegistryError(`${name}@${v}.json is not a valid tool spec:\n${spec.errors.join('\n')}`);
    return spec.value;
  }

  // The current version of every registered tool.
  async current(): Promise<ToolSpec[]> {
    const out: ToolSpec[] = [];
    for (const name of Object.keys((await this.index()).tools).sort()) {
      const spec = await this.get(name);
      if (spec) out.push(spec);
    }
    return out;
  }

  async register(spec: ToolSpec): Promise<string> {
    const v = validateToolSpec(spec);
    if (!v.ok) throw new RegistryError(`${spec.name} is not a valid tool spec:\n${v.errors.join('\n')}`);
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${spec.name}@${spec.version}.json`);
    await writeFile(file, JSON.stringify(spec, null, 2) + '\n');
    const index = await this.index();
    const prev = index.tools[spec.name];
    index.tools[spec.name] = { version: spec.version, status: 'ok', access: spec.access, ...(prev?.lastApprovedVersion && { lastApprovedVersion: prev.lastApprovedVersion }) };
    await this.save(index);
    return file;
  }

  async nextVersion(name: string): Promise<number> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const versions = files.map((f) => new RegExp(`^${name}@(\\d+)\\.json$`).exec(f)?.[1]).filter(Boolean).map(Number);
    return versions.length ? Math.max(...versions) + 1 : 1;
  }

  async markApproved(name: string, version: number): Promise<void> {
    const index = await this.index();
    const e = index.tools[name];
    if (!e) return;
    e.lastApprovedVersion = version;
    await this.save(index);
  }
}
