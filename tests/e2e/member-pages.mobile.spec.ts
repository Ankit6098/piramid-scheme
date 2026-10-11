/**
 * Mobile layout (Pixel 7 project): the main member pages render without horizontal overflow.
 * Uses the seeded demo member at the top of the demo tree (team + posted rewards), so the pages
 * have real content (SEED_DEMO_DATA=true).
 */
import type { Page } from '@playwright/test';

import { DEMO_PASSWORD, signInMember } from './utils/flows';
import { expect, test } from './utils/test';

const DEMO_MEMBER = process.env.E2E_DEMO_MEMBER_EMAIL ?? 'anita@example.com';

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  // Let fonts/layout settle (skeletons → content) before measuring.
  await page.waitForLoadState('networkidle');
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    // Diagnostics only: elements that stick out of the viewport and are not inside a scroll/clip box.
    offenders: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= window.innerWidth + 1) return false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(p).overflowX))
            return false;
        }
        return getComputedStyle(el).position !== 'fixed';
      })
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} right=${Math.round(el.getBoundingClientRect().right)}`,
      ),
  }));
  expect(
    metrics.doc,
    `document wider than the viewport: ${metrics.offenders.join(' | ')}`,
  ).toBeLessThanOrEqual(metrics.viewport);
  expect(
    metrics.body,
    `body wider than the viewport: ${metrics.offenders.join(' | ')}`,
  ).toBeLessThanOrEqual(metrics.viewport);
  // Horizontal scrolling must not move the page.
  await page.evaluate(() => window.scrollTo(200, window.scrollY));
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
}

test.describe('member pages on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await signInMember(page, DEMO_MEMBER, DEMO_PASSWORD);
  });

  test('dashboard', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: /^Welcome back/ })).toBeVisible();
    await expect(page.getByText('Earned to date').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('team (list view)', async ({ page }) => {
    await page.goto('/team');
    await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
    // Below 768 px the list view is the default.
    await expect(page.getByRole('radio', { name: 'List view' })).toBeChecked();
    const tree = page.getByRole('tree', { name: 'Your team' });
    await expect(tree.getByRole('treeitem').first()).toBeVisible();
    expect(await tree.getByRole('treeitem').count()).toBeGreaterThan(1);
    await expectNoHorizontalOverflow(page);
  });

  test('rewards', async ({ page }) => {
    await page.goto('/rewards');
    await expect(page.getByRole('heading', { level: 1, name: 'Rewards' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Reward history' })).toBeVisible();
    await expect(page.getByText('Posted').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('programs', async ({ page }) => {
    await page.goto('/programs');
    await expect(page.getByRole('heading', { level: 1, name: 'Programs' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View plans' }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('link', { name: 'View plans' }).first().click();
    await expect(page.getByRole('heading', { level: 2, name: 'Plans' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
