# User Guide — Referral & Rewards Platform

How to use the platform day to day, for every role. For installing and running it, see the
[README](../README.md) and [deployment guide](deployment.md).

---

## 1. What the platform does

You sell a real **product or service**. Members join your **program**, share their personal
**referral link**, and build a **team** (the people who joined through them, and the people who
joined through those people, and so on).

When a **sale** of your product is recorded for a member, the platform calculates **rewards** for
the people above that member in the team, using the **reward policy** you configured. A finance
reviewer approves the rewards, and they are added to each member's **earnings**.

**Rules the platform always enforces** (they cannot be switched off):

- Rewards come **only from sales** of an approved product or service — never from someone joining,
  never from a member's own plan payment, and never from a recruit's plan payment.
- Total rewards for one sale can never exceed **50 %** of the sale amount.
- Rewards from manually recorded sales always need a **second person** to approve them.
- Real-money payouts are **not** performed by the software; it records what each member has earned.

Rewards can be shown as **money** (in the currency you choose) or as **points** — you choose this
once for the whole platform in **Settings**.

---

## 2. Who does what (roles)

| Role | What they can do |
|---|---|
| **Super Admin** | Everything: settings, products, programs, reward policies, roles, approvals, corrections, audit log, integrations |
| **Program Admin** | Run the programs assigned to them: plans, reward policies, enrollments, recording sales |
| **Finance Reviewer** | Approve / reject / reverse rewards, reverse sales, ledger, reconciliation, CSV exports |
| **Member** | Join programs, share their link, see their team, sponsor and rewards |

A person can hold several roles. Admin roles are given by a Super Admin in
**Admin → Members → (person) → Roles**.

---

## 3. Signing in

### Members
1. Open the site and choose **Create account** (or open someone's referral link —
   `…/register?ref=CODE` — which shows "Invited by …").
2. Enter your name, email and a password (at least 10 characters with a letter and a number).
3. Check your email for a **6-digit code** and enter it together with the **same password**.
   Your account is created only at this step.
4. Next time, sign in with your email and password.

> Each new code cancels the previous one. Always use the code from the **newest** email.

### Admins (Super Admin, Program Admin, Finance Reviewer)
Admins use a second factor — an **authenticator app** on their phone (Google Authenticator,
Microsoft Authenticator, Authy…).

1. Sign in with email and password.
2. **First time only:** enter the code sent to your email, then **scan the QR code** with your
   authenticator app and type the 6-digit code it shows.
3. **Every time after that:** email + password, then the current 6-digit code from the app.

You then land on the **Admin** area (`/admin`). An admin session lasts at most 12 hours.

> The very first Super Admin is created when the platform is installed (see README:
> `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD`).

---

## 4. Super Admin — first-time setup

Do these once, in this order.

### 4.1 Choose money or points — *Admin → Settings*
- **Reward unit:** *Money* (rewards are currency amounts) or *Points* (non-cash points).
- **Currency:** used for plan prices and sale amounts everywhere (e.g. INR ₹).
- **Points label** (e.g. "Points") and **points per currency unit** (e.g. 1 point per ₹1) — used
  when rewards are points.
- **Default reward budget %** — the starting budget for new reward policies (max 50 %).
- Enter a reason and confirm. The preview shows how amounts will look.

> Each program keeps the unit and currency it was created with. Changing the setting later affects
> new programs only. The currency cannot be changed while live programs use another currency.

### 4.2 Add your product or service — *Admin → Offerings*
1. **New offering** → name, description, type (Product / Service), SKU (optional).
2. New offerings start **Inactive**. A Super Admin clicks **Approve** to make it usable.

### 4.3 Create a program — *Admin → Programs → New program*
- **Basics:** name, code (web-friendly id), description, the approved offering.
- **Dates:** program start/end, enrollment opens/closes, time zone.
- **Maximum reward depth:** how many levels above a seller can ever be rewarded (1–10).
- **Eligibility:** e.g. minimum account age, whether a sponsor is required.
- **Terms** members must accept.

The program is saved as a **Draft**. Then open it and add **plans** on the **Options** tab:
name, price, billing frequency (one-time, monthly, quarterly, half-yearly, yearly), duration in
days. Plan prices pay for the product/service — they never generate rewards.

