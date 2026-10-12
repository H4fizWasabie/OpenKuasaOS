/**
 * Comparing the quotes for one request side by side. Copy to another supplier
 * makes a group: the first RFQ, and every RFQ that names it as its source (a
 * copy of a copy names the first too). Compare quotes lays a group's lines out
 * as rows and its suppliers as columns, and marks the lowest price on each
 * line. It marks figures only: the cheapest is not always the supplier chosen
 * (delivery time, past service), so the choice is the person's. Pure.
 */
import { lineAmounts } from './bill-math';
import type { RfqDetail, RfqListRow } from './rfqs';

/** The id a group goes by: the first RFQ's. */
export function rfqGroupId(row: Pick<RfqListRow, 'id' | 'source_rfq_id'>): string {
  return row.source_rfq_id ?? row.id;
}

/**
 * The RFQs whose quotes can be compared: those that have gone to their supplier, in a group where at
 * least one other has too. A draft has asked nobody anything yet, so it neither counts nor is offered.
 */
export function comparableRfqIds(rows: RfqListRow[]): Set<string> {
  const sent = rows.filter((row) => row.status !== 'draft');
  const counts = new Map<string, number>();
  for (const row of sent) counts.set(rfqGroupId(row), (counts.get(rfqGroupId(row)) ?? 0) + 1);
  return new Set(sent.filter((row) => (counts.get(rfqGroupId(row)) ?? 0) > 1).map((row) => row.id));
}

/** One supplier's answer on one line. */
export type QuoteCell = {
  quantity: number;
  /** null until the supplier's answer is recorded: a price typed on the RFQ before then is not a quote. */
  unit_price: number | null;
  sst_rate: number;
  /** The line's amount plus its SST, as the RFQ totals it; null when unpriced. */
  total: number | null;
  /** The lowest unit price on this line, SST included. Every supplier tied at the lowest is marked. */
  lowest: boolean;
  /**
   * This supplier's own description of the line, when it is not the row's: lines matched by product
   * can be worded differently, and a substitute is told apart only by its description. null when it
   * reads as the row's does.
   */
  description: string | null;
};

export type ComparisonRow = {
  key: string;
  description: string;
  uom: string | null;
  pack_size: string | null;
  /** One per RFQ, in the order given; null where that RFQ does not ask for this item. */
  cells: (QuoteCell | null)[];
};

const words = (text: string | null) => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Which item a line asks for: its product, or else its description, in the same unit and pack size.
 * A copy keeps both, and a description edited by a space or a capital still matches. Two lines for
 * the same item on one RFQ stay two rows, matched in the order they were entered.
 */
function itemKeys(lines: RfqDetail['lines']): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = `${line.product_id ?? words(line.description)}|${words(line.uom)}|${words(line.pack_size)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${key}#${n}`;
  });
}

/**
 * What one unit costs once SST is paid, in whole 10^-6 ringgit, so prices compare exactly: SST on a
 * purchase is a cost, as no input tax is claimed back. Unit price keeps 4 decimals and the rate 2.
 */
function unitCost(price: number, rate: number): bigint {
  return BigInt(Math.round(price * 10 ** 4)) * BigInt(Math.round((100 + rate) * 100));
}

/**
 * The group's lines as rows, in the order the first RFQ lists them and then any line only a later RFQ
 * has, with one cell per RFQ. Only an RFQ whose answer was recorded (`quoted_at`) has prices here: the
 * form lets a buyer type a price before sending, and that is not the supplier's. The lowest price on a
 * line is marked only when at least two suppliers priced it: a price nobody else gave is not a comparison.
 * A row goes by the description on the first RFQ that has it; a cell worded differently keeps its own.
 */
export function compareQuotes(rfqs: RfqDetail[]): ComparisonRow[] {
  const rows = new Map<string, ComparisonRow>();
  rfqs.forEach((rfq, column) => {
    const keys = itemKeys(rfq.lines);
    rfq.lines.forEach((line, index) => {
      let row = rows.get(keys[index]);
      if (!row) {
        row = { key: keys[index], description: line.description, uom: line.uom, pack_size: line.pack_size, cells: rfqs.map(() => null) };
        rows.set(keys[index], row);
      }
      const unit_price = rfq.quoted_at === null ? null : line.unit_price;
      let total: number | null = null;
      if (unit_price !== null) {
        const { amount, sst } = lineAmounts({ quantity: line.quantity, unit_price, sst_rate: line.sst_rate });
        total = Math.round((amount + sst) * 100) / 100;
      }
      const description = words(line.description) === words(row.description) ? null : line.description;
      row.cells[column] = { quantity: line.quantity, unit_price, sst_rate: line.sst_rate, total, lowest: false, description };
    });
  });

  for (const row of rows.values()) {
    const priced = row.cells.filter((c): c is QuoteCell & { unit_price: number } => c !== null && c.unit_price !== null);
    if (priced.length < 2) continue;
    const costs = priced.map((c) => unitCost(c.unit_price, c.sst_rate));
    const lowest = costs.reduce((a, b) => (b < a ? b : a));
    priced.forEach((c, i) => {
      c.lowest = costs[i] === lowest;
    });
  }
  return [...rows.values()];
}
