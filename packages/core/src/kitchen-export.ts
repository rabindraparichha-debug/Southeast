// "Export my kitchen" (wave 4): rows from public.export_kitchen → CSV files → one ZIP, in the browser.
// No dependencies: a tiny CSV writer and a ZIP writer that stores files uncompressed (CSV of a
// small kitchen is a few MB; every unzip tool and Excel read stored entries).

type Cell = string | number | boolean | null | undefined | object;

/** Paise columns become rupee columns with two decimals ("amount_paise": 7050 → "amount_rupees": "70.50"). */
export function exportRow(row: Record<string, Cell>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('_paise') && (typeof value === 'number' || value === null)) {
      out[`${key.slice(0, -'_paise'.length)}_rupees`] = value === null ? null : paiseToRupeeText(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 7050 → "70.50", -7000 → "-70.00" (plain numbers for spreadsheets, not "₹"). */
export function paiseToRupeeText(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.round(paise));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const PLAIN_NUMBER = /^[+-]?\d[\d\s.]*$/;

/** One CSV cell: quoted when needed; text that a spreadsheet would run as a formula is defused. */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // =SUM(...), +cmd, -cmd, @cmd: prefix with ' so Excel shows text. Phone numbers (+9198…) and
  // negative amounts are plain numbers and stay as they are.
  if (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text with a header row. Columns: the given ones, else every key in order of first appearance. */
export function toCsvText(rows: Record<string, Cell>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
  // Byte-order mark: Excel then reads UTF-8 (Odia and Hindi names) correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP archive (stored, UTF-8 names) of the given files. */
export function zipFiles(files: { name: string; data: Uint8Array | string }[], at: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const dosTime = (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2);
  const dosDate = ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 names
    lv.setUint16(8, 0, true);           // stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, data);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);     // local header offset (other fields stay 0)
    entry.set(name, 46);
    central.push(entry);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
