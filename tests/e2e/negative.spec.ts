/**
 * Negative paths: wrong / superseded / expired email codes, an unknown referral code, a member using
 * the admin API, and a suspended member signing in.
 */
import { expect, test } from './utils/test';

import { newActor, attachScreens, type Actor } from './utils/actors';
import { findMemberId, toast } from './utils/admin';
import { dbAvailable, lit, sql } from './utils/db';
import {
  apiGet,
  apiSend,
  enterVerification,
  fillLogin,
  MEMBER_PASSWORD,
  registerAndVerify,
  submitRegistration,
  uniqueEmail,
  uniqueId,
} from './utils/flows';
import {
  extractCode,
  messageText,
  waitForMessage,
  waitForOtp,
  type MailpitMessage,
} from './utils/mailpit';
import { storageStatePath } from './utils/state';

const OTP_ERROR =
  'That code is incorrect or has expired. Check the latest email or request a new code';
const VERIFY_SUBJECT = 'Verify your email address';

function otpError(page: import('@playwright/test').Page) {
  return page.getByRole('alert').filter({ hasText: OTP_ERROR });
}

/** A 6-digit code that is not `code`. */
function otherCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

test.describe('email verification codes', () => {
  test('a wrong code, or the right code with the wrong password, is rejected; the right pair then works', async ({
    page,
  }) => {
    const email = uniqueEmail('wrongotp');
    const since = new Date();
    await submitRegistration(page, { fullName: 'Wanda Wrongcode', email });
    const code = await waitForOtp(email, { since, subject: VERIFY_SUBJECT });

    expect(await enterVerification(page, otherCode(code))).toBe(400);
    await expect(otpError(page)).toBeVisible();
    await expect(page).toHaveURL(/\/verify-email/);

    // Correct code but not the password chosen at registration → the same generic error.
    expect(await enterVerification(page, code, 'Another-password-77')).toBe(400);
    await expect(otpError(page)).toBeVisible();
    await expect(page).toHaveURL(/\/verify-email/);

    expect(await enterVerification(page, code)).toBe(200);
    await page.waitForURL('**/dashboard');
  });

  test('a code superseded by a newer registration is rejected', async ({ page }) => {
    const email = uniqueEmail('superseded');
    const hasCode = (m: MailpitMessage) => extractCode(messageText(m)) !== null;
    await submitRegistration(page, { fullName: 'Sam Superseded', email });
    const firstMessage = await waitForMessage(email, {
      subject: VERIFY_SUBJECT,
      predicate: hasCode,
    });
    const first = extractCode(messageText(firstMessage))!;

    await submitRegistration(page, { fullName: 'Sam Superseded', email });
    const secondMessage = await waitForMessage(email, {
      subject: VERIFY_SUBJECT,
      predicate: hasCode,
      excludeIds: [firstMessage.ID],
    });
    const second = extractCode(messageText(secondMessage))!;
    test.skip(
      first === second,
      'both registrations happened to draw the same random code (1 in 10^6)',
    );

    expect(await enterVerification(page, first)).toBe(400);
    await expect(otpError(page)).toBeVisible();
    expect(await enterVerification(page, second)).toBe(200);
    await page.waitForURL('**/dashboard');
  });

  test('an expired code is rejected', async ({ page }) => {
    test.skip(!dbAvailable(), 'needs docker access to the e2e PostgreSQL container');
    const email = uniqueEmail('expired');
    const since = new Date();
    await submitRegistration(page, { fullName: 'Ezra Expired', email });
    const code = await waitForOtp(email, { since, subject: VERIFY_SUBJECT });

    // Age the open challenge past its 10-minute TTL (created_at must stay before expires_at).
    const updated = sql(
      `UPDATE email_challenges SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' ` +
        `WHERE email = ${lit(email)} AND purpose = 'EMAIL_VERIFICATION' AND consumed_at IS NULL AND invalidated_at IS NULL`,
    );
    expect(updated).toBe('UPDATE 1');

    expect(await enterVerification(page, code)).toBe(400);
    await expect(otpError(page)).toBeVisible();
    await expect(page).toHaveURL(/\/verify-email/);
    // No account was created: signing in fails like for an unknown address.
    await fillLogin(page, email, MEMBER_PASSWORD);
    await expect(
      page.getByRole('alert').filter({ hasText: 'Incorrect email or password' }),
    ).toBeVisible();
  });
});

