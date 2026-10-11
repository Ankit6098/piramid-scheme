# Frontend (apps/web)

Next.js 16.4 App Router, React 19, Tailwind 4, shadcn/ui (radix-nova), TanStack Query/Table,
react-hook-form + Zod, next-themes, sonner, date-fns v4 + `@date-fns/tz`. This document is the
contract for feature slices building pages on top of the web core.

> Next 16 differs from older versions: read `apps/web/AGENTS.md` and the bundled docs in
> `apps/web/node_modules/next/dist/docs/` before using an unfamiliar API. `middleware.ts` is now
> `src/proxy.ts`.

## 1. Rendering model (Cache Components)

`next.config.ts` keeps `cacheComponents: true` + `partialPrefetching: true` (the Next 16 default
direction). What that means for this app:

- Public pages (`/`, auth screens, error pages) are fully static.
- The member/admin shells prerender a **static shell** (sidebar frame, nav labels, top bar). Every
  session- or URL-dependent part renders inside a `<Suspense>` boundary.
- Page content is rendered inside `<Suspense>` + `<RequireAuth>` in `AppShell`, and `loading.tsx`
  adds another boundary per navigation. `RequireAuth` renders a skeleton until the session query
  resolves in the browser, so **page components never run during prerender**. In practice slices can
  use `useSearchParams`, `useParams`, `usePathname`, TanStack Query and dynamic `[id]` segments
  without adding their own Suspense (verified with probe routes during setup).
- All data is fetched **in the browser** with TanStack Query against `/api/v1` (cookie auth). No
  server-side data fetching, no Server Actions, no `cookies()` reads in pages.
- Navigation keeps up to 3 recent routes mounted but hidden (React `<Activity>`): component state
  (form drafts, open dialogs) survives back/forward. Reset transient UI state on success yourself.
  The auth screens (login, register, verify-email, forgot/reset password) call
  `useResetWhenHidden()` (`features/auth/lib/use-reset-when-hidden.ts`, a `useLayoutEffect` cleanup) to
  clear mutation results, errors and typed secrets when hidden, so a return visit starts clean.

Rules:

1. Never export `dynamic`, `revalidate`, `runtime` or `fetchCache` from a route. Cache Components
   does not allow them.
2. Do not call `Date.now()`, `new Date()` (no args) or `Math.random()` during render in components
   that can render outside a page body (shell, layouts, public pages). Use `useNow()`
   (`src/hooks/use-now.ts`) or `<RelativeTime>`; compute times in effects/handlers.
3. A component that reads `cookies()`/`headers()` (server) or URL hooks in a **layout** must sit in
   `<Suspense>`.
4. `page.tsx` may be a Server Component (export `metadata`, render a client feature component) or a
   `'use client'` page. Prefer the first: `export const metadata = { title: '…' }` then
   `<RewardsPage />` from `src/features/rewards/…`.

## 2. Directory layout

```
src/app/
  layout.tsx            root: fonts, metadata, skip link, <AppProviders>
  page.tsx              public landing page
  not-found.tsx error.tsx global-error.tsx
  (auth)/layout.tsx     centered card + brand + theme toggle; login, register, verify-email,
                        forgot-password, reset-password, mfa (stubs)
  (member)/layout.tsx   <AppShell area="member">; loading.tsx, error.tsx, not-found.tsx
  (member)/<route>/page.tsx   dashboard, programs, referrals, team, sponsor, rewards, profile, notifications
  admin/layout.tsx      <AppShell area="admin"> (admin role + MFA required)
  admin/<route>/page.tsx      overview, programs, offerings, enrollments, members, events, rewards,
                              ledger, reconciliation, flags, audit, settings
src/proxy.ts            cookie-presence redirects
src/config/             site.ts (brand), routes.ts (paths, cookie names, redirect helpers),
                        navigation.ts (ALL nav routes, icons, permissions, breadcrumb labels)
src/lib/                api-client.ts, query-keys.ts, query-client.ts, types.ts, datetime.ts,
                        enum-labels.ts, utils.ts (cn)
src/providers/          app-providers, query, theme, platform-settings (+ amount hooks)
src/hooks/              use-session.ts, use-now.ts, use-time-zone.ts, use-mobile.ts
src/components/ui/      shadcn (generated — add with `npx shadcn@4.21.4 add <name> -y`, don't edit)
src/components/app/     app kit (below), shell/, form/, data-table/
src/features/<f>/       feature code owned by slices: components/, hooks/api (queries+mutations),
                        schemas, columns
```

