/**
 * The critical business flow, end to end through nginx → web → API → worker → Mailpit:
 *
 *   (a) super admin sign-in + TOTP          → admin.setup.ts (setup project, stored session)
 *   (b) offering → approval → draft program with plans → reward policy (dry run) → publish both
 *   (c) member A registers, verifies (Mailpit code + password), enrolls in the free plan
 *   (d) member B registers through A's referral link, verifies, requests the paid plan, the admin
 *       activates it with a payment reference; A's team shows B, B's sponsor page shows A
 *   (e) the admin records a product sale credited to B → a pending reward for A
 *       (recording the same sale again is an idempotent replay)
 *   (f) the seeded finance reviewer signs in (email code + TOTP enrollment) and approves the reward;
 *       the ledger holds exactly one posting for it
 *   (g) A sees the posted reward and "Earned to date"; A cannot use the admin area or see B's
 *       private data
 *   (h) reversing the sale reverses the posted reward (compensating ledger entry)
 *
 * Runs serially with one browser context per actor; each step builds on the previous one.
 */
import { expect, test } from './utils/test';

import { newActor, attachScreens, type Actor } from './utils/actors';
import {
  activatePendingEnrollment,
  addOption,
  approveOffering,
  configureAndPublishPolicy,
  createDraftProgram,
  createOffering,
  findEvents,
  findMemberId,
  findRewardsForEvent,
  ledgerTransactionsForReward,
  publishProgram,
  recordSale,
  toast,
} from './utils/admin';
import { nextFullMinute } from './utils/dates';
import {
  apiGet,
  DEMO_PASSWORD,
  registerAndVerify,
  signInAdmin,
  submitRegistration,
  uniqueEmail,
  uniqueId,
} from './utils/flows';
import { waitForOtp } from './utils/mailpit';
import { storageStatePath } from './utils/state';
import { enterVerification, MEMBER_PASSWORD } from './utils/flows';

test.describe.configure({ mode: 'serial' });

const run = uniqueId(6);
const offeringName = `E2E Solar Lamp ${run}`;
const programName = `E2E Partners ${run}`;
const programCode = `e2e-${run.toLowerCase()}`;
const FREE_PLAN = 'Starter (free)';
const PAID_PLAN = 'Pro monthly';

const memberA = { fullName: `Asha Tester${run}`, email: uniqueEmail('a'), display: `Asha T.` };
const memberB = { fullName: `Bimal Ray${run}`, email: uniqueEmail('b'), display: `Bimal R.` };
const financeEmail = process.env.E2E_FINANCE_EMAIL ?? 'finance@example.com';
const financePassword = process.env.E2E_FINANCE_PASSWORD ?? DEMO_PASSWORD;

// Sale credited to B: ₹2,500.00 → 2,500 points (1 point per INR) → level 1 at 10 % = 250 Points.
const sale = {
  externalId: `E2E-ORDER-${run}`,
  customerReference: `E2E-CUST-${run}`,
  amount: '2500.00',
  rewardText: '250 Points',
  rewardMinor: '250',
};

let admin: Actor;
let a: Actor;
let b: Actor;
let finance: Actor | undefined;
let programId: string;
let referralCode: string;
let memberBId: string;
let saleOccurredAt: Date;
let eventId: string;
let rewardId: string;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await newActor(browser, testInfo, storageStatePath('admin'), 'admin');
  a = await newActor(browser, testInfo, undefined, 'memberA');
  b = await newActor(browser, testInfo, undefined, 'memberB');
});

test.afterEach(async ({}, testInfo) => {
  await attachScreens(testInfo, { admin, a, b, finance });
});

test.afterAll(async () => {
  for (const actor of [admin, a, b, finance]) await actor?.context.close();
});

test('(b) admin creates and approves an offering, builds a program with plans and a published reward policy', async () => {
  const page = admin.page;
  await createOffering(page, offeringName, `E2E-SKU-${run}`);
  await approveOffering(page, offeringName);

  programId = await createDraftProgram(page, {
    name: programName,
    code: programCode,
    offeringName,
    startsAt: new Date(Date.now() - 60 * 60_000),
  });
  await addOption(page, programId, { name: FREE_PLAN, price: '0' });
  await addOption(page, programId, { name: PAID_PLAN, price: '499.00' });

  // Levels: 10 % and 5 % of the sale (budget 20 %). Dry run ₹1,000 with 3 eligible uplines → 100 + 50.
  await configureAndPublishPolicy(page, programId, [{ percent: '10' }, { percent: '5' }], {
    saleAmount: '1000',
    expectedAllocated: '150 Points',
  });

  await publishProgram(page, programId, programName);
});