test('an unknown referral code is refused at registration (the member may continue without one)', async ({
  page,
}) => {
  const email = uniqueEmail('badref');
  const badCode = 'ZZZZ2222'; // valid alphabet, not issued
  await page.goto(`/register?ref=${badCode}`);
  await expect(page.getByLabel('Referral code (optional)')).toHaveValue(badCode);
  await expect(
    page.getByText("We couldn't find this referral code. Check it, or continue without one."),
  ).toBeVisible();

  await page.getByLabel('Full name').fill('Ivan Invalidref');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]:visible').fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(
    page.getByText(
      'This referral code is not valid. Check it, or remove it to continue without one.',
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/register/);

  await page.getByRole('button', { name: 'Continue without a code' }).click();
  await expect(page.getByLabel('Referral code (optional)')).toHaveValue('');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/verify-email');
});

test('a member calling admin APIs gets 403 (and a signed-out client 401)', async ({
  page,
  request,
}) => {
  await registerAndVerify(page, { fullName: 'Mona Member', email: uniqueEmail('apimember') });

  for (const path of [
    '/admin/members',
    '/admin/offerings',
    '/admin/rewards',
    '/admin/ledger/summary',
    '/admin/settings',
  ]) {
    const res = await apiGet(page, path);
    expect(res.status(), path).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe('FORBIDDEN');
  }
  // A state-changing admin call with a valid CSRF token is refused by authorization, not by CSRF.
  const create = await apiSend(page, 'POST', '/admin/offerings', {
    name: 'Not allowed',
    kind: 'PRODUCT',
  });
  expect(create.status()).toBe(403);
  expect(((await create.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

  const anonymous = await request.get('/api/v1/admin/members');
  expect(anonymous.status()).toBe(401);
});

test.describe('suspension', () => {
  let admin: Actor;
  let member: Actor;

  test.beforeEach(async ({ browser }, testInfo) => {
    admin = await newActor(browser, testInfo, storageStatePath('admin'), 'admin');
    member = await newActor(browser, testInfo, undefined, 'member');
  });
  test.afterEach(async ({}, testInfo) => {
    await attachScreens(testInfo, { admin, member });
    await admin.context.close();
    await member.context.close();
  });

  test('a suspended member is signed out and cannot sign in', async () => {
    const name = `Suki Suspended${uniqueId(4)}`;
    const email = uniqueEmail('suspended');
    await registerAndVerify(member.page, { fullName: name, email });

    const id = await findMemberId(admin.page, email);
    await admin.page.goto(`/admin/members/${id}`);
    await expect(admin.page.getByRole('heading', { level: 1, name })).toBeVisible();
    await admin.page.getByRole('button', { name: 'Suspend', exact: true }).click();
    const confirm = admin.page.getByRole('alertdialog', { name: `Suspend ${name}?` });
    await confirm
      .getByRole('textbox', { name: 'Reason for suspension' })
      .fill('Suspicious activity reported by support (e2e).');
    await confirm.getByRole('button', { name: 'Suspend member' }).click();
    await expect(toast(admin.page, `${name} was suspended`)).toBeVisible();
    await expect(
      admin.page
        .locator('[data-slot="status-badge"]')
        .filter({ hasText: /^Suspended$/ })
        .first(),
    ).toBeVisible();

    // The existing session was revoked.
    const me = await apiGet(member.page, '/auth/session');
    expect(me.status()).toBe(401);

    // Signing in again: the correct password is recognised, the account is refused.
    await member.context.clearCookies();
    await fillLogin(member.page, email, MEMBER_PASSWORD);
    await expect(
      member.page
        .getByRole('alert')
        .filter({ hasText: 'Your account is suspended. Please contact support' }),
    ).toBeVisible();
    await expect(member.page).toHaveURL(/\/login/);
  });
});