## 3. Design tokens (`src/app/globals.css`)

Neutral cool-gray surfaces, one accent (deep teal), no gradients. All colors are CSS variables
mapped to Tailwind utilities via `@theme inline`; `.dark` (next-themes, `attribute="class"`) swaps them.

| Token (utility) | Use |
|---|---|
| `background` / `foreground` | page plane (very light gray / near-black) and body text |
| `card`, `popover` | raised surfaces (white in light mode) with `ring-1 ring-foreground/10` |
| `muted` / `muted-foreground` | subdued fills / secondary text (≥ 5.6:1 contrast) |
| `primary` / `primary-foreground` | the teal accent: primary buttons, active states, links |
| `secondary`, `accent` | neutral fills for secondary buttons and hover states |
| `border`, `input`, `ring` | hairlines, input borders, focus ring (teal) |
| `success`, `warning`, `info`, `destructive` (+ `-foreground`) | semantic status. Soft badge = `bg-success/10 text-success ring-success/25`. Text on `/10` tint is ≥ 4.7:1 in both themes |
| `chart-1 … chart-5` | categorical chart palette in fixed order (teal, orange, blue, amber, violet), CVD- and contrast-validated for both themes. Never cycle; fold a 6th series into "Other". `chart-grid`, `chart-axis` for chrome |
| `sidebar-*` | sidebar surface, active item (`sidebar-accent`) |
| `--radius` 0.625rem | `rounded-lg` = controls, `rounded-xl` = cards |

Typography: Geist Sans / Geist Mono via `next/font` (`font-sans`, `font-mono`, `font-heading`).
Scale: page title `text-2xl font-semibold tracking-tight` (PageHeader), section `text-base font-semibold`,
body `text-sm`, captions/meta `text-xs text-muted-foreground`, KPI figures `text-2xl font-semibold tabular-nums`.
Spacing: page padding comes from the shell (`px-4 sm:px-6 lg:px-8`, max-w-7xl); stack sections with
`space-y-6`/`space-y-8`, grids with `gap-4`. Numbers in tables use `tabular-nums` (`tabular` utility).

Status/semantic colors are never the only signal: badges carry a text label, trends an icon + sr text.
`prefers-reduced-motion` disables animations globally.

## 4. Data fetching

### API client (`src/lib/api-client.ts`)

```ts
import { api, ApiError, createIdempotencyKey, getErrorMessage } from '@/lib/api-client';

const reward = await api.get<RewardDto>(`/rewards/${id}`);              // → data (unwrapped)
const page = await api.getPage<RewardRow>('/rewards', { query: { status, cursor, limit } }); // → ApiPage<T>
await api.post<RewardDto>(`/admin/rewards/${id}/approve`, { reason }, { idempotencyKey });
```

- Paths are relative to `/api/v1`. Browser-only (relative URL + cookies).
- Mutations automatically send the CSRF header (`x-csrf-token`, from the readable `csrf_token`
  cookie or `GET /auth/csrf`) and retry once on `CSRF_FAILED`.
- Errors are thrown as `ApiError` (`code`, `status`, `message`, `details`, `requestId`,
  `fieldErrors` + helpers `isUnauthenticated`, `isForbidden`, `isNotFound`, `isValidation`,
  `isConflict`, `isRateLimited`, `isNetworkError`). Network failures → code `NETWORK_ERROR`, status 0.
- Idempotency: create the key **once per user intent** (e.g. `useState(createIdempotencyKey)` when the
  dialog opens) so a retry reuses it.