test('(c) member A registers, verifies the email code with the password and enrolls in the free plan', async () => {
  const page = a.page;
  await registerAndVerify(page, { fullName: memberA.fullName, email: memberA.email });

  await page.goto(`/programs/${programCode}`);
  await expect(page.getByRole('heading', { level: 1, name: programName })).toBeVisible();
  const plan = page
    .getByRole('region', { name: 'Plans' })
    .getByRole('listitem')
    .filter({ hasText: FREE_PLAN });
  await plan.getByRole('button', { name: 'Enroll for free' }).click();
  const dialog = page.getByRole('dialog', { name: `Enroll in ${programName}` });
  await expect(dialog.getByText('Free plans are activated immediately.')).toBeVisible();
  const enroll = dialog.getByRole('button', { name: 'Enroll', exact: true });
  await expect(enroll).toBeDisabled();
  await dialog.getByRole('checkbox').click();
  await enroll.click();
  await expect(toast(page, `enrolled in ${programName}`)).toBeVisible();

  await page.goto('/programs?tab=enrollments');
  await expect(page.getByText(FREE_PLAN).first()).toBeVisible();
  await expect(
    page
      .locator('[data-slot="status-badge"]')
      .filter({ hasText: /^Active$/ })
      .first(),
  ).toBeVisible();

  // A's referral link (code = ?ref=… of the link).
  await page.goto('/referrals');
  const link = await page.locator('#referral-link').inputValue();
  referralCode = new URL(link).searchParams.get('ref') ?? '';
  expect(referralCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  await expect(page.locator('code', { hasText: referralCode })).toBeVisible();
});

test('(d) member B registers through A’s link, enrolls in a paid plan the admin activates; team and sponsor views agree', async () => {
  const page = b.page;
  await page.goto(`/register?ref=${referralCode}`);
  await expect(page.getByLabel('Referral code (optional)')).toHaveValue(referralCode);
  await expect(page.getByRole('status').filter({ hasText: 'Invited by' })).toContainText(
    `Invited by ${memberA.display}`,
  );

  const since = new Date();
  await submitRegistration(page, {
    fullName: memberB.fullName,
    email: memberB.email,
    referralCode,
  });
  const code = await waitForOtp(memberB.email, { since, subject: 'Verify your email address' });
  expect(await enterVerification(page, code, MEMBER_PASSWORD)).toBe(200);
  await page.waitForURL('**/dashboard');

  // Paid plan → pending until the admin records the offline payment.
  await page.goto(`/programs/${programCode}`);
  const plan = page
    .getByRole('region', { name: 'Plans' })
    .getByRole('listitem')
    .filter({ hasText: PAID_PLAN });
  await plan.getByRole('button', { name: 'Choose this plan' }).click();
  const dialog = page.getByRole('dialog', { name: `Enroll in ${programName}` });
  await dialog.getByRole('checkbox').click();
  await dialog.getByRole('button', { name: 'Request enrollment' }).click();
  await expect(toast(page, 'Enrollment received')).toBeVisible();

  await activatePendingEnrollment(admin.page, memberB.email, memberB.fullName, `E2E-PAY-${run}`);
  await page.goto('/programs?tab=enrollments');
  await expect(page.getByText(PAID_PLAN).first()).toBeVisible();
  await expect(
    page
      .locator('[data-slot="status-badge"]')
      .filter({ hasText: /^Active$/ })
      .first(),
  ).toBeVisible();

  // B's sponsor is A (display name only).
  await page.goto('/sponsor');
  await expect(page.getByRole('heading', { level: 1, name: 'My sponsor' })).toBeVisible();
  await expect(page.getByText(memberA.display).first()).toBeVisible();
  await expect(page.getByText('Registration with referral link')).toBeVisible();

  // A's team (list view) shows B.
  await a.page.goto('/team');
  await a.page.getByRole('radio', { name: 'List view' }).click();
  const tree = a.page.getByRole('tree', { name: 'Your team' });
  await expect(
    tree.getByRole('treeitem', { name: new RegExp(`^${memberB.display}, level 1`) }),
  ).toBeVisible();

  memberBId = await findMemberId(admin.page, memberB.email);
});

test('(e) admin records a product sale credited to B; the engine creates a pending reward for A; a replay is idempotent', async () => {
  const page = admin.page;
  saleOccurredAt = nextFullMinute(5_000);
  const input = {
    programLabel: `${programName} · ${programCode}`,
    externalId: sale.externalId,
    customerReference: sale.customerReference,
    memberQuery: memberB.email,
    memberName: memberB.fullName,
    amount: sale.amount,
    occurredAt: saleOccurredAt,
  };
  const sheet = await recordSale(page, input);
  await expect(toast(page, 'Sale recorded')).toBeVisible();
  const result = sheet.getByRole('status').filter({ hasText: 'reward' });
  await expect(result).toContainText('1 reward created');
  await expect(result).toContainText('pending approval');
  await sheet.getByRole('button', { name: 'Done' }).click();

  const events = await findEvents(page, sale.externalId);
  expect(events).toHaveLength(1);
  expect(events[0]!.status).toBe('PROCESSED');
  eventId = events[0]!.id;
  const rewards = await findRewardsForEvent(page, eventId);
  expect(rewards).toHaveLength(1);
  expect(rewards[0]).toMatchObject({
    level: 1,
    status: 'PENDING_APPROVAL',
    amountMinor: sale.rewardMinor,
  });
  rewardId = rewards[0]!.id;

  // Same sale again (same facts, new sheet / idempotency key) → the existing record, nothing new.
  const again = await recordSale(page, input);
  await expect(toast(page, 'Sale already recorded')).toBeVisible();
  await expect(again.getByText('Already recorded', { exact: true })).toBeVisible();
  await again.getByRole('button', { name: 'Done' }).click();
  expect(await findEvents(page, sale.externalId)).toHaveLength(1);
  expect(await findRewardsForEvent(page, eventId)).toHaveLength(1);

  // The recorder cannot approve the rewards of a sale they recorded (four eyes).
  await page.goto('/admin/rewards');
  await page
    .getByRole('searchbox', { name: 'Search rewards by recipient name or email' })
    .fill(memberA.email);
  const row = page
    .getByRole('table', { name: 'Rewards' })
    .getByRole('row')
    .filter({ hasText: memberA.fullName });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'Approve' })).toBeDisabled();
});

