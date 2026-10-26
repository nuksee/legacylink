// The LegacyLink console: a small local web page with the tools, the pending
// approvals (with a screenshot of the filled form) and the run log. It is the
// only place a write can be approved.
//
// It listens on 127.0.0.1 only. Requests that change state must carry the
// X-LegacyLink header (a cross-site page can't send it without a CORS
// preflight, which this server never answers), and the Host header must be
// this server's, so DNS rebinding can't reach it either.

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApprovalGate } from '../approval/gate.js';
import type { Workspace } from '../workspace.js';

export interface ConsoleOptions {
  workspace: Workspace;
  gate: ApprovalGate;
  port?: number; // 0 picks a free port
}

export interface ConsoleServer {
  url: string;
  close(): Promise<void>;
}

export async function startConsole(opts: ConsoleOptions): Promise<ConsoleServer> {
  const { workspace, gate } = opts;
  let port = 0;

  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, '{"error":"bad host"}');
    const url = new URL(req.url ?? '/', `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const entries = await workspace.registry.entries();
      const tools = (await workspace.registry.current()).map((s) => ({
        name: s.name,
        version: s.version,
        access: s.access,
        status: entries[s.name]?.status ?? 'ok',
        description: s.description,
        changedSinceApproval: s.access === 'write' && entries[s.name]?.lastApprovedVersion !== s.version,
      }));
      const approvals = gate.list().map(({ screenshot: _, ...a }) => a);
      const events = await workspace.runLog.tail(500);
      const runs = events.filter((e) => e.type !== 'step').slice(-60);
      const heals = events.filter((e) => e.type === 'heal').slice(-5);
      return send(res, 200, JSON.stringify({ tools, approvals, runs, heals }));
    }
    const shot = /^\/api\/approvals\/([\w-]+)\/screenshot$/.exec(url.pathname);
    if (req.method === 'GET' && shot) {
      const a = gate.get(shot[1]!);
      const png = a && (await readFile(a.screenshot).catch(() => undefined));
      return png ? send(res, 200, png, 'image/png') : send(res, 404, '{"error":"not found"}');
    }
    const decide = /^\/api\/approvals\/([\w-]+)\/(approve|reject)$/.exec(url.pathname);
    if (req.method === 'POST' && decide) {
      if (req.headers['x-legacylink'] !== '1') return send(res, 403, '{"error":"missing X-LegacyLink header"}');
      const ok = gate.decide(decide[1]!, decide[2] === 'approve' ? 'approved' : 'rejected', 'console');
      return send(res, ok ? 200 : 404, JSON.stringify({ ok }));
    }
    send(res, 404, '{"error":"not found"}');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => send(res, 500, JSON.stringify({ error: e.message })));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 5180, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LegacyLink console</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --ink: #1d232b; --muted: #5b6573; --line: #dde2e8; --accent: #2457c5; --ok: #1d7a46; --bad: #b3261e; --warn: #9a6200; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14171c; --card: #1d2229; --ink: #e6e9ee; --muted: #9aa4b2; --line: #2e353f; --accent: #7ea6ff; --ok: #5cc98b; --bad: #ff8a80; --warn: #f0b85a; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--card); display: flex; gap: 12px; align-items: baseline; }
  header h1 { font-size: 17px; margin: 0; }
  header span { color: var(--muted); }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  code, pre { font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; border: 1px solid var(--line); }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  .approval { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 16px; border: 2px solid var(--warn); border-radius: 8px; padding: 14px; }
  .approval + .approval { margin-top: 12px; }
  .approval img { width: 100%; border: 1px solid var(--line); border-radius: 4px; }
  .changed { background: var(--warn); color: #000; padding: 4px 8px; border-radius: 4px; font-weight: 600; display: inline-block; margin: 6px 0; }
  button { font: inherit; padding: 8px 18px; border-radius: 6px; border: 1px solid var(--line); cursor: pointer; margin-right: 8px; }
  button.approve { background: var(--ok); color: #fff; border-color: var(--ok); }
  button.reject { background: transparent; color: var(--bad); border-color: var(--bad); }
  .empty { color: var(--muted); }
  #healsBox { display: none; border: 2px solid var(--accent); }
  #healsBox.on { display: block; }
  .heal + .heal { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .heal .title { font-size: 15px; font-weight: 600; }
  .heal .fix { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 8px; align-items: center; margin: 6px 0 2px; }
  .heal .old { text-decoration: line-through; color: var(--bad); }
  .heal .new { color: var(--ok); font-weight: 600; }
  .heal .why { color: var(--muted); margin: 0 0 4px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; background: var(--accent); color: var(--card); margin-left: 6px; }
  .healnote { margin: 6px 0; padding-left: 18px; }
  @media (max-width: 760px) { .approval { grid-template-columns: 1fr; } }
</style></head>
<body>
<header><h1>LegacyLink console</h1><span id="sub"></span></header>
<main>
  <section id="healsBox"><h2>Self-heals</h2><div id="heals"></div></section>
  <section><h2>Waiting for approval</h2><div id="approvals"></div></section>
  <section><h2>Tools</h2><table><thead><tr><th>Tool</th><th>Version</th><th>Access</th><th>Status</th></tr></thead><tbody id="tools"></tbody></table></section>
  <section><h2>Run log</h2><table><thead><tr><th>Time</th><th>Run</th><th>Event</th><th>Detail</th></tr></thead><tbody id="runs"></tbody></table></section>
</main>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let shown = '';
async function decide(id, what) {
  await fetch('/api/approvals/' + id + '/' + what, { method: 'POST', headers: { 'X-LegacyLink': '1' } });
  refresh();
}
function eventRow(e) {
  let what = e.type, detail = '';
  if (e.type === 'run_started') { what = 'started'; detail = e.tool + '@' + e.version + ' ' + JSON.stringify(e.input) + (e.caller ? ' (' + e.caller + ')' : ''); }
  if (e.type === 'run_finished') {
    const cls = e.outcome === 'ok' ? 'ok' : e.outcome === 'app_error' || e.outcome === 'rejected' ? 'warn' : 'bad';
    what = '<span class="' + cls + '">' + esc(e.outcome) + '</span>';
    detail = e.tool + ' in ' + e.ms + ' ms, post-condition ' + e.postcondition + (e.error ? ': ' + e.error.message : '') + (e.output ? ' ' + JSON.stringify(e.output).slice(0, 200) : '');
  }
  if (e.type === 'approval_requested') { what = 'approval requested'; detail = e.healedSinceLastApproval ? 'changed since last approval' : ''; }
  if (e.type === 'approval_decided') { what = 'approval ' + e.decision; detail = e.by ? 'by ' + e.by : ''; }
  if (e.type === 'heal') {
    what = '<span class="' + (e.status === 'healed' ? 'ok' : e.status === 'failed' ? 'bad' : 'warn') + '">self-heal ' + esc(e.status) + '</span>';
    detail = e.tool + ' v' + e.fromVersion + (e.toVersion ? ' -> v' + e.toVersion : '') + ': ' + (e.changes.map((c) => c.key + ' ' + c.before + ' -> ' + c.after).join('; ') || e.message);
  }
  if (e.type === 'model_call') { what = 'model call'; detail = e.stage + ' ' + e.prompt + (e.cached ? ' (cached)' : ''); }
  return '<tr><td><code>' + esc((e.at || '').slice(11, 19)) + '</code></td><td><code>' + esc(e.runId || '') + '</code></td><td>' + (what.startsWith('<') ? what : esc(what)) + '</td><td><code>' + esc(detail) + '</code></td></tr>';
}
async function refresh() {
  let s;
  try { s = await (await fetch('/api/state')).json(); } catch { document.getElementById('sub').textContent = 'server not reachable'; return; }
  document.getElementById('sub').textContent = s.tools.length + ' tools, ' + s.approvals.length + ' waiting';
  const key = JSON.stringify(s.approvals.map((a) => a.id));
  if (key !== shown) {
    shown = key;
    document.getElementById('approvals').innerHTML = s.approvals.length ? s.approvals.map((a) =>
      '<div class="approval"><div><b>' + esc(a.tool) + '</b> v' + a.version +
      (a.healedSinceLastApproval ? '<div class="changed">Changed since last approval: this tool was healed or recompiled</div>' : '') +
      (a.heal ? '<ul class="healnote">' + a.heal.map((l) => '<li><code>' + esc(l) + '</code></li>').join('') + '</ul>' : '') +
      '<pre>' + esc(JSON.stringify(a.input, null, 2)) + '</pre><p class="empty">Run ' + esc(a.runId) + ', expires ' + esc(a.expiresAt.slice(11, 19)) + '</p>' +
      '<button class="approve" onclick="decide(\\'' + a.id + '\\', \\'approve\\')">Approve</button><button class="reject" onclick="decide(\\'' + a.id + '\\', \\'reject\\')">Reject</button></div>' +
      '<div><img alt="The filled form, before saving" src="/api/approvals/' + a.id + '/screenshot"></div></div>').join('') : '<p class="empty">Nothing is waiting.</p>';
  }
  const via = (c, e) => c.via === 'model' ? e.model : c.via === 'heuristic' ? 'rule-based stand-in' : 'exact match';
  document.getElementById('healsBox').classList.toggle('on', s.heals.length > 0);
  document.getElementById('heals').innerHTML = s.heals.slice().reverse().map((e) =>
    '<div class="heal"><div class="title">' + esc(e.tool) + ' v' + e.fromVersion + (e.toVersion ? ' &rarr; v' + e.toVersion : '') +
    ' <span class="' + (e.status === 'healed' ? 'ok' : e.status === 'failed' ? 'bad' : 'warn') + '">' + esc(e.status) + '</span>' +
    ' <span class="empty">' + esc((e.at || '').slice(11, 19)) + '</span></div>' +
    e.changes.map((c) => '<div class="fix"><code class="old">' + esc(c.before) + '</code><span>&rarr;</span><code class="new">' + esc(c.after) + '</code></div>' +
      '<p class="why">' + esc(c.key) + ', step ' + c.step + '<span class="badge">' + esc(via(c, e)) + '</span> ' + esc(c.why) + '</p>').join('') +
    '<p class="empty">' + esc(e.message) + '</p></div>').join('');
  document.getElementById('tools').innerHTML = s.tools.map((t) =>
    '<tr><td><b>' + esc(t.name) + '</b><br><span class="empty">' + esc(t.description) + '</span></td><td>' + t.version + '</td><td><span class="pill">' + esc(t.access) + '</span></td><td class="' + (t.status === 'ok' ? 'ok' : 'bad') + '">' + esc(t.status) + (t.changedSinceApproval ? ' <span class="warn">(changed since approval)</span>' : '') + '</td></tr>').join('') || '<tr><td colspan="4" class="empty">No tools registered.</td></tr>';
  document.getElementById('runs').innerHTML = s.runs.slice().reverse().map(eventRow).join('') || '<tr><td colspan="4" class="empty">No runs today.</td></tr>';
}
refresh();
setInterval(refresh, 1500);
</script>
</body></html>`;
