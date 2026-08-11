const $ = (id) => document.getElementById(id);

/** 適時開示的な書類種別（プリセット用） */
const PRESET_TIMELY = ['180', '190', '220', '230', '240', '250', '260', '270', '280', '290', '300', '310', '320', '350', '360'];
const PRESET_PERIODIC = ['120', '130', '140', '150', '160', '170', '135', '136', '235', '236'];

let appState = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showBanner(message, isError = false) {
  const el = $('banner');
  if (!message) {
    el.hidden = true;
    return;
  }
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

async function loadState() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`サーバ状態の取得に失敗しました (HTTP ${res.status})`);
  appState = await res.json();

  $('refreshDays').value = appState.fetchDays;
  if (!$('qFrom').value) $('qFrom').value = appState.dateFrom;
  if (!$('qTo').value) $('qTo').value = appState.dateTo;

  const sel = $('qDocType');
  sel.innerHTML = appState.docTypes.map((d) => `<option value="${d.code}">${d.code} ${esc(d.name)}</option>`).join('');

  renderStatus();
  renderUnmatched();
  renderWatchlist();

  if (!appState.apiKeyConfigured) {
    showBanner(
      'EDINET_API_KEY が未設定です。.env.example を .env にコピーし、EDINET_API_KEY を設定してサーバを再起動してください。書類の取得はできません。',
      true
    );
  } else if (appState.lastError) {
    showBanner(`直近の取得でエラーが発生しました:\n${appState.lastError}`, true);
  } else {
    showBanner('');
  }
}

function renderStatus() {
  const s = appState;
  const parts = [
    `監視銘柄 ${s.matched} 件`,
    s.unmatched.length ? `未マッチ ${s.unmatched.length} 件` : null,
    `期間 ${s.dateFrom} 〜 ${s.dateTo}（${s.fetchDays}日）`,
    s.lastRefresh
      ? `最終取得 ${new Date(s.lastRefresh.at).toLocaleString('ja-JP')}（API ${s.lastRefresh.fetchedCount}日 / キャッシュ ${s.lastRefresh.cachedCount}日・全 ${s.lastRefresh.totalDocuments} 件）`
      : '未取得',
    `通知 ${esc(s.notifyTargets)}`,
  ].filter(Boolean);
  $('status').textContent = parts.join('　|　');
}

function renderUnmatched() {
  const list = appState.unmatched;
  $('unmatchedPanel').hidden = list.length === 0;
  $('unmatchedCount').textContent = list.length;
  if (!list.length) return;

  $('unmatchedBody').innerHTML =
    '<p class="reason">stocklist に載っているが EDINETコードリストと突合できなかった銘柄です。これらの書類は一覧に表示されません。</p>' +
    list
      .map((u) => {
        const sug = u.suggestions.length
          ? `<div class="suggest">銘柄名から推定される候補: ${u.suggestions
              .map((s) => `${esc(s.filerName)} <code>${esc(s.edinetCode)}</code> (${s.score}%)`)
              .join(' / ')}<br />→ <code>overrides.csv</code> に <code>${esc(u.code4)},${esc(u.suggestions[0].edinetCode)}</code> を追記すると突合されます。</div>`
          : '';
        return `<div style="margin-bottom:10px"><strong>${esc(u.code4)}</strong> ${esc(u.name || '(名称なし)')}
          <div class="reason">${esc(u.reason)}</div>${sug}</div>`;
      })
      .join('');
}

function renderWatchlist() {
  const list = appState.watchlist;
  $('watchlistPanel').hidden = list.length === 0;
  $('watchlistCount').textContent = list.length;
  if (!list.length) return;

  $('watchlistBody').innerHTML =
    `<table class="mini-table"><tbody>${list
      .map(
        (w) =>
          `<tr><td><strong>${esc(w.code5)}</strong></td><td>${esc(w.filerName)}</td><td class="reason">${esc(w.industry)}</td>` +
          `<td class="reason">${w.stockName ? `stocklist: ${esc(w.stockName)}` : ''}${w.viaOverride ? ' <span class="tag">overrides.csv</span>' : ''}</td></tr>`
      )
      .join('')}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// 検索
// ---------------------------------------------------------------------------

function currentQuery() {
  const docType = [...$('qDocType').selectedOptions].map((o) => o.value).join(',');
  return {
    code: $('qCode').value.trim(),
    name: $('qName').value.trim(),
    from: $('qFrom').value,
    to: $('qTo').value,
    role: $('qRole').value,
    scope: $('qScope').value,
    docType,
    excludeWithdrawn: $('qExcludeWithdrawn').checked ? '1' : '0',
  };
}

async function search() {
  const q = currentQuery();
  if (q.scope === 'all-edinet' && !q.code) {
    $('resultSummary').textContent = '「証券コード指定分のみ」を選んだ場合は、証券コードを入力してください。';
    $('results').innerHTML = '';
    return;
  }

  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null));
  $('resultSummary').textContent = '検索中…';

  const res = await fetch(`/api/documents?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    $('resultSummary').textContent = `検索に失敗しました: ${err.error ?? res.status}`;
    return;
  }
  const data = await res.json();
  renderResults(data, q);
}

