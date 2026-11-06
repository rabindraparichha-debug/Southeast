import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyMapping,
  cutoffInstant,
  formatPaise,
  formatPhone,
  formatTime12h,
  formatIstShort,
  formatServiceDate,
  guessMapping,
  istDate,
  isoDow,
  normalizeDate,
  normalizePhone,
  rupeesToPaise,
  validateImportRows,
  parseBilling,
  parseImportStatus,
  previewImportRows,
  importChunks,
  importTemplateRows,
  IMPORT_TEMPLATE_HEADERS,
  IMPORT_ERROR_MESSAGES,
  IMPORT_WARNING_MESSAGES,
  type ImportRow,
} from '../src';

describe('normalizePhone (same vectors as private.normalize_phone)', () => {
  it.each([
    ['9861000001', '+919861000001'],
    ['+91 98610 00001', '+919861000001'],
    ['+91-98610-00001', '+919861000001'],
    ['919861000001', '+919861000001'],
    ['09861000001', '+919861000001'],
    ['(986) 100-0001', '+919861000001'],
    [9861000001, '+919861000001'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([['12345'], ['5861000001'], ['98610000011'], [''], [null], ['+1 415 555 0101']])('%s is invalid', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('formats for display', () => {
    expect(formatPhone('+919861000001')).toBe('+91 98610 00001');
  });
});

describe('money', () => {
  it('formats paise', () => {
    expect(formatPaise(7000)).toBe('₹70');
    expect(formatPaise(7050)).toBe('₹70.50');
    expect(formatPaise(200000)).toBe('₹2,000');
    expect(formatPaise(-6500)).toBe('-₹65');
  });
  it('parses rupees without floating point drift', () => {
    expect(rupeesToPaise('70')).toBe(7000);
    expect(rupeesToPaise('70.5')).toBe(7050);
    expect(rupeesToPaise('₹1,200.05')).toBe(120005);
    expect(rupeesToPaise('0.29')).toBe(29);
    expect(rupeesToPaise('-5')).toBeNull();
    expect(rupeesToPaise('7.123')).toBeNull();
  });
});

describe('IST time helpers', () => {
  it('lunch cutoff is 21:00 IST the previous day = 15:30 UTC', () => {
    expect(cutoffInstant('2026-11-03', '21:00:00', true).toISOString()).toBe('2026-11-02T15:30:00.000Z');
  });
  it('dinner cutoff is 12:00 IST the same day = 06:30 UTC', () => {
    expect(cutoffInstant('2026-11-03', '12:00', false).toISOString()).toBe('2026-11-03T06:30:00.000Z');
  });
  it('IST date rolls over at 18:30 UTC', () => {
    expect(istDate(new Date('2026-11-02T18:29:00Z'))).toBe('2026-11-02');
    expect(istDate(new Date('2026-11-02T18:30:00Z'))).toBe('2026-11-03');
  });
  it('date arithmetic and weekdays', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isoDow('2026-11-01')).toBe(7); // Sunday
    expect(isoDow('2026-11-02')).toBe(1); // Monday
    expect(formatTime12h('21:00:00')).toBe('9:00 pm');
    expect(formatTime12h('12:00')).toBe('12:00 pm');
    expect(formatTime12h('00:30')).toBe('12:30 am');
  });
  it('formats service dates and IST instants for the counts screens', () => {
    expect(formatServiceDate('2026-11-03')).toBe('Tue, 3 Nov');
    expect(formatIstShort('2026-11-02T15:30:00Z')).toBe('Mon, 9:00 pm');
  });
});

describe('import mapping', () => {
  it('guesses columns from typical vendor headers', () => {
    const m = guessMapping(['Sl No', 'Customer Name', 'Mobile No.', 'Veg/Non-veg', 'Plan Name', 'Start Date', 'Area', 'Delivery notes', 'Remarks']);
    expect(m).toMatchObject({ name: 1, phone: 2, diet: 3, plan: 4, start_date: 5, area: 6, delivery_notes: 7, notes: 8 });
  });

  it('normalises Indian date formats, Excel serials and Date objects', () => {
    expect(normalizeDate('02/11/2026')).toBe('2026-11-02');
    expect(normalizeDate('2-11-26')).toBe('2026-11-02');
    expect(normalizeDate('2026-11-02')).toBe('2026-11-02');
    expect(normalizeDate(46328)).toBe('2026-11-02');
    expect(normalizeDate('31/02/2026')).toBe('31/02/2026'); // left for the server to reject
    expect(normalizeDate('')).toBe('');
  });

  it('applies the mapping and drops blank rows', () => {
    const rows = applyMapping(
      [
        ['Asha', '98610 11111', '02/11/2026'],
        ['', '', ''],
        ['Ravi', '9861022222', ''],
      ],
      { name: 0, phone: 1, start_date: 2 },
    );
    expect(rows).toEqual([
      { name: 'Asha', phone: '98610 11111', start_date: '2026-11-02' },
      { name: 'Ravi', phone: '9861022222' },
    ]);
  });
});

describe('validateImportRows', () => {
  it('reports the 3 bad rows out of 50 with the server error codes', () => {
    const rows: ImportRow[] = Array.from({ length: 50 }, (_, k) => {
      const i = k + 1;
      if (i === 10) return { name: 'Bad Phone', phone: '12345' };
      if (i === 25) return { name: '', phone: '9777000025' };
      if (i === 40) return { name: 'customer  1', phone: '9777000001' };
      return { name: `Customer ${i}`, phone: `9777${String(i).padStart(6, '0')}`, plan: 'Veg Lunch', start_date: '2026-11-02' };
    });
    expect(validateImportRows(rows, ['Veg Lunch'])).toEqual([
      { row: 10, errors: ['invalid_phone'] },
      { row: 25, errors: ['name_required'] },
      { row: 40, errors: ['duplicate_in_file'] },
    ]);
  });

  it('validates the opening balance column (whole meals, -200 to 1000)', () => {
    expect(
      validateImportRows(
        [
          { name: 'A', phone: '9861000001', balance: '24' },
          { name: 'B', phone: '9861000002', balance: '-3' },
          { name: 'C', phone: '9861000003', balance: '2.5' },
          { name: 'D', phone: '9861000004', balance: '5000' },
        ],
        [],
      ),
    ).toEqual([
      { row: 3, errors: ['invalid_balance'] },
      { row: 4, errors: ['invalid_balance'] },
    ]);
    expect(guessMapping(['Name', 'Mobile', 'Meals left']).balance).toBe(2);
  });

  it('accepts a shared phone with another name (D-118) but not the same person twice', () => {
    expect(
      validateImportRows(
        [
          { name: 'Gyana Sethi', phone: '9862000001' },
          { name: 'Tanmay Sethi', phone: '98620 00001' },
          { name: 'gyana  sethi', phone: '+91 9862000001' },
        ],
        [],
      ),
    ).toEqual([{ row: 3, errors: ['duplicate_in_file'] }]);
  });

  it('validates billing mode and opening dues like the server', () => {
    expect(
      validateImportRows(
        [
          { name: 'A', phone: '9861000001', billing: 'Pay later', dues: '1250.50' },
          { name: 'B', phone: '9861000002', billing: 'prepaid', dues: '100' },
          { name: 'C', phone: '9861000003', billing: 'weekly' },
          { name: 'D', phone: '9861000004', dues: 'abc' },
          { name: 'E', phone: '9861000005', dues: '-300' },
        ],
        [],
      ),
    ).toEqual([
      { row: 2, errors: ['dues_need_monthly'] },
      { row: 3, errors: ['invalid_billing'] },
      { row: 4, errors: ['invalid_dues'] },
    ]);
    expect(validateImportRows([{ name: 'F', phone: '9861000006', dues: '50' }], [], 'prepaid')).toEqual([
      { row: 1, errors: ['dues_need_monthly'] },
    ]);
    expect(parseBilling('Khata')).toBe('monthly');
    expect(parseBilling('')).toBe('');
    expect(guessMapping(['Name', 'Mobile', 'Billing', 'Dues']).dues).toBe(3);
  });

  it('checks plan, date, qty, diet, language and location', () => {
    const issues = validateImportRows(
      [
        { name: 'A', phone: '9861000001', plan: 'Gold' },
        { name: 'B', phone: '9861000002', start_date: '2026-11-02' },
        { name: 'C', phone: '9861000003', qty: '0', diet: 'eggetarian', language: 'Tamil' },
        { name: 'D', phone: '9861000004', lat: '20.3' },
        { name: 'E', phone: '9861000005', diet: 'Non-Veg', language: 'Odia', qty: '2' },
      ],
      ['Veg Lunch'],
    );
    expect(issues).toEqual([
      { row: 1, errors: ['unknown_plan'] },
      { row: 2, errors: ['start_date_requires_plan'] },
      { row: 3, errors: ['invalid_diet', 'invalid_language', 'invalid_qty'] },
      { row: 4, errors: ['invalid_location'] },
    ]);
  });
});

describe('import upgrades: status, two plans, repeated rows, diet, chunks, template', () => {
  const plans = [{ name: 'Lunch', diet: 'veg' }, { name: 'Dinner', diet: 'nonveg' }];

  it('reads the status column like the server', () => {
    expect(parseImportStatus('')).toBe('active');
    expect(parseImportStatus('On hold')).toBe('paused');
    expect(parseImportStatus('Left')).toBe('stopped');
    expect(parseImportStatus('holiday')).toBeNull();
    expect(guessMapping(['Name', 'Mobile', 'Status', 'Paused from']).status).toBe(2);
    expect(guessMapping(['Name', 'Mobile', 'Status', 'Paused from']).paused_from).toBe(3);
    expect(guessMapping(['Name', 'Mobile', 'Current Status']).status).toBe(2);
  });

  it('never takes an address State or a Payment status column as the status', () => {
    // A contacts export that imported cleanly before the status column existed still does.
    expect(guessMapping(['Name', 'Phone', 'Area', 'City', 'State']).status).toBeUndefined();
    expect(guessMapping(['Name', 'Phone', 'Payment status']).status).toBeUndefined();
    expect(guessMapping(['Name', 'Phone', 'Status (active / paused / stopped)']).status).toBe(2);
  });

  it('maps lunch plan and dinner plan columns to the two plans', () => {
    const m = guessMapping(['Name', 'Mobile', 'Lunch plan', 'Dinner plan', 'Start date']);
    expect(m).toMatchObject({ plan: 2, plan_2: 3, start_date: 4 });
    // The original header set still maps the same way.
    expect(guessMapping(['Sl No', 'Customer Name', 'Mobile No.', 'Veg/Non-veg', 'Plan Name', 'Start Date', 'Area', 'Delivery notes', 'Remarks']))
      .toEqual({ name: 1, phone: 2, diet: 3, plan: 4, start_date: 5, area: 6, delivery_notes: 7, notes: 8 });
    expect(applyMapping([['Asha', '9861011111', 'Paused', '5/12/2026']], { name: 0, phone: 1, status: 2, paused_from: 3 }))
      .toEqual([{ name: 'Asha', phone: '9861011111', status: 'Paused', paused_from: '2026-12-05' }]);
  });

  it('previews the same outcome as the server test file (16_held_back)', () => {
    const rows: ImportRow[] = [
      { name: 'Rina Ray', phone: '9316200001', plan: 'Lunch', plan_2: 'Dinner' },
      { name: 'Sanu Sahu', phone: '9316200002', plan: 'Lunch', status: 'Paused', paused_from: '2026-12-01' },
      { name: 'Gopal Giri', phone: '9316200003', plan: 'Lunch', status: 'Stopped', dues: '500' },
      { name: 'rina  ray', phone: '9316200001', plan: 'Dinner' },
      { name: 'Sanu Sahu', phone: '+91 93162 00002', plan: 'Dinner', qty: '2' },
      { name: 'Gopal Giri', phone: '9316200003' },
      { name: 'Meera Mohanty', phone: '9316200004', diet: 'Non-veg', plan: 'Lunch' },
      { name: 'Tara', phone: '9316200005', status: 'holiday' },
      { name: 'Uma', phone: '9316200006', status: 'active', paused_from: '2026-12-20' },
      { name: 'Sanu Sahu', phone: '9316200002', plan: 'Dinner', balance: '5' },
      { name: 'Vik', phone: '9316200007', plan: 'Lunch', paused_from: '2026-12-20', start_date: '2026-12-18' },
      { name: 'Wasim', phone: '9316200008', plan: 'Lunch', plan_2: 'lunch' },
      { name: 'Xena', phone: '9316200009', plan: 'Lunch', plan_2: 'Gold' },
    ];
    const { issues, warnings } = previewImportRows(rows, plans);
    expect(issues).toEqual([
      { row: 4, errors: ['same_plan_twice'] },
      { row: 6, errors: ['duplicate_in_file'] },
      { row: 8, errors: ['invalid_status'] },
      { row: 9, errors: ['paused_from_needs_paused'] },
      { row: 10, errors: ['balance_on_repeated_row'] },
      { row: 12, errors: ['same_plan_twice'] },
      { row: 13, errors: ['unknown_second_plan'] },
    ]);
    expect(warnings).toEqual([
      { row: 3, warnings: ['stopped_plan_ignored'] },
      { row: 5, warnings: ['adds_plan'], into: 2 },
      { row: 7, warnings: ['diet_differs_from_plan'] },
    ]);
    // Plan names alone (no diets) still validate; there is just no diet warning.
    expect(validateImportRows(rows, ['Lunch', 'Dinner'])).toEqual(issues);
    expect(previewImportRows(rows, ['Lunch', 'Dinner']).warnings.map((w) => w.row)).toEqual([3, 5]);
  });

  it('checks the paused-from date and keeps "start date needs a plan" for the second plan too', () => {
    expect(validateImportRows([
      { name: 'A', phone: '9861000001', plan: 'Lunch', paused_from: '31/02/2026' },
      { name: 'B', phone: '9861000002', plan_2: 'Dinner', start_date: '2026-12-01' },
      { name: 'C', phone: '9861000003', start_date: '2026-12-01' },
    ], plans)).toEqual([
      { row: 1, errors: ['invalid_pause_date'] },
      { row: 3, errors: ['start_date_requires_plan'] },
    ]);
  });

  it('every error and warning code has a message', () => {
    for (const m of Object.values(IMPORT_ERROR_MESSAGES)) expect(m.length).toBeGreaterThan(5);
    for (const m of Object.values(IMPORT_WARNING_MESSAGES)) expect(m.length).toBeGreaterThan(5);
  });

  it('splits a file into chunks with file-wide row numbers', () => {
    const rows = Array.from({ length: 250 }, (_, i) => i + 1);
    const chunks = importChunks(rows, 100);
    expect(chunks.map((c) => [c.firstRow, c.rows.length])).toEqual([[1, 100], [101, 100], [201, 50]]);
    expect(chunks[2]!.rows[0]).toBe(201);
    expect(importChunks([], 100)).toEqual([]);
  });

  it('the template example rows fill every column, use the IST date, and pass the preview', () => {
    const vegPlans = [{ name: 'Lunch', diet: 'veg' }, { name: 'Dinner', diet: 'nonveg' }, { name: 'Veg Dinner', diet: 'veg' }];
    const t = importTemplateRows(vegPlans, istDate(new Date('2026-11-01T20:00:00Z')));
    expect(t[1]!.slice(9, 11)).toEqual(['Lunch', 'Veg Dinner']); // a second plan of the same diet
    expect(t[0]).toEqual(IMPORT_TEMPLATE_HEADERS);
    expect(t[1]!.length).toBe(IMPORT_TEMPLATE_HEADERS.length);
    expect(t[2]!.length).toBe(IMPORT_TEMPLATE_HEADERS.length);
    expect(t[1]!.every((c) => c !== '')).toBe(true);
    expect(t[1]![11]).toBe('02/11/2026'); // 01:30 IST on 2 Nov is still 1 Nov in UTC
    expect(t[1]![14]).toBe('09/11/2026');
    const mapping = guessMapping(t[0]!);
    expect(Object.keys(mapping).length).toBe(IMPORT_TEMPLATE_HEADERS.length);
    expect(previewImportRows(applyMapping(t.slice(1), mapping), vegPlans)).toEqual({ issues: [], warnings: [] });
    expect(importTemplateRows(['Thali'], '2026-11-02')[1]!.slice(9, 11)).toEqual(['Thali', '']);
  });
});

describe('isIsoDate', () => {
  it('accepts real dates only', async () => {
    const { isIsoDate } = await import('../src/time');
    expect(isIsoDate('2026-11-02')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-45')).toBe(false);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('zz')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});
