# How to Use the App — Admin Panel & Customer Guide

A page-by-page guide to every feature of the Referral Rewards Platform: first the **Admin panel**
(for the business), then the **member area** (for customers). For installing and running the
software, see the [README](../README.md) and [deployment guide](deployment.md).

**Contents**

1. [Overview](#1-overview)
2. [Signing in](#2-signing-in)
3. [Admin panel tour](#3-admin-panel-tour)
4. [First-time setup checklist (Super Admin)](#4-first-time-setup-checklist-super-admin)
5. [Admin pages, one by one](#5-admin-pages-one-by-one)
   - [5.1 Overview](#51-overview) · [5.2 Settings](#52-settings) · [5.3 Offerings](#53-offerings) ·
     [5.4 Programs](#54-programs) · [5.5 Reward policies](#55-reward-policies) ·
     [5.6 Enrollments](#56-enrollments) · [5.7 Members](#57-members) · [5.8 Flags](#58-flags) ·
     [5.9 Events (sales)](#59-events-sales) · [5.10 Rewards](#510-rewards) · [5.11 Ledger](#511-ledger) ·
     [5.12 Reconciliation](#512-reconciliation) · [5.13 Audit log](#513-audit-log) ·
     [5.14 Integrations](#514-integrations)
6. [Customer guide (member area)](#6-customer-guide-member-area)
7. [How a reward happens, end to end](#7-how-a-reward-happens-end-to-end)
8. [Troubleshooting & FAQ](#8-troubleshooting--faq)
9. [Quick reference](#9-quick-reference)

---

## 1. Overview

The app runs referral programs for a **real product or service**. Customers (members) share a
personal link and build a **team**: the people who joined through them, the people who joined
through those people, and so on. When a **sale** of your product is credited to a member, the app
calculates **rewards** for the people above that member, using the **reward policy** you set up.
A finance reviewer approves the rewards and they are added to each member's **earnings**.

### The four roles

| Role | Who it is for | Main job |
|---|---|---|
| **Super Admin** | Business owner / operator | Sets up the platform, products, programs, reward rules and roles; can do everything |
| **Program Admin** | Staff running specific programs | Plans, reward policies, enrollments and recording sales for the programs assigned to them |
| **Finance Reviewer** | Accounts / finance staff | Approves, rejects and reverses rewards; ledger, reconciliation, exports |
| **Member (customer)** | Your customers and partners | Joins programs, shares their link, follows their team and earnings |

One person can have several roles; an admin uses the same account for the member area.

### Rules the app always enforces

These are built into the database and cannot be switched off by any setting:

- Rewards come **only from sales of an approved product or service** — never from someone joining,
  never from a member's own plan payment, never from a recruit's plan payment.
- Total rewards for one sale can never be more than **50 %** of the sale amount.
- Rewards from a **manually recorded sale** always need a **second person** to approve them, and
  nobody can approve, reject or reverse **their own** reward.
- The app **records** what each member has earned; it does **not** send money. Payouts happen
  outside the software.

Rewards are shown either as **money** in the currency you choose or as **points** — chosen once
for the whole platform in [Settings](#52-settings).

---

## 2. Signing in

### Customers (members)

1. Open the site and click **Create account** — or open a friend's referral link
   (`…/register?ref=CODE`), which shows **"Invited by …"** and links you to them.
2. Enter your **full name**, **email** and a **password** (at least 10 characters, with a letter and
   a number).
3. Check your email for a **6-digit code**. Enter it together with the **same password**. Your account
   is created at this step and you are signed in.
4. Next time, click **Sign in** and use your email and password.

> Each new code cancels the previous one, and codes expire after 10 minutes — always use the code
> from the **newest** email. Forgot your password? Use **Forgot password** on the sign-in page.

### Admins

Admins (Super Admin, Program Admin, Finance Reviewer) also need an **authenticator app** on their
phone — Google Authenticator, Microsoft Authenticator or Authy.

1. Sign in with email and password.
2. **First time only:** enter the code that was **emailed** to you, then **scan the QR code** with
   your authenticator app and type the 6-digit code it shows.
3. **Every time after that:** email + password, then the current 6-digit code from the app.

You land in the **Admin panel** (`/admin`). Admin access lasts up to **12 hours**; after that you
confirm with the app again.

> The first Super Admin is created when the platform is installed. Everyone else gets admin roles
> from a Super Admin ([5.7 Members](#57-members)).

---

## 3. Admin panel tour

The sidebar has five groups. Each admin only sees the pages their role allows (and the server
blocks anything else, even if someone types the address).

| Sidebar group | Pages | Super Admin | Program Admin | Finance Reviewer |
|---|---|:---:|:---:|:---:|
| Overview | Overview | ✓ | ✓ | ✓ |
| Catalog | Offerings | ✓ | | |
| | Programs | ✓ | ✓ (assigned) | ✓ (view) |
| | Enrollments | ✓ | ✓ (assigned) | |
| Members | Members | ✓ | ✓ (their programs' members) | ✓ |
| | Flags | ✓ | | |
| Rewards & finance | Events (sales) | ✓ | ✓ (record) | ✓ (reverse) |
| | Rewards | ✓ | ✓ (view) | ✓ |
| | Ledger | ✓ | | ✓ |
| | Reconciliation | ✓ | | ✓ |
| System | Audit log | ✓ | | ✓ |
| | Settings | ✓ | | |
| | Integrations | ✓ | | |

**Finding your way**

- The top bar shows **breadcrumbs** (e.g. *Programs › Wellness Partners › Policies*), the
  **notifications bell** and your **account menu** (profile, light/dark theme, sign out).
- Press **Ctrl + K** (⌘ K on a Mac) to open the command menu and jump to any page by name.
- Lists have filters and search; the filters are kept in the page address, so a filtered view can be
  bookmarked or shared.
- On a phone the sidebar becomes a menu button and tables become cards.
- Important actions ask for confirmation; actions that touch money or people ask for a **reason**,
  which is stored in the [audit log](#513-audit-log).

---

## 4. First-time setup checklist (Super Admin)

Do these once, in this order:

1. **[Settings](#52-settings)** — choose *Money* or *Points* and the platform currency.
2. **[Offerings](#53-offerings)** — add your product or service and **Approve** it.
3. **[Programs → New program](#54-programs)** — create the program and add its plans (options).
4. **[Program → Policies](#55-reward-policies)** — create the reward policy, run a **dry run**,
   **Publish** it.
5. **[Program → Overview → Publish](#54-programs)** — the program becomes Active (or Scheduled).
6. **[Members → Roles](#57-members)** — give your staff their admin roles; assign Program Admins to
   programs on the program's **Admins** tab.
7. *(Optional)* **[Integrations](#514-integrations)** — create an API key so your shop sends sales
   automatically.

Then share the program with customers: they sign up, enroll, and share their own referral links.

---

## 5. Admin pages, one by one

### 5.1 Overview

The admin home page: the state of the platform at a glance, with links straight into the queues.

| Card / chart | What it tells you | What to do |
|---|---|---|
| **Registrations** | Members total, verified, suspended | — |
| **Active programs** | Programs currently running | Open Programs |
| **Pending enrollments** | Paid plans waiting for activation | Open Enrollments |
| **Qualifying sales** | Sales in the last 30 days (count and value) | Open Events |
| **Pending reward approvals** | Rewards waiting for a reviewer | Open Rewards |
| **Posted rewards** | Rewards added to members' earnings | Open Ledger |
| **Open flags** | Suspicious-activity flags to review | Open Flags |
| **Reconciliation exceptions** | Anything where rewards, ledger and sales disagree (should be 0) | Open Reconciliation |
| **Charts** | Daily registrations, sales and rewards for 30 days (switch **Display as** chart or table) | — |
| **Recent admin actions** | The last 10 audit entries | Open the Audit log |

A Program Admin sees the numbers for their own programs only.

### 5.2 Settings

*Who:* Super Admin. *Where:* System → Settings.

| Setting | What it does |
|---|---|
| **Reward unit** | **Money** (rewards are currency amounts) or **Points** (non-cash points) |
| **Platform currency** | Used for plan prices and sale amounts everywhere (e.g. INR ₹) |
| **Points label** | What points are called in the app (e.g. "Points", "Coins") |
| **Default points per currency unit** | How many points one unit of sale value is worth (e.g. 1 point per ₹1) |
| **Default reward budget** | Starting budget (% of each sale) for new reward policies; at most 50 % |
| **Payouts** | Always shown as off — the app never sends money |

The preview shows how *a plan price*, *a sale* and *a reward* will look. Enter a **reason for the
change** and confirm.

Good to know:
- Each program **keeps the unit and currency it was created with**. Changing the setting affects new
  programs and the general display.
- The currency can't be changed while live programs use a different one ("Currency changes are
  limited").

### 5.3 Offerings

*Who:* Super Admin. *Where:* Catalog → Offerings.

An **offering** is the product or service your programs sell. Rewards can only come from sales of an
approved offering.

1. Click **New offering** → name, description, **kind** (Product or Service), **SKU** (optional).
2. It is created as **Not approved** (inactive).
3. Click **Approve** to make it available to programs. **Deactivate** stops it being used for new
   programs and new sales.

### 5.4 Programs

*Who:* Super Admin, Program Admin (assigned programs). *Where:* Catalog → Programs.

**Create a program** — **New program**:

| Section | Fields |
|---|---|
| **Basics** | Name, **code** (short web id, e.g. `spring-2027`), description, offering |
| **Dates** | Program starts / ends, **enrollment opens / closes**, time zone, **late sale grace period** (days after the end when late-recorded sales are still accepted) |
| **Configuration** | **Maximum reward depth** — how many levels above a seller can ever be rewarded (1–10) |
| **Eligibility** | Minimum account age, whether members must have joined through a referral |
| **Terms** | The terms members accept when they enroll |

The program is saved as a **Draft**. Open it to see its tabs:

- **Overview** — status, key dates, the status timeline, and the lifecycle buttons.
- **Options** — the **plans** members choose: name, **price**, **billing** (one-time, monthly,
  quarterly, half-yearly, yearly), **duration** in days, renewal. Use **Add an option**. A plan that
  members already use can't change its price or duration — add a new plan instead and deactivate
  the old one. *Plan prices pay for the product/service; they never generate rewards.*
- **Policies** — the reward rules ([5.5](#55-reward-policies)).
- **Enrollments** — who has joined this program.
- **Admins** — **Manage program admins**: which Program Admins run it.
- **History** — everything that changed, with who and why.

**Lifecycle buttons**

| Button | When | Effect |
|---|---|---|
| **Publish** | Draft, once the checklist is green (an active plan, an approved offering, a published policy) | Active now, or **Scheduled** if the start date is in the future (it switches to Active automatically) |
| **Cancel program** | Scheduled, before it starts | Archived without ever running |
| **Pause** / **Resume** | Active / Paused | Paused: no new enrollments, and sales dated in the pause are not rewarded |
| **Complete** | Active or Paused | Ends the program (also happens automatically at the end date) |
| **Archive** | Completed | Moves it out of the way |
| **Edit program** / **Edit dates** | Any time | Drafts can change everything; published programs can change name, description, terms and later dates |

### 5.5 Reward policies

*Who:* Super Admin, Program Admin. *Where:* Programs → (program) → Policies.

A policy says **who gets what** from each sale. Policies are versioned: a published version never
changes; to change the rules you publish a new version.

**Create one** — **New draft**, then fill in:

| Field | Meaning |
|---|---|
| **Applies to** | Which sale types are rewarded: product sale, service completed, subscription renewal |
| **Levels** | One row per level. **Level 1** = the seller's direct sponsor, **level 2** = the sponsor's sponsor, … For each: a **fixed amount** or a **percentage** of the sale, optionally **capped** |
| **Budget** | Total rewards as a % of each sale — the **hard cap is 50 %** |
| **Maximum depth** | How many levels this policy pays (up to the program's maximum) |
| **Minimum sale amount** / **Maximum total per sale** | Optional limits |
| **Ineligible upline members** | **Forfeit** — that level gets nothing · **Compress** — the next eligible person moves up |
| **Approval** | Whether rewards need a reviewer. Only a Super Admin can publish a policy without approval, and manually recorded sales always need approval anyway |
| **Points rate** | For Points programs: points per unit of sale value |
| **Internal notes** | For your team |

The editor checks the policy as you type: percentages that exceed the budget are an error; fixed
amounts that a small sale can't fund show a warning with the smallest sale that funds every level.

**Dry run (preview)** — before publishing, enter a **sale amount** and tick which levels are
eligible, or pick a **real member** to use their actual team. You see each level's decision
(Awarded, Forfeited, No upline member, Budget exhausted…), the amount, and how much of the budget is
used. Nothing is saved.

**Publish** — choose **Effective from** (now or a future date) and confirm. If another version is
in effect, it ends exactly when the new one starts.

**Retire** — ends a version (with a reason). Retiring a version that hasn't started yet withdraws it.

**Members can see** the current rates on the program page — transparency, without internal details.

### 5.6 Enrollments

*Who:* Super Admin, Program Admin. *Where:* Catalog → Enrollments (or a program's Enrollments tab).

- **Free plans** become active the moment a member enrolls.
- **Paid plans** wait here as **Awaiting activation**. When the member has paid you (outside the
  app), click **Record payment and activate**: enter the **payment reference** and **amount
  received** (at least the plan price). Coverage starts now — or, for a **renewal**, when the
  current period ends, so there's no gap ("Renewal queued").
- **Reject** a request or **Cancel** an enrollment with a reason. The member is notified.
- Enrollments **expire** automatically at the end of their period.

> A payment reference can never be reused as a sale id — plan payments are never rewarded.

### 5.7 Members

*Who:* Super Admin; Program Admins and Finance see members (Program Admins only those in their
programs). *Where:* Members → Members.

- Search by name or email, filter by **status**, **role** and **program**.
- Open a member to see: profile, email verification, authenticator status, last sign-in, referral
  code, sponsor, team counts, enrollments, reward totals and open flags.

**Actions on a member** (each needs a reason and is audited):

| Action | Who | Notes |
|---|---|---|
| **Suspend** / **Reactivate** | Super Admin (and admins with member rights for non-admins) | Suspending signs the member out everywhere; they can't sign in |
| **Roles** | Super Admin | Give or remove Super Admin, Program Admin, Finance Reviewer. Nobody can change their own roles; the last Super Admin can't be removed. The member is signed out so the change applies |
| **Send password reset** | Super Admin | Emails a reset code — the way to help an **admin** who forgot their password |
| **Team** tab | Admins | The member's team tree and upline |
| **Correct sponsor** (Team tab) | Super Admin | Moves the member, with their whole team, under a new sponsor. A preview shows how many people move; a reason is required. Past rewards don't change — only future sales use the new structure. Not allowed while the moved team has unprocessed sales |

### 5.8 Flags

*Who:* Super Admin. *Where:* Members → Flags.

Flags mark **suspicious activity** for review; they never change money by themselves.

- **Automatic flags**: *several sign-ups from the same internet address under one sponsor within
  24 hours*, and *a sale that matches a plan payment in the seller's team* ("Plan payment lookalike").
- **Raise a flag** manually on any member, with details.
- Review it, then **Resolve flag** or **Dismiss flag** with a resolution note. You can't resolve a
  flag about yourself.

### 5.9 Events (sales)

*Who:* Super Admin and Program Admins record; Finance reverses. *Where:* Rewards & finance → Events.

Every sale that can earn rewards is a **sale event**.

**Record sale**:

1. Choose the **program** and the sale type.
2. **Order / invoice id** from your system (stops duplicates) and the **end-customer reference**.
3. Choose the **member credited** with the sale (search by name or email), the **amount** and when it
   **occurred**.
4. Save. Rewards are calculated immediately and the outcome is shown.

| What you might see | Meaning |
|---|---|
| **Already recorded** | The same order id was recorded before — nothing new is created |
| **Processed** | Rewards were created (or nobody was eligible) |
| **Rejected** + reason | E.g. the sale date is outside the program, no policy covered that date, the member isn't active, or it looks like a plan payment. Fix the cause and use **Re-record** |
| **Processing** | Normally takes a moment; a sale stuck here can be rejected with **Reject stuck sale** and re-recorded |

Open a sale to see the **calculation**: which upline members were considered, who was eligible,
each level's amount and the budget used.

**Reverse sale** (refund or chargeback; *Finance / Super Admin*): pending rewards from the sale are
rejected and posted ones are taken back, in one step, with a reason.

Rules that protect you: you **can't record a sale for yourself or your own team**, and a sale that
matches a recent plan payment is refused or held for review with a warning.

### 5.10 Rewards

*Who:* Finance Reviewer and Super Admin decide; Program Admins can view. *Where:* Rewards & finance → Rewards.

Tabs: **Pending approval** (oldest first) · Approved · Posted · Rejected · Reversed · All — each
with a count. Filter by program, member, level or date.

Open a reward to see **Overview** (member, amount, sale), **Calculation** (each level's decision
and the budget bar), **Ledger** (its postings) and **Audit**.

| Action | Effect |
|---|---|
| **Approve and post** | The reward is approved **and posted** to the member's earnings at once |
| **Reject** (reason) | The reward is cancelled; it never counts |
| **Bulk actions → Approve all** | Select several pending rewards; each is processed separately and any failures are listed |
| **Reverse** (reason, type REVERSE to confirm) | Takes a posted reward back out of the member's earnings |
| **Reverse whole sale** | Reverses every reward of that sale (see 5.9) |

You can't approve or reject **your own** reward, or rewards from a sale **you recorded** — the
button explains why and another reviewer must do it.

**"Plan payment?" warning** — the sale amount matches a recent plan payment by someone in the
seller's team. That can be a disguised recruitment payment; check the sale before approving.

**Export CSV** downloads the current list.

### 5.11 Ledger

*Who:* Finance Reviewer, Super Admin. *Where:* Rewards & finance → Ledger.

The ledger is the permanent record of every reward added to or taken back from a member — entries
are never edited or deleted, only reversed by new entries.

- **Summary cards** per unit/currency: **Total posted**, **Total reversed**, **Outstanding
  liability** (what members have earned and not yet been paid outside the app).
- **Transactions** tab: every posting and reversal, with the reward, member, who posted it, and the
  entries (debit/credit). **Export CSV**.
- **Accounts** tab: the balance of each member's earnings account.

### 5.12 Reconciliation

*Who:* Finance Reviewer, Super Admin. *Where:* Rewards & finance → Reconciliation.

Automatic health checks that rewards, ledger and sales agree, e.g. *every posted reward has exactly
one ledger posting*, *member balances equal posted minus reversed rewards*, *no sale is stuck in
processing*, plus the **compliance review queue** (sales that look like plan payments).

Each check shows **Passed**, **Warning** or **Critical**, a description and how to fix it; exceptions
link to the record. On a healthy system there are **No exceptions**.

### 5.13 Audit log

*Who:* Super Admin, Finance Reviewer. *Where:* System → Audit log.

Every important action: who did it (and their roles at the time), what changed (**Before / After**),
the **reason**, the time and the request id. Filter by person, action, resource, program and date;
open an entry for a readable difference. Personal data such as emails is shown masked.

### 5.14 Integrations

*Who:* Super Admin. *Where:* System → Integrations.

Lets your online shop or billing system send sales automatically instead of recording them by hand.

1. **New API client** → a name and the **program** it may send sales for.
2. Copy the **API key** — *this key will never be shown again*.
3. Give it to your developer; **How to send sales** shows an example request.
4. **Revoke** a key at any time; **Last used** shows activity.

Sales from a shop follow the same rules as manual ones (duplicate protection, plan-payment checks).

---

## 6. Customer guide (member area)

The member area has four sidebar groups: **Overview** (Dashboard), **Programs & rewards**
(Programs, Rewards), **Network** (Referrals, Team, Sponsor) and **Account** (Profile,
Notifications).

### 6.1 Dashboard

Your home page: verification status, **Your enrollments**, **Your referral link** (copy / share),
**Key figures** (direct referrals, team size), your **Rewards** summary with **Earned to date**,
**Recent activity** and **Announcements**.

### 6.2 Programs — join a program

1. **Programs** lists the programs you can join, with dates and plans. Click one to see its
   **plans** (price, billing, duration), its **terms** and the current **reward rates**.
2. Click **Enroll** on a plan, read and accept the terms.
   - **Free plan** → you're enrolled immediately.
   - **Paid plan** → status *Awaiting activation* until the business confirms your payment.
3. **My enrollments** tab: see each enrollment's status and coverage dates, or **Cancel** one.

> To earn rewards you need an **active enrollment** in the program at the time of the sale. Paying
> for your own plan never earns a reward, for you or anyone above you.

### 6.3 Referrals — share your link

- **Your referral link** and **code**: **Copy**, or **Share referral link** (uses your phone's share
  menu). Anyone who signs up through it joins your team, with you as their sponsor.
- **Direct referrals**: the people who joined through you, with their join date and whether they're
  active and enrolled. Filter by account status.

### 6.4 Team — your team tree

An interactive tree with **you at the top** and each level of your team below.

- **Zoom in / Zoom out**, drag to move, **Fit tree to view**.
- Click a member to open the side panel (name, level, join date, status, enrollment, direct
  referrals) and to see the **path** from you to them.
- Expand a branch to load the next level; very large branches show *Load more*.
- **Search** your team by name.
- **Members by level** shows how many people are at each depth.
- **List view** shows the same team as an indented list (the default on phones).

You see your team down to 10 levels, with display names only (first name + initial).

### 6.5 Sponsor — who referred you

**My sponsor** shows who referred you and when, and **Your upline** shows the people above them.
"You joined without a sponsor" means you signed up without a referral link.

### 6.6 Rewards — your earnings

- Summary cards: **Earned to date**, **Pending** and **Reversed**, per currency or points.
- The list of your rewards: program, level, amount, status, date. Open one for its timeline.
- **Export CSV** to download your history.

| Status | Meaning | Counts in "Earned to date"? |
|---|---|---|
| **Pending approval** | Waiting for the finance team | Not yet |
| **Approved** | Approved, being posted | Not yet |
| **Posted** | Added to your earnings | **Yes** |
| **Rejected** | Not approved (reason shown) | No |
| **Reversed** | Taken back, e.g. the sale was refunded | Removed again |

A reward shows the program and level, never the buyer's details — and you never see anyone else's
rewards.

### 6.7 Profile & security

- **Personal details**: name, phone, profile picture link.
- **Earned to date** at the top.
- **Security**: change your **password** (current password needed), change your **email** (a code is
  sent to the new address), see your **sessions** (devices signed in) and sign them out.
  Admins also see their **authenticator** status here.
- **Activity**: your recent account activity.

### 6.8 Notifications

The bell in the top bar shows unread notifications (rewards, enrollments, account changes,
announcements). **Notifications** lists them all; mark one or all as read.

---

## 7. How a reward happens, end to end

```
 Member B buys the product
        │
        ▼
 Sale recorded (by an admin or the shop), credited to B
        │
        ▼
 Reward engine applies the program's policy for that date
   • B's sponsor (A) = level 1, A's sponsor = level 2, …
   • only people with an active enrollment at the sale date
   • never more than the budget (max 50 % of the sale)
        │
        ▼
 Rewards created as "Pending approval"   ──►  Finance Reviewer: Approve / Reject
        │                                              │
        ▼                                              ▼
 "Posted": added to A's Earned to date          "Rejected": never counts
        │
        ▼  (if the sale is refunded)
 "Reverse sale" takes the rewards back out of everyone's earnings
```

**Example** — a policy pays 8 % at level 1 and 5 % at level 2 (budget 20 %). Neha's sponsor is
Priya, and Priya's sponsor is Rahul. A ₹4,500 sale credited to Neha creates **₹360 for Priya**
(level 1) and **₹225 for Rahul** (level 2), both pending until approved.

---

## 8. Troubleshooting & FAQ

| Problem | What to do |
|---|---|
| **The email code never arrives** | Check spam. On test installations emails go to a test inbox instead of real mailboxes (see [Quick reference](#9-quick-reference)). |
| **"Invalid code" when verifying** | Use the code from the **newest** email (each new code cancels the last) together with the **same password** you chose. Codes expire after 10 minutes — click **Resend code**. |
| **Authenticator code rejected** | Turn on automatic date & time on your phone (Google Authenticator: Settings → Time correction → Sync now). Each code works once; wait for the next one. After 10 wrong codes the authenticator is locked for a while. |
| **Changing phones (admins)** | While you still have the old phone: **Profile → Security → Replace authenticator app** (needs a current code), then set up the new phone at your next sign-in. |
| **Lost the authenticator phone** | There's no in-app recovery yet: the platform operator removes the old authenticator (see [security.md](security.md)), then you set up a new one at your next sign-in. |
| **Admin forgot their password** | Self-service reset is off for admin accounts; a Super Admin uses **Send password reset** on the member page. |
| **"Too many attempts, try again in …"** | Wait for the time shown — limits protect accounts from guessing. |
| **"Admin access required"** | Sign out and in again and complete the authenticator step. |
| **Can't approve a reward** | It's your own reward or a sale you recorded — another reviewer must approve it. |
| **A sale was rejected** | Open it in **Events** to see why, fix the cause, then **Re-record**. |
| **A customer's reward is still pending** | A Finance Reviewer must approve it in **Rewards**. |
| **A customer got no reward for their team's sale** | They had no active enrollment on the sale date, they're above the policy's depth, or the budget was used up by lower levels — the sale's **Calculation** shows which. |
| **Someone joined under the wrong sponsor** | A Super Admin uses **Correct sponsor** on the member's Team tab. |

---

## 9. Quick reference

### Where to find each feature

| I want to… | Go to |
|---|---|
| Choose money or points, change currency | Admin → Settings |
| Add a product or service | Admin → Offerings → New offering → Approve |
| Create a program and its plans | Admin → Programs → New program → Options |
| Set reward percentages / amounts | Program → Policies → New draft → Dry run → Publish |
| Activate a paid enrollment | Admin → Enrollments → Record payment and activate |
| Record a sale | Admin → Events → Record sale |
| Approve rewards | Admin → Rewards → Pending approval → Approve and post |
| Refund a sale | Admin → Events (or Rewards) → Reverse sale |
| Give someone an admin role | Admin → Members → (person) → Roles |
| Fix a wrong sponsor | Admin → Members → (person) → Team → Correct sponsor |
| See all changes | Admin → Audit log |
| Connect an online shop | Admin → Integrations → New API client |
| Share my link (customer) | Referrals → Copy / Share |
| See my team (customer) | Team |
| See my earnings (customer) | Rewards, or Profile → Earned to date |

### Test and local installations

| What | Address |
|---|---|
| App (local development) | `http://localhost:3000` (API `:4000`, API docs `:4000/api/docs`) |
| Test inbox for local development | `http://localhost:8025` |
| App (Docker production-style stack) | `http://localhost:8080` |
| Test inbox for the Docker stack | `http://localhost:8026` |

Demo data (`SEED_DEMO_DATA=true`) creates a sample program "Wellness Partners" and a team —
`anita@example.com`, `rahul@example.com`, `priya@example.com` … (password `Demo@12345678`), a Finance
Reviewer `finance@example.com` and a Program Admin `programs@example.com`. Change every password
before real use.
