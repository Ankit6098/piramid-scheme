/** Extra query keys of the settings feature (roots shared with `queryKeys.settings`). */
export const settingsKeys = {
  /** GET /admin/currencies — ISO 4217 reference data. */
  currencies: () => ['settings', 'currencies'] as const,
};
