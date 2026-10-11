/**
 * Browser contexts for several actors (admin, members, reviewer) inside one serial spec. Contexts
 * created with `browser.newContext()` do not inherit the project's `use` options, so the relevant
 * ones are copied here.
 */
import {
  devices,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

import { collectDiagnostics } from './test';

export interface Actor {
  context: BrowserContext;
  page: Page;
  /** Attaches the context's console errors / failed requests when the test failed. */
  diagnostics: (testInfo: TestInfo) => Promise<void>;
}

export async function newActor(
  browser: Browser,
  testInfo: TestInfo,
  storageState?: string,
  label = 'actor',
): Promise<Actor> {
  const use = testInfo.project.use;
  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
    baseURL: use.baseURL,
    locale: use.locale ?? 'en-US',
    timezoneId: use.timezoneId ?? 'UTC',
    storageState,
  });
  const diagnostics = collectDiagnostics(context, label);
  const page = await context.newPage();
  // Forms with unsaved changes ask before in-app navigation (window.confirm): always continue.
  page.on('dialog', (dialog) => void dialog.accept());
  return { context, page, diagnostics };
}

/** On failure, attach a screenshot of every actor's page to the report. */
export async function attachScreens(
  testInfo: TestInfo,
  actors: Record<string, Actor | undefined>,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  for (const [name, actor] of Object.entries(actors)) {
    if (!actor || actor.page.isClosed()) continue;
    await actor.diagnostics(testInfo);
    try {
      const body = await actor.page.screenshot({ fullPage: true });
      await testInfo.attach(
        `${name}-${actor.page
          .url()
          .replace(/[^a-z0-9]+/gi, '_')
          .slice(-60)}.png`,
        {
          body,
          contentType: 'image/png',
        },
      );
    } catch {
      // page may be mid-navigation; nothing to attach
    }
  }
}
