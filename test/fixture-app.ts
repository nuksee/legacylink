// A tiny WebForms-style app for the explorer tests, so CI doesn't need the
// sample app's private repo. It copies the patterns that matter: a login, a
// menu, a search whose grid rows post back, a details page, and a form whose
// Save and Delete must never be pressed. It counts those presses.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const CUSTOMERS = [
  { id: 'C1', name: 'Northwind', city: 'Seattle' },
  { id: 'C2', name: 'Fabrikam', city: 'Redmond' },
];

export interface FixtureApp {
  url: string; // base URL, ending in the base path
  commits: string[]; // every commit-like request the app received
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function startFixture(basePath = ''): Promise<FixtureApp> {
  const commits: string[] = [];
  const sessions = new Set<string>();
  const href = (p: string) => basePath + p;

  const page = (title: string, body: string, loggedIn = true) => `<!DOCTYPE html>
<html><head><title>Fixture Books - ${esc(title)}</title></head><body>
<form method="post" id="aspnetForm">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
<input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="" />
<script>function __doPostBack(t, a) { var f = document.forms.aspnetForm; f.__EVENTTARGET.value = t; f.__EVENTARGUMENT.value = a; f.submit(); }</script>
${loggedIn ? `<div id="menu"><a href="${href('/Home.aspx')}">Home</a> <a href="${href('/Search.aspx')}">Find Customer</a> <a href="${href('/Invoice.aspx')}">New Invoice</a> <a id="lnkLogout" href="${href('/Logout.aspx')}">Log Out</a></div>` : ''}
<h2>${esc(title)}</h2>
${body}
</form></body></html>`;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || '/' : '';
      const body = new URLSearchParams(req.method === 'POST' ? raw : '');
      const token = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
      const send = (html: string, headers: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': 'text/html', ...headers });
        res.end(html);
      };
      const redirect = (to: string, headers: Record<string, string> = {}) => {
        res.writeHead(302, { location: href(to), ...headers });
        res.end();
      };

      if (path === '/Login.aspx') {
        if (req.method === 'POST' && body.get('txtUser') === 'demo' && body.get('txtPass') === 'demo') {
          const sid = Math.random().toString(36).slice(2);
          sessions.add(sid);
          return redirect('/Home.aspx', { 'set-cookie': `sid=${sid}; path=/` });
        }
        return send(
          page(
            'Sign In',
            `<table><tr><td><label for="txtUser">User:</label></td><td><input id="txtUser" name="txtUser" type="text" /></td></tr>
             <tr><td><label for="txtPass">Password:</label></td><td><input id="txtPass" name="txtPass" type="password" /></td></tr></table>
             <input type="submit" id="btnLogin" name="btnLogin" value="Sign In" />`,
            false,
          ),
        );
      }
      if (!token || !sessions.has(token)) return redirect('/Login.aspx');
      if (path === '/Logout.aspx') {
        sessions.delete(token);
        return redirect('/Login.aspx');
      }

      if (path === '/' || path === '/Home.aspx') {
        return send(page('Home', `<p><a id="lnkSearch" href="${href('/Search.aspx')}">Customer search</a></p>`));
      }
      if (path === '/Search.aspx') {
        if (body.get('__EVENTTARGET') === 'gvResults') {
          const row = CUSTOMERS[Number(/Select\$(\d+)/.exec(body.get('__EVENTARGUMENT') ?? '')?.[1])];
          if (row) return redirect(`/Customer.aspx?id=${row.id}`);
        }
        let grid = '';
        if (req.method === 'POST' && body.has('btnFind')) {
          const q = (body.get('txtName') ?? '').toLowerCase();
          const rows = CUSTOMERS.filter((c) => c.name.toLowerCase().includes(q));
          grid = `<table id="gvResults"><tr><th>&nbsp;</th><th>Customer ID</th><th>Name</th></tr>${rows
            .map((c, i) => `<tr><td><a href="javascript:__doPostBack('gvResults','Select$${i}')">Select</a></td><td>${c.id}</td><td>${c.name}</td></tr>`)
            .join('')}</table>`;
        }
        return send(
          page(
            'Find Customer',
            `<fieldset><legend>Criteria</legend><label for="txtName">Name:</label> <input id="txtName" name="txtName" type="text" maxlength="20" />
             <input type="submit" id="btnFind" name="btnFind" value="Find" /></fieldset>${grid}`,
          ),
        );
      }
      if (path === '/Customer.aspx') {
        const c = CUSTOMERS.find((x) => x.id === url.searchParams.get('id'));
        if (body.has('lnkDelete') || url.searchParams.has('delete')) commits.push('delete');
        return send(
          page(
            'Customer',
            c
              ? `<table><tr><td>Customer ID</td><td><span id="lblId">${c.id}</span></td></tr><tr><td>Name</td><td><span id="lblName">${c.name}</span></td></tr></table>
                 <p><a href="${href(`/Customer.aspx?id=${c.id}&delete=1`)}">Delete customer</a></p>`
              : `<span id="lblMsg" role="alert">Customer not found.</span>`,
          ),
        );
      }
      if (path === '/Invoice.aspx') {
        if (req.method === 'POST' && body.has('btnSave')) commits.push('save');
        if (req.method === 'POST' && body.has('btnCancel')) return redirect('/Home.aspx');
        return send(
          page(
            'New Invoice',
            `<fieldset><legend>Invoice</legend>
             <label for="txtCust">Customer ID:</label> <input id="txtCust" name="txtCust" type="text" /> <span id="rfvCust" class="validator" style="visibility:hidden">*</span>
             <label for="ddlTerms">Terms:</label> <select id="ddlTerms" name="ddlTerms"><option value="30">Net 30</option><option value="60">Net 60</option></select>
             </fieldset>
             <input type="submit" id="btnCancel" name="btnCancel" value="Cancel" /> <input type="submit" id="btnSave" name="btnSave" value="Save Invoice" />
             <input type="submit" id="btnFrob" name="btnFrob" value="Frobnicate" />`,
          ),
        );
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${basePath}/`,
    commits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
