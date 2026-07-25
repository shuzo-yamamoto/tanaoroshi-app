/**
 * app.js — 画面遷移とアプリロジック
 * 画箋堂 棚卸PWA v1.0
 *
 * 画面構成(SPA):
 *   home → inv-start → inv-new / inv-select → scan ⇄ confirm / manual
 *   タブ: home / products(マスタ) / data(データ確認) / settings
 *
 * 提出: GAS WebアプリへPOST(text/plain JSON。CORSプリフライト回避)
 * オフライン: 明細はIndexedDBに常時保存。提出はオンライン時のみ。
 */
'use strict';

const APP_VERSION = '1.2.1';

/** 商品マスタ同期の1回あたり取得件数(README設計判断#13) */
const SYNC_PAGE_SIZE = 2000;
/** 1リクエストの上限時間。応答が返らずローディングが残り続けるのを防ぐ */
const SYNC_TIMEOUT_MS = 60000;

/* ═══════════ ユーティリティ ═══════════ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg, isErr = false, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => { t.hidden = true; }, ms);
}

function spinner(show, msg = '処理中…') {
  $('#spinner').hidden = !show;
  $('#spinner-msg').textContent = msg;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtPrice(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? String(v) : '¥' + n.toLocaleString('ja-JP');
}

/**
 * 金額(原価)の取得。
 * v1.1.0でキーを price → cost に改称したが、v1.0系で保存済みの
 * 商品マスタ・明細は price を持つため、そちらもフォールバックで読む。
 * (既存端末の再取込を不要にするための互換措置 — README設計判断#9)
 */
function costOf(o) {
  if (!o) return '';
  if (o.cost !== undefined && o.cost !== null && o.cost !== '') return o.cost;
  return (o.price === undefined || o.price === null) ? '' : o.price;
}

/** 設定(localStorage。使用不可環境ではメモリ保持にフォールバック — 標準§3.7) */
const Settings = (() => {
  let mem = {};
  let usable = true;
  try {
    localStorage.setItem('_t', '1');
    localStorage.removeItem('_t');
  } catch (e) { usable = false; }
  const KEY = 'gasendo-tanaoroshi-settings';
  function load() {
    if (!usable) return mem;
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  }
  function save(obj) {
    mem = obj;
    if (usable) localStorage.setItem(KEY, JSON.stringify(obj));
  }
  return { load, save };
})();

/* ═══════════ 画面遷移 ═══════════ */

const VIEW_TITLES = {
  'home': '在庫ツール',
  'inv-start': '棚卸を始める',
  'inv-new': '棚卸名の入力',
  'inv-select': '棚卸データの選択',
  'scan': 'スキャン',
  'manual': 'JAN手入力',
  'confirm': '数量の入力',
  'data': 'データ確認',
  'products': '商品情報',
  'csvmap': 'CSV取り込み',
  'product-add': '商品の個別登録',
  'settings': '設定'
};

// 戻る先の定義(ヘッダー左上「戻る」)
const BACK_TARGET = {
  'inv-start': 'home',
  'inv-new': 'inv-start',
  'inv-select': 'inv-start',
  'manual': 'scan',
  'csvmap': 'products',
  'product-add': 'products'
};

const TAB_OF_VIEW = {
  home: 'home', 'inv-start': 'home', 'inv-new': 'home', 'inv-select': 'home',
  scan: 'home', manual: 'home', confirm: 'home',
  data: 'data', products: 'products', csvmap: 'products', 'product-add': 'products',
  settings: 'settings'
};

let currentView = 'home';

async function goto(view) {
  // スキャン画面から離れるときはカメラ停止
  if (currentView === 'scan' && view !== 'scan') await Scanner.stop();

  $$('.view').forEach(v => { v.hidden = true; });
  const el = $('#view-' + view);
  if (!el) return;
  el.hidden = false;
  currentView = view;

  $('#header-title').textContent = VIEW_TITLES[view] || '';
  const back = BACK_TARGET[view];
  $('#btn-back').hidden = !back;
  $('#btn-back').dataset.target = back || '';

  const tab = TAB_OF_VIEW[view] || 'home';
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

  // 画面ごとの初期化
  if (view === 'inv-select') renderSessionList();
  if (view === 'scan') startScan();
  if (view === 'data') renderDataView();
  if (view === 'products') renderProducts();
  if (view === 'product-add') updatePaddButton();
  if (view === 'settings') renderSettings();

  window.scrollTo(0, 0);
}

