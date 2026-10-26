// Deterministic page capture: the interactive and output elements on a page,
// with the facts locators and naming are built from. No model involved.

import type { ElementHandle, Page } from 'playwright';
import type { ElementKind, Fingerprint } from '../formats/graph.js';

export interface RawElement {
  ref: string; // "e3", stable within one snapshot only
  kind: ElementKind;
  tag: string;
  type?: string; // input type
  id?: string;
  name?: string;
  text?: string; // button caption, link text, output text
  label?: string;
  labelFrom?: 'label' | 'aria' | 'cell' | 'column' | 'title' | 'placeholder';
  labelCellTag?: string; // with labelFrom 'cell': tag of the label cell and of the value cell
  valueCellTag?: string;
  section?: string; // enclosing fieldset legend
  href?: string; // same-origin path, or "postback" for __doPostBack links
  grid?: string; // ref of the enclosing grid, for gridLinks
  column?: number; // 1-based cell index within the row, for gridLinks
  constantText?: boolean; // gridLinks: same caption on every row
  columns?: string[]; // grids: header captions
  rows?: number; // grids: data rows
  options?: { value: string; text: string }[];
  maxLength?: number;
  required?: boolean;
  isPassword?: boolean;
  css?: string; // structural fallback selector, only for elements without an id
}

export interface Sample {
  label: string; // where the value was seen: a column header or a field label
  value: string;
}

export interface Snapshot {
  url: string;
  title: string;
  fingerprint: Fingerprint;
  elements: RawElement[];
  samples: Sample[];
  hasPassword: boolean;
}

export interface CapturedSnapshot extends Snapshot {
  handles: Map<string, ElementHandle>;
}

