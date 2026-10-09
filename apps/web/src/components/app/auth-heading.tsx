import type { ReactNode } from 'react';

/** Title block for pages rendered inside the (auth) card layout. */
export function AuthHeading({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-6 space-y-1.5 text-center">
      <h1 className="font-heading text-xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}
