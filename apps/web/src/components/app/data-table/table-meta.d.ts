import '@tanstack/react-table';

declare module '@tanstack/react-table' {
  // Extra per-column options understood by <DataTable>. (Type params must match the original.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Label for the column-visibility menu (defaults to a string header or the column id). */
    label?: string;
    /** Horizontal alignment of header + cells. Use "right" for amounts. */
    align?: 'left' | 'center' | 'right';
    headerClassName?: string;
    cellClassName?: string;
  }
}
