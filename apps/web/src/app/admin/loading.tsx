import { PageSkeleton } from '@/components/app/states';

/** Instant loading UI for page navigations inside the shell (also a Suspense boundary for pages). */
export default function Loading() {
  return <PageSkeleton />;
}
