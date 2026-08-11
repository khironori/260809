/**
 * 依存を増やさないための最小CSVパーサ。
 * RFC4180 準拠の範囲（ダブルクォート囲み、"" によるエスケープ、
 * クォート内の改行・カンマ）を扱う。CRLF/LF/CR いずれの改行にも対応。
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM除去
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let hasContent = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      hasContent = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (hasContent || row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
      hasContent = false;
    } else {
      field += ch;
      hasContent = true;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.map((r) => r.map((c) => c.trim()));
}

/**
 * ヘッダ行 + データ行の配列を、ヘッダ名をキーにしたオブジェクト配列へ変換する。
 */
export function rowsToObjects(headerRow, dataRows) {
  const headers = headerRow.map(normalizeHeader);
  return dataRows.map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      o[h] = r[i] ?? '';
    });
    return o;
  });
}

/**
 * 列名の表記ゆれを吸収する。
 * EdinetcodeDlInfo.csv のヘッダは全角英字（ＥＤＩＮＥＴコード）や
 * 全角括弧（提出者名（英字））を含むため、全角→半角に寄せて比較できるようにする。
 */
export function normalizeHeader(name) {
  return String(name ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[　\s]/g, '')
    .trim();
}
