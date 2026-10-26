// Locator resolution, shared by the explorer (to check the locators it
// records) and the runner (to find a step's target). One rule everywhere: try
// the ranked locators in order and take the first that resolves to exactly
// one visible element.

import type { Locator as PwLocator, Page } from 'playwright';
import type { Locator } from '../formats/graph.js';

type Scope = Page | PwLocator;
type AriaRole = Parameters<Page['getByRole']>[0];

export function toPlaywright(scope: Scope, loc: Locator): PwLocator {
  switch (loc.by) {
    case 'role':
      return scope.getByRole(loc.role as AriaRole, { name: loc.name, exact: true });
    case 'label':
      return scope.getByLabel(loc.text, { exact: true });
    case 'id':
      return scope.locator(`[id=${JSON.stringify(loc.id)}]`);
    case 'name':
      return scope.locator(`[name=${JSON.stringify(loc.name)}]`);
    case 'text':
      return scope.getByText(loc.text, { exact: loc.exact ?? false });
    case 'css':
      return scope.locator(loc.selector);
  }
}

export interface Resolved {
  locator: PwLocator;
  index: number; // which ranked locator matched; above 0 is an early sign of drift
}

export async function resolve(scope: Scope, locators: Locator[]): Promise<Resolved | null> {
  for (const [index, loc] of locators.entries()) {
    const locator = toPlaywright(scope, loc);
    if ((await locator.count()) === 1 && (await locator.isVisible())) return { locator, index };
  }
  return null;
}
