import Link from 'next/link';

import { BrandMark } from '@/components/app/shell/brand-mark';
import { NotFoundState } from '@/components/app/states';
import { routes } from '@/config/routes';

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center px-4 sm:px-6">
        <Link href={routes.home} className="rounded-md" aria-label="Home">
          <BrandMark />
        </Link>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-4 pb-16 outline-none"
      >
        <NotFoundState
          className="max-w-lg"
          backHref={routes.home}
          backLabel="Go to the home page"
        />
      </main>
    </div>
  );
}
