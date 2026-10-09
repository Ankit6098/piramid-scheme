import { NotFoundState } from '@/components/app/states';
import { routes } from '@/config/routes';

export default function MemberNotFound() {
  return <NotFoundState backHref={routes.member.dashboard} backLabel="Back to dashboard" />;
}
