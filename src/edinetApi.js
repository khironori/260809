import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PATHS, EDINET_API_BASE, config, requireApiKey, redact, ConfigError } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** リクエスト間ウェイト（既定 200〜500ms のランダム） */
function requestDelayMs() {
  const min = config.requestDelayMinMs;
  const max = Math.max(min, config.requestDelayMaxMs);
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// 日付ユーティリティ（EDINETの日付は日本時間basis）
// ---------------------------------------------------------------------------

/** 日本時間での YYYY-MM-DD */
export function jstDateString(d = new Date()) {
  const jst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  const day = String(jst.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今日から遡って days 日分の日付（古い順） */
export function dateRange(days) {
  const today = new Date();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(jstDateString(new Date(today.getTime() - i * 86_400_000)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// キャッシュ
// ---------------------------------------------------------------------------

function cachePath(date) {
  return path.join(PATHS.cacheDir, `${date}.json`);
}

async function readCache(date) {
  try {
    const raw = await fsp.readFile(cachePath(date), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.results)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(date, payload) {
  await fsp.mkdir(PATHS.cacheDir, { recursive: true });
  await fsp.writeFile(cachePath(date), JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * キャッシュを使うべきか判定する。
 * - 過去日: 提出書類は確定しているので常に再利用する（再取得しない）
 * - 当日  : 日中に書類が追加されるため TODAY_CACHE_TTL_MIN を過ぎたら再取得する
 */
function isCacheFresh(date, cached) {
  if (!cached) return false;
  if (date !== jstDateString()) return true;
  const ageMin = (Date.now() - new Date(cached.fetchedAt).getTime()) / 60_000;
  return Number.isFinite(ageMin) && ageMin < config.todayCacheTtlMin;
}

// ---------------------------------------------------------------------------
// 書類一覧API
// ---------------------------------------------------------------------------

/**
 * EDINET API はエラー時も HTTP 200 を返し、本文JSONの metadata.status / StatusCode に
 * 実際のステータスが入る（仕様書 3-3）。そのため本文を見て判定する。
 */
function interpretApiError(json) {
  if (json && typeof json.StatusCode === 'number' && json.StatusCode !== 200) {
    return { status: String(json.StatusCode), message: json.message || '' };
  }
  const status = json?.metadata?.status;
  if (status && status !== '200') {
    return { status: String(status), message: json?.metadata?.message || '' };
  }
  return null;
}

function apiErrorToMessage(date, err) {
  switch (err.status) {
    case '401':
      return (
        `EDINET APIキーが無効です（401）。\n` +
        '  .env の EDINET_API_KEY を、APIキー発行画面に表示されている値と照合してください。'
      );
    case '400':
      return `EDINET APIへのリクエスト内容が不正です（400 ${err.message}）。日付=${date}`;
    case '404':
      return `EDINET APIにデータが存在しません（404）。日付=${date}\n  EDINETで取得できるのは過去10年分までです。`;
    case '429':
      return `EDINET APIへのリクエストが多すぎます（429）。時間を空けて再実行してください。`;
    case '500':
      return `EDINET API側でエラーが発生しました（500）。EDINETのメンテナンス情報を確認してください。日付=${date}`;
    default:
      return `EDINET APIがエラーを返しました（${err.status} ${err.message}）。日付=${date}`;
  }
}

/**
 * 指定日の提出書類一覧を取得する（キャッシュ優先）。
 * @returns {{date, results, metadata, fetchedAt, fromCache:boolean}}
 */
export async function fetchDocumentsForDate(date, { force = false, log = console.log } = {}) {
  if (!force) {
    const cached = await readCache(date);
    if (isCacheFresh(date, cached)) {
      return { ...cached, fromCache: true };
    }
  }

  const apiKey = requireApiKey();
  const url = new URL(`${EDINET_API_BASE}/documents.json`);
  url.searchParams.set('date', date);
  url.searchParams.set('type', '2'); // 2 = 提出書類一覧及びメタデータ
  url.searchParams.set('Subscription-Key', apiKey);

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'edinet-watchlist/1.0 (local use)' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const detail = e.name === 'TimeoutError' ? 'タイムアウト（30秒）' : e.message;
      throw new Error(
        `EDINET APIへの接続に失敗しました（ネットワークエラー: ${redact(detail)}）。日付=${date}\n` +
          '  ネットワーク接続・プロキシ設定・EDINETのメンテナンス情報を確認してください。'
      );
    }

    if (!res.ok) {
      throw new Error(
        `EDINET APIが予期しないHTTPステータスを返しました（HTTP ${res.status} ${res.statusText}）。日付=${date}\n` +
          '  EDINETがメンテナンス中の可能性があります。'
      );
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(
        `EDINET APIのレスポンスをJSONとして解釈できませんでした。日付=${date}\n` +
          '  EDINETがメンテナンス画面を返している可能性があります。'
      );
    }

    const err = interpretApiError(json);
    if (err) {
      if (err.status === '429' && attempt < maxAttempts) {
        const waitMs = 2000 * attempt * attempt;
        log(`  429 Too Many Requests。${Math.round(waitMs / 1000)}秒待って再試行します (${attempt}/${maxAttempts - 1})`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(apiErrorToMessage(date, err));
    }

    const payload = {
      date,
      fetchedAt: new Date().toISOString(),
      metadata: json.metadata ?? null,
      results: Array.isArray(json.results) ? json.results : [],
    };
    await writeCache(date, payload);
    return { ...payload, fromCache: false };
  }

  throw new Error(`EDINET APIへのリクエストが規定回数失敗しました（429継続）。日付=${date}`);
}

// ---------------------------------------------------------------------------
// 監視銘柄への突合
// ---------------------------------------------------------------------------

/**
 * 書類が監視対象のどのEDINETコードに関係するかを判定する。
 *
 * 大量保有報告書・公開買付届出書などは提出者が第三者で、対象会社は
 * subjectEdinetCode 側に入る（仕様書 3-1-2-2）。そのため自社提出(edinetCode)に加えて
 * 対象会社・発行会社・子会社の各コードも突合する。
 */
const MATCH_FIELDS = [
  { field: 'edinetCode', role: 'self', label: '自社提出' },
  { field: 'subjectEdinetCode', role: 'subject', label: '対象会社' },
  { field: 'issuerEdinetCode', role: 'issuer', label: '発行会社' },
  { field: 'subsidiaryEdinetCode', role: 'subsidiary', label: '子会社' },
];

/**
 * subsidiaryEdinetCode は複数コードがカンマ等で連結される場合があるため分割する。
 */
function codesIn(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 生の書類レコード配列から、監視対象(targets)に該当するものを抽出して注記を付ける。
 * @param {Array} docs 生の書類レコード
 * @param {Map<string, {secCode5, filerName, code4, industry, stockName}>} targets EDINETコード -> 銘柄情報
 */
export function annotateDocuments(docs, targets) {
  const out = [];
  const seen = new Set();

  for (const doc of docs) {
    for (const { field, role, label } of MATCH_FIELDS) {
      for (const code of codesIn(doc[field])) {
        const target = targets.get(code);
        if (!target) continue;
        const key = `${doc.docID}|${code}|${role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...doc,
          watchEdinetCode: code,
          watchSecCode4: target.code4,
          watchSecCode5: target.secCode5,
          watchFilerName: target.filerName,
          watchStockName: target.stockName || '',
          watchIndustry: target.industry || '',
          matchRole: role,
          matchRoleLabel: label,
        });
      }
    }
  }

  out.sort((a, b) => String(b.submitDateTime || '').localeCompare(String(a.submitDateTime || '')));
  return out;
}

/** matchStocks() の結果から annotateDocuments 用の targets を作る */
export function targetsFromMatchResult(matchResult) {
  const map = new Map();
  for (const m of matchResult.matched) {
    map.set(m.edinetCode, {
      code4: m.code4,
      secCode5: m.code5,
      filerName: m.filerName,
      industry: m.industry,
      stockName: m.stockName,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 期間まとめ取得
// ---------------------------------------------------------------------------

/**
 * 指定日数分の書類一覧を取得する。
 * 書類一覧APIは日付ごとにしか返さないため、日数分ループする。
 */
export async function collectDocuments({
  days,
  matchResult,
  force = false,
  cacheOnly = false,
  log = console.log,
} = {}) {
  const dates = dateRange(days);
  const allDocuments = [];
  const perDate = [];
  const missingDates = [];
  let fetchedCount = 0;
  let cachedCount = 0;
  let needDelay = false;

  for (const date of dates) {
    // APIキーが無い場合などは、既存キャッシュだけで組み立てる（取得はしない）
    if (cacheOnly) {
      const cached = await readCache(date);
      if (!cached) {
        missingDates.push(date);
        continue;
      }
      cachedCount++;
      perDate.push({ date, count: cached.results.length, fromCache: true, fetchedAt: cached.fetchedAt });
      for (const r of cached.results) allDocuments.push(r);
      continue;
    }

    if (needDelay) await sleep(requestDelayMs());

    const day = await fetchDocumentsForDate(date, { force, log });
    if (day.fromCache) {
      cachedCount++;
      needDelay = false;
    } else {
      fetchedCount++;
      needDelay = true;
      log(`  ${date}: ${day.results.length} 件を取得しました`);
    }

    perDate.push({ date, count: day.results.length, fromCache: day.fromCache, fetchedAt: day.fetchedAt });
    for (const r of day.results) allDocuments.push(r);
  }

  const targets = targetsFromMatchResult(matchResult);
  const documents = annotateDocuments(allDocuments, targets);

  return {
    dates,
    perDate,
    missingDates,
    fetchedCount,
    cachedCount,
    totalDocuments: allDocuments.length,
    allDocuments,
    documents,
    targets,
  };
}

export function describeCacheState(result) {
  const lines = [`キャッシュ: ${PATHS.cacheDir}`];
  const today = jstDateString();
  const todayEntry = result.perDate.find((p) => p.date === today);
  if (todayEntry) {
    lines.push(
      `  当日(${today})分は TTL ${config.todayCacheTtlMin} 分で再取得します（最終取得: ${
        todayEntry.fetchedAt ? new Date(todayEntry.fetchedAt).toLocaleString('ja-JP') : '-'
      }）`
    );
  }
  lines.push('  過去日分は再取得しません。強制的に取り直す場合は --force を付けてください。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 書類取得API（PDF/ZIP のプロキシ用）
// ---------------------------------------------------------------------------

/** 書類管理番号は英数字8文字。想定外の値をそのままURLに載せない。 */
export function isValidDocId(docID) {
  return /^[A-Za-z0-9]{8}$/.test(String(docID ?? ''));
}

export const DOC_FETCH_TYPES = {
  1: { ext: 'zip', label: '提出本文書及び監査報告書(ZIP)', contentType: 'application/octet-stream' },
  2: { ext: 'pdf', label: 'PDF', contentType: 'application/pdf' },
  3: { ext: 'zip', label: '代替書面・添付文書(ZIP)', contentType: 'application/octet-stream' },
  4: { ext: 'zip', label: '英文ファイル(ZIP)', contentType: 'application/octet-stream' },
  5: { ext: 'zip', label: 'CSV(ZIP)', contentType: 'application/octet-stream' },
};

/**
 * 書類取得API から実ファイルを取得する。
 *
 * このAPIも成功/失敗ともHTTP 200を返すため、Content-Type で判定する（仕様書 3-2-2 / 3-3）。
 * application/json が返ってきた場合はエラー本文である。
 * @returns {{buffer: Buffer, contentType: string}}
 */
export async function fetchDocumentBinary(docID, type) {
  if (!isValidDocId(docID)) {
    throw new ConfigError(`書類管理番号の形式が不正です: ${String(docID).slice(0, 32)}`);
  }
  const t = String(type);
  if (!DOC_FETCH_TYPES[t]) {
    throw new ConfigError(`必要書類の種別が不正です: ${String(type).slice(0, 8)}（1〜5を指定してください）`);
  }

  const apiKey = requireApiKey();
  const url = new URL(`${EDINET_API_BASE}/documents/${docID}`);
  url.searchParams.set('type', t);
  url.searchParams.set('Subscription-Key', apiKey);

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'edinet-watchlist/1.0 (local use)' },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    const detail = e.name === 'TimeoutError' ? 'タイムアウト（120秒）' : e.message;
    throw new Error(`EDINETからの書類取得に失敗しました（ネットワークエラー: ${redact(detail)}）。`);
  }

  if (!res.ok) {
    throw new Error(`EDINETからの書類取得に失敗しました（HTTP ${res.status} ${res.statusText}）。`);
  }

  const contentType = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());

  if (contentType.includes('application/json')) {
    let err = null;
    try {
      err = interpretApiError(JSON.parse(buffer.toString('utf8')));
    } catch {
      /* JSONとして読めない場合はそのまま下のメッセージへ */
    }
    if (err?.status === '401') {
      throw new Error('EDINET APIキーが無効です（401）。.env の EDINET_API_KEY を確認してください。');
    }
    if (err?.status === '404') {
      throw new Error(
        `この書類は取得できません（404）。docID=${docID} type=${t}\n` +
          '  取下げられた書類・開示対象外の書類、または該当形式が存在しない場合に発生します。'
      );
    }
    throw new Error(
      `EDINETが書類ではなくエラーを返しました（${err ? `${err.status} ${err.message}` : '詳細不明'}）。docID=${docID} type=${t}`
    );
  }

  return { buffer, contentType: contentType || DOC_FETCH_TYPES[t].contentType };
}

export function cacheDirExists() {
  return fs.existsSync(PATHS.cacheDir);
}