// Runs in the page. Kept as a string so the TypeScript toolchain can't inject
// helpers into it. Leaves the matched DOM nodes on window.__llElements.
const CAPTURE = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const legendOf = (el) => clean(el.closest('fieldset')?.querySelector('legend')?.textContent) || undefined;
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (n.id) { parts.unshift('[id="' + n.id + '"]'); break; }
      const same = Array.from(n.parentElement?.children || []).filter((c) => c.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  };
  // The text of the cell before this element's cell, the WebForms way of labelling.
  const cellLabel = (el) => {
    const cell = el.closest('td, th');
    let prev = cell?.previousElementSibling;
    if (!prev) return undefined;
    const text = clean(prev.textContent);
    return text ? { text, labelTag: prev.tagName.toLowerCase(), valueTag: cell.tagName.toLowerCase() } : undefined;
  };

  const isGrid = (t) => {
    const rows = Array.from(t.rows);
    return rows.length > 1 && rows[0].cells.length > 1 && Array.from(rows[0].cells).every((c) => c.tagName === 'TH');
  };
  const grids = Array.from(document.querySelectorAll('table')).filter((t) => isGrid(t) && visible(t));

  const nodes = [];
  const out = [];
  const samples = [];
  const add = (el, info) => {
    info.ref = 'e' + (out.length + 1);
    info.tag = el.tagName.toLowerCase();
    if (el.id) info.id = el.id;
    else info.css = cssPath(el);
    const section = legendOf(el);
    if (section) info.section = section;
    nodes.push(el);
    out.push(info);
    return info;
  };

  const gridRefs = new Map();
  for (const t of grids) {
    const columns = Array.from(t.rows[0].cells).map((c) => clean(c.textContent));
    const info = add(t, { kind: 'grid', columns, rows: t.rows.length - 1 });
    gridRefs.set(t, info.ref);
    for (const row of Array.from(t.rows).slice(1)) {
      Array.from(row.cells).forEach((c, i) => {
        if (c.querySelector('input, select, textarea')) return;
        const value = clean(c.textContent);
        if (value && columns[i]) samples.push({ label: columns[i], value });
      });
    }
    // One gridLink per link column, taken from the first data row.
    const first = t.rows[1];
    Array.from(first.cells).forEach((cell, i) => {
      const a = cell.querySelector('a[href]');
      if (!a || !visible(a)) return;
      const texts = Array.from(t.rows).slice(1).map((r) => clean(r.cells[i]?.querySelector('a')?.textContent));
      const href = a.getAttribute('href') || '';
      add(a, {
        kind: 'gridLink',
        text: clean(a.textContent),
        label: columns[i] || undefined,
        grid: info.ref,
        column: i + 1,
        constantText: texts.every((x) => x === texts[0]),
        href: /__doPostBack/.test(href) ? 'postback' : new URL(href, location.href).pathname,
      });
    });
  }
  const inGrid = (el) => grids.some((t) => t.contains(el));

  const controls = document.querySelectorAll('input, select, textarea, button, a[href]');
  for (const el of controls) {
    const tag = el.tagName.toLowerCase();
    if (!visible(el) || (tag === 'a' && inGrid(el))) continue;
    const type = (el.getAttribute('type') || (tag === 'button' ? 'submit' : 'text')).toLowerCase();
    if (tag === 'input' && ['hidden', 'checkbox', 'radio', 'file', 'reset'].includes(type)) continue;

    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (/^(#|mailto:|tel:)/.test(href)) continue;
      let path;
      if (/__doPostBack/.test(href)) path = 'postback';
      else if (/^javascript:/i.test(href)) continue;
      else {
        const u = new URL(href, location.href);
        if (u.origin !== location.origin) continue;
        path = u.pathname + u.search;
      }
      add(el, { kind: 'link', text: clean(el.textContent), href: path });
      continue;
    }
    if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'image'].includes(type))) {
      add(el, { kind: 'button', type, text: clean(el.value || el.textContent || el.getAttribute('alt')) });
      continue;
    }

    const info = { kind: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'input' };
    if (tag === 'input') info.type = type;
    if (type === 'password') info.isPassword = true;
    if (el.name) info.name = el.name;
    const lbl = clean(el.labels?.[0]?.textContent);
    const grid = grids.find((t) => t.contains(el));
    const cl = grid ? undefined : cellLabel(el);
    if (lbl) { info.label = lbl; info.labelFrom = 'label'; }
    else if (el.getAttribute('aria-label')) { info.label = clean(el.getAttribute('aria-label')); info.labelFrom = 'aria'; }
    else if (cl) { info.label = cl.text; info.labelFrom = 'cell'; info.labelCellTag = cl.labelTag; info.valueCellTag = cl.valueTag; }
    else if (el.title) { info.label = clean(el.title); info.labelFrom = 'title'; }
    else if (el.placeholder) { info.label = clean(el.placeholder); info.labelFrom = 'placeholder'; }
    else if (grid) {
      // A control in a grid row, like an order line: "Qty (row 2)".
      const cell = el.closest('td, th');
      const row = el.closest('tr');
      const header = clean(grid.rows[0].cells[cell?.cellIndex ?? -1]?.textContent);
      if (header) { info.label = header + ' (row ' + row.rowIndex + ')'; info.labelFrom = 'column'; }
    }
    if (el.maxLength > 0) info.maxLength = el.maxLength;
    if (tag === 'select') info.options = Array.from(el.options).map((o) => ({ value: o.value, text: clean(o.textContent) }));
    const cell = el.closest('td') || el.parentElement;
    const validator = cell && Array.from(cell.querySelectorAll('[id*="rfv"], [id*="RequiredField"], .validator')).some((v) => v !== el);
    if (el.required || el.getAttribute('aria-required') === 'true' || validator) info.required = true;
    add(el, info);
  }
  // Buttons carry WebForms control names too.
  for (const [i, el] of nodes.entries()) if (el.name && !out[i].name) out[i].name = el.name;

  // Outputs: visible, id-carrying text holders that aren't controls or labels.
  // Messages: alerts, status lines and validation summaries.
  const taken = new Set(nodes);
  for (const el of document.querySelectorAll('[id], [role=alert], [role=status]')) {
    if (taken.has(el) || !visible(el) || inGrid(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (['input', 'select', 'textarea', 'button', 'a', 'label', 'form', 'table', 'tr', 'td', 'div', 'body', 'html', 'script', 'fieldset'].includes(tag) && !el.matches('[role=alert], [role=status]')) continue;
    if (el.querySelector('input, select, textarea, button')) continue;
    const text = clean(el.textContent);
    if (!text || text === '*' || text.length > 300) continue;
    const isMessage = el.matches('[role=alert], [role=status]') || /message|summary|error|notification/i.test((el.id || '') + ' ' + el.className);
    const info = { kind: isMessage ? 'message' : 'output', text };
    if (!isMessage) {
      const cl = cellLabel(el);
      if (cl) { info.label = cl.text; info.labelFrom = 'cell'; info.labelCellTag = cl.labelTag; info.valueCellTag = cl.valueTag; samples.push({ label: cl.text, value: text }); }
    }
    add(el, info);
  }

  const heading = clean((document.querySelector('h2') || document.querySelector('h1'))?.textContent) || undefined;
  const landmarks = [
    ...Array.from(document.querySelectorAll('fieldset > legend')).filter(visible).map((l) => clean(l.textContent)),
    ...Array.from(document.querySelectorAll('h3')).filter(visible).map((h) => clean(h.textContent)),
    ...grids.filter((t) => t.id).map((t) => t.id),
  ].filter(Boolean);

  // Document order, so the graph lists elements the way a user reads the screen.
  const order = nodes.map((n, i) => i).sort((a, b) => (nodes[a].compareDocumentPosition(nodes[b]) & 4 ? -1 : 1));
  const sortedNodes = order.map((i) => nodes[i]);
  const sortedOut = order.map((i) => out[i]);
  nodes.length = 0; nodes.push(...sortedNodes);
  out.length = 0; out.push(...sortedOut);

  window.__llElements = nodes;
  return {
    url: location.href,
    title: clean(document.title),
    fingerprint: { title: clean(document.title), heading, landmarks: Array.from(new Set(landmarks)) },
    elements: out.map((o) => JSON.parse(JSON.stringify(o))),
    samples,
    hasPassword: out.some((o) => o.isPassword),
  };
})()`;

export async function capture(page: Page): Promise<CapturedSnapshot> {
  const snap = (await page.evaluate(CAPTURE)) as Snapshot;
  const list = await page.evaluateHandle('window.__llElements');
  const handles = new Map<string, ElementHandle>();
  for (const [i, el] of snap.elements.entries()) {
    const h = (await list.getProperty(String(i))).asElement();
    if (h) handles.set(el.ref, h);
  }
  await list.dispose();
  if (!snap.fingerprint.heading) delete snap.fingerprint.heading;
  return { ...snap, handles };
}
