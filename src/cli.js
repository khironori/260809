import { ConfigError, config, redact } from './config.js';
import {
  loadEdinetCodeList,
  loadStockList,
  matchStocks,
  downloadEdinetCodeList,
  loadOverrides,
  suggestByName,
} from './edinetCode.js';
import { collectDocuments, describeCacheState } from './edinetApi.js';
import { docTypeName } from './docTypes.js';
import { processNewDocuments, describeNotifyTargets } from './notify.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

function pad(s, width) {
  const str = String(s ?? '');
  // 全角文字を2文字幅として数える簡易実装
  let w = 0;
  for (const ch of str) w += /[　-鿿＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, width - w));
}

// ---------------------------------------------------------------------------
// codes: CSV読み込み＋突合の結果を表示する（ステップ1の動作確認用）
// ---------------------------------------------------------------------------
async function cmdCodes(args) {
  if (args.download) {
    await downloadEdinetCodeList();
    console.log('');
  }

  console.log('=== stocklist の読み込み ===');
  const stockList = await loadStockList();
  console.log(`  ファイル      : ${stockList.file}`);
  console.log(`  文字コード    : ${stockList.encoding}`);
  console.log(`  ヘッダ行      : ${stockList.hasHeader ? 'あり' : 'なし'}`);
  console.log(`  証券コード列  : ${stockList.codeColumn} (${stockList.codeColumnIndex + 1}列目)`);
  console.log(`  銘柄名列      : ${stockList.nameColumn ?? '(なし)'}`);
  console.log(`  読み込み件数  : ${stockList.items.length} 件`);
  if (stockList.invalid.length) {
    console.log(`  形式不正で除外: ${stockList.invalid.length} 件`);
    for (const iv of stockList.invalid) console.log(`      - "${iv.raw}" ${iv.name}`);
  }

  console.log('');
  console.log('=== EDINETコードリストの読み込み ===');
  const codeList = await loadEdinetCodeList();
  console.log(`  ダウンロード日: ${codeList.meta.downloadedAt}`);
  console.log(`  総レコード数  : ${codeList.records.length} 件`);
  console.log(`  証券コード有り: ${codeList.bySecCode4.size} 件（4桁ユニーク）`);

  const overrides = await loadOverrides();
  if (overrides.size) console.log(`  overrides.csv : ${overrides.size} 件の手動対応付けを読み込みました`);

  console.log('');
  console.log('=== 突合結果 ===');
  const { matched, unmatched } = matchStocks(stockList, codeList, overrides);
  const overrideCount = matched.filter((m) => m.viaOverride).length;
  console.log(`  マッチ    : ${matched.length} 件 / stocklist ${stockList.items.length} 件` + (overrideCount ? `（うち overrides.csv 経由 ${overrideCount} 件）` : ''));
  console.log(`  未マッチ  : ${unmatched.length} 件`);
  console.log('');

  if (args.verbose || args.v) {
    console.log('--- マッチ一覧 ---');
    console.log(`  ${pad('4桁', 6)}${pad('5桁', 7)}${pad('EDINET', 8)}${pad('提出者名', 34)}業種`);
    for (const m of matched) {
      console.log(
        `  ${pad(m.code4, 6)}${pad(m.code5, 7)}${pad(m.edinetCode, 8)}${pad(m.filerName, 34)}${m.industry}` +
          (m.duplicated ? '  ※同一証券コードに複数EDINETコード' : '')
      );
    }
    console.log('');
  }

  if (unmatched.length) {
    console.log('--- 未マッチ一覧（EDINETコードリストに該当なし） ---');
    for (const u of unmatched) {
      console.log(`  ${pad(u.code4, 6)}${pad(u.name || '(名称なし)', 30)}`);
      console.log(`         理由: ${u.reason}`);
      const cands = suggestByName(codeList, u.name);
      if (cands.length) {
        console.log('         銘柄名から推定される候補（overrides.csv 記入の参考。自動採用はしません）:');
        for (const c of cands) {
          console.log(`           ${c.edinetCode}  ${c.filerName}  [類似度 ${(c.score * 100).toFixed(0)}%]`);
        }
        console.log(`         → overrides.csv に「${u.code4},${cands[0].edinetCode}」を追記すると突合されます。`);
      }
    }
    console.log('');
    console.log('  ※ REIT/投資法人・ETFは EdinetcodeDlInfo.csv の証券コード列が空のため、証券コードでは突合できません。');
    console.log('  ※ そのほか未上場・上場廃止・コード変更でも発生します。');
    console.log('  ※ コードリストが古い可能性がある場合は npm run codes:update で最新化してください。');
  } else {
    console.log('  未マッチはありません。');
  }
}

