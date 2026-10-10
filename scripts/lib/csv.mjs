// An incremental CSV reader: text comes in pieces, a finished row goes to onRow().
// Quotes, doubled quotes and line breaks inside quotes are handled. A cell is kept only up to `cellCap` characters
// (product descriptions can be huge and we never need them whole).

export class CsvReader {
  constructor(delim, onRow, cellCap = 400) {
    this.delim = delim;
    this.onRow = onRow;
    this.cellCap = cellCap;
    this.row = [];
    this.cell = '';
    this.inQuote = false;
    this.maybeEnd = false; // saw a quote inside quotes: it is either the end or the first half of ""
  }
  put(c) {
    if (this.cell.length < this.cellCap) this.cell += c;
  }
  push(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.inQuote) {
        if (this.maybeEnd) {
          this.maybeEnd = false;
          if (c === '"') { this.put('"'); continue; }
          this.inQuote = false; // it was the end of the quoted part; handle this character normally below
        } else if (c === '"') { this.maybeEnd = true; continue; }
        else { this.put(c); continue; }
      }
      if (c === '"') this.inQuote = true;
      else if (c === this.delim) { this.row.push(this.cell); this.cell = ''; }
      else if (c === '\n') { this.row.push(this.cell.replace(/\r$/, '')); this.onRow(this.row); this.row = []; this.cell = ''; }
      else this.put(c);
    }
  }
  end() {
    if (this.cell !== '' || this.row.length) { this.row.push(this.cell); this.onRow(this.row); }
  }
}

export function guessDelimiter(text) {
  const line = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 3000);
  const counts = [';', ',', '\t', '|'].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}
