/**
 * Client-side CSV export of rows already loaded in the console.
 *
 * Cells are quoted when needed and a leading `=`, `+`, `-`, `@`, tab or
 * carriage return is prefixed with a quote so a spreadsheet never runs a
 * member name or an email as a formula (CSV injection).
 */
const FORMULA_START = /^[=+\-@\t\r]/u;

function cell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

/** Hands a CSV string to the browser as a download, with a BOM so Excel reads UTF-8. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
