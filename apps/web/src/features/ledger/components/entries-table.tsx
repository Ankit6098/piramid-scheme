import type { LedgerTransactionDetailDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { enumLabel } from '@/lib/enum-labels';

import { unitFormat } from '../../finance/lib';

/** Debit / credit entries of one ledger transaction, with the (balanced) totals. */
export function EntriesTable({ transaction }: { transaction: LedgerTransactionDetailDto }) {
  const fmt = unitFormat(transaction);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <caption className="sr-only">Ledger entries of transaction {transaction.id}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transaction.entries.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-normal">
                <span className="block text-sm">{enumLabel('LedgerAccountType', e.accountType)}</span>
                {e.accountOwner ? <span className="text-xs text-muted-foreground">{e.accountOwner.fullName}</span> : null}
              </TableCell>
              <TableCell className="text-right">
                {e.direction === 'DEBIT' ? <Amount value={e.amountMinor} format={unitFormat(e)} /> : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="text-right">
                {e.direction === 'CREDIT' ? <Amount value={e.amountMinor} format={unitFormat(e)} /> : <span className="text-muted-foreground">—</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-xs text-muted-foreground">Total ({transaction.entryCount} entries)</TableCell>
            <TableCell className="text-right">
              <Amount value={transaction.amountMinor} format={fmt} className="font-medium" />
            </TableCell>
            <TableCell className="text-right">
              <Amount value={transaction.amountMinor} format={fmt} className="font-medium" />
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