/* ═══════════ 棚卸フロー ═══════════ */

let currentSession = null;   // {id, name, ...}
let pendingCode = null;      // 確認画面で扱っているJAN
let pendingProduct = null;   // マスタヒットした商品(なければnull)

// ── 新規作成 ──
async function createSession() {
  const name = $('#inv-name').value.trim();
  if (!name) { toast('棚卸データの名前を入力してください。', true); return; }
  currentSession = await dbCreateSession(name);
  $('#inv-name').value = '';
  toast(`「${name}」を作成しました。スキャンを開始します。`);
  goto('scan');
}

// ── 既存データ一覧 ──
async function renderSessionList() {
  const list = await dbListSessions();
  const ul = $('#session-list');
  ul.innerHTML = '';
  $('#session-empty').hidden = list.length > 0;
  for (const s of list) {
    const count = (await dbListItems(s.id)).length;
    const li = document.createElement('li');
    li.className = 'tappable';
    li.innerHTML = `
      <div class="grow">
        <div class="li-title"></div>
        <div class="li-sub">${fmtDate(s.updatedAt)} 更新 ・ ${count}件${s.submittedAt ? ' ・ 提出済' : ''}</div>
      </div>
      <span class="li-qty">›</span>`;
    li.querySelector('.li-title').textContent = s.name;
    li.addEventListener('click', () => { currentSession = s; goto('scan'); });
    ul.appendChild(li);
  }
}

// ── スキャン ──
async function startScan() {
  if (!currentSession) { goto('inv-start'); return; }
  $('#scan-session-name').textContent = currentSession.name;
  updateScanCount();
  $('#zoom-badge').hidden = true;
  try {
    const { torchSupported } = await Scanner.start($('#scan-video'), onCodeDetected);
    $('#btn-torch').hidden = !torchSupported;
  } catch (e) {
    console.error(e);
    toast('カメラを起動できませんでした。ブラウザのカメラ許可を確認するか、手入力をご利用ください。', true, 4500);
  }
}


async function updateScanCount() {
  if (!currentSession) return;
  const items = await dbListItems(currentSession.id);
  const total = items.reduce((a, b) => a + Number(b.qty || 0), 0);
  $('#scan-count').textContent = `${items.length}品目 / ${total}点`;
}

function onCodeDetected(code) {
  if (navigator.vibrate) navigator.vibrate(80); // Androidは振動でお知らせ
  // 読取は成功しているのに後段で例外が出ると「無反応」に見えるため、例外を画面に出す
  // (iOSではコンソールを見られないので、無言で失敗させない安全網)
  return Promise.resolve()
    .then(() => openConfirm(code))
    .catch(e => {
      console.error(e);
      toast('読取後の処理でエラー: ' + ((e && e.message) ? e.message : String(e)), true, 6000);
    });
}