- Amounts are decimal strings in and out — never `Number()` them. bigint values in request bodies are
  serialized as strings automatically.

### Query keys (`src/lib/query-keys.ts`)

Every key comes from the central factory; add your feature's keys there (`all` root first, literal
arrays — see the file header). Invalidate by root: `queryClient.invalidateQueries({ queryKey: queryKeys.rewards.all })`.

### Queries & mutations

- Put feature hooks in `src/features/<f>/api.ts` (or `hooks.ts`): `useRewards(params)`,
  `useApproveReward()` … using `queryOptions` + `queryKeys`.
- QueryClient defaults (`src/lib/query-client.ts`): `staleTime` 30 s, no retry on 4xx, 2 retries
  otherwise, mutations never retry. Any 401 / `MFA_REQUIRED` invalidates the session so
  `<RequireAuth>` redirects.
- Render states with the kit: `isPending` → skeleton, `error` → `<ErrorState error onRetry>`, empty →
  `<EmptyState>`. On mutation success: `toast.success(...)` + invalidate affected keys; on error:
  `if (!applyApiFieldErrors(error, form)) toast.error(getErrorMessage(error))` — it applies only
  issues for fields the form renders (registered, or `knownFields`) and returns false otherwise, so
  409s / invariant violations are never swallowed. `ApiError.fieldErrors` is built only from
  `details.issues|errors|fieldErrors`; `ApiError.retryAfterSeconds` carries the 429 wait
  (`details.retryAfterSeconds` or the `Retry-After` header).
- Forms with `useUnsavedChangesWarning(form)`: the guard follows `isDirty`, so `form.reset(saved)`
  (or remount) on success.
- URL-synced search boxes: `useUrlTextFilters({ q: filters.q ?? '' }, setParams)` (debounced, writes
  only the edited keys, follows URL changes made elsewhere).
- Cursor lists: `useCursorList<T>({ queryKey, path, query, pageSize })` →
  `{ rows, isLoading, isFetching, error, refetch, pagination }`, plug straight into `<DataTable>`.

### Session & permissions

```ts
const { user, status, can, canAny, hasRole } = useSession(); // src/hooks/use-session.ts
const logout = useLogout();                                    // POST /auth/logout → hard nav to /login
```

