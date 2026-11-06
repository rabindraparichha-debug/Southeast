import { describe, expect, it } from 'vitest';
import { crc32, csvCell, exportRow, paiseToRupeeText, toCsvText, zipFiles } from '../src/index';

describe('kitchen export: CSV', () => {
  it('quotes commas, quotes and new lines', () => {
    expect(csvCell('Plot 5, Patia')).toBe('"Plot 5, Patia"');
    expect(csvCell('Says "hi"')).toBe('"Says ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('defuses spreadsheet formulas but keeps phone numbers and negative amounts', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('+919000000001')).toBe('+919000000001');
    expect(csvCell('-70.00')).toBe('-70.00');
    expect(csvCell('-cmd')).toBe("'-cmd");
  });

  it('writes a header from all keys, a BOM and CRLF lines (Odia names survive)', () => {
    const text = toCsvText([{ name: 'ମା ତାରିଣୀ', meals: 3 }, { name: 'Asha', note: 'veg' }]);
    expect(text).toBe('﻿name,meals,note\r\nମା ତାରିଣୀ,3,\r\nAsha,,veg\r\n');
    expect(toCsvText([], ['a', 'b'])).toBe('﻿a,b\r\n');
  });

  it('turns paise columns into rupees', () => {
    expect(paiseToRupeeText(7050)).toBe('70.50');
    expect(paiseToRupeeText(-7000)).toBe('-70.00');
    expect(paiseToRupeeText(5)).toBe('0.05');
    expect(exportRow({ amount_paise: 7050, price_per_meal_paise: null, meals: 2 })).toEqual({ amount_rupees: '70.50', price_per_meal_rupees: null, meals: 2 });
  });
});

/** Reads a stored ZIP back (central directory → local headers), checking every CRC. */
function unzip(zip: Uint8Array): Record<string, string> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out[name] = dec.decode(data);
    p += 46 + nameLen;
  }
  return out;
}

describe('kitchen export: ZIP', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('packs files that read back unchanged', () => {
    const zip = zipFiles([
      { name: 'customers.csv', data: 'name\r\nଅଶା\r\n' },
      { name: 'meal_orders.csv', data: new TextEncoder().encode('x,y\r\n1,2\r\n') },
      { name: 'empty.csv', data: '' },
    ], new Date(2026, 10, 9, 10, 30, 0));
    expect(unzip(zip)).toEqual({ 'customers.csv': 'name\r\nଅଶା\r\n', 'meal_orders.csv': 'x,y\r\n1,2\r\n', 'empty.csv': '' });
  });
});