// ── 商品確認・数量入力 ──
async function openConfirm(code) {
  await Scanner.stop();
  pendingCode = code;
  pendingProduct = await dbGetProduct(code);

  const card = $('#confirm-card');
  const status = $('#confirm-status');
  const newNameInput = $('#confirm-newname');

  $('#confirm-jan').textContent = code;
  if (pendingProduct) {
    card.classList.remove('unknown');
    status.textContent = '✓ 商品マスタに登録済み';
    status.className = 'product-status ok';
    $('#confirm-name').textContent = pendingProduct.name || '(名称未設定)';
    const c = costOf(pendingProduct);
    $('#confirm-cost').textContent = c === '' ? '' : '原価 ' + fmtPrice(c);
    newNameInput.hidden = true;
  } else {
    card.classList.add('unknown');
    status.textContent = '⚠ 商品マスタに見つかりません(このまま登録できます)';
    status.className = 'product-status ng';
    $('#confirm-name').textContent = '未登録の商品';
    $('#confirm-cost').textContent = '';
    newNameInput.hidden = false;
    newNameInput.value = '';
  }

  // 同一セッション内で既にスキャン済みなら注意表示
  const dup = await dbFindItemsByJan(currentSession.id, code);
  const note = $('#confirm-dup-note');
  if (dup.length > 0) {
    const sum = dup.reduce((a, b) => a + Number(b.qty || 0), 0);
    note.textContent = `⚠ この商品はこの棚卸で既に ${sum} 点登録されています(今回の数量は追加で記録されます)`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  $('#qty-input').value = 1;
  goto('confirm');
}

async function registerItem() {
  const qty = Number($('#qty-input').value);
  if (!Number.isFinite(qty) || qty < 0) { toast('数量は0以上の数字で入力してください。', true); return; }
  const name = pendingProduct ? pendingProduct.name : ($('#confirm-newname').value.trim() || '');
  await dbAddItem({
    sessionId: currentSession.id,
    jan: pendingCode,
    name: name,
    cost: pendingProduct ? costOf(pendingProduct) : '',
    inMaster: !!pendingProduct,
    qty: qty,
    scannedAt: new Date().toISOString()
  });
  toast(`登録しました：${name || pendingCode} × ${qty}`);
  goto('scan'); // 自動でカメラへ戻る
}

// ── 手入力 ──
function manualSearch() {
  const code = $('#manual-jan').value.trim();
  if (!/^\d{4,14}$/.test(code)) { toast('JANコードは数字で入力してください(通常13桁)。', true); return; }
  $('#manual-jan').value = '';
  openConfirm(code);
}

/* ═══════════ データ確認 ═══════════ */

async function renderDataView() {
  const sessions = await dbListSessions();
  const sel = $('#data-session-sel');
  sel.innerHTML = '';
  if (sessions.length === 0) {
    $('#data-summary').textContent = '';
    $('#item-list').innerHTML = '';
    $('#item-empty').hidden = false;
    $('#item-empty').textContent = '棚卸データがありません。ホームの「棚卸」から始めてください。';
    return;
  }
  for (const s of sessions) {
    const op = document.createElement('option');
    op.value = s.id;
    op.textContent = s.name + (s.submittedAt ? '(提出済)' : '');
    sel.appendChild(op);
  }
  // 直前に作業していたセッションを優先選択
  if (currentSession && sessions.some(s => s.id === currentSession.id)) {
    sel.value = currentSession.id;
  }
  await renderItems(sel.value);
}

async function renderItems(sessionId) {
  const items = await dbListItems(sessionId);
  const ul = $('#item-list');
  ul.innerHTML = '';
  $('#item-empty').hidden = items.length > 0;
  $('#item-empty').textContent = 'まだ商品が登録されていません。';

  const totalQty = items.reduce((a, b) => a + Number(b.qty || 0), 0);
  $('#data-summary').innerHTML = `<span>${items.length} 品目</span><span>合計 ${totalQty} 点</span>`;

  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="grow">
        <div class="li-title"></div>
        <div class="li-sub mono">${it.jan}</div>
        <div class="li-sub">${fmtDate(it.scannedAt)} ${it.inMaster ? '' : '<span class="li-badge ng">マスタ外</span>'}</div>
      </div>
      <span class="li-qty">${it.qty}<small> 点</small></span>
      <button class="li-del" aria-label="削除">🗑</button>`;
    li.querySelector('.li-title').textContent = it.name || '(名称なし)';
    li.querySelector('.li-qty').addEventListener('click', async () => {
      const v = prompt(`「${it.name || it.jan}」の数量を修正`, it.qty);
      if (v === null) return;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) { toast('数量は0以上の数字で入力してください。', true); return; }
      await dbUpdateItemQty(it.id, n);
      renderItems(sessionId);
    });
    li.querySelector('.li-del').addEventListener('click', async () => {
      if (!confirm(`「${it.name || it.jan}」(${it.qty}点)を削除しますか？`)) return;
      await dbDeleteItem(it.id);
      renderItems(sessionId);
    });
    ul.appendChild(li);
  }
}

/* ── CSV出力(UTF-8 BOM付き。Excelで文字化けしない) ── */
async function exportCsv() {
  const sessionId = $('#data-session-sel').value;
  if (!sessionId) { toast('出力する棚卸データがありません。', true); return; }
  const session = await dbGetSession(sessionId);
  const items = await dbListItems(sessionId);
  if (items.length === 0) { toast('出力する明細がありません。', true); return; }

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['棚卸名', 'JANコード', '商品名', '原価', '数量', '読取日時']];
  // 古い順に出力
  for (const it of [...items].reverse()) {
    rows.push([session.name, it.jan, it.name, costOf(it), it.qty, fmtDate(it.scannedAt)]);
  }
  const csv = '\uFEFF' + rows.map(r => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `棚卸_${session.name}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSVをダウンロードしました。');
}

/* ── Webへ提出(GAS → スプレッドシート) ── */
async function submitToWeb() {
  const conf = Settings.load();
  if (!conf.gasUrl) {
    toast('先に「設定」タブで提出先URLを登録してください。', true, 4000);
    goto('settings');
    return;
  }
  if (!navigator.onLine) { toast('オフラインです。電波のある場所で提出してください(データは端末に保存されています)。', true, 4500); return; }

  const sessionId = $('#data-session-sel').value;
  const session = await dbGetSession(sessionId);
  const items = await dbListItems(sessionId);
  if (items.length === 0) { toast('提出する明細がありません。', true); return; }
  if (session.submittedAt && !confirm('この棚卸データは提出済みです。もう一度提出しますか？(スプレッドシートに再度追記されます)')) return;

  spinner(true, 'スプレッドシートへ送信中…');
  try {
    // 通信は gasPost() に集約(エラー文言の統一・タイムアウト — 設計判断#15)
    const data = await gasPost({
      action: 'submit',
      session: { name: session.name, id: session.id },
      staff: conf.staff || '',
      // cost と price の両方を送る。gas/Code.gs を再デプロイしていない提出先でも
      // 金額が欠落しないようにするための互換措置(README設計判断#9)
      items: [...items].reverse().map(it => ({
        jan: it.jan, name: it.name, cost: costOf(it), price: costOf(it), qty: it.qty,
        inMaster: it.inMaster, scannedAt: it.scannedAt
      }))
    });
    await dbTouchSession(sessionId, { submittedAt: new Date().toISOString() });
    toast(`提出しました(${data.rows}行を保存)。`);
    renderDataView();
  } catch (e) {
    console.error(e);
    toast('提出に失敗しました：' + e.message + '(データは端末に残っています。もう一度提出してください)', true, 6000);
  } finally {
    spinner(false);
  }
}

async function deleteSession() {
  const sessionId = $('#data-session-sel').value;
  if (!sessionId) return;
  const session = await dbGetSession(sessionId);
  const items = await dbListItems(sessionId);
  const warn = session.submittedAt ? '' : '\n※この棚卸はまだ提出されていません。';
  if (!confirm(`「${session.name}」(${items.length}品目)を端末から削除しますか？${warn}\nこの操作は元に戻せません。`)) return;
  await dbDeleteSession(sessionId);
  if (currentSession && currentSession.id === sessionId) currentSession = null;
  toast('削除しました。');
  renderDataView();
}

/* ═══════════ 商品マスタ ═══════════ */

async function renderProducts() {
  const count = await dbCountProducts();
  $('#master-count').textContent = count.toLocaleString('ja-JP');
  const conf = Settings.load();
  if (conf.masterUpdatedAt) {
    const how = conf.masterSource === 'sync' ? '同期' : '取込';
    $('#master-updated').textContent = `最終${how}: ${fmtDate(conf.masterUpdatedAt)}`;
  } else {
    $('#master-updated').textContent = '未取込';
  }
  renderProductSearch();
}

/* ── スプレッドシートから同期(設計判断#11) ── */

/** GASへPOSTし data を返す。失敗時は throw(呼び出し側でtoast表示 — 標準§3.1) */
async function gasPost(payload, timeoutMs = SYNC_TIMEOUT_MS) {
  const conf = Settings.load();
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(conf.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライト回避
      body: JSON.stringify({ token: conf.token || '', ...payload }),
      signal: ctl.signal
    });
    // GASはURL誤り・デプロイ設定違いのときHTMLやエラーページを返す。
    // その場合 res.json() の例外文がそのまま画面に出ると原因が分からないので言い換える
    if (!res.ok) throw new Error(`サーバーがエラーを返しました(HTTP ${res.status})。提出先URLとデプロイ設定を確認してください。`);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('応答を解釈できませんでした。提出先URLが正しいか、デプロイの「アクセスできるユーザー」が「全員」になっているか確認してください。');
    }
    if (!json.success) throw new Error(json.error || '不明なエラー');
    return json.data;
  } catch (e) {
    // ブラウザ生の英語例外(Load failed / Failed to fetch など)は店頭スタッフに伝わらないため
    // 日本語の対処つき文言へ言い換える(README設計判断#15)。呼び出し側で用途(提出/同期/接続)を補う
    if (e.name === 'AbortError') throw new Error('応答がありません(60秒)。電波の良い場所でもう一度お試しください。');
    if (e instanceof TypeError) throw new Error('通信できませんでした。電波の良い場所でもう一度お試しください。');
    throw e;
  } finally {
    clearTimeout(tm);
  }
}

