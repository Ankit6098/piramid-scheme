import { NotFoundState } from '@/components/app/states';
import { routes } from '@/config/routes';

export default function AdminNotFound() {
  return <NotFoundState backHref={routes.admin.overview} backLabel="Back to overview" />;
}
