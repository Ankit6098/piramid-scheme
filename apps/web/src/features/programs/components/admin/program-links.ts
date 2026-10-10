/** Hrefs of the admin program screens (tabs are nested routes under /admin/programs/[id]). */
export const PROGRAMS_HREF = '/admin/programs';

export function programHref(id: string, tab?: 'options' | 'enrollments' | 'admins' | 'history' | 'policies' | 'edit'): string {
  return tab ? `${PROGRAMS_HREF}/${id}/${tab}` : `${PROGRAMS_HREF}/${id}`;
}
