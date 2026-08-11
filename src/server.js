import express from 'express';

import { PATHS, config, redact, ConfigError } from './config.js';
import {
  loadEdinetCodeList,
  loadStockList,
  matchStocks,
  loadOverrides,
  suggestByName,
  normalizeSecCode,
} from './edinetCode.js';
import {
  collectDocuments,
  annotateDocuments,
  targetsFromMatchResult,
  fetchDocumentBinary,
  isValidDocId,
  DOC_FETCH_TYPES,
  dateRange,
  jstDateString,
} from './edinetApi.js';
import { docTypeName, docTypeOptions, ordinanceName } from './docTypes.js';
import { processNewDocuments, describeNotifyTargets } from './notify.js';

// ---------------------------------------------------------------------------
// アプリ状態（起動時に読み込み、/api/refresh で更新）
// ---------------------------------------------------------------------------

const state = {
  stockList: null,
  codeList: null,
  overrides: null,
  matchResult: null,
  watchTargets: new Map(),
  allDocuments: [],
  perDate: [],
  lastRefresh: null,
  refreshing: false,
  lastError: null,
};

async function loadCsvLayer(log = console.log) {
  state.stockList = await loadStockList({ log });
  state.codeList = await loadEdinetCodeList({ log });
  state.overrides = await loadOverrides({ log });
  state.matchResult = matchStocks(state.stockList, state.codeList, state.overrides);
  state.watchTargets = targetsFromMatchResult(state.matchResult);

  log(`stocklist: ${state.stockList.items.length} 件 / マッチ ${state.matchResult.matched.length} 件 / 未マッチ ${state.matchResult.unmatched.length} 件`);
  for (const u of state.matchResult.unmatched) {
    log(`  [未マッチ] ${u.code4} ${u.name || '(名称なし)'} — ${u.reason}`);
  }
}

async function refreshDocuments({
  days = config.fetchDays,
  force = false,
  notify = true,
  cacheOnly = false,
  log = console.log,
} = {}) {
  if (state.refreshing) throw new Error('すでに取得処理が実行中です。しばらく待ってから再実行してください。');
  state.refreshing = true;
  try {
    const result = await collectDocuments({ days, matchResult: state.matchResult, force, cacheOnly, log });
    state.allDocuments = result.allDocuments;
    state.perDate = result.perDate;
    state.lastRefresh = {
      at: new Date().toISOString(),
      days,
      cacheOnly,
      fetchedCount: result.fetchedCount,
      cachedCount: result.cachedCount,
      missingDates: result.missingDates?.length ?? 0,
      totalDocuments: result.totalDocuments,
      watchedDocuments: result.documents.length,
    };
    state.lastError = null;

    if (notify) await processNewDocuments(result.documents, { log });
    return result;
  } finally {
    state.refreshing = false;
  }
}

// ---------------------------------------------------------------------------
// 検索
// ---------------------------------------------------------------------------

/**
 * 検索条件に応じた突合対象を作る。
 *
 * 証券コードが指定された場合は、stocklist に無い銘柄でも
 * EDINETコードリストから引いて検索対象に加える（要件）。
 */
function buildTargets({ code, scope }) {
  const targets = new Map();
  const extra = [];

  if (scope !== 'all-edinet') {
    for (const [k, v] of state.watchTargets) targets.set(k, v);
  }

  const q = String(code ?? '').trim().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (q) {
    // 4桁/5桁どちらでも、また部分一致でも引けるようにする
    for (const rec of state.codeList.records) {
      if (!rec.secCode4) continue;
      if (!rec.secCode4.includes(q) && !rec.secCode5.includes(q)) continue;
      if (targets.has(rec.edinetCode)) continue;
      const t = {
        code4: rec.secCode4,
        secCode5: rec.secCode5,
        filerName: rec.filerName,
        industry: rec.industry,
        stockName: '',
        outsideWatchlist: true,
      };
      targets.set(rec.edinetCode, t);
      extra.push({ edinetCode: rec.edinetCode, secCode5: rec.secCode5, filerName: rec.filerName });
    }
  }

  return { targets, extra };
}

