'use client';

import { useState } from 'react';
import { BadgeCheck, ClipboardCheck, Scale } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { rm } from '@/lib/finance/format';
import { RFQ_STATUS_LABELS, rfqActions } from '@/lib/finance/purchase-views';
import { compareQuotes } from '@/lib/finance/rfq-compare';
import type { RfqDetail } from '@/lib/finance/rfqs';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

/** A unit price keeps up to 4 decimals, so two prices that differ only there do not read the same. */
function unitPrice(n: number) {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/**
 * The quotes for one request side by side: a row for each item, a column for each supplier asked, the
 * lowest price on each line marked in words as well as colour, and "Not quoted" where a supplier gave
 * no price. A quoted column without an order gets Make purchase order, the RFQ's own action; closing the
 * other RFQs is left to the person. The rules are in src/lib/finance/rfq-compare.ts.
 */
export function RfqCompareCard({
  rfqs,
  convert,
  onConverted,
  onClose,
}: {
  /** The group's RFQs that have gone to their supplier, in the order they were made, with their lines. */
  rfqs: RfqDetail[];
  /** Makes a draft purchase order from a quoted RFQ; absent for a person who may not. */
  convert?: (input: unknown) => Promise<FinResult<unknown>>;
  /** The order was made from this RFQ. */
  onConverted: (rfq: RfqDetail) => void;
  onClose: () => void;
}) {
  const rows = compareQuotes(rfqs);
  const [confirming, setConfirming] = useState<RfqDetail | null>(null);
  const action = useFinanceAction();

  return (
    <BentoCard
      title="Compare quotes"
      subtitle={`${rfqs.length} suppliers asked for the same items`}
      icon={Scale}
      flush
      className="col-span-2 md:col-span-12"
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Item</TableHead>
              {rfqs.map((r) => (
                <TableHead key={r.id} className="text-right align-bottom">
                  <span className="block whitespace-normal font-medium text-foreground">{r.supplier_name}</span>
                  <span className="block whitespace-nowrap text-xs font-normal">
                    {r.rfq_no} · {RFQ_STATUS_LABELS[r.status]}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="min-w-48 whitespace-normal align-top">
                  <span className="font-medium">{row.description}</span>
                  {row.uom || row.pack_size ? (
                    <span className="block text-xs text-muted-foreground">{[row.uom, row.pack_size].filter(Boolean).join(' · ')}</span>
                  ) : null}
                </TableCell>
                {row.cells.map((cell, i) => (
                  <TableCell key={rfqs[i].id} className="whitespace-nowrap text-right align-top tabular-nums">
                    {cell === null || cell.unit_price === null || cell.total === null ? (
                      <span className="text-muted-foreground">Not quoted</span>
                    ) : (
                      <>
                        <span className="flex items-center justify-end gap-1.5">
                          {cell.lowest ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-600">
                              <BadgeCheck className="size-3" aria-hidden />
                              Lowest
                            </span>
                          ) : null}
                          <span className={cn(cell.lowest && 'font-semibold')}>{unitPrice(cell.unit_price)}</span>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Qty {cell.quantity} · {cell.sst_rate ? `SST ${cell.sst_rate}%` : 'No SST'} · {rm(cell.total)}
                        </span>
                      </>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-medium">
              <TableCell>Total</TableCell>
              {rfqs.map((r) => (
                <TableCell key={r.id} className="whitespace-nowrap text-right tabular-nums">
                  {r.quoted_at ? rm(r.total) : <span className="font-normal text-muted-foreground">Not quoted</span>}
                </TableCell>
              ))}
            </TableRow>
            <TableRow>
              <TableCell>
                <span className="sr-only">Purchase order</span>
              </TableCell>
              {rfqs.map((r) => (
                <TableCell key={r.id} className="whitespace-nowrap text-right">
                  {convert && rfqActions(r).includes('convert') ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-expanded={confirming?.id === r.id}
                      disabled={action.pending}
                      onClick={() => {
                        action.clear();
                        setConfirming(r);
                      }}
                    >
                      <ClipboardCheck className="size-4" />
                      Make purchase order
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {r.purchase_order_id ? `Order ${r.purchase_order_no ?? 'drafted'}` : '—'}
                    </span>
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 border-t px-4 py-3 text-sm">
        {confirming && convert ? (
          <div role="group" aria-label={`Make a purchase order from ${confirming.rfq_no}`} className="flex flex-wrap items-center gap-3">
            <p className="basis-full">
              Make a draft purchase order from <span className="font-medium">{confirming.rfq_no}</span> to{' '}
              <span className="font-medium">{confirming.supplier_name}</span> ({rm(confirming.total)})? It gets the same supplier
              and lines, at the prices quoted, and stays a draft on Purchase Orders until it is submitted for approval. The
              other RFQs stay as they are.
            </p>
            <Button
              type="button"
              size="sm"
              disabled={action.pending}
              autoFocus
              onClick={() => action.run(() => convert({ id: confirming.id }), () => onConverted(confirming))}
            >
              {action.pending ? 'Making…' : 'Make purchase order'}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={action.pending} onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            {action.error ? (
              <p role="alert" className="text-destructive">
                {action.error}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-muted-foreground">
            Lowest is the lowest price for one unit once SST is added. The lowest price is not always the best choice:
            delivery time and past service count too.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={action.pending} data-finance-focus>
            Close
          </Button>
        </div>
      </div>
    </BentoCard>
  );
}
