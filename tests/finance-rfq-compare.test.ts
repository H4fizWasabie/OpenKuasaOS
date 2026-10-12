import { describe, expect, it } from 'vitest';
import { comparableRfqIds, compareQuotes, rfqGroupId } from '@/lib/finance/rfq-compare';
import type { RfqDetail, RfqLine, RfqListRow } from '@/lib/finance/rfqs';

const row = (id: string, over: Partial<RfqListRow> = {}): RfqListRow => ({
  id,
  rfq_no: `RFQ-${id}`,
  supplier_id: `sup-${id}`,
  supplier_name: `Supplier ${id}`,
  rfq_date: '2026-10-01',
  reply_by: null,
  supplier_ref: null,
  status: 'sent',
  line_count: 1,
  total: 0,
  fully_priced: false,
  purchase_order_id: null,
  purchase_order_no: null,
  source_rfq_id: null,
  ...over,
});

let lineSeq = 0;
const line = (description: string, unit_price: number | null, over: Partial<RfqLine> = {}): RfqLine => ({
  id: `l${(lineSeq += 1)}`,
  product_id: null,
  description,
  quantity: 10,
  uom: 'ream',
  pack_size: null,
  unit_price,
  sst_rate: 0,
  ...over,
});

/** A quoted RFQ: its answer has been recorded. */
const rfq = (id: string, lines: RfqLine[], over: Partial<RfqDetail> = {}): RfqDetail => ({
  ...row(id, { status: 'quoted' }),
  subtotal: 0,
  sst_total: 0,
  notes: null,
  quoted_at: '2026-10-02T09:00:00Z',
  lines,
  ...over,
});

/** Each row as `description: cell, cell, …`, a cell being its price (`*` when marked lowest), `-` unpriced, `x` not asked. */
const grid = (rfqs: RfqDetail[]) =>
  compareQuotes(rfqs).map(
    (r) =>
      `${r.description}: ${r.cells
        .map((c) => (c === null ? 'x' : c.unit_price === null ? '-' : `${c.unit_price}${c.lowest ? '*' : ''}`))
        .join(', ')}`,
  );

describe('RFQ groups', () => {
  it('go by the first RFQ, which its copies name', () => {
    expect(rfqGroupId(row('a'))).toBe('a');
    expect(rfqGroupId(row('b', { source_rfq_id: 'a' }))).toBe('a');
  });
  it('can be compared once two of their RFQs have gone to a supplier, whatever has happened to them since', () => {
    const rows = [
      row('a', { status: 'quoted' }),
      row('b', { source_rfq_id: 'a', status: 'closed' }),
      row('c', { source_rfq_id: 'a', status: 'draft' }),
      row('d'),
      row('e', { source_rfq_id: 'd', status: 'draft' }),
    ];
    expect([...comparableRfqIds(rows)].sort()).toEqual(['a', 'b']);
  });
});

describe('compareQuotes', () => {
  it('marks the lowest price on each line, and every supplier tied at it', () => {
    expect(
      grid([
        rfq('a', [line('Paper', 12.5), line('Toner', 80)]),
        rfq('b', [line('Paper', 12.4), line('Toner', 80)]),
        rfq('c', [line('Paper', 13), line('Toner', 95)]),
      ]),
    ).toEqual(['Paper: 12.5, 12.4*, 13', 'Toner: 80*, 80*, 95']);
  });
  it('compares prices with SST added, as SST on a purchase is a cost', () => {
    // 10.00 + 10% = 11.00 against 10.50 + 0%: the second is lower.
    expect(grid([rfq('a', [line('Paper', 10, { sst_rate: 10 })]), rfq('b', [line('Paper', 10.5)])])).toEqual(['Paper: 10, 10.5*']);
  });
  it('tells prices apart in the fourth decimal', () => {
    expect(grid([rfq('a', [line('Screw', 0.045)]), rfq('b', [line('Screw', 0.0449)])])).toEqual(['Screw: 0.045, 0.0449*']);
  });
  it('counts no price on an RFQ whose answer has not been recorded: one typed before sending is not a quote', () => {
    expect(
      grid([
        rfq('a', [line('Paper', 12)]),
        rfq('b', [line('Paper', 9)], { status: 'sent', quoted_at: null }),
        rfq('c', [line('Paper', 11)], { status: 'closed', quoted_at: null }),
        rfq('d', [line('Paper', 10)], { status: 'closed' }),
      ]),
    ).toEqual(['Paper: 12, -, -, 10*']);
    const [paper] = compareQuotes([rfq('b', [line('Paper', 9)], { status: 'sent', quoted_at: null })]);
    expect(paper.cells[0]?.total).toBeNull();
  });
  it('marks nothing on a line only one supplier has priced, and keeps an unpriced line apart from one not asked for', () => {
    expect(
      grid([
        rfq('a', [line('Paper', 12), line('Toner', 80)]),
        rfq('b', [line('Paper', null)]),
      ]),
    ).toEqual(['Paper: 12, -', 'Toner: 80, x']);
  });
  it('matches a line by its product, or else by its description, in the same unit and pack size', () => {
    expect(
      grid([
        rfq('a', [
          line('A4 paper 80gsm', 12, { product_id: 'p1' }),
          line('Staples', 3),
          line('Envelopes', 5, { pack_size: 'box of 100' }),
        ]),
        rfq('b', [
          line('A4 paper, 80 gsm', 11, { product_id: 'p1' }),
          line('  STAPLES ', 4),
          line('Envelopes', 2, { pack_size: 'box of 50' }),
        ]),
      ]),
    ).toEqual(['A4 paper 80gsm: 12, 11*', 'Staples: 3*, 4', 'Envelopes: 5, x', 'Envelopes: x, 2']);
  });
  it('keeps two lines for the same item on one RFQ as two rows, matched in the order entered', () => {
    expect(
      grid([rfq('a', [line('Paper', 12), line('Paper', 10)]), rfq('b', [line('Paper', 11), line('Paper', 9)])]),
    ).toEqual(['Paper: 12, 11*', 'Paper: 10, 9*']);
  });
  it('totals each priced line as the RFQ does: the amount and its SST, each rounded to the sen', () => {
    const [paper] = compareQuotes([rfq('a', [line('Paper', 12.345, { quantity: 3, sst_rate: 6 })])]);
    // 3 x 12.345 = 37.035 -> 37.04; SST 2.2221 -> 2.22.
    expect(paper.cells[0]?.total).toBe(39.26);
  });
});