function searchDocuments(query) {
  const { targets, extra } = buildTargets(query);
  let docs = annotateDocuments(state.allDocuments, targets);

  const code = String(query.code ?? '').trim().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (code) {
    docs = docs.filter((d) => (d.watchSecCode4 || '').includes(code) || (d.watchSecCode5 || '').includes(code));
  }

  const name = String(query.name ?? '').trim();
  if (name) {
    const n = name.toLowerCase();
    docs = docs.filter(
      (d) =>
        (d.watchFilerName || '').toLowerCase().includes(n) ||
        (d.watchStockName || '').toLowerCase().includes(n) ||
        (d.filerName || '').toLowerCase().includes(n)
    );
  }

  const docTypes = String(query.docType ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (docTypes.length) {
    docs = docs.filter((d) => docTypes.includes(String(d.docTypeCode ?? '')));
  }

  const from = String(query.from ?? '').trim();
  const to = String(query.to ?? '').trim();
  if (from) docs = docs.filter((d) => (d.submitDateTime || '').slice(0, 10) >= from);
  if (to) docs = docs.filter((d) => (d.submitDateTime || '').slice(0, 10) <= to);

  const role = String(query.role ?? '').trim();
  if (role && role !== 'all') docs = docs.filter((d) => d.matchRole === role);

  if (String(query.excludeWithdrawn ?? '') === '1') {
    docs = docs.filter((d) => d.withdrawalStatus !== '1' && d.withdrawalStatus !== '2');
  }

  return { docs, extra };
}

/** 画面に返す形へ整形（内部情報や不要フィールドを落とす） */
function toViewModel(d) {
  return {
    docID: d.docID,
    secCode5: d.watchSecCode5,
    secCode4: d.watchSecCode4,
    stockName: d.watchStockName,
    watchFilerName: d.watchFilerName,
    filerName: d.filerName,
    industry: d.watchIndustry,
    submitDate: (d.submitDateTime || '').slice(0, 10),
    submitDateTime: d.submitDateTime || '',
    docTypeCode: d.docTypeCode ?? '',
    docTypeName: docTypeName(d.docTypeCode),
    ordinanceName: ordinanceName(d.ordinanceCode),
    docDescription: d.docDescription || '',
    matchRole: d.matchRole,
    matchRoleLabel: d.matchRoleLabel,
    outsideWatchlist: Boolean(d.outsideWatchlist),
    withdrawalStatus: d.withdrawalStatus ?? '0',
    pdfFlag: d.pdfFlag ?? '0',
    xbrlFlag: d.xbrlFlag ?? '0',
    csvFlag: d.csvFlag ?? '0',
    attachDocFlag: d.attachDocFlag ?? '0',
    englishDocFlag: d.englishDocFlag ?? '0',
    parentDocID: d.parentDocID || '',
  };
}

// ---------------------------------------------------------------------------
// HTTPサーバ
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(PATHS.publicDir));

app.get('/api/state', (req, res) => {
  const dates = dateRange(config.fetchDays);
  res.json({
    stockList: {
      file: state.stockList.file.replace(PATHS.root, '.'),
      encoding: state.stockList.encoding,
      codeColumn: state.stockList.codeColumn,
      nameColumn: state.stockList.nameColumn,
      count: state.stockList.items.length,
      invalid: state.stockList.invalid,
    },
    codeList: {
      downloadedAt: state.codeList.meta.downloadedAt,
      records: state.codeList.records.length,
    },
    matched: state.matchResult.matched.length,
    overrideCount: state.matchResult.matched.filter((m) => m.viaOverride).length,
    unmatched: state.matchResult.unmatched.map((u) => ({
      code4: u.code4,
      name: u.name,
      reason: u.reason,
      suggestions: suggestByName(state.codeList, u.name).map((s) => ({
        edinetCode: s.edinetCode,
        filerName: s.filerName,
        score: Math.round(s.score * 100),
      })),
    })),
    watchlist: state.matchResult.matched.map((m) => ({
      code5: m.code5,
      code4: m.code4,
      filerName: m.filerName,
      stockName: m.stockName,
      industry: m.industry,
      viaOverride: Boolean(m.viaOverride),
    })),
    docTypes: docTypeOptions(),
    fetchDays: config.fetchDays,
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    today: jstDateString(),
    perDate: state.perDate,
    lastRefresh: state.lastRefresh,
    refreshing: state.refreshing,
    lastError: state.lastError,
    notifyTargets: describeNotifyTargets(),
    pollIntervalMin: config.pollIntervalMin,
    apiKeyConfigured: Boolean(config.apiKey),
  });
});

app.get('/api/documents', (req, res) => {
  try {
    const { docs, extra } = searchDocuments(req.query);
    const limit = Math.min(Number(req.query.limit) || 2000, 5000);
    res.json({
      total: docs.length,
      truncated: docs.length > limit,
      extraTargets: extra.slice(0, 50),
      extraTargetCount: extra.length,
      items: docs.slice(0, limit).map(toViewModel),
    });
  } catch (e) {
    res.status(500).json({ error: redact(e.message) });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const days = Number(req.body?.days) || config.fetchDays;
    const force = Boolean(req.body?.force);
    if (req.body?.reloadCsv) await loadCsvLayer();
    await refreshDocuments({ days, force });
    res.json({ ok: true, lastRefresh: state.lastRefresh });
  } catch (e) {
    state.lastError = redact(e.message);
    const status = e instanceof ConfigError ? 400 : 502;
    res.status(status).json({ error: redact(e.message) });
  }
});

