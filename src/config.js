import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PATHS = {
  root: ROOT,
  cacheDir: path.join(ROOT, 'cache'),
  stateDir: path.join(ROOT, 'state'),
  seenDocs: path.join(ROOT, 'state', 'seen-docs.json'),
  publicDir: path.join(ROOT, 'public'),
  // stocklist は実ファイル名が stocklist.csv.csv になっている場合があるため候補を順に探す
  stockListCandidates: [
    path.join(ROOT, 'stocklist.csv'),
    path.join(ROOT, 'stocklist.csv.csv'),
  ],
  edinetCodeCsv: path.join(ROOT, 'EdinetcodeDlInfo.csv'),
  // 証券コードで突合できない銘柄（REIT/投資法人など）を手動で対応付けるファイル
  overridesCsv: path.join(ROOT, 'overrides.csv'),
};

/** EDINET API 仕様書 4-1「EDINETコードリスト」に記載された公式の固定リンク */
export const EDINET_CODELIST_ZIP_URL =
  'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip';

export const EDINET_API_BASE = 'https://api.edinet-fsa.go.jp/api/v2';

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

export const config = {
  apiKey: (process.env.EDINET_API_KEY || '').trim(),
  fetchDays: num(process.env.FETCH_DAYS, 30),
  port: num(process.env.PORT, 3000),

  pollIntervalMin: num(process.env.POLL_INTERVAL_MIN, 60),
  todayCacheTtlMin: num(process.env.TODAY_CACHE_TTL_MIN, 15),
  requestDelayMinMs: num(process.env.REQUEST_DELAY_MIN_MS, 200),
  requestDelayMaxMs: num(process.env.REQUEST_DELAY_MAX_MS, 500),
  autoDownloadCodelist: bool(process.env.AUTO_DOWNLOAD_CODELIST, true),

  notifySlack: bool(process.env.NOTIFY_SLACK),
  slackWebhookUrl: (process.env.SLACK_WEBHOOK_URL || '').trim(),
  notifyMail: bool(process.env.NOTIFY_MAIL),
  smtpHost: (process.env.SMTP_HOST || '').trim(),
  smtpPort: num(process.env.SMTP_PORT, 587),
  smtpUser: (process.env.SMTP_USER || '').trim(),
  smtpPass: process.env.SMTP_PASS || '',
  mailTo: (process.env.MAIL_TO || '').trim(),
};

/**
 * APIキーが必要な処理の入口で呼ぶ。未設定なら原因が分かるメッセージで止める。
 */
export function requireApiKey() {
  if (!config.apiKey) {
    throw new ConfigError(
      'EDINET_API_KEY が設定されていません。\n' +
        '  1) .env.example を .env にコピーしてください（cp .env.example .env）\n' +
        '  2) .env の EDINET_API_KEY= に EDINET API v2 のAPIキーを設定してください\n' +
        '  APIキーの取得方法は README.md「APIキーの取得方法」を参照してください。'
    );
  }
  return config.apiKey;
}

/**
 * ログ・エラーメッセージ・HTTPレスポンスに出す文字列は必ずこれを通す。
 * 万一APIキーが混入していても伏字にする。
 */
export function redact(text) {
  let s = String(text ?? '');
  if (config.apiKey) {
    s = s.split(config.apiKey).join('***REDACTED***');
  }
  // Subscription-Key=... の形をまるごと伏字にする（別経路で混入した場合の保険）
  return s.replace(/(Subscription-Key=)[^&\s"']+/gi, '$1***REDACTED***');
}

/** 設定不備を表すエラー。CLI/サーバ側でスタックトレース無しに表示する。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}
