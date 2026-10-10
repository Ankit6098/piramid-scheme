/**
 * Extra query keys of the programs feature. Detail/list keys come from `queryKeys.admin.program(id)` /
 * `queryKeys.admin.programs(params)` and `queryKeys.programs.*`; the keys below nest under the
 * program detail so invalidating `queryKeys.admin.program(id)` refreshes them too.
 */
export const programKeys = {
  admins: (programId: string) => ['admin', 'program', programId, 'admins'] as const,
  adminCandidates: (programId: string) => ['admin', 'program', programId, 'admin-candidates'] as const,
  /** Offerings offered in the program form. */
  offeringChoices: () => ['admin', 'offerings', 'choices'] as const,
};
