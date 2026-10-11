/**
 * Admin console flows driven through the UI (offerings, programs, options, policies, enrollments,
 * sales, rewards). Each helper asserts the visible outcome (toast / badge) of its step.
 */
import { expect, type Page } from '@playwright/test';

import { apiGet } from './flows';
import { zonedInputValue } from './dates';

export const PROGRAM_TIME_ZONE = 'Asia/Kolkata'; // the program form's default

export function toast(page: Page, text: string | RegExp) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
}

// ─── Offerings ───────────────────────────────────────────────────────────────

export async function createOffering(page: Page, name: string, sku: string): Promise<void> {
  await page.goto('/admin/offerings');
  await expect(page.getByRole('heading', { level: 1, name: 'Offerings' })).toBeVisible();
  await page.getByRole('button', { name: 'New offering' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New offering' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await sheet.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: 'Product', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'SKU', exact: true }).fill(sku);
  await sheet
    .getByRole('textbox', { name: 'Description' })
    .fill('End-to-end test product sold to end customers.');
  await sheet.getByRole('button', { name: 'Create offering' }).click();
  await expect(toast(page, 'Offering created')).toBeVisible();
  await expect(sheet).toBeHidden();
}

export async function approveOffering(page: Page, name: string): Promise<void> {
  await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(name);
  const table = page.getByRole('table', { name: 'Offerings' });
  const row = table.getByRole('row').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Inactive', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Approve' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Approve “${name}”?` });
  await confirm.getByRole('button', { name: 'Approve offering' }).click();
  await expect(toast(page, 'Offering approved')).toBeVisible();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
}

// ─── Programs ────────────────────────────────────────────────────────────────

export interface DraftProgramInput {
  name: string;
  code: string;
  offeringName: string;
  startsAt: Date;
}

/** Creates a draft program; returns its id (from the /admin/programs/{id} URL). */
export async function createDraftProgram(page: Page, input: DraftProgramInput): Promise<string> {
  await page.goto('/admin/programs/new');
  await expect(page.getByRole('heading', { level: 1, name: 'New program' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Program name' }).fill(input.name);
  const code = page.getByRole('textbox', { name: 'Code', exact: true });
  await code.fill(input.code);
  await page.getByRole('combobox', { name: 'Offering' }).click();
  await page.getByRole('option', { name: input.offeringName, exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Description' })
    .fill('Program created by the Playwright end-to-end suite.');
  await page.getByLabel('Starts').fill(zonedInputValue(input.startsAt, PROGRAM_TIME_ZONE));
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(toast(page, 'Draft program created')).toBeVisible();
  await page.waitForURL(/\/admin\/programs\/[0-9a-f-]{36}$/);
  const id = /\/admin\/programs\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByRole('heading', { level: 1, name: input.name })).toBeVisible();
  await expect(
    page
      .locator('[data-slot="status-badge"]')
      .filter({ hasText: /^Draft$/ })
      .first(),
  ).toBeVisible();
  return id;
}

export interface OptionInput {
  name: string;
  /** Major units as typed, e.g. "0" or "499.00". */
  price: string;
}

export async function addOption(page: Page, programId: string, option: OptionInput): Promise<void> {
  if (!page.url().endsWith(`/admin/programs/${programId}/options`)) {
    await page.goto(`/admin/programs/${programId}/options`);
  }
  await expect(page.getByRole('heading', { level: 2, name: 'Options' })).toBeVisible();
  await page.getByRole('button', { name: 'Add option' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add option' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(option.name);
  const price = dialog.getByRole('textbox', { name: 'Price', exact: true });
  await expect(price).toBeEnabled();
  await price.fill(option.price);
  // Billing defaults to Monthly / 30 days.
  await expect(dialog.getByRole('combobox', { name: 'Billing' })).toContainText('Monthly');
  await dialog.getByRole('button', { name: 'Add option' }).click();
  await expect(toast(page, 'Option added')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole('table', { name: 'Program options' })
      .getByRole('row')
      .filter({ hasText: option.name }),
  ).toBeVisible();
}

export interface PolicyLevel {
  /** Percent of the sale, e.g. "10". */
  percent: string;
}

/**
 * Creates the first policy draft, adds percentage levels, saves, runs the dry-run preview (asserting
 * the allocated total) and publishes it effective now.
 */
export async function configureAndPublishPolicy(
  page: Page,
  programId: string,
  levels: PolicyLevel[],
  dryRun: { saleAmount: string; expectedAllocated: string },
): Promise<void> {
  await page.goto(`/admin/programs/${programId}/policies`);
  await expect(page.getByRole('heading', { level: 1, name: 'Reward policies' })).toBeVisible();
  await page.getByRole('button', { name: 'Create first draft' }).click();
  const newDraft = page.getByRole('dialog', { name: 'New draft' });
  await newDraft.getByRole('textbox', { name: 'Name' }).fill('E2E launch policy');
  await newDraft.getByRole('button', { name: 'Create draft' }).click();
  await expect(toast(page, 'Draft version 1 created')).toBeVisible();

  const form = page.getByRole('form', { name: 'Edit draft version 1' });
  await expect(form).toBeVisible();
  await expect(form.getByRole('checkbox', { name: 'Product sale' })).toBeChecked();

  const list = form.getByRole('list', { name: 'Reward levels' });
  for (const [i, level] of levels.entries()) {
    await form.getByRole('button', { name: `Add level ${i + 1}` }).click();
    const row = list.getByRole('listitem').nth(i);
    await expect(row.getByRole('combobox', { name: 'Type', exact: true })).toContainText(
      'Percentage of sale',
    );
    await row.getByRole('textbox', { name: 'Percentage', exact: true }).fill(level.percent);
  }
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(toast(page, 'Draft saved')).toBeVisible();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Policy checks' })).toContainText(
    'No issues found',
    { timeout: 20_000 },
  );

  // Dry run: synthetic upline, every level eligible.
  const dry = page.getByRole('region', { name: 'Dry run' });
  await expect(dry.getByText('Preview only — nothing is recorded')).toBeVisible();
  await dry.getByRole('textbox', { name: 'Sale amount', exact: true }).fill(dryRun.saleAmount);
  await dry.getByRole('button', { name: 'Run preview' }).click();
  await expect(dry.getByRole('heading', { name: 'Preview result' })).toBeVisible();
  const allocated = dry
    .locator('dt', { hasText: /^Allocated$/ })
    .locator('xpath=following-sibling::dd[1]');
  await expect(allocated).toContainText(dryRun.expectedAllocated);
  await expect(
    dry.getByRole('table', { name: 'Rewards each level would receive' }).getByRole('row'),
  ).toHaveCount(levels.length + 1);

  // Publish now.
  await page.getByRole('button', { name: 'Publish…' }).click();
  const publish = page.getByRole('dialog', { name: 'Publish version 1' });
  await expect(publish.getByRole('radio', { name: /^Now/ })).toBeChecked();
  await publish
    .getByRole('checkbox', { name: 'I understand published policies cannot be edited' })
    .click();
  await expect(publish.getByText('All checks passed.')).toBeVisible({ timeout: 20_000 });
  await publish.getByRole('button', { name: 'Publish now' }).click();
  await expect(toast(page, 'Version 1 published')).toBeVisible();
  await expect(
    page.getByRole('navigation').filter({ hasText: 'Version 1' }).getByText('In effect'),
  ).toBeVisible();

  // Back to the program overview the way an admin would: the in-app "Program" link (client-side
  // navigation, so the overview must not show a cached "publish a policy first" check).
  await page.getByRole('link', { name: 'Program', exact: true }).click();
  await page.waitForURL(new RegExp(`/admin/programs/${programId}$`));
}

export async function publishProgram(page: Page, programId: string, name: string): Promise<void> {
  if (!page.url().endsWith(`/admin/programs/${programId}`))
    await page.goto(`/admin/programs/${programId}`);
  await expect(page.getByText('A reward policy is published')).toBeVisible();
  await expect(page.getByText('Ready to publish')).toBeVisible();
  const publish = page.getByRole('button', { name: 'Publish', exact: true });
  await expect(publish).toBeEnabled();
  await publish.click();
  const confirm = page.getByRole('alertdialog', { name: `Publish “${name}”?` });
  await expect(confirm.getByRole('button', { name: 'Publish now' })).toBeVisible();
  await confirm.getByRole('button', { name: 'Publish now' }).click();
  await expect(toast(page, 'Program active')).toBeVisible();
  await expect(
    page
      .locator('[data-slot="status-badge"]')
      .filter({ hasText: /^Active$/ })
      .first(),
  ).toBeVisible();
}

// ─── Enrollments ─────────────────────────────────────────────────────────────

/** Activates the member's pending paid enrollment from the admin queue with a payment reference. */
export async function activatePendingEnrollment(
  page: Page,
  memberEmail: string,
  memberName: string,
  paymentReference: string,
): Promise<void> {
  await page.goto('/admin/enrollments');
  await expect(page.getByRole('heading', { level: 1, name: 'Enrollments' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search member or payment ref' }).fill(memberEmail);
  const row = page.getByRole('row').filter({ hasText: memberName });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Activate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record payment and activate' });
  await dialog.getByRole('textbox', { name: 'Payment reference' }).fill(paymentReference);
  await expect(dialog.getByRole('textbox', { name: 'Amount received' })).not.toHaveValue('');
  await dialog.getByRole('button', { name: 'Activate enrollment' }).click();
  await expect(toast(page, 'Enrollment activated')).toBeVisible();
}

// ─── Sales ───────────────────────────────────────────────────────────────────

export interface SaleInput {
  programLabel: string; // "<name> · <code>"
  externalId: string;
  customerReference: string;
  memberQuery: string; // email typed into the member picker
  memberName: string;
  amount: string; // major units, e.g. "2500.00"
  occurredAt: Date;
}

/** Opens "Record sale", fills it in and submits. Returns the result panel locator. */
export async function recordSale(page: Page, sale: SaleInput) {
  if (!/\/admin\/events(\?|$)/.test(page.url())) await page.goto('/admin/events');
  await expect(page.getByRole('heading', { level: 1, name: 'Sales events' })).toBeVisible();
  await page.getByRole('button', { name: 'Record sale' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Record sale' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('combobox', { name: 'Program' }).click();
  await page.getByRole('option', { name: sale.programLabel }).click();
  await sheet.getByRole('textbox', { name: 'Order / invoice id' }).fill(sale.externalId);
  await sheet.getByRole('textbox', { name: 'End-customer reference' }).fill(sale.customerReference);
  const picker = sheet.getByRole('combobox', { name: 'Member credited' });
  await picker.fill(sale.memberQuery);
  const option = page
    .getByRole('listbox', { name: 'Members' })
    .getByRole('option')
    .filter({ hasText: sale.memberName });
  await option.click();
  await expect(sheet.getByRole('button', { name: 'Change selected member' })).toBeVisible();
  const amount = sheet.getByRole('textbox', { name: 'Sale amount' });
  await expect(amount).toBeEnabled();
  await amount.fill(sale.amount);
  await sheet.getByLabel('Occurred at').fill(zonedInputValue(sale.occurredAt, PROGRAM_TIME_ZONE));
  await sheet.getByRole('button', { name: 'Record sale' }).click();
  return sheet;
}

// ─── API lookups (ids for assertions) ─────────────────────────────────────────

interface Page_<T> {
  data: T[];
}

export async function findMemberId(page: Page, email: string): Promise<string> {
  const res = await apiGet(page, `/admin/members?q=${encodeURIComponent(email)}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Page_<{ id: string; email: string }>;
  const member = body.data.find((m) => m.email.toLowerCase() === email.toLowerCase());
  expect(member, `member ${email}`).toBeTruthy();
  return member!.id;
}

export interface EventSummary {
  id: string;
  externalId: string;
  status: string;
  revision: number;
}

export async function findEvents(page: Page, externalId: string): Promise<EventSummary[]> {
  const res = await apiGet(page, `/admin/events?q=${encodeURIComponent(externalId)}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Page_<EventSummary>;
  return body.data.filter((e) => e.externalId === externalId);
}

export interface RewardSummary {
  id: string;
  status: string;
  level: number;
  amountMinor: string;
}

export async function findRewardsForEvent(page: Page, eventId: string): Promise<RewardSummary[]> {
  const res = await apiGet(page, `/admin/rewards?eventId=${eventId}&limit=50`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as Page_<RewardSummary>).data;
}

export interface LedgerTransactionSummary {
  id: string;
  type: string;
  idempotencyKey?: string;
}

export async function ledgerTransactionsForReward(
  page: Page,
  rewardId: string,
): Promise<LedgerTransactionSummary[]> {
  const res = await apiGet(page, `/admin/ledger/transactions?rewardId=${rewardId}&limit=50`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as Page_<LedgerTransactionSummary>).data;
}