/**
 * 書類取得APIのプロキシ。
 * APIキーはサーバ側でのみ付与し、HTMLやリダイレクト先には一切出さない。
 *   /doc/S1234567.pdf  -> type=2 (PDF)
 *   /doc/S1234567.zip  -> type=1 (提出本文書及び監査報告書)
 *   /doc/S1234567.zip?type=5 -> CSV(ZIP) など type を明示指定
 */
app.get('/doc/:file', async (req, res) => {
  const m = /^([A-Za-z0-9]{8})\.(pdf|zip)$/.exec(req.params.file || '');
  if (!m) {
    res.status(400).type('text/plain; charset=utf-8').send('URLの形式が不正です。/doc/{書類管理番号}.pdf または .zip を指定してください。');
    return;
  }
  const [, docID, ext] = m;

  let type = ext === 'pdf' ? '2' : '1';
  if (req.query.type !== undefined) {
    const t = String(req.query.type);
    if (!DOC_FETCH_TYPES[t]) {
      res.status(400).type('text/plain; charset=utf-8').send('type は 1〜5 を指定してください。');
      return;
    }
    type = t;
  }

  if (!isValidDocId(docID)) {
    res.status(400).type('text/plain; charset=utf-8').send('書類管理番号の形式が不正です。');
    return;
  }

  try {
    const { buffer, contentType } = await fetchDocumentBinary(docID, type);
    const filename = `${docID}_type${type}.${DOC_FETCH_TYPES[type].ext}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `${DOC_FETCH_TYPES[type].ext === 'pdf' ? 'inline' : 'attachment'}; filename="${filename}"`
    );
    res.send(buffer);
  } catch (e) {
    const status = e instanceof ConfigError ? 400 : 502;
    res.status(status).type('text/plain; charset=utf-8').send(redact(e.message));
  }
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

let pollTimer = null;

function startPolling() {
  if (config.pollIntervalMin <= 0) {
    console.log('定期ポーリングは無効です（POLL_INTERVAL_MIN=0）。');
    return;
  }
  const ms = config.pollIntervalMin * 60_000;
  console.log(`定期ポーリング: ${config.pollIntervalMin} 分ごとに新規書類を確認します。`);
  pollTimer = setInterval(async () => {
    try {
      console.log(`[${new Date().toLocaleString('ja-JP')}] 定期チェックを実行します。`);
      await refreshDocuments({ log: (m) => console.log('  ' + m) });
    } catch (e) {
      // 定期処理の失敗でサーバを落とさない
      state.lastError = redact(e.message);
      console.error(`  [定期チェック失敗] ${redact(e.message)}`);
    }
  }, ms);
  pollTimer.unref?.();
}

async function main() {
  console.log('EDINET Watchlist を起動しています...');
  console.log('');

  await loadCsvLayer();
  console.log('');

  if (!config.apiKey) {
    console.warn('警告: EDINET_API_KEY が未設定です。');
    console.warn('  .env.example を .env にコピーし、EDINET_API_KEY を設定してください。');
    console.warn('  既存のキャッシュがあればそれだけを読み込んで閲覧できますが、新規取得・PDF取得はできません。');
    await refreshDocuments({ cacheOnly: true, notify: false, log: () => {} });
    console.warn(
      `  キャッシュから ${state.lastRefresh.cachedCount} 日分 / 全 ${state.lastRefresh.totalDocuments} 件を読み込みました。`
    );
    console.warn('');
  } else {
    try {
      await refreshDocuments({ log: (m) => console.log(m) });
      console.log('');
      console.log(
        `取得完了: 全 ${state.lastRefresh.totalDocuments} 件 / 監視銘柄 ${state.lastRefresh.watchedDocuments} 件` +
          `（API ${state.lastRefresh.fetchedCount} 日 / キャッシュ ${state.lastRefresh.cachedCount} 日）`
      );
    } catch (e) {
      // 取得に失敗してもUIは開けるようにする（原因は画面と標準出力に出す）
      state.lastError = redact(e.message);
      console.error('');
      console.error(`[取得エラー] ${redact(e.message)}`);
      console.error('  Web UI は起動します。原因を解消してから画面の「再取得」を押してください。');
    }
    console.log('');
    console.log(`通知先: ${describeNotifyTargets()}`);
    startPolling();
  }

  app.listen(config.port, () => {
    console.log('');
    console.log(`  ブラウザで開いてください: http://localhost:${config.port}`);
    console.log('');
  });
}

main().catch((err) => {
  console.error('');
  if (err instanceof ConfigError) {
    console.error(`[設定エラー] ${redact(err.message)}`);
  } else {
    console.error(`[起動エラー] ${redact(err.message)}`);
    if (process.env.DEBUG) console.error(redact(err.stack));
  }
  process.exit(1);
});