### 4.4 Configure the reward policy — *Program → Policies*
1. **New draft**. Set:
   - **Sale types rewarded:** product sale, service completed, subscription renewal.
   - **Levels:** for each level (1 = the seller's direct sponsor, 2 = the sponsor's sponsor, …)
     choose a **fixed amount** or a **percentage** of the sale, optionally with a cap.
   - **Total budget %** of each sale (hard maximum 50 %). If fixed amounts would exceed the budget
     on a small sale, deeper levels are reduced — the editor warns you.
   - **Minimum sale amount**, **maximum total per sale** (optional).
   - **When someone above is not eligible:** *Forfeit* (that level gets nothing) or *Compress*
     (the next eligible person moves up).
   - **Require approval** (recommended; only a Super Admin can publish a policy without it, and
     manually recorded sales always need approval anyway).
2. **Dry run:** enter a sale amount and tick which levels are eligible to preview exactly who would
   get what. You can also dry-run against a real member's team.
3. **Publish** and choose when it takes effect (now or a future date). Published versions can't be
   edited — to change rules, create a new version; publishing it ends the previous one.

### 4.5 Publish the program — *Program → Overview → Publish*
The checklist shows what's missing (an active plan, an approved offering, a published policy).
Publishing makes it **Active** (or **Scheduled** if the start date is in the future). Later you can
**Pause / Resume**, **Complete**, **Archive**, or **Cancel** a program that hasn't started yet.

### 4.6 Give other people admin roles — *Admin → Members*
Open a member → **Roles** → choose roles and give a reason. Program Admins are then assigned to
programs on **Program → Admins**. Role changes sign the person out everywhere.

### 4.7 (Optional) Connect your shop — *Admin → Integrations*
Create an **API client** for a program to let your online shop send sales automatically. The key is
shown **once** — copy it into your shop's settings. Revoke it any time.

---

## 5. Program Admin — day to day

### Enrollments — *Admin → Enrollments*
- **Free plans** activate immediately when a member enrolls.
- **Paid plans** wait here as *Pending*. When the member has paid (offline), click **Activate** and
  enter the **payment reference** and amount. Or **Reject** with a reason.
- Renewals start when the current period ends — no gap in coverage.

### Record a sale — *Admin → Events → Record sale*
1. Choose the program and the sale type.
2. **Order / sale id** from your system (used to stop duplicates) and the **customer reference**.
3. Pick the **member** credited with the sale, the amount and the sale date.
4. Save. The platform calculates rewards immediately and shows the outcome.

Notes:
- Recording the **same order id** again is recognised as a duplicate and creates nothing new.
- You **cannot record sales for yourself or your own team** (a different admin must).
- A sale that looks like a member's or a recruit's **plan payment** is refused or flagged for review.
- A sale stuck in "processing" can be rejected and recorded again.

---

## 6. Finance Reviewer

