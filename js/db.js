/**
 * db.js — IndexedDB データ層
 * 画箋堂 棚卸PWA
 *
 * ストア構成:
 *   products : 商品マスタ        key = jan   {jan, name, cost, updatedAt}
 *   sessions : 棚卸データ(親)     key = id    {id, name, createdAt, updatedAt, submittedAt}
 *   items    : 棚卸明細(子)       key = 自動   {id, sessionId, jan, name, cost, qty, scannedAt,
 *                                               sellEx, taxRate, sellIn, costIn}
 *     sellEx〜costIn は v1.4.0 で追加(未登録品の売価(税抜)・税率・入力した税込の売価/下代。
 *     README設計判断#21)。v1.3.x以前の明細には無いので app.js の priceExtOf() を通して読む。
 *     **新しいキーに price は使わない**(下記の costOf() が原価のフォールバックとして読むため)
 *
 * 金額キーについて(README設計判断#9):
 *   v1.1.0 で price(売価想定) → cost(原価) に改称した。
 *   v1.0系で保存済みのレコードは price を持つため、読み出しは app.js の
 *   costOf() を通すこと。DBバージョンは上げず、移行処理も行わない
 *   (既存端末のマスタ再取込・登録済み明細を無効にしないため)。
 *
 * 方針(開発標準§3準拠):
 *   - 全公開関数は Promise を返し、失敗時は throw(呼び出し側でtoast表示)
 *   - 物理削除はセッション削除時のみ(端末ローカルの作業データのため)
 */
'use strict';

const DB_NAME = 'gasendo-tanaoroshi';
const DB_VER = 1;
let _db = null;

function dbOpen() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('products')) {
        db.createObjectStore('products', { keyPath: 'jan' });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('items')) {
        const st = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
        st.createIndex('bySession', 'sessionId', { unique: false });
        st.createIndex('bySessionJan', ['sessionId', 'jan'], { unique: false });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(new Error('データベースを開けませんでした。ブラウザのプライベートモードでは使用できません。'));
  });
}

function _tx(store, mode, fn) {
  return dbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    let result;
    try { result = fn(st); } catch (err) { reject(err); return; }
    tx.oncomplete = () => resolve(result && result._get ? result.value : result);
    tx.onerror = () => reject(tx.error || new Error('データベース処理に失敗しました。'));
  }));
}