// ---------------------------------------------------------------------------
// fetch: 書類一覧APIの取得＋キャッシュ（ステップ2の動作確認用）
// ---------------------------------------------------------------------------
async function cmdFetch(args) {
  const days = Number(args.days ?? config.fetchDays);
  if (!Number.isFinite(days) || days < 1) {
    throw new ConfigError(`--days の値が不正です: ${args.days}`);
  }

  const stockList = await loadStockList();
  const codeList = await loadEdinetCodeList();
  const { matched, unmatched } = matchStocks(stockList, codeList);
  console.log(`監視銘柄 ${matched.length} 件（未マッチ ${unmatched.length} 件）/ 取得期間 ${days} 日`);
  if (unmatched.length) {
    console.log(`  未マッチ: ${unmatched.map((u) => u.code4 + (u.name ? `(${u.name})` : '')).join(', ')}`);
  }
  console.log('');

  const result = await collectDocuments({ days, matchResult: { matched, unmatched }, force: Boolean(args.force) });

  console.log('');
  console.log('=== 取得結果 ===');
  console.log(`  対象日数        : ${result.dates.length} 日`);
  console.log(`  APIリクエスト数 : ${result.fetchedCount} 日分（キャッシュ再利用 ${result.cachedCount} 日分）`);
  console.log(`  全書類件数      : ${result.totalDocuments} 件`);
  console.log(`  監視銘柄の書類  : ${result.documents.length} 件`);
  console.log('');

  const limit = Number(args.limit ?? 40);
  const shown = result.documents.slice(0, limit);
  if (shown.length) {
    console.log(`--- 直近 ${shown.length} 件 ---`);
    console.log(`  ${pad('提出日', 12)}${pad('コード', 8)}${pad('提出者名', 28)}${pad('書類種別', 22)}概要`);
    for (const d of shown) {
      console.log(
        `  ${pad((d.submitDateTime || '').slice(0, 10), 12)}${pad(d.watchSecCode5 || '-', 8)}` +
          `${pad(d.watchFilerName || d.filerName || '-', 28)}${pad(docTypeName(d.docTypeCode), 22)}${d.docDescription || ''}`
      );
    }
    if (result.documents.length > shown.length) {
      console.log(`  ... 他 ${result.documents.length - shown.length} 件（--limit=N で表示件数を変更）`);
    }
  } else {
    console.log('  監視銘柄に該当する書類はありませんでした。');
  }

  console.log('');
  console.log(describeCacheState(result));
}

// ---------------------------------------------------------------------------
// check: 取得＋新規書類の通知（スケジューラから叩く用）
// ---------------------------------------------------------------------------
async function cmdCheck(args) {
  const days = Number(args.days ?? config.fetchDays);
  const stockList = await loadStockList();
  const codeList = await loadEdinetCodeList();
  const overrides = await loadOverrides();
  const matchResult = matchStocks(stockList, codeList, overrides);

  console.log(`通知先: ${describeNotifyTargets()}`);
  if (matchResult.unmatched.length) {
    console.log(`未マッチ ${matchResult.unmatched.length} 件: ${matchResult.unmatched.map((u) => u.code4).join(', ')}`);
  }

  const result = await collectDocuments({ days, matchResult });
  const { first, fresh } = await processNewDocuments(result.documents);

  console.log(`監視銘柄の書類 ${result.documents.length} 件 / うち新規 ${fresh.length} 件`);
  if (!first) {
    for (const d of fresh) {
      console.log(
        `  [新規] ${(d.submitDateTime || '').slice(0, 16)} ${d.watchSecCode5} ${d.watchFilerName} ${docTypeName(d.docTypeCode)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------

const COMMANDS = { codes: cmdCodes, fetch: cmdFetch, check: cmdCheck };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log('使い方:');
    console.log('  npm run codes                  CSV読み込みと突合の結果を表示');
    console.log('  npm run codes -- --verbose     マッチ一覧も表示');
    console.log('  npm run codes:update           EDINETコードリストを再取得してから突合');
    console.log('  npm run fetch -- --days=7      書類一覧APIを取得（キャッシュ利用）');
    console.log('  npm run fetch -- --days=7 --force   キャッシュを無視して再取得');
    console.log('  npm run check -- --days=3      取得して新規書類を通知');
    console.log('  npm start                      Web UI を起動');
    process.exitCode = 1;
    return;
  }
  await fn(args);
}

main().catch((err) => {
  console.error('');
  if (err instanceof ConfigError) {
    console.error(`[設定エラー] ${redact(err.message)}`);
  } else {
    console.error(`[エラー] ${redact(err.message)}`);
    if (process.env.DEBUG) console.error(redact(err.stack));
  }
  process.exitCode = 1;
});
