import fsp from 'node:fs/promises';

import { PATHS, config, redact } from './config.js';
import { docTypeName } from './docTypes.js';

/**
 * 通知先が未設定なら黙ってスキップする方針のため、
 * ここでは「有効かどうか」だけを判定し、例外は投げない。
 */
function slackEnabled() {
  return config.notifySlack && Boolean(config.slackWebhookUrl);
}

function mailEnabled() {
  return config.notifyMail && Boolean(config.smtpHost) && Boolean(config.mailTo);
}

export function describeNotifyTargets() {
  const targets = [];
  if (slackEnabled()) targets.push('Slack');
  else if (config.notifySlack) targets.push('Slack(SLACK_WEBHOOK_URL未設定のためスキップ)');
  if (mailEnabled()) targets.push(`メール(${config.mailTo})`);
  else if (config.notifyMail) targets.push('メール(SMTP_HOST/MAIL_TO未設定のためスキップ)');
  return targets.length ? targets.join(' / ') : '未設定（通知しません）';
}

// ---------------------------------------------------------------------------
// 既読docIDの管理
// ---------------------------------------------------------------------------

export async function loadSeenDocIds() {
  try {
    const raw = await fsp.readFile(PATHS.seenDocs, 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed.docIds) ? parsed.docIds : []);
  } catch {
    return new Set();
  }
}

export async function saveSeenDocIds(docIds, existing = new Set()) {
  const merged = new Set(existing);
  for (const id of docIds) merged.add(id);
  await fsp.mkdir(PATHS.stateDir, { recursive: true });
  await fsp.writeFile(
    PATHS.seenDocs,
    JSON.stringify({ updatedAt: new Date().toISOString(), docIds: [...merged] }, null, 2),
    'utf8'
  );
  return merged;
}

/**
 * 初回実行時に過去30日分すべてを「新規」として通知してしまうのを防ぐため、
 * 既読ファイルが無い場合は通知せずに現状を既読として記録する。
 */
export async function isFirstRun() {
  try {
    await fsp.access(PATHS.seenDocs);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 本文の組み立て
// ---------------------------------------------------------------------------

function docLine(doc, baseUrl) {
  const date = (doc.submitDateTime || '').slice(0, 16);
  const name = doc.watchFilerName || doc.filerName || '(提出者名なし)';
  const code = doc.watchSecCode5 || '-';
  const type = docTypeName(doc.docTypeCode);
  const desc = doc.docDescription || '';
  const role = doc.matchRole && doc.matchRole !== 'self' ? `[${doc.matchRoleLabel}] ` : '';
  const link = doc.pdfFlag === '1' ? `${baseUrl}/doc/${doc.docID}.pdf` : `${baseUrl}/doc/${doc.docID}.zip`;
  return { date, name, code, type, desc, role, link };
}

function buildSlackPayload(docs, baseUrl) {
  const lines = docs.slice(0, 30).map((d) => {
    const l = docLine(d, baseUrl);
    return `• *${l.name}* (${l.code})　${l.date}\n　${l.role}${l.type}${l.desc ? `｜${l.desc}` : ''}\n　<${l.link}|書類を開く>`;
  });
  const more = docs.length > 30 ? `\n…他 ${docs.length - 30} 件` : '';
  return {
    text: `EDINET 新規書類 ${docs.length} 件`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `EDINET 新規書類 ${docs.length} 件`, emoji: false } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') + more } },
    ],
  };
}

function buildMailBody(docs, baseUrl) {
  const rows = docs.map((d) => {
    const l = docLine(d, baseUrl);
    return [
      `銘柄名   : ${l.name}`,
      `証券コード: ${l.code}`,
      `提出日   : ${l.date}`,
      `書類種別 : ${l.role}${l.type}`,
      `書類概要 : ${l.desc || '(なし)'}`,
      `リンク   : ${l.link}`,
    ].join('\n');
  });
  return (
    `EDINETで監視銘柄の新規書類が ${docs.length} 件検出されました。\n\n` +
    rows.join('\n\n----------------------------------------\n\n') +
    `\n\n※ リンクはローカルサーバ経由です。${baseUrl} が起動している必要があります。\n`
  );
}

// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------

async function sendSlack(docs, baseUrl, log) {
  try {
    const res = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSlackPayload(docs, baseUrl)),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    if (!res.ok || body.trim() !== 'ok') {
      log(`  [通知] Slack送信に失敗しました: HTTP ${res.status} ${redact(body).slice(0, 200)}`);
      return null;
    }
    return `Slack(${docs.length}件)`;
  } catch (e) {
    // 通知の失敗で本処理を落とさない
    log(`  [通知] Slack送信でエラーが発生しました: ${redact(e.message)}`);
    return null;
  }
}

async function sendMail(docs, baseUrl, log) {
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    log('  [通知] nodemailer が未インストールのためメール通知をスキップします（npm i nodemailer）。');
    return null;
  }

  try {
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    });
    await transport.sendMail({
      from: config.smtpUser || config.mailTo,
      to: config.mailTo,
      subject: `[EDINET] 監視銘柄の新規書類 ${docs.length} 件`,
      text: buildMailBody(docs, baseUrl),
    });
    return `メール(${docs.length}件)`;
  } catch (e) {
    log(`  [通知] メール送信でエラーが発生しました: ${redact(e.message)}`);
    return null;
  }
}

/**
 * 前回までに見ていない docID を検出し、新規分だけを通知して既読を更新する。
 *
 * 初回実行時は取得済みの全件が「新規」になってしまうため、通知はせず既読記録のみ行う。
 * サーバの定期ポーリングと CLI の check コマンドで共通に使う。
 *
 * @returns {{first:boolean, fresh:Array, sent:string[]}}
 */
export async function processNewDocuments(watchedDocs, { log = console.log } = {}) {
  const first = await isFirstRun();
  const seen = await loadSeenDocIds();
  const fresh = watchedDocs.filter((d) => d.docID && !seen.has(d.docID));
  let sent = [];

  if (first) {
    log(`通知: 初回実行のため既存 ${watchedDocs.length} 件を既読として記録します（通知はしません）。`);
  } else if (fresh.length) {
    log(`通知: 新規書類 ${fresh.length} 件を検知しました。`);
    sent = await notifyNewDocuments(fresh, { log });
    log(`  送信結果: ${sent.length ? sent.join(' / ') : '通知先が未設定のためスキップしました'}`);
  }

  await saveSeenDocIds(
    watchedDocs.map((d) => d.docID).filter(Boolean),
    seen
  );

  return { first, fresh, sent };
}

/**
 * 新規書類を通知する。通知先が未設定なら何もせず空配列を返す（エラーにしない）。
 * @returns {Promise<string[]>} 送信できた通知先の説明
 */
export async function notifyNewDocuments(docs, { log = console.log } = {}) {
  if (!docs.length) return [];
  const baseUrl = `http://localhost:${config.port}`;
  const sent = [];

  if (slackEnabled()) {
    const r = await sendSlack(docs, baseUrl, log);
    if (r) sent.push(r);
  }
  if (mailEnabled()) {
    const r = await sendMail(docs, baseUrl, log);
    if (r) sent.push(r);
  }
  return sent;
}
