/**
 * Guards against pointing destructive test helpers (TRUNCATE) at a real database: the database name
 * must contain "test".
 */
export function assertSafeTestDatabaseUrl(url: string | undefined): string {
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Example: postgresql://referral:referral_dev_password@localhost:5432/referral_test?schema=public',
    );
  }
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to use database "${name}" for tests: its name must contain "test"`);
  }
  return url;
}
