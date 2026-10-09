/**
 * Mailpit helpers for e2e tests: find the newest email sent to an address and pull the 6-digit
 * one-time code out of it (email verification, admin MFA, password reset, email change).
 *
 * Mailpit API docs: https://mailpit.axllent.org/docs/api-v1/
 *   GET    /api/v1/search?query=to:"a@b.c"&limit=N   newest first
 *   GET    /api/v1/message/{ID}                       full message (Text + HTML)
 *   DELETE /api/v1/search?query=...                   delete matching messages
 *
 * Configuration (env):
 *   MAILPIT_URL   default http://localhost:8025
 *   MAILPIT_AUTH  optional "user:password" when the Mailpit UI/API is protected by basic auth
 *
 * Usage:
 *   const since = new Date();
 *   await page.getByRole('button', { name: 'Create account' }).click();
 *   const code = await waitForOtp(email, { since });
 */

export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitMessageSummary {
  ID: string;
  MessageID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  /** ISO timestamp at which Mailpit received the message. */
  Created: string;
  Snippet: string;
}

export interface MailpitMessage {
  ID: string;
  MessageID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  /** ISO timestamp from the message's Date header. */
  Date: string;
  Text: string;
  HTML: string;
}

interface SearchResponse {
  total: number;
  messages: MailpitMessageSummary[] | null;
}

export interface WaitForMessageOptions {
  /** Only messages whose subject contains this text / matches this pattern. */
  subject?: string | RegExp;
  /**
   * Ignore messages received before this instant. Take the timestamp *before* triggering the
   * email so a code from an earlier step (or an earlier resend) is never picked up.
   */
  since?: Date;
  /** Ignore these message ids (e.g. messages already consumed by the test). */
  excludeIds?: Iterable<string>;
  /** Extra condition on the full message (body checks). */
  predicate?: (message: MailpitMessage) => boolean;
  /** Give up after this long. Default 20 s (the worker delivers email asynchronously via the outbox). */
  timeoutMs?: number;
  /** Poll interval. Default 500 ms. */
  intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 500;
/** Tolerance for clock differences between the test runner and the Mailpit container. */
const CLOCK_SKEW_MS = 2_000;

function mailpitBaseUrl(): string {
  return (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/+$/, '');
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const auth = process.env.MAILPIT_AUTH;
  if (auth) headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
  return headers;
}

async function mailpit<T>(method: 'GET' | 'DELETE', path: string): Promise<T> {
  const url = `${mailpitBaseUrl()}${path}`;
  const res = await fetch(url, { method, headers: requestHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mailpit ${method} ${path} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  if (method === 'DELETE' || res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function toQuery(address: string): string {
  return `to:"${address.trim().toLowerCase().replace(/"/g, '')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function subjectMatches(subject: string, filter: string | RegExp | undefined): boolean {
  if (filter === undefined) return true;
  return typeof filter === 'string' ? subject.includes(filter) : filter.test(subject);
}

/** Newest-first list of messages matching a Mailpit search query (e.g. `to:"a@b.c"`). */
export async function searchMessages(query: string, limit = 50): Promise<MailpitMessageSummary[]> {
  const params = new URLSearchParams({ query, limit: String(limit) });
  const res = await mailpit<SearchResponse>('GET', `/api/v1/search?${params.toString()}`);
  return res.messages ?? [];
}

/** Full message (plain-text and HTML bodies). */
export function getMessage(id: string): Promise<MailpitMessage> {
  return mailpit<MailpitMessage>('GET', `/api/v1/message/${encodeURIComponent(id)}`);
}

/** Deletes every message addressed to `address` (keeps parallel tests independent). */
export async function deleteMessagesTo(address: string): Promise<void> {
  const params = new URLSearchParams({ query: toQuery(address) });
  await mailpit<void>('DELETE', `/api/v1/search?${params.toString()}`);
}

/**
 * Extracts a one-time code from an email body/subject. Prefers a code that follows the word
 * "code" (e.g. "Your verification code is 123456"); falls back to the first standalone run of
 * exactly `length` digits. Returns null when none is found.
 */
export function extractCode(content: string, length = 6): string | null {
  const text = content
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
  const digits = `\\d{${length}}`;
  const nearKeyword = new RegExp(`code\\b[^0-9]{0,40}(?<!\\d)(${digits})(?!\\d)`, 'i').exec(text);
  if (nearKeyword?.[1]) return nearKeyword[1];
  const standalone = new RegExp(`(?<!\\d)(${digits})(?!\\d)`).exec(text);
  return standalone?.[1] ?? null;
}

/** Plain text of a message, falling back to its HTML when there is no text part. */
export function messageText(message: MailpitMessage): string {
  return message.Text?.trim() ? message.Text : (message.HTML ?? '');
}

/**
 * Polls Mailpit until a matching message to `to` arrives and returns the newest one.
 * Throws with a summary of what *was* found when the timeout expires.
 */
export async function waitForMessage(
  to: string,
  options: WaitForMessageOptions = {},
): Promise<MailpitMessage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sinceMs = options.since
    ? options.since.getTime() - CLOCK_SKEW_MS
    : Number.NEGATIVE_INFINITY;
  const excluded = new Set(options.excludeIds ?? []);
  const deadline = Date.now() + timeoutMs;
  let lastSeen: MailpitMessageSummary[] = [];

  for (;;) {
    lastSeen = await searchMessages(toQuery(to));
    const candidates = lastSeen.filter(
      (m) =>
        !excluded.has(m.ID) &&
        Date.parse(m.Created) >= sinceMs &&
        subjectMatches(m.Subject, options.subject),
    );
    for (const summary of candidates) {
      const message = await getMessage(summary.ID);
      if (!options.predicate || options.predicate(message)) return message;
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }

  const seen = lastSeen.map((m) => `"${m.Subject}" @ ${m.Created}`).join('; ') || 'none';
  throw new Error(
    `No matching email to ${to} within ${timeoutMs} ms` +
      (options.subject ? ` (subject ${String(options.subject)})` : '') +
      `. Messages for this address: ${seen}`,
  );
}

/** Waits for the newest email to `to` that contains a 6-digit code and returns the code. */
export async function waitForOtp(
  to: string,
  options: Omit<WaitForMessageOptions, 'predicate'> = {},
): Promise<string> {
  const message = await waitForMessage(to, {
    ...options,
    predicate: (m) => extractCode(messageText(m)) !== null || extractCode(m.Subject) !== null,
  });
  const code = extractCode(messageText(message)) ?? extractCode(message.Subject);
  if (!code) throw new Error(`Email "${message.Subject}" to ${to} contains no 6-digit code`);
  return code;
}
