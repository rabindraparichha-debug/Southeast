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
      if (i === 40) return { name: 'Dup', phone: '9777000001' };
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