test('(f) finance reviewer signs in with email code + TOTP enrollment and approves the reward; the ledger has exactly one posting', async ({
  browser,
}, testInfo) => {
  finance = await newActor(browser, testInfo, undefined, 'finance');
  const page = finance.page;
  await signInAdmin(page, financeEmail, financePassword);

  await page.goto('/admin/rewards');
  await expect(page.getByRole('heading', { level: 1, name: 'Rewards' })).toBeVisible();
  await page
    .getByRole('searchbox', { name: 'Search rewards by recipient name or email' })
    .fill(memberA.email);
  const row = page
    .getByRole('table', { name: 'Rewards' })
    .getByRole('row')
    .filter({ hasText: memberA.fullName });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(sale.rewardText);
  await expect(row).toContainText('Pending approval');
  await row.getByRole('button', { name: 'Approve' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Approve and post this reward?' });
  await confirm.getByRole('button', { name: 'Approve and post' }).click();
  await expect(toast(page, 'Reward approved and posted')).toBeVisible();

  // Ledger: exactly one transaction for this reward — the posting (2 entries).
  const txns = await ledgerTransactionsForReward(page, rewardId);
  expect(txns).toHaveLength(1);
  expect(txns[0]).toMatchObject({
    type: 'REWARD_POSTING',
    idempotencyKey: `reward-posting:${rewardId}`,
    entryCount: 2,
  });
  await page.goto(`/admin/ledger?reward=${rewardId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Ledger' })).toBeVisible();
  const ledgerRows = page
    .getByRole('table', { name: 'Ledger transactions' })
    .getByRole('row')
    .filter({ hasText: memberA.fullName });
  await expect(ledgerRows).toHaveCount(1);
  await expect(ledgerRows).toContainText('Reward posting');
});

test('(g) member A sees the posted reward and earnings; A cannot use the admin area or see B’s private data', async () => {
  const page = a.page;
  await page.goto('/rewards');
  await expect(page.getByRole('heading', { level: 1, name: 'Rewards' })).toBeVisible();
  const row = page.getByRole('table').getByRole('row').filter({ hasText: programName });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('L1');
  await expect(row).toContainText(sale.rewardText);
  await expect(row).toContainText('Posted');

  await page.goto('/profile');
  await expect(page.getByRole('region', { name: 'Earned to date' })).toContainText(sale.rewardText);
  await page.goto('/dashboard');
  const earned = page.getByText('Earned to date', { exact: false }).first();
  await expect(earned).toBeVisible();
  await expect(earned.locator('xpath=..')).toContainText(sale.rewardText);

  // Admin area: the UI refuses, and so does the API.
  await page.goto('/admin');
  await expect(page.getByText('Admin access required')).toBeVisible();
  await page.goto('/admin/rewards');
  await expect(page.getByText('Admin access required')).toBeVisible();
  for (const path of [
    '/admin/members',
    `/admin/members/${memberBId}`,
    '/admin/rewards',
    '/admin/ledger/transactions',
  ]) {
    const res = await apiGet(page, path);
    expect(res.status(), path).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe('FORBIDDEN');
  }

  // Team / referral data about B: display name only — no email, full name or amounts.
  await page.goto('/team');
  await page.getByRole('radio', { name: 'List view' }).click();
  await expect(
    page
      .getByRole('tree', { name: 'Your team' })
      .getByRole('treeitem', { name: new RegExp(`^${memberB.display}`) }),
  ).toBeVisible();
  await expect(page.getByText(memberB.email)).toHaveCount(0);
  await expect(page.getByText(memberB.fullName)).toHaveCount(0);
  const firstName = memberB.display.split(' ')[0]!;
  for (const path of [
    '/users/me/hierarchy/tree',
    `/users/me/hierarchy/search?q=${firstName}`,
    '/users/me/referrals',
    `/users/me/hierarchy/path/${memberBId}`,
  ]) {
    const res = await apiGet(page, path);
    expect(res.status(), path).toBe(200);
    const text = await res.text();
    expect(text, path).toContain(memberB.display);
    expect(text, path).not.toContain(memberB.email);
    expect(text, path).not.toContain(memberB.fullName);
    expect(text, path).not.toMatch(/"(email|phone|amountMinor|priceMinor|paymentReference)"/);
  }
});

test('(h) reversing the sale reverses the posted reward with a compensating ledger entry', async () => {
  const page = admin.page;
  await page.goto(`/admin/events?event=${eventId}`);
  const sheet = page.getByRole('dialog', { name: new RegExp(sale.externalId) });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Reverse sale' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Reverse sale ${sale.externalId}?` });
  await confirm
    .getByRole('textbox', { name: 'Reason' })
    .fill('Full refund issued to the end customer (e2e).');
  const reverse = confirm.getByRole('button', { name: 'Reverse sale' });
  await expect(reverse).toBeDisabled();
  await confirm.getByRole('textbox', { name: /Type REVERSE to confirm/ }).fill('REVERSE');
  await reverse.click();
  await expect(toast(page, 'Sale reversed')).toBeVisible();

  const [event] = await findEvents(page, sale.externalId);
  expect(event!.status).toBe('REVERSED');
  const [reward] = await findRewardsForEvent(page, eventId);
  expect(reward!.status).toBe('REVERSED');
  const txns = await ledgerTransactionsForReward(page, rewardId);
  expect(txns.map((t) => t.type).sort()).toEqual(['REWARD_POSTING', 'REWARD_REVERSAL']);
  expect(txns.find((t) => t.type === 'REWARD_REVERSAL')!.idempotencyKey).toBe(
    `reward-reversal:${rewardId}`,
  );

  // A: the reward is reversed and no longer counts as earned.
  await a.page.goto('/rewards');
  const row = a.page.getByRole('table').getByRole('row').filter({ hasText: programName });
  await expect(row).toContainText('Reversed');
  const earnings = (await (await apiGet(a.page, '/users/me/earnings')).json()) as {
    data: { buckets: { earnedToDateMinor: string; reversedMinor: string }[] };
  };
  expect(earnings.data.buckets).toEqual([
    expect.objectContaining({ earnedToDateMinor: '0', reversedMinor: sale.rewardMinor }),
  ]);
});