### Approve rewards — *Admin → Rewards*
- Tabs: **Pending approval**, Approved, Posted, Rejected, Reversed. Pending is oldest first.
- Open a reward to see the sale, the full **calculation** (who was considered and why), and history.
- **Approve** (it is posted to the member's earnings immediately), **Reject** with a reason, or
  select several and **Bulk approve**.
- You can't approve your own reward, or rewards from a sale you recorded — another reviewer must.
- A **"Plan payment?"** warning means the sale amount matches a recent plan payment in the seller's
  team. Check it carefully before approving.

### Reverse
- **Reverse a reward** (e.g. it was a mistake): it is removed from the member's earnings with a
  matching ledger entry.
- **Reverse a sale** (refund / chargeback) from the sale or reward: all its pending rewards are
  rejected and posted ones reversed, in one step.

### Ledger and reconciliation
- **Ledger:** every posting and reversal, balances per member, totals per unit/currency, CSV export.
- **Reconciliation:** automatic checks that rewards, ledger and sales all agree, plus the
  compliance review queue. On a healthy system it shows no exceptions.

---

## 7. Members

| Page | What you see |
|---|---|
| **Dashboard** | Your status, enrollments, referral link, team size, earnings summary, recent activity |
| **Programs** | Programs you can join, their plans and terms; "My enrollments" tab to cancel |
| **Referrals** | Your **referral link** (copy / share) and the people who joined through it |
| **Team** | Your team as an interactive **tree** (you at the top, each level below) — zoom, expand branches, search, or switch to the **list view** |
| **Sponsor** | Who referred you, and the people above them |
| **Rewards** | Your rewards with their status, plus CSV export |
| **Profile** | Your details, **Earned to date**, security (password, email, sessions), activity |
| **Notifications** | Updates about rewards, enrollments and your account |

**Reward statuses:** *Pending approval* → *Approved* → **Posted** (counted in "Earned to date").
*Rejected* rewards never count; *Reversed* rewards are taken back out.

To earn rewards you need an **active enrollment** in the program at the time of the sale. Joining,
referring someone, or paying for your own plan never earns a reward by itself.

You only see other members' display names (first name + initial) — never their email, purchases or
rewards.

---

## 8. How a reward happens (end to end)

```
Member B buys the product  ──►  Admin / shop records the sale (credited to B)
                                   │
                                   ▼
                      Reward engine applies the program's policy:
                      B's sponsor A = level 1, A's sponsor = level 2, …
                      (only eligible people, within the 50% budget)
                                   │
                                   ▼
                      Rewards "Pending approval"  ──►  Finance Reviewer approves
                                   │
                                   ▼
                      "Posted" — added to A's Earned to date (ledger entry)
```

If the sale is refunded, reversing it takes the rewards back out automatically.

---

## 9. Correcting a sponsor (Super Admin)

If someone joined under the wrong person: **Admin → Members → (person) → Team → Correct sponsor**.
Choose the new sponsor, check the preview (how many people move with them), give a reason, confirm.
Their whole team moves with them. Past rewards are not changed; only future sales use the new
structure. It is fully audited.

---

## 10. Troubleshooting

| Problem | What to do |
|---|---|
| **No email code arrives** | Check spam. In test setups, emails are not sent to real inboxes — they're captured in the test mailbox (Mailpit: `http://localhost:8025` for local development, `http://localhost:8026` for the Docker test stack on :8080). |
| **"Invalid code" when verifying** | Use the code from the **newest** email (a new code cancels old ones), together with the **same password** you used when creating the account. Codes expire after 10 minutes. |
| **Authenticator code rejected** | Turn on automatic date & time on your phone (Google Authenticator: Settings → Time correction → Sync now). Each code works once — wait for the next one. After 10 wrong codes the account's authenticator is locked for a while. |
| **Changing phones** | While you still have the old phone: **Profile → Security → reset authenticator** (needs a current code), then set up the new phone at next sign-in. |
| **Lost the authenticator phone** | There is no in-app recovery yet: the platform operator removes the old authenticator following the recovery procedure in [security.md](security.md); you then set up a new one at next sign-in. A Super Admin can also send you a password-reset code from **Admin → Members → (person)**. |
| **"Too many attempts, try again in …"** | Wait for the time shown; limits protect accounts from guessing. |
| **Can't approve a reward** | You're its recipient or you recorded the sale — another reviewer must approve. |
| **A sale was rejected** | Open it in **Admin → Events** to see why (outside program dates, no policy, plan payment, …). Fix the cause and **Re-record** it. |
| **Member's reward stays pending** | A Finance Reviewer needs to approve it in **Admin → Rewards**. |
| **Admin page says "Admin access required"** | Sign out and in again, and complete the authenticator step. |

---

## 11. Quick reference for local/test setups

| What | Address |
|---|---|
| App (local development) | `http://localhost:3000` (API on `:4000`) |
| Test inbox (local development) | `http://localhost:8025` |
| App (Docker production-style stack) | `http://localhost:8080` |
| Test inbox (Docker stack) | `http://localhost:8026` |
| API documentation (development only) | `http://localhost:4000/api/docs` |

Demo data (`SEED_DEMO_DATA=true`) creates a sample program and team: members such as
`anita@example.com`, `rahul@example.com` (password `Demo@12345678`), a Finance Reviewer
`finance@example.com` and a Program Admin `programs@example.com`. Change all passwords before any
real use.
