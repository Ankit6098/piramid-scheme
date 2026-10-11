import {
  ArrowRight,
  BadgeCheck,
  ReceiptText,
  Scale,
  ShieldCheck,
  ShoppingBag,
  Share2,
} from 'lucide-react';
import Link from 'next/link';

import { BrandMark } from '@/components/app/shell/brand-mark';
import { ThemeToggle } from '@/components/app/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { routes } from '@/config/routes';
import { siteConfig } from '@/config/site';

const steps = [
  {
    icon: ShoppingBag,
    title: 'Join a program',
    body: 'Each program is tied to an approved product or service, with its reward policy published up front.',
  },
  {
    icon: Share2,
    title: 'Recommend it',
    body: 'Share your personal link with people who may genuinely want the offering. Sign-ups are attributed to you — nothing more.',
  },
  {
    icon: ReceiptText,
    title: 'Rewards follow real sales',
    body: 'When a qualifying sale or completed service is recorded, rewards are calculated under the published policy and reviewed before posting.',
  },
] as const;

const principles = [
  {
    icon: ShoppingBag,
    title: 'Funded by sales only',
    body: 'Registering, referring someone or enrolling in a program never creates a reward on its own.',
  },
  {
    icon: Scale,
    title: 'Capped and published',
    body: 'Every program publishes its reward rules, and total rewards for a sale are capped at a fixed share of that sale.',
  },
  {
    icon: BadgeCheck,
    title: 'Reviewed and recorded',
    body: 'Rewards are approved by a reviewer and recorded in an auditable double-entry ledger. Refunds reverse them.',
  },
  {
    icon: ShieldCheck,
    title: 'No promises about earnings',
    body: 'We never project or guarantee income. You see only what has actually been recorded for your account.',
  },
] as const;

export default function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href={routes.home} className="min-w-0 rounded-md" aria-label={`${siteConfig.name} home`}>
            <BrandMark />
          </Link>
          <nav aria-label="Account" className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            {/* Phones: the hero has its own "Sign in" link; keep the header to one call to action. */}
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link href={routes.auth.login}>Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href={routes.auth.register}>Create account</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        <section className="border-b bg-card">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-[1.2fr_1fr] lg:items-center">
            <div className="space-y-6">
              <p className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
                <span className="size-1.5 rounded-full bg-primary" aria-hidden />
                Referral rewards for approved products and services
              </p>
              <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                Recommend what you trust. Rewards come only from real sales.
              </h1>
              <p className="max-w-xl text-lg text-pretty text-muted-foreground">
                {siteConfig.name} lets you share offerings you believe in. When someone you referred
                buys an approved product or completes a service, a reward may be credited under the
                program&apos;s published rules — sign-ups alone never earn anything.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button asChild size="lg" className="h-10 px-4">
                  <Link href={routes.auth.register}>
                    Create an account
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline" className="h-10 px-4">
                  <Link href={routes.auth.login}>Sign in</Link>
                </Button>
              </div>
            </div>

            <Card className="gap-0 py-0" aria-label="How a reward is created">
              <div className="border-b px-5 py-4">
                <p className="text-sm font-medium">How a reward is created</p>
                <p className="text-sm text-muted-foreground">
                  Every reward traces back to a recorded sale.
                </p>
              </div>
              <ol className="divide-y">
                {[
                  ['Sale recorded', 'An approved offering is sold or a service is completed.'],
                  [
                    'Policy applied',
                    "The program's published, capped policy calculates any reward.",
                  ],
                  ['Reviewed', 'A finance reviewer approves it, or it is rejected.'],
                  ['Posted to the ledger', 'Approved rewards are recorded; refunds reverse them.'],
                ].map(([title, body], index) => (
                  <li key={title} className="flex gap-3 px-5 py-3.5">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums">
                      {index + 1}
                    </span>
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">{title}</span>
                      <span className="block text-sm text-muted-foreground">{body}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </section>

        <section
          aria-labelledby="how-heading"
          className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6"
        >
          <h2 id="how-heading" className="font-heading text-2xl font-semibold tracking-tight">
            How it works
          </h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {steps.map((step) => (
              <Card key={step.title} className="gap-3 px-5">
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground">
                  <step.icon className="size-4" aria-hidden />
                </span>
                <h3 className="font-medium">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section aria-labelledby="principles-heading" className="border-t bg-card">
          <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
            <h2
              id="principles-heading"
              className="font-heading text-2xl font-semibold tracking-tight"
            >
              Clear rules, built in
            </h2>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              These guardrails are enforced by the platform itself, not just written in the terms.
            </p>
            <dl className="mt-8 grid gap-6 sm:grid-cols-2">
              {principles.map((item) => (
                <div key={item.title} className="flex gap-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <item.icon className="size-4" aria-hidden />
                  </span>
                  <div className="space-y-1">
                    <dt className="font-medium">{item.title}</dt>
                    <dd className="text-sm text-muted-foreground">{item.body}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            Rewards are not guaranteed and depend entirely on qualifying sales. Program plans are
            purchases of a product or service, not investments.
          </p>
          <p className="shrink-0">{siteConfig.name}</p>
        </div>
      </footer>
    </div>
  );
}
