/**
 * db.js — IndexedDB データ層
 * 画箋堂 棚卸PWA
 *
 * ストア構成:
 *   products : 商品マスタ        key = jan   {jan, name, cost, updatedAt}
 *   sessions : 棚卸データ(親)     key = id    {id, name, createdAt, updatedAt, submittedAt}
 *   items    : 棚卸明細(子)       key = 自動   {id, sessionId, jan, name, cost, qty, scannedAt}
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

/** JANで商品1件取得(なければnull) */
async function dbGetProduct(jan) {
  const db = await dbOpen();
  const st = db.transaction('products').objectStore('products');
  return (await _reqToPromise(st.get(jan))) || null;
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

/** 同一セッション内の同一JANの既存明細を取得(重複スキャンの確認用) */
async function dbFindItemsByJan(sessionId, jan) {
  const db = await dbOpen();
  const idx = db.transaction('items').objectStore('items').index('bySessionJan');
  return _reqToPromise(idx.getAll([sessionId, jan]));
}