function _reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ───────── JANの先頭0の揺れ(README設計判断#19・不具合ログ#3) ─────────
 * スプレッドシート/Excelを経由するとJANが数値化され、先頭の0が落ちることがある。
 * GS1規格では GTIN-8/12/13/14 は「左に0を詰めて14桁にした形で一意」なので、
 * 先頭0だけが違うコードは同一商品とみなしてよい。
 */

/** GS1のチェックデジット(末尾1桁)が正しいか。先頭に0を足しても結果は変わらない */
function gs1CheckDigitOk(code) {
  const s = String(code || '');
  if (!/^\d{2,}$/.test(s)) return false;
  let sum = 0;
  // チェックデジットの左隣から左へ、重み 3,1,3,1… を掛けて合計する
  for (let i = s.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(s[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(s[s.length - 1]);
}

/**
 * マスタ取込時の正規化。9〜12桁でチェックデジットが正しいコードは、先頭0が落ちた
 * EAN-13(UPC-Aを含む)とみなして13桁に0詰めする。スキャナ(EAN_13)の読取値とそろえるため。
 * 8桁・13桁・14桁と7桁以下は変えない(短い店内コードを誤って書き換えないため)。
 */
function normalizeMasterJan(code) {
  const s = String(code == null ? '' : code).trim();
  if (/^\d{9,12}$/.test(s) && gs1CheckDigitOk(s)) return s.padStart(13, '0');
  return s;
}

/**
 * 照合用の候補キー。先頭0を外した核に0を足した形を14桁まで並べる。
 * よく使う桁数(13→8→12→14)を先に置き、同じ商品が複数形で入っていても標準形を優先する。
 */
function janZeroVariants(code) {
  const s = String(code == null ? '' : code).trim();
  if (!/^\d+$/.test(s)) return [];
  const core = s.replace(/^0+/, '');
  if (!core || core.length > 14) return [];
  const out = [];
  for (let len = core.length; len <= 14; len++) out.push(core.padStart(len, '0'));
  const rank = (k) => { const i = [13, 8, 12, 14].indexOf(k.length); return i < 0 ? 4 : i; };
  return out.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
}

/* ───────── 商品マスタ ───────── */

/** 商品マスタを一括登録(CSV取込)。既存JANは上書き */
async function dbPutProducts(list) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('products', 'readwrite');
    const st = tx.objectStore('products');
    const now = new Date().toISOString();
    for (const p of list) st.put({ ...p, updatedAt: now });
    tx.oncomplete = () => resolve(list.length);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 商品マスタを全件置換(スプレッドシート同期用 — README設計判断#13/#14)。
 * clear と put を1トランザクションで行うため、途中で失敗すれば既存マスタは残る。
 * 呼び出し側は「全ページを取得し終えてから」渡すこと。
 */
async function dbReplaceProducts(list) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('products', 'readwrite');
    const st = tx.objectStore('products');
    st.clear();
    const now = new Date().toISOString();
    for (const p of list) st.put({ ...p, updatedAt: now });
    tx.oncomplete = () => resolve(list.length);
    tx.onerror = () => reject(tx.error || new Error('商品マスタの置き換えに失敗しました。'));
    tx.onabort = () => reject(tx.error || new Error('商品マスタの置き換えが中断されました(端末の空き容量を確認してください)。'));
  });
}

/**
 * JANで商品1件取得(なければnull)。
 * 完全一致を優先し、無いときだけ先頭0の有無が違うキーを探す(README設計判断#19)。
 */
async function dbGetProduct(jan) {
  const db = await dbOpen();
  const exact = await _reqToPromise(db.transaction('products').objectStore('products').get(jan));
  if (exact) return exact;

  const keys = janZeroVariants(jan).filter(k => k !== jan);
  if (keys.length === 0) return null;
  // 要求は同じ tick でまとめて発行する。1件ずつ await すると、iOS Safari では
  // その間にトランザクションが閉じて後続の get が失敗することがあるため
  const st = db.transaction('products').objectStore('products');
  const results = await Promise.all(keys.map(k => _reqToPromise(st.get(k))));
  return results.find(Boolean) || null;
}

/** 商品マスタ件数 */
async function dbCountProducts() {
  const db = await dbOpen();
  const st = db.transaction('products').objectStore('products');
  return _reqToPromise(st.count());
}

/** 商品マスタ検索(部分一致・最大limit件) */
async function dbSearchProducts(keyword, limit = 50) {
  const db = await dbOpen();
  const st = db.transaction('products').objectStore('products');
  const kw = (keyword || '').trim().toLowerCase();
  return new Promise((resolve, reject) => {
    const out = [];
    const cur = st.openCursor();
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (!c || out.length >= limit) return resolve(out);
      const p = c.value;
      if (!kw || p.jan.includes(kw) || (p.name || '').toLowerCase().includes(kw)) out.push(p);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

/* ───────── 棚卸セッション ───────── */

async function dbCreateSession(name) {
  const s = {
    id: 'S' + Date.now(),
    name: name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    submittedAt: null
  };
  await _tx('sessions', 'readwrite', st => st.put(s));
  return s;
}

async function dbListSessions() {
  const db = await dbOpen();
  const st = db.transaction('sessions').objectStore('sessions');
  const all = await _reqToPromise(st.getAll());
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function dbGetSession(id) {
  const db = await dbOpen();
  const st = db.transaction('sessions').objectStore('sessions');
  return (await _reqToPromise(st.get(id))) || null;
}

async function dbTouchSession(id, patch = {}) {
  const s = await dbGetSession(id);
  if (!s) return;
  Object.assign(s, patch, { updatedAt: new Date().toISOString() });
  await _tx('sessions', 'readwrite', st => st.put(s));
}

/** セッションと明細をまとめて削除 */
async function dbDeleteSession(id) {
  const items = await dbListItems(id);
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'items'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    const st = tx.objectStore('items');
    for (const it of items) st.delete(it.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ───────── 棚卸明細 ───────── */

async function dbAddItem(item) {
  await _tx('items', 'readwrite', st => st.put(item));
  await dbTouchSession(item.sessionId);
}

async function dbUpdateItemQty(itemId, qty) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite');
    const st = tx.objectStore('items');
    const req = st.get(itemId);
    req.onsuccess = () => {
      const it = req.result;
      if (!it) return resolve();
      it.qty = qty;
      st.put(it);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteItem(itemId) {
  await _tx('items', 'readwrite', st => st.delete(itemId));
}

async function dbListItems(sessionId) {
  const db = await dbOpen();
  const idx = db.transaction('items').objectStore('items').index('bySession');
  const all = await _reqToPromise(idx.getAll(sessionId));
  return all.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt)); // 新しい順
}

/**
 * 同一セッション内の同じ商品の既存明細を取得(重複スキャンの確認用)。
 * 先頭0だけが違うJANで登録された明細も同じ商品として含める(README設計判断#20)。
 */
async function dbFindItemsByJan(sessionId, jan) {
  const db = await dbOpen();
  const idx = db.transaction('items').objectStore('items').index('bySessionJan');
  const keys = [...new Set([jan, ...janZeroVariants(jan)])];
  // 要求は同じ tick でまとめて発行する(dbGetProduct と同じ理由)
  const lists = await Promise.all(keys.map(k => _reqToPromise(idx.getAll([sessionId, k]))));
  const seen = new Set();
  return lists.flat().filter(it => !seen.has(it.id) && seen.add(it.id));
}