function renderResults(data, q) {
  const summary = [`${data.total} 件`];
  if (data.truncated) summary.push(`（表示は先頭 ${data.items.length} 件）`);
  if (data.extraTargetCount) summary.push(`証券コード指定で stocklist 外の ${data.extraTargetCount} 社を検索対象に追加`);
  $('resultSummary').textContent = summary.join(' / ');

  if (!data.items.length) {
    $('results').innerHTML =
      '<div class="empty">該当する書類はありませんでした。<br />取得期間内に提出が無いか、条件が絞り込みすぎている可能性があります。</div>';
    return;
  }

  // 銘柄（証券コード＋提出者名）でグルーピング
  const groups = new Map();
  for (const d of data.items) {
    const key = `${d.secCode5}|${d.watchFilerName}`;
    if (!groups.has(key)) groups.set(key, { secCode5: d.secCode5, filerName: d.watchFilerName, stockName: d.stockName, industry: d.industry, outside: d.outsideWatchlist, rows: [] });
    groups.get(key).rows.push(d);
  }

  const sorted = [...groups.values()].sort((a, b) => String(a.secCode5).localeCompare(String(b.secCode5)));
  $('results').innerHTML = sorted.map(renderGroup).join('');
}

function renderGroup(g) {
  const rows = g.rows
    .slice()
    .sort((a, b) => String(b.submitDateTime).localeCompare(String(a.submitDateTime)))
    .map(renderRow)
    .join('');

  return `<section class="group">
    <div class="group-head">
      <span class="group-code">${esc(g.secCode5)}</span>
      <span class="group-name">${esc(g.filerName)}</span>
      ${g.stockName && g.stockName !== g.filerName ? `<span class="tag">stocklist: ${esc(g.stockName)}</span>` : ''}
      ${g.outside ? '<span class="tag outside">stocklist外</span>' : ''}
      <span class="group-meta">${esc(g.industry)}　${g.rows.length} 件</span>
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:78px">証券コード</th>
          <th style="width:190px">提出者名</th>
          <th style="width:96px">提出日</th>
          <th style="width:180px">書類種別</th>
          <th>書類概要</th>
          <th style="width:150px">リンク</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderRow(d) {
  const withdrawn = d.withdrawalStatus === '1' || d.withdrawalStatus === '2';

  let links;
  if (withdrawn) {
    links = '<span class="withdrawn">取下げ済み（取得不可）</span>';
  } else {
    const parts = [];
    if (d.pdfFlag === '1') parts.push(`<a href="/doc/${d.docID}.pdf" target="_blank" rel="noopener">PDF</a>`);
    parts.push(`<a href="/doc/${d.docID}.zip" title="提出本文書及び監査報告書(ZIP)">ZIP</a>`);
    if (d.csvFlag === '1') parts.push(`<a href="/doc/${d.docID}.zip?type=5" title="XBRLをCSV化したZIP">CSV</a>`);
    if (d.attachDocFlag === '1') parts.push(`<a href="/doc/${d.docID}.zip?type=3" title="代替書面・添付文書">添付</a>`);
    if (d.englishDocFlag === '1') parts.push(`<a href="/doc/${d.docID}.zip?type=4" title="英文ファイル">英文</a>`);
    links = parts.join('');
  }

  // 提出者が監視銘柄自身でない場合（大量保有報告書等）は提出者名と役割を明示する
  const roleTag = d.matchRole !== 'self' ? `<span class="role">${esc(d.matchRoleLabel)}</span>` : '';
  const filer =
    d.matchRole === 'self'
      ? esc(d.filerName || d.watchFilerName)
      : `${esc(d.filerName || '(提出者名なし)')}${roleTag}`;

  return `<tr>
    <td class="code">${esc(d.secCode5)}</td>
    <td>${filer}</td>
    <td class="date">${esc(d.submitDate)}</td>
    <td class="doctype">${esc(d.docTypeName)}</td>
    <td class="desc">${esc(d.docDescription)}</td>
    <td class="links">${links}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// 再取得
// ---------------------------------------------------------------------------

async function refresh(force) {
  const btns = [$('refreshBtn'), $('refreshForceBtn')];
  btns.forEach((b) => (b.disabled = true));
  $('status').textContent = force ? 'EDINETから強制再取得しています…' : 'EDINETから取得しています…';
  showBanner('');

  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: Number($('refreshDays').value) || undefined, force, reloadCsv: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(`取得に失敗しました:\n${data.error ?? res.status}`, true);
    }
    await loadState();
    await search();
  } catch (e) {
    showBanner(`取得に失敗しました: ${e.message}`, true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
    renderStatus();
  }
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------

function setupCollapse(toggleId, bodyId) {
  const toggle = $(toggleId);
  const body = $(bodyId);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
  });
}

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  search();
});

$('resetBtn').addEventListener('click', () => {
  $('qCode').value = '';
  $('qName').value = '';
  $('qRole').value = 'all';
  $('qScope').value = 'watchlist';
  $('qFrom').value = appState.dateFrom;
  $('qTo').value = appState.dateTo;
  $('qExcludeWithdrawn').checked = true;
  [...$('qDocType').options].forEach((o) => (o.selected = false));
  search();
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    const set = preset === 'timely' ? PRESET_TIMELY : preset === 'periodic' ? PRESET_PERIODIC : [];
    [...$('qDocType').options].forEach((o) => (o.selected = set.includes(o.value)));
  });
});

$('refreshBtn').addEventListener('click', () => refresh(false));
$('refreshForceBtn').addEventListener('click', () => refresh(true));

setupCollapse('unmatchedToggle', 'unmatchedBody');
setupCollapse('watchlistToggle', 'watchlistBody');

(async () => {
  try {
    await loadState();
    await search();
  } catch (e) {
    showBanner(`初期化に失敗しました: ${e.message}`, true);
    $('status').textContent = 'エラー';
  }
})();
