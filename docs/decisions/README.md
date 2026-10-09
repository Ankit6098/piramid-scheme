# Architecture Decision Records

Short records of decisions that shape the codebase. Each states the context, the decision, and its
consequences. Records are immutable once accepted: to change a decision, add a new ADR that
supersedes the old one, and set the old one's status to "Superseded by ADR-NNNN".

| ADR | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith-nestjs-nextjs.md) | Modular monolith: NestJS API + Next.js web in one pnpm workspace | Accepted |
| [0002](0002-prisma-with-raw-sql-invariants.md) | Prisma for data access, raw SQL for invariants | Accepted |
| [0003](0003-referral-tree-closure-table.md) | Referral tree as adjacency list + closure table | Accepted |
| [0004](0004-integer-minor-units-reward-unit.md) | Integer minor units, and a MONEY/POINTS reward unit | Accepted |
| [0005](0005-cookie-sessions-csrf-email-otp-mfa.md) | Cookie sessions, CSRF double-submit, email-OTP admin MFA | Accepted |
| [0006](0006-transactional-outbox-bullmq.md) | Transactional outbox + BullMQ worker | Accepted |
| [0007](0007-sale-funded-rewards-budget-cap.md) | Sale-funded rewards and the 50 % budget cap | Accepted |
| [0008](0008-nginx-single-origin-reverse-proxy.md) | nginx single-origin reverse proxy | Accepted |

Template: copy any record, keep the headings (Status, Date, Context, Decision, Consequences,
Alternatives considered).
