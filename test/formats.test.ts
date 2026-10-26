import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScreenGraph } from '../src/formats/graph.js';
import { validateGraph } from '../src/formats/validate.js';

const graph = (): ScreenGraph => ({
  formatVersion: 1,
  app: { name: 'Contoso Order Entry', baseUrl: 'http://localhost:5080' },
  exploredAt: '2026-10-27T15:02:11Z',
  screens: [
    {
      id: 'new-sales-order',
      name: 'New Sales Order',
      purpose: 'Key in a new sales order.',
      urlPattern: '/Orders/New.aspx',
      fingerprint: { title: 'Contoso Order Entry - New Sales Order', heading: 'New Sales Order', landmarks: ['Customer', 'Line Items'] },
      requiresLogin: true,
      screenshot: 'artifacts/explore/new-sales-order.png',
      elements: [
        {
          key: 'customerId',
          kind: 'input',
          label: 'Customer #:',
          intent: "the customer's account number",
          required: true,
          maxLength: 5,
          locators: [
            { by: 'role', role: 'textbox', name: 'Customer #:' },
            { by: 'label', text: 'Customer #:' },
            { by: 'id', id: 'ctl00_MainContent_txtCustomerId' },
          ],
        },
        { key: 'saveOrder', kind: 'button', role: 'commit', intent: 'save the order', locators: [{ by: 'role', role: 'button', name: 'Save Order' }] },
      ],
    },
  ],
  edges: [{ id: 'new-sales-order:saveOrder', from: 'new-sales-order', to: null, via: 'saveOrder', kind: 'commit', fields: ['customerId'], status: 'unexplored' }],
});

describe('screen graph validation', () => {
  it('accepts a graph in the documented format', () => {
    assert.equal(validateGraph(graph()).ok, true);
  });

  it('rejects shape errors', () => {
    const g = graph() as any;
    g.screens[0].elements[0].locators.push({ by: 'xpath', path: '//input' });
    g.edges[0].kind = 'click';
    const v = validateGraph(g);
    assert.equal(v.ok, false);
  });

  it('rejects dangling references and duplicate keys', () => {
    const g = graph();
    g.screens[0]!.elements.push({ ...g.screens[0]!.elements[0]! });
    g.edges.push({ id: 'e2', from: 'new-sales-order', to: 'nowhere', via: 'missing', kind: 'navigate', status: 'explored' });
    const v = validateGraph(g);
    assert.equal(v.ok, false);
    assert.deepEqual(!v.ok && v.errors, [
      '/screens/0 duplicate element key "customerId" on "new-sales-order"',
      '/edges/1 "via" element "missing" is not on "new-sales-order"',
      '/edges/1 unknown "to" screen "nowhere"',
    ]);
  });
});
