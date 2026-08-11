import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { PATHS, EDINET_CODELIST_ZIP_URL, config, ConfigError } from './config.js';
import { parseCsv, rowsToObjects, normalizeHeader } from './csv.js';

// ---------------------------------------------------------------------------
// 証券コードの正規化
// ---------------------------------------------------------------------------

/**
 * 証券コードを比較用の4桁表記に正規化する。
 *
 * EdinetcodeDlInfo.csv および EDINET API の secCode は5桁（例: 7203 -> 72030）、
 * stocklist.csv 側は4桁（例: 7203）で表記されるため、先頭4桁に揃えて突合する。
 * 2024年以降の英数字混在コード（例: 130A -> 130A0）も同じ規則で扱える。
 */
export function normalizeSecCode(raw) {
  const s = String(raw ?? '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase();
  if (!s) return '';
  if (s.length >= 5) return s.slice(0, 4);
  if (s.length === 4) return s;
  return s.padStart(4, '0'); // 3桁以下で書かれていた場合の保険
}

/** 表示用の5桁表記（EDINET形式）。4桁しか分からない場合は末尾に0を補う。 */
export function toFiveDigit(raw) {
  const s = String(raw ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!s) return '';
  if (s.length >= 5) return s.slice(0, 5);
  return (s + '0').slice(0, 5);
}

// ---------------------------------------------------------------------------
// EdinetcodeDlInfo.csv の自動取得
// ---------------------------------------------------------------------------

/**
 * 依存を増やさないための最小ZIP展開。
 * セントラルディレクトリを読み、指定名のエントリを取り出す（stored / deflate 対応）。
 */
function extractFromZip(buf, wantedName) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIPの終端レコード(EOCD)が見つかりません。ダウンロードが破損している可能性があります。');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('ZIPのセントラルディレクトリの形式が不正です。');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('latin1', ptr + 46, ptr + 46 + nameLen);

    if (path.basename(name).toLowerCase() === wantedName.toLowerCase()) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('ZIPのローカルヘッダの形式が不正です。');
      }
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`ZIPの圧縮方式 ${method} には対応していません。`);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP内に ${wantedName} が見つかりませんでした。`);
}

/**
 * EDINETコードリストを公式の固定リンクからダウンロードして
 * EdinetcodeDlInfo.csv として保存する（Shift-JISのまま保存する）。
 */
export async function downloadEdinetCodeList({ log = console.log } = {}) {
  log(`EDINETコードリストをダウンロードします: ${EDINET_CODELIST_ZIP_URL}`);
  let res;
  try {
    res = await fetch(EDINET_CODELIST_ZIP_URL, {
      headers: { 'User-Agent': 'edinet-watchlist/1.0 (local use)' },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(
      `EDINETコードリストのダウンロードに失敗しました（ネットワークエラー）: ${e.message}\n` +
        '  ネットワーク接続・プロキシ設定を確認するか、README.mdの手順で手動配置してください。'
    );
  }
  if (!res.ok) {
    throw new Error(
      `EDINETコードリストのダウンロードに失敗しました（HTTP ${res.status} ${res.statusText}）。\n` +
        '  EDINETがメンテナンス中の可能性があります。README.mdの手順で手動配置してください。'
    );
  }

  const zipBuf = Buffer.from(await res.arrayBuffer());
  const csvBuf = extractFromZip(zipBuf, 'EdinetcodeDlInfo.csv');
  await fsp.writeFile(PATHS.edinetCodeCsv, csvBuf);
  log(`  -> ${path.relative(PATHS.root, PATHS.edinetCodeCsv)} を保存しました (${csvBuf.length.toLocaleString()} bytes)`);
  return PATHS.edinetCodeCsv;
}

// ---------------------------------------------------------------------------
// EdinetcodeDlInfo.csv の読み込み
// ---------------------------------------------------------------------------

const COL = {
  edinetCode: 'EDINETコード',
  filerName: '提出者名',
  industry: '提出者業種',
  secCode: '証券コード',
  listed: '上場区分',
  filerType: '提出者種別',
  fiscalEnd: '決算日',
};

/**
 * EdinetcodeDlInfo.csv を読み込む。
 * - 文字コードは Shift-JIS
 * - 1行目は「ダウンロード実行日,...,件数,...」というメタ行、2行目が実ヘッダ
 */
export async function loadEdinetCodeList({ log = console.log, autoDownload = config.autoDownloadCodelist } = {}) {
  if (!fs.existsSync(PATHS.edinetCodeCsv)) {
    if (!autoDownload) {
      throw new ConfigError(
        `EdinetcodeDlInfo.csv が見つかりません: ${PATHS.edinetCodeCsv}\n` +
          '  AUTO_DOWNLOAD_CODELIST=true にするか、README.mdの手順で手動配置してください。'
      );
    }
    log('EdinetcodeDlInfo.csv が見つからないため自動取得します。');
    await downloadEdinetCodeList({ log });
  }

  const buf = await fsp.readFile(PATHS.edinetCodeCsv);
  const text = new TextDecoder('shift_jis').decode(buf);
  const rows = parseCsv(text);

  if (rows.length < 3) {
    throw new ConfigError(
      `EdinetcodeDlInfo.csv の行数が不足しています（${rows.length}行）。ファイルが壊れている可能性があります。\n` +
        '  npm run codes:update で再取得してください。'
    );
  }

  // 1行目=メタ行 / 2行目=ヘッダ。念のためヘッダ行を自動判定する。
  let headerIdx = rows.findIndex((r) => r.some((c) => normalizeHeader(c) === COL.edinetCode));
  if (headerIdx < 0) {
    throw new ConfigError(
      'EdinetcodeDlInfo.csv に「ＥＤＩＮＥＴコード」列が見つかりません。\n' +
        '  想定と異なるファイルか、文字コードがShift-JISではない可能性があります。\n' +
        '  npm run codes:update で公式ファイルを再取得してください。'
    );
  }

  const meta = { downloadedAt: rows[0]?.[1] ?? '', count: rows[0]?.[3] ?? '' };
  const raw = rowsToObjects(rows[headerIdx], rows.slice(headerIdx + 1)).filter((r) => r[COL.edinetCode]);

  const byEdinetCode = new Map();
  const bySecCode4 = new Map(); // 4桁 -> レコード配列（同一コードに複数EDINETコードが紐づく場合がある）

  // 以降で扱いやすいよう、全レコードを共通の正規化済みキーに揃えておく
  const records = raw.map((r) => ({
    edinetCode: r[COL.edinetCode],
    filerName: r[COL.filerName] || '',
    industry: r[COL.industry] || '',
    secCode5: r[COL.secCode] || '',
    secCode4: normalizeSecCode(r[COL.secCode]),
    listed: r[COL.listed] || '',
    filerType: r[COL.filerType] || '',
    fiscalEnd: r[COL.fiscalEnd] || '',
  }));

  for (const entry of records) {
    byEdinetCode.set(entry.edinetCode, entry);
    if (entry.secCode4) {
      if (!bySecCode4.has(entry.secCode4)) bySecCode4.set(entry.secCode4, []);
      bySecCode4.get(entry.secCode4).push(entry);
    }
  }

  return { meta, records, byEdinetCode, bySecCode4 };
}

// ---------------------------------------------------------------------------
// stocklist.csv の読み込み
// ---------------------------------------------------------------------------

const CODE_HEADER_HINTS = ['証券コード', '銘柄コード', 'コード', 'ティッカー', 'code', 'ticker', 'symbol'];
const NAME_HEADER_HINTS = ['銘柄名', '会社名', '企業名', '名称', 'name'];

function looksLikeCode(value) {
  const s = String(value ?? '').replace(/[^0-9A-Za-z]/g, '');
  return /^[0-9]{4}$/.test(s) || /^[0-9]{3}[A-Za-z]$/.test(s) || /^[0-9]{4}[0-9A-Za-z]$/.test(s);
}

/**
 * stocklist.csv を読み込む。
 * - 実ファイル名が stocklist.csv.csv の場合も拾う
 * - 列名から証券コード列を判定し、見つからなければ「1列目を証券コードとみなす」
 * - UTF-8 で読めない場合は Shift-JIS で読み直す
 */
export async function loadStockList({ log = console.log } = {}) {
  const file = PATHS.stockListCandidates.find((p) => fs.existsSync(p));
  if (!file) {
    throw new ConfigError(
      'stocklist.csv が見つかりません。次のいずれかのパスに配置してください:\n' +
        PATHS.stockListCandidates.map((p) => `  - ${p}`).join('\n')
    );
  }

  const buf = await fsp.readFile(file);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  // U+FFFD が多数出る＝UTF-8ではない、と判断してShift-JISで読み直す
  const replacementRatio = (text.match(/�/g) || []).length / Math.max(text.length, 1);
  let encoding = 'utf-8';
  if (replacementRatio > 0.01) {
    text = new TextDecoder('shift_jis').decode(buf);
    encoding = 'shift_jis';
  }

  const rows = parseCsv(text).filter((r) => r.some((c) => c !== ''));
  if (rows.length === 0) {
    throw new ConfigError(`stocklist.csv が空です: ${file}`);
  }

  // --- 証券コード列の決定 ---
  const first = rows[0];
  let codeIdx = -1;
  let nameIdx = -1;
  let hasHeader = false;

  const normFirst = first.map(normalizeHeader);
  codeIdx = normFirst.findIndex((h) => CODE_HEADER_HINTS.some((hint) => h.toLowerCase().includes(hint.toLowerCase())));
  if (codeIdx >= 0) {
    hasHeader = true;
    nameIdx = normFirst.findIndex((h) => NAME_HEADER_HINTS.some((hint) => h.toLowerCase().includes(hint.toLowerCase())));
  } else if (!first.some(looksLikeCode)) {
    // ヘッダらしき行だが既知の列名が無い -> ヘッダ扱いにして1列目をコードとみなす
    hasHeader = true;
    codeIdx = 0;
    log(`  警告: stocklist の列名から証券コード列を特定できませんでした。1列目「${first[0]}」を証券コードとみなします。`);
  } else {
    // ヘッダ無し -> コードらしい列を探し、無ければ1列目
    hasHeader = false;
    codeIdx = first.findIndex(looksLikeCode);
    if (codeIdx < 0) codeIdx = 0;
    log('  警告: stocklist にヘッダ行が見つかりませんでした。1行目からデータとして読み込みます。');
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const codeHeader = hasHeader ? first[codeIdx] : `列${codeIdx + 1}`;

  const seen = new Set();
  const items = [];
  const invalid = [];

  for (const r of dataRows) {
    const raw = r[codeIdx] ?? '';
    const code4 = normalizeSecCode(raw);
    const name = nameIdx >= 0 ? r[nameIdx] ?? '' : '';
    if (!code4) continue;
    if (!looksLikeCode(raw)) {
      invalid.push({ raw, name });
      continue;
    }
    if (seen.has(code4)) continue;
    seen.add(code4);
    items.push({ code4, code5: toFiveDigit(code4), raw: String(raw).trim(), name });
  }

  return {
    file,
    encoding,
    codeColumn: codeHeader,
    codeColumnIndex: codeIdx,
    nameColumn: nameIdx >= 0 ? first[nameIdx] : null,
    hasHeader,
    items,
    invalid,
  };
}

// ---------------------------------------------------------------------------
// 手動オーバーライド
// ---------------------------------------------------------------------------

/**
 * REIT（投資法人）やETFは EdinetcodeDlInfo.csv の証券コード列が空のため、
 * 証券コードでは突合できない。そうした銘柄を手動で対応付けるための overrides.csv を読む。
 *
 * 形式（ヘッダ必須）: 証券コード,EDINETコード
 *   3472,E34081
 */
export async function loadOverrides({ log = console.log } = {}) {
  const map = new Map();
  if (!fs.existsSync(PATHS.overridesCsv)) return map;

  const text = await fsp.readFile(PATHS.overridesCsv, 'utf8');
  const rows = parseCsv(text).filter((r) => r.some((c) => c !== '' && !c.startsWith('#')));
  if (rows.length === 0) return map;

  const header = rows[0].map(normalizeHeader);
  const hasHeader = header.some((h) => /コード|code/i.test(h));
  for (const r of hasHeader ? rows.slice(1) : rows) {
    const code4 = normalizeSecCode(r[0]);
    const edinetCode = String(r[1] ?? '').trim().toUpperCase();
    if (!code4 || !/^E\d{5}$/.test(edinetCode)) {
      if (r[0] && !String(r[0]).startsWith('#')) {
        log(`  警告: overrides.csv の行を解釈できませんでした: ${r.join(',')}`);
      }
      continue;
    }
    if (!map.has(code4)) map.set(code4, []);
    map.get(code4).push(edinetCode);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 突合
// ---------------------------------------------------------------------------

/**
 * stocklist の証券コードを EDINETコードリストと突合する。
 * 突合できなかったものは unmatched として必ず返す（黙って捨てない）。
 *
 * @param overrides loadOverrides() の結果（証券コード4桁 -> EDINETコード配列）
 */
export function matchStocks(stockList, codeList, overrides = new Map()) {
  const matched = [];
  const unmatched = [];

  for (const item of stockList.items) {
    let hits = codeList.bySecCode4.get(item.code4);
    let viaOverride = false;

    if (!hits || hits.length === 0) {
      const forced = overrides.get(item.code4);
      if (forced?.length) {
        hits = forced.map((ec) => codeList.byEdinetCode.get(ec)).filter(Boolean);
        viaOverride = true;
        const missing = forced.filter((ec) => !codeList.byEdinetCode.get(ec));
        if (missing.length) {
          unmatched.push({
            ...item,
            reason: `overrides.csv のEDINETコードがコードリストに存在しません: ${missing.join(', ')}`,
          });
        }
      }
    }

    if (!hits || hits.length === 0) {
      unmatched.push({
        ...item,
        reason:
          'EDINETコードリストに該当する証券コードがありません' +
          '（REIT/投資法人・ETFは証券コード列が空のため突合できません。overrides.csv で対応付けできます）',
      });
      continue;
    }

    for (const hit of hits) {
      matched.push({
        code4: item.code4,
        code5: hit.secCode5 || item.code5,
        stockName: item.name,
        edinetCode: hit.edinetCode,
        filerName: hit.filerName,
        industry: hit.industry,
        listed: hit.listed,
        filerType: hit.filerType,
        fiscalEnd: hit.fiscalEnd,
        duplicated: hits.length > 1,
        viaOverride,
      });
    }
  }

  const byEdinetCode = new Map(matched.map((m) => [m.edinetCode, m]));
  return { matched, unmatched, byEdinetCode };
}

/**
 * 名称の表記ゆれを落として比較用に正規化する。
 */
function normalizeName(name) {
  return String(name ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/株式会社|投資法人|有限会社|合同会社|ホールディングス|ＨＤ|HD/g, '')
    .replace(/[\s　・，,．.（）()「」【】＆&\/／-]/g, '')
    .toUpperCase();
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice係数による簡易な名称類似度（0〜1） */
function nameSimilarity(a, b) {
  const A = bigrams(normalizeName(a));
  const B = bigrams(normalizeName(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/**
 * 未マッチ銘柄について、銘柄名からEDINETコードリストの候補を提示する。
 * あくまで overrides.csv 記入の補助であり、自動では採用しない（誤突合を避けるため）。
 */
export function suggestByName(codeList, stockName, limit = 3) {
  if (!stockName) return [];
  return codeList.records
    .map((r) => ({ ...r, score: nameSimilarity(stockName, r.filerName) }))
    .filter((r) => r.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * stocklist に無い証券コードを EDINETコードリストから直接引く（画面検索用）。
 */
export function lookupBySecCode(codeList, rawCode) {
  const code4 = normalizeSecCode(rawCode);
  if (!code4) return [];
  return codeList.bySecCode4.get(code4) ?? [];
}