- After a successful login/MFA/registration the auth slice must reset client state:
  `queryClient.clear()` then `window.location.assign(next ?? '/dashboard')` (hard navigation; the
  previous user's hidden routes must not survive).
- Guards (`src/components/app/guards.tsx`), UX only — the API authorizes everything:
  - `<RequireAuth area>` — already applied by the shells.
  - `<RequirePermission perm={Permission.LedgerRead}>` / `anyOf` / `allOf` — wrap admin pages
    (stubs already do; keep it when replacing a page).
  - `<Can perm={Permission.RewardsApprove}>…</Can>` — hide individual actions.
- Endpoints the core relies on (API contract):
  `GET /auth/csrf → { data: { csrfToken } }` (+ `csrf_token` cookie),
  `GET /auth/session → { data: { user: { id, fullName, email, emailVerified, avatarUrl, roles, permissions, isAdmin, adminAccess, mfaMethod, hasTotpFactor } } }` or 401
  (`SessionUserDto` in `@app/shared`; `<RequireAuth area="admin">` sends admins without `adminAccess` to `/mfa`),
  `POST /auth/logout`, `GET /settings/public → { data: { rewardUnit, currencyCode, currencyMinorUnits, pointsLabel } }` (public).

### Proxy (`src/proxy.ts`)

Cookie presence only: no `sid` cookie on a member/admin route → `/login?next=<path>`; `sid` on
`/login`/`/register` → `next` (sanitized by `safeNextPath`) or `/dashboard`, except when `?expired=1`
(set by `RequireAuth` after a 401, prevents loops on stale cookies). New top-level member routes must
be added to `routes.member` in `src/config/routes.ts` to be protected.

## 5. Amounts and dates

- **Every amount goes through the platform formatter.** Use `<Amount value={x.amountMinor} />` or
  `useFormatAmount()` (`formatAmount`, `formatCurrency`, `unitSymbol`) from
  `src/providers/platform-settings-provider.tsx`. Never divide by 100, never hard-code ₹/$.
- Reward amounts (`kind="reward"`, default) follow the platform reward unit (MONEY or POINTS).
  Prices and sale amounts are always currency: `<Amount kind="currency" … />`.
- Rows that store their own unit/currency (program snapshot, reward, ledger account) pass it:
  `<Amount value={r.amountMinor} format={{ unit: r.unit, currencyCode: r.currencyCode }} />`.
- `tone="auto"` colors negatives red; `signed` prefixes `+`. Until settings load, `<Amount>` renders a
  skeleton rather than guessing the unit.
- Dates: API values are UTC ISO strings. `<DateTime value timeZone={program.timezone} showTimeZone />`
  for absolute times, `<RelativeTime value />` for "5 minutes ago". Pure helpers in
  `src/lib/datetime.ts`. Program dates are displayed and entered in the program's `timezone`.

## 6. Component kit (`src/components/app`)

| Component | Notes |
|---|---|
| `PageHeader` (`page-header.tsx`) | `title`, `description`, `actions`, `meta` (badges), optional `breadcrumbs`. One per page, first child. `SectionHeader` for sections |
| `StatCard` | `label`, `value` (pass `<Amount>`), `hint`, `trend {value, direction, upIsGood, label}`, `icon`, `loading`, `footer` |
| `Amount` | see §5 |
| `StatusBadge` / `ToneBadge` | `<StatusBadge kind="RewardStatus" value={r.status} />` — every enum in `@app/shared` has a label + tone in `src/lib/enum-labels.ts` (typecheck fails if one is missing). Also `enumLabel(kind, v)`, `enumOptions(kind)` for selects/filters |
| `DataTable` (`data-table/`) | TanStack v8; props: `columns`, `data`, `isLoading`, `isFetching`, `error`, `onRetry`, `pagination` (Load more + rows-per-page), `sorting`/`onSortingChange` (server-side, `useTableSort()` → `sortParams`), `enableColumnVisibility`, `toolbar`, `emptyState`, `onRowClick` + `rowLabel`, `renderCard` (mobile card list below `md`), `caption`. Column `meta: { align: 'right', label }`; sortable headers via `DataTableColumnHeader`. Put a real `<Link>` in the primary cell for keyboard/screen-reader users |
| `LoadingState`, `PageSkeleton`, `StatGridSkeleton`, `TableSkeleton`, `FormSkeleton`, `CardSkeleton` (`states.tsx`) | prerender-safe skeletons |
| `EmptyState` | `icon`, `title`, `description`, `action`, `variant` (`card`/`plain`), `size` |
| `ErrorState` (`error-state.tsx`) | `error`, `onRetry`; 401 → sign-in prompt, 403 → `PermissionDenied`, 404 → `NotFoundState`, network → offline, else message + copyable request id |
| `PermissionDenied`, `NotFoundState` | full-section states |
| `ConfirmDialog` | `trigger` or controlled `open`; `title`, `description`, `children` (summary), `variant="destructive"`, `reason` (true or options; validated with `reasonSchema` (10–1000) unless `schema` / `minLength` / `maxLength` match the endpoint, e.g. `financeReasonSchema`; `description` replaces the admin help text), `typedConfirmation="REVERSE"`, `onConfirm({ reason })` returning a promise → pending spinner, closes on success, inline error on failure |
| Form kit (`form/`) | `FormTextField`, `FormTextarea` (`showCount`), `FormSelect` (`options`), `FormSwitch`, `FormDateTimeField` (`timeZone`, value = UTC ISO), `FormAmountField` (value = minor-units string via `decimalToMinor`; `kind`, `currencyCode`, `unit`), `useUnsavedChangesWarning(form)`, `applyApiFieldErrors(error, form)` |
| `CopyButton` | `value`, `label`, optional visible children |
| `DateTime`, `RelativeTime` | see §5 |
| `UserAvatar` | `name`, `src`, `size` |
| `RouteError`, `ComingSoon`, `AuthComingSoon`, `AuthHeading` | boundaries/stubs; auth pages start with `<AuthHeading>` |
| Shell (`shell/`) | `AppShell`, `AppSidebar`, `AppTopbar`, `AppBreadcrumbs`, `CommandMenu` (⌘K/Ctrl+K), `AccountMenu`, `ThemeToggle`, `BrandMark`; `useBreadcrumbLabel(label)` replaces an id segment in the breadcrumbs with a name |

Form example:

```tsx
const schema = z.object({ name: z.string().trim().min(2), priceMinor: positiveMinorAmountSchema });
const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
  resolver: zodResolver(schema),
  defaultValues: { name: '', priceMinor: '' },
});
useUnsavedChangesWarning(form);
<form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} noValidate>
  <FieldGroup>
    <FormTextField control={form.control} name="name" label="Name" required />
    <FormAmountField control={form.control} name="priceMinor" label="Price" currencyCode={program.currencyCode} required />
    <Button type="submit" disabled={mutation.isPending}>Save</Button>
  </FieldGroup>
</form>
```

Cross-feature stubs (slices replace internals, **keep names and props**):
`features/rewards/components/earnings-summary.tsx` (`{ variant: 'card' | 'compact' }`),
`features/referrals/components/referral-link-card.tsx` (`{ compact?: boolean }`),
`features/notifications/components/notification-bell.tsx` (rendered by the top bar).

## 7. How a slice adds a page or feature

1. Types/schemas: request schemas + response DTO types go in `packages/shared/src/contracts/<module>.ts`
   (rebuild shared: `corepack pnpm --filter @app/shared build`).
2. Keys: add `queryKeys.<feature>` in `src/lib/query-keys.ts`.
3. Data hooks: `src/features/<feature>/api.ts` (queries/mutations with `api.*`).
4. UI: `src/features/<feature>/components/*.tsx` built from `src/components/app` + `src/components/ui`.
5. Route: overwrite the stub `src/app/(member)/<route>/page.tsx` or `src/app/admin/<route>/page.tsx`
   (keep `export const metadata = { title }`; keep `<RequirePermission>` on admin pages). Nested routes
   (`/admin/programs/[id]`, `/admin/programs/new`) go under the same folder; add a breadcrumb label
   to `ROUTE_LABELS` (`"/admin/programs/[id]": "Program"`) and call `useBreadcrumbLabel(program.name)`.
6. New top-level routes: add to `routes` (`src/config/routes.ts`) and to `memberNav`/`adminNav`
   (`src/config/navigation.ts`) with an icon and permission.
7. New shadcn component: `npx shadcn@4.21.4 add <name> -y` (never hand-edit `components/ui`).
8. Verify: `corepack pnpm --filter @app/web typecheck` (runs `next typegen` first), `… lint`, `… build`.

Copy & compliance (docs/business-rules.md §0): rewards come only from qualifying sales of approved
offerings; never show projected/guaranteed income, never imply that sign-ups, referrals or enrollment
earn rewards; option prices are purchases, not investments; no payout UI.

## 8. Accessibility checklist

- Landmarks: root skip link → `#main-content` (each layout renders one `<main id="main-content">`),
  `<header>` top bar, `<nav aria-label>` sidebar, one `<h1>` per page (PageHeader).
- Icon-only buttons need `aria-label`; decorative icons `aria-hidden`.
- Use shadcn controls (focus rings built in); plain links get a 2 px ring from `globals.css`.
- Form fields: use the form kit (labels, `aria-invalid`, `aria-describedby` for help + errors).
- Status never by color alone (labels/icons). Respect reduced motion (global CSS).
- Tables: `caption` prop for context, `aria-sort` set automatically, mobile card fallback.
