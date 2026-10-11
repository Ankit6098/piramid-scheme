/**
 * `test` with diagnostics: browser console errors/warnings, page errors and failed or 5xx requests of
 * every page in the test's context are collected and attached to the report when a test fails.
 * Specs import { test, expect } from here instead of @playwright/test.
 */
import { test as base, type BrowserContext, type TestInfo } from '@playwright/test';

export { expect } from '@playwright/test';

/** Starts collecting diagnostics for a browser context; call the returned function on teardown. */
export function collectDiagnostics(
  context: BrowserContext,
  label = 'browser',
): (testInfo: TestInfo) => Promise<void> {
  const lines: string[] = [];
  const stamp = () => new Date().toISOString().slice(11, 23);
  const watch = (page: import('@playwright/test').Page) => {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning')
        lines.push(`${stamp()} console.${m.type()} ${page.url()} :: ${m.text().slice(0, 500)}`);
    });
    page.on('pageerror', (e) =>
      lines.push(`${stamp()} pageerror ${page.url()} :: ${e.message.slice(0, 500)}`),
    );
    page.on('requestfailed', (r) => {
      const err = r.failure()?.errorText ?? '';
      if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(err))
        lines.push(`${stamp()} requestfailed ${r.method()} ${r.url()} :: ${err}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 500)
        lines.push(`${stamp()} http ${r.status()} ${r.request().method()} ${r.url()}`);
    });
  };
  context.pages().forEach(watch);
  context.on('page', watch);
  return async (testInfo: TestInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && lines.length > 0) {
      await testInfo.attach(`${label}-diagnostics.txt`, {
        body: lines.join('\n'),
        contentType: 'text/plain',
      });
    }
  };
}

export const test = base.extend<{ diagnostics: void }>({
  diagnostics: [
    async ({ context }, use, testInfo) => {
      const finish = collectDiagnostics(context);
      await use();
      await finish(testInfo);
    },
    { auto: true },
  ],
});