async function syncProducts() {
  const conf = Settings.load();
  if (!conf.gasUrl) {
    toast('先に「設定」タブで提出先URLを登録してください。', true, 4000);
    goto('settings');
    return;
  }
  if (!navigator.onLine) {
    toast('オフラインです。電波のある場所で同期してください(今のマスタはそのまま使えます)。', true, 4500);
    return;
  }

  spinner(true, '商品マスタを同期中…');
  try {
    // 全ページを取得し終えてから置き換える。途中で切れても既存マスタを壊さない(設計判断#13)
    const all = [];
    let offset = 0, total = 0;
    for (;;) {
      const data = await gasPost({ action: 'getProducts', offset, limit: SYNC_PAGE_SIZE });
      total = Number(data.total) || 0;
      for (const it of data.items) all.push(it);
      offset += Number(data.count) || 0;
      spinner(true, `商品マスタを同期中… ${offset.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')}件`);
      if (!data.count || offset >= total) break;
    }
    if (all.length === 0) {
      throw new Error(`スプレッドシートの「商品マスタ」から有効な商品を取得できませんでした(${total.toLocaleString('ja-JP')}行を確認)。JANコードの列を確認してください。`);
    }

    spinner(true, `端末の商品マスタを更新中…(${all.length.toLocaleString('ja-JP')}件)`);
    await dbReplaceProducts(all);

    const c = Settings.load();
    c.masterUpdatedAt = new Date().toISOString();
    c.masterSource = 'sync';
    Settings.save(c);

    const skipped = total - all.length;
    toast(`${all.length.toLocaleString('ja-JP')}件を同期しました${skipped > 0 ? `(JAN不正 ${skipped.toLocaleString('ja-JP')}行はスキップ)` : ''}。`, false, 4000);
    renderProducts();
  } catch (e) {
    console.error(e);
    toast('同期に失敗しました：' + e.message + '(端末の商品マスタはそのまま残っています)', true, 6000);
  } finally {
    spinner(false);
  }
}

async function renderProductSearch() {
  const kw = $('#product-search').value;
  const list = await dbSearchProducts(kw, 30);
  const ul = $('#product-list');
  ul.innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="grow">
        <div class="li-title"></div>
        <div class="li-sub mono">${p.jan}</div>
      </div>
      <span class="li-sub">${costOf(p) === '' ? '' : '原価 ' + fmtPrice(costOf(p))}</span>`;
    li.querySelector('.li-title').textContent = p.name || '(名称なし)';
    ul.appendChild(li);
  }
}

/* ── CSV取込 ── */

let csvParsed = null; // {headers:[], rows:[[]]}

function parseCsvText(text) {
  // シンプルなCSVパーサ(ダブルクォート・改行対応)
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some(v => v !== '')) rows.push(row); }
  return rows;
}

async function handleCsvFile(file) {
  spinner(true, 'CSVを読み込み中…');
  try {
    const buf = await file.arrayBuffer();
    // UTF-8で試し、文字化け(置換文字)が多ければShift_JISで読み直す(スマレジはSJISのことがある)
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (bad > 0) {
      try { text = new TextDecoder('shift_jis').decode(buf); } catch (e) { /* SJIS非対応環境はUTF-8のまま */ }
    }
    text = text.replace(/^\uFEFF/, '');
    const rows = parseCsvText(text);
    if (rows.length < 2) throw new Error('CSVにデータ行がありません(1行目は見出し、2行目以降にデータが必要です)。');
    csvParsed = { headers: rows[0], rows: rows.slice(1) };
    buildCsvMapUI();
    goto('csvmap');
  } catch (e) {
    toast('CSVを読み込めませんでした：' + e.message, true, 5000);
  } finally {
    spinner(false);
  }
}

function buildCsvMapUI() {
  const { headers, rows } = csvParsed;
  const guess = (cands) => {
    const idx = headers.findIndex(h => cands.some(c => h.trim().includes(c)));
    return idx;
  };
  const defaults = {
    jan: guess(['JAN', 'jan', 'バーコード', '商品コード']),
    name: guess(['商品名', '品名']),
    // 取り込むのは原価(スマレジCSVのH列)。「商品単価」(売価)や
    // 「オープン価格」(0/1のフラグ)を拾わないよう候補を原価系に限定する(設計判断#9)
    cost: guess(['原価', '仕入原価', '仕入価格', '仕入単価'])
  };
  for (const key of ['jan', 'name', 'cost']) {
    const sel = $('#map-' + key);
    sel.innerHTML = '';
    if (key === 'cost') {
      const op = document.createElement('option');
      op.value = '-1'; op.textContent = '(取り込まない)';
      sel.appendChild(op);
    }
    headers.forEach((h, i) => {
      const op = document.createElement('option');
      op.value = String(i);
      op.textContent = `${i + 1}列目: ${h}`;
      sel.appendChild(op);
    });
    sel.value = String(defaults[key] >= 0 ? defaults[key] : (key === 'cost' ? -1 : 0));
  }
  // プレビュー(先頭3行)
  const pv = $('#csv-preview');
  const head = headers.map(h => `<th>${h}</th>`).join('');
  const body = rows.slice(0, 3).map(r => '<tr>' + headers.map((_, i) => `<td>${r[i] ?? ''}</td>`).join('') + '</tr>').join('');
  pv.innerHTML = `<table><tr>${head}</tr>${body}</table><p class="hint">全 ${rows.length.toLocaleString('ja-JP')} 行(先頭3行を表示)</p>`;
}

async function importCsv() {
  const janIdx = Number($('#map-jan').value);
  const nameIdx = Number($('#map-name').value);
  const costIdx = Number($('#map-cost').value);
  spinner(true, '商品マスタを取り込み中…');
  try {
    const list = [];
    let skipped = 0;
    for (const r of csvParsed.rows) {
      const jan = String(r[janIdx] ?? '').trim();
      if (!/^\d{4,14}$/.test(jan)) { skipped++; continue; } // JANとして不正な行はスキップ
      list.push({
        jan: jan,
        name: String(r[nameIdx] ?? '').trim(),
        cost: costIdx >= 0 ? String(r[costIdx] ?? '').trim().replace(/[¥,\s]/g, '') : ''
      });
    }
    if (list.length === 0) throw new Error('取り込める行がありません。JANコードの列指定を確認してください。');
    await dbPutProducts(list);
    const conf = Settings.load();
    conf.masterUpdatedAt = new Date().toISOString();
    conf.masterSource = 'csv';
    Settings.save(conf);
    toast(`${list.length.toLocaleString('ja-JP')}件を取り込みました${skipped ? `(JAN不正 ${skipped}行はスキップ)` : ''}。`);
    csvParsed = null;
    goto('products');
  } catch (e) {
    toast(e.message, true, 5000);
  } finally {
    spinner(false);
  }
}

/**
 * JAN・商品名が両方入るまで登録ボタンを無効化(README設計判断#10)。
 * 無効化だけに頼らず addProductManually 側の検証も残す(二重の防御)。
 */
function updatePaddButton() {
  const jan = $('#padd-jan').value.trim();
  const name = $('#padd-name').value.trim();
  $('#btn-padd-save').disabled = !(jan && name);
}

async function addProductManually() {
  const jan = $('#padd-jan').value.trim();
  const name = $('#padd-name').value.trim();
  const cost = $('#padd-cost').value.trim();
  if (!jan) { toast('JANコードを入力してください。', true); return; }
  if (!/^\d{4,14}$/.test(jan)) { toast('JANコードは数字で入力してください(通常13桁)。', true); return; }
  if (!name) { toast('商品名を入力してください。', true); return; }
  await dbPutProducts([{ jan, name, cost }]);
  $('#padd-jan').value = ''; $('#padd-name').value = ''; $('#padd-cost').value = '';
  updatePaddButton();
  toast(`登録しました：${name}`);
  goto('products');
}

/* ═══════════ 設定 ═══════════ */

function renderSettings() {
  const conf = Settings.load();
  $('#set-staff').value = conf.staff || '';
  $('#set-gas').value = conf.gasUrl || '';
  $('#set-token').value = conf.token || '';
  $('#app-version').textContent = APP_VERSION;
}

function saveSettings() {
  const conf = Settings.load();
  conf.staff = $('#set-staff').value.trim();
  conf.gasUrl = $('#set-gas').value.trim();
  conf.token = $('#set-token').value.trim();
  Settings.save(conf);
  toast('設定を保存しました。');
}

async function testConnection() {
  const conf = Settings.load();
  if (!conf.gasUrl) { toast('提出先URLを入力してから保存してください。', true); return; }
  spinner(true, '接続テスト中…');
  try {
    const data = await gasPost({ action: 'ping' }); // 通信は gasPost() に集約(設計判断#15)
    toast('接続OK：' + (data.message || '応答あり'));
  } catch (e) {
    toast('接続に失敗しました：' + e.message, true, 5000);
  } finally {
    spinner(false);
  }
}

/* ═══════════ 初期化・イベント ═══════════ */

function updateNetBadge() {
  const b = $('#net-badge');
  const on = navigator.onLine;
  b.textContent = on ? 'オンライン' : 'オフライン';
  b.className = 'net-badge ' + (on ? 'online' : 'offline');
}

function init() {
  // Service Worker登録(オフライン対応)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* file://等では失敗するが動作は継続 */ });
  }

  updateNetBadge();
  window.addEventListener('online', updateNetBadge);
  window.addEventListener('offline', updateNetBadge);

  // 汎用: data-goto属性による遷移
  $$('[data-goto]').forEach(el => el.addEventListener('click', () => goto(el.dataset.goto)));
  $('#btn-back').addEventListener('click', () => goto($('#btn-back').dataset.target || 'home'));

  // タブ
  $$('.tab').forEach(t => t.addEventListener('click', () => goto(t.dataset.tab)));

  // 棚卸フロー
  $('#btn-inv-create').addEventListener('click', createSession);
  $('#inv-name').addEventListener('keydown', e => { if (e.key === 'Enter') createSession(); });

  // スキャン画面
  $('#scan-viewport').addEventListener('click', async () => {
    if (!Scanner.running) return;
    const label = await Scanner.cycleZoom();
    const badge = $('#zoom-badge');
    badge.textContent = label;
    badge.hidden = false;
  });
  $('#btn-torch').addEventListener('click', async (e) => {
    e.stopPropagation();
    const on = await Scanner.toggleTorch();
    toast(on ? 'ライトを点けました' : 'ライトを消しました', false, 1200);
  });
  $('#btn-manual').addEventListener('click', () => goto('manual'));
  $('#btn-scan-end').addEventListener('click', async () => {
    await Scanner.stop();
    goto('data'); // 終了したらデータ確認へ
  });

  // 手入力
  $('#btn-manual-ok').addEventListener('click', manualSearch);
  $('#manual-jan').addEventListener('keydown', e => { if (e.key === 'Enter') manualSearch(); });

  // 数量入力
  $('#qty-minus').addEventListener('click', () => {
    const el = $('#qty-input');
    el.value = Math.max(0, Number(el.value || 0) - 1);
  });
  $('#qty-plus').addEventListener('click', () => {
    const el = $('#qty-input');
    el.value = Number(el.value || 0) + 1;
  });
  $('#btn-register').addEventListener('click', registerItem);
  $('#btn-confirm-cancel').addEventListener('click', () => goto('scan'));

  // データ確認
  $('#data-session-sel').addEventListener('change', e => renderItems(e.target.value));
  $('#btn-resume-scan').addEventListener('click', async () => {
    const s = await dbGetSession($('#data-session-sel').value);
    if (!s) { toast('棚卸データを選択してください。', true); return; }
    currentSession = s;
    goto('scan');
  });
  $('#btn-submit').addEventListener('click', submitToWeb);
  $('#btn-csv').addEventListener('click', exportCsv);
  $('#btn-del-session').addEventListener('click', deleteSession);

  // 商品マスタ
  $('#btn-sync-products').addEventListener('click', syncProducts);
  $('#product-search').addEventListener('input', renderProductSearch);
  $('#csv-file').addEventListener('change', e => {
    if (e.target.files[0]) handleCsvFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#btn-csv-import').addEventListener('click', importCsv);
  $('#btn-product-add').addEventListener('click', () => goto('product-add'));
  $('#btn-padd-save').addEventListener('click', addProductManually);
  // 必須項目の入力状況を監視(IME変換中も拾えるよう input を使用)
  $('#padd-jan').addEventListener('input', updatePaddButton);
  $('#padd-name').addEventListener('input', updatePaddButton);

  // 設定
  $('#btn-set-save').addEventListener('click', saveSettings);
  $('#btn-set-test').addEventListener('click', testConnection);

  goto('home');
}

document.addEventListener('DOMContentLoaded', init);
