/**
 * Code.gs — 棚卸PWA 提出受け口(GAS Webアプリ)
 * 画箋堂 棚卸PWA v1.0
 *
 * 役割: PWAからのPOSTを受け、棚卸データをスプレッドシートに追記する
 *
 * ■ セットアップ手順(初回のみ)
 *   1. 保存先スプレッドシートを新規作成し、そのIDを下記 settings シートに設定
 *      …ではなく本スクリプトを「スプレッドシートに紐づくスクリプト」として作成するのが簡単:
 *      スプレッドシート → 拡張機能 → Apps Script → 本ファイルを貼り付け
 *   2. シート「settings」を作成し、A列にキー・B列に値:
 *        token | (任意の長い英数字。PWAの設定画面と同じ値にする)
 *   2-2. エディタで setupProductMaster() を1回実行(シート「商品マスタ」を用意)
 *   (v1.4.0へ更新するとき) 貼り直し→デプロイを管理→新しいバージョン。その後 setupDataSheetHeaders() を
 *        実行すると既存の棚卸データシートに K1〜N1 の見出しが入る(任意。提出時にも自動で補う)
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行: 自分
 *        アクセスできるユーザー: 全員
 *      ※「全員」にしないとPWA(fetch)からアクセスできない。
 *        そのため token による認証を必須としている(標準§3.5の趣旨)。
 *   4. 発行されたURL(…/exec)をPWAの「設定」タブに登録
 *
 * ■ 通信仕様(標準§3.1準拠)
 *   - リクエスト: POST, Content-Type: text/plain(CORSプリフライト回避), body=JSON
 *   - レスポンス: {success:true, data} | {success:false, error} のJSON文字列
 */
'use strict';

var SHEET_DATA = '棚卸データ';
var SHEET_SETTINGS = 'settings';
var SHEET_LOG = 'opsLog';
var SHEET_PRODUCTS = '商品マスタ';

// 拠点コードの許可リスト(README設計判断#16)。提出はこのシートに振り分ける:
//   GWH → 棚卸データ_GWH  … のように SHEET_DATA + '_' + 拠点。
// リスト外のコードは提出を弾く(不正な値でシートを乱造させないため)。
// 拠点を増やすときは app.js の LOCATIONS にも同じコードを足すこと。
var LOCATIONS = ['GWH', 'GWS', 'GWK', 'GWC'];

// 商品マスタの列は「1行目の見出し名」で探す(README設計判断#12)。
// スマレジCSVをそのままインポートしても、出力列が増減しても壊れないようにするため。
var HEADERS_JAN = ['商品コード', 'JAN', 'jan', 'バーコード'];
var HEADERS_NAME = ['商品名', '品名'];
var HEADERS_COST = ['原価', '仕入原価', '仕入価格', '仕入単価'];

var PRODUCTS_LIMIT_DEFAULT = 2000;
var PRODUCTS_LIMIT_MAX = 5000;

// G列は v1.1.0 で「単価(売価)」→「原価」に変更(README設計判断#9)。
// 見出しはシート新規作成時のみ書き込むため、運用中のシートは G1 を手動で直すこと。
// K〜N列は v1.4.0 で追加(未登録品の売価・税率・入力した税込額。README設計判断#21)。
// 既存シートの K1〜N1 は提出時に ensureHeader_ が補う(設計判断#22)。
var HEADER = ['提出日時', '棚卸名', '棚卸ID', '担当者', 'JANコード', '商品名', '原価', '数量', 'マスタ登録', '読取日時',
  '売価(税抜)', '税率(%)', '売価(税込・入力値)', '下代(税込・入力値)'];
/** v1.4.0 で追加した列の開始位置(0始まり。K列) */
var HEADER_EXT_FROM = 10;

// PWAが提出前に確認するAPIの版(README設計判断#23)。K〜N列を書けるのは 2 以上
var API_VERSION = 2;

/** POST受け口 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // トークン認証(全公開関数の先頭で毎回強制 — 標準§3.5)
    var token = getSetting_('token');
    if (!token) {
      return json_({ success: false, error: 'サーバー側の設定が未完了です。settingsシートに token を設定してください。' });
    }
    if (body.token !== token) {
      return json_({ success: false, error: '認証に失敗しました。PWAの設定画面のトークンを確認してください。' });
    }

    if (body.action === 'ping') {
      return json_({ success: true, data: { message: '棚卸提出先に接続できています。', apiVersion: API_VERSION } });
    }
    if (body.action === 'submit') {
      return json_(submit_(body));
    }
    if (body.action === 'getProducts') {
      return json_(getProducts_(body));
    }
    return json_({ success: false, error: '不明な操作です: ' + body.action });
  } catch (err) {
    return json_({ success: false, error: '受信データを処理できませんでした: ' + err.message });
  }
}

/** 棚卸データの追記(排他ロック必須 — 標準§3.2) */
function submit_(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { success: false, error: '他の端末が提出中です。少し待ってからもう一度お試しください。' };
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 拠点別シートへ振り分け(README設計判断#16)。未指定は従来の SHEET_DATA(後方互換)
    var loc = String(body.location || '').trim();
    if (loc && LOCATIONS.indexOf(loc) < 0) {
      return { success: false, error: '不明な拠点コードです: ' + loc + '(設定タブの拠点を確認してください)' };
    }
    var sheetName = loc ? (SHEET_DATA + '_' + loc) : SHEET_DATA;
    var sheet = ensureDataSheet_(ss, sheetName);

    var items = body.items || [];
    if (items.length === 0) return { success: false, error: '明細が0件です。' };

    // v1.3.x までのシートに K1〜N1 の見出しを補う。別の見出しがあれば書き込まずに止める(設計判断#22)
    var hdr = ensureHeader_(sheet);
    if (!hdr.ok) return { success: false, error: hdr.error };

    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    var rows = items.map(function (it) {
      // cost(v1.1.0以降)を優先し、無ければ price(v1.0系のPWA)を読む
      var cost = (it.cost === '' || it.cost == null) ? it.price : it.cost;
      return [
        now,
        String(body.session && body.session.name || ''),
        String(body.session && body.session.id || ''),
        String(body.staff || ''),
        String(it.jan || ''),
        String(it.name || ''),
        numOrBlank_(cost),
        Number(it.qty || 0),
        it.inMaster ? '○' : '×',
        String(it.scannedAt || ''),
        // K〜N: 未登録品の売価・税率・入力した税込額(v1.4.0。無ければ空欄 — 設計判断#21)
        numOrBlank_(it.sellEx),
        numOrBlank_(it.taxRate),
        numOrBlank_(it.sellIn),
        numOrBlank_(it.costIn)
      ];
    });

    // 一括書き込みのみ(セル単位set禁止 — 標準§3.2)
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADER.length).setValues(rows);

    appendLog_('submit', (body.staff || '不明') + ' が「' + (body.session && body.session.name) +
      '」を' + (loc ? '[' + loc + ']' : '') + '提出(' + rows.length + '行)' +
      (hdr.added ? '。K1〜N1 の見出しを追加' : ''));
    return { success: true, data: { rows: rows.length, sheet: sheetName, apiVersion: API_VERSION } };
  } catch (err) {
    return { success: false, error: '保存に失敗しました: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 棚卸データシートを取得。無ければ見出し・書式つきで作成する(README設計判断#16)。
 * JAN列(E)・棚卸ID列(C)・読取日時列(J)は日付誤変換を防ぐためプレーンテキスト書式(標準§4-1)。
 */
function ensureDataSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
  sheet.getRange('C:C').setNumberFormat('@');
  sheet.getRange('E:E').setNumberFormat('@');
  sheet.getRange('J:J').setNumberFormat('@');
  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * v1.4.0 で追加した K〜N 列の見出しを補う(README設計判断#22)。
 * 空欄のセルだけを埋める。別の文字が入っていたら、その列が他の用途に使われている
 * おそれがあるため何も書かずに ok:false を返す(売価等を混ぜ込まないため)。
 * @returns {{ok:boolean, added:number, error?:string}}
 */
function ensureHeader_(sheet) {
  var width = HEADER.length - HEADER_EXT_FROM;
  var cur = sheet.getRange(1, HEADER_EXT_FROM + 1, 1, width).getValues()[0];
  var blank = 0, conflicts = [];
  for (var i = 0; i < width; i++) {
    var v = String(cur[i] == null ? '' : cur[i]).trim();
    if (v === '') blank++;
    else if (v !== HEADER[HEADER_EXT_FROM + i]) conflicts.push(colLetter_(HEADER_EXT_FROM + i) + '1「' + v + '」');
  }
  if (conflicts.length) {
    return { ok: false, added: 0, error: 'シート「' + sheet.getName() + '」の ' + conflicts.join('・') +
      ' に別の見出しがあるため、売価などの列を追加できません。管理者に連絡してください(K〜N列を空けるか、その列を右へ移動)。' };
  }
  if (blank === 0) return { ok: true, added: 0 };
  // 既存の値は期待どおりの見出しなので、K1〜N1 をまとめて書けば空欄だけが埋まる(一括書き込み — 標準§3.2)
  sheet.getRange(1, HEADER_EXT_FROM + 1, 1, width)
    .setValues([HEADER.slice(HEADER_EXT_FROM)]).setFontWeight('bold');
  return { ok: true, added: blank };
}

/**
 * 既存の棚卸データシートすべての K1〜N1 見出しを点検・追加する(再デプロイ直後に1回手動実行 — 任意)。
 * 提出時にも自動で補うので実行しなくても動くが、衝突(K〜Nに別の見出し)があれば棚卸当日より前に分かる。
 */
function setupDataSheetHeaders() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('他の端末が提出中です。少し待ってから実行してください。');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var lines = [];
    ss.getSheets().forEach(function (sh) {
      var name = sh.getName();
      if (name !== SHEET_DATA && name.indexOf(SHEET_DATA + '_') !== 0) return;
      var r = ensureHeader_(sh);
      lines.push(name + ': ' + (!r.ok ? '要対応 — ' + r.error : (r.added ? 'K1〜N1 の見出しを追加' : '追加済み(変更なし)')));
    });
    var msg = lines.length ? lines.join('\n') : '棚卸データのシートがまだありません(初回の提出時に作成されます)。';
    appendLog_('setup', '見出し点検: ' + lines.join(' / '));
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** 0始まりの列番号 → 列名(A, B, …, Z, AA …) */
function colLetter_(i) {
  var s = '';
  for (var n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

/** 数値の列に書く値。空欄は空欄のまま、それ以外は数値にする */
function numOrBlank_(v) {
  return v === '' || v == null ? '' : Number(v);
}

/* ═══════════ 商品マスタ同期(getProducts) ═══════════ */

/**
 * シート「商品マスタ」を用意する(初回のみ手動実行)。
 * シート全体をプレーンテキスト書式にして、CSVインポート時にJANが数値化され
 * 先頭ゼロが落ちる・指数表記になるのを防ぐ(標準§4-1)。
 */
function setupProductMaster() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PRODUCTS);
  var created = false;
  if (!sheet) { sheet = ss.insertSheet(SHEET_PRODUCTS); created = true; }
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setNumberFormat('@');
  if (sheet.getFrozenRows() === 0) sheet.setFrozenRows(1);
  var msg = 'シート「' + SHEET_PRODUCTS + '」を' + (created ? '作成' : '再設定') +
    'しました。ファイル→インポート→「現在のシートを置き換える」でスマレジCSVを取り込んでください' +
    '(「テキストを数値、日付、数式に変換する」はオフ)。';
  appendLog_('setup', msg);
  Logger.log(msg);
  return msg;
}

/**
 * 商品マスタの取得(ページング)。読み取り専用のためロックは取らない。
 * リクエスト: {token, action:'getProducts', offset, limit}
 * レスポンス: {items:[{jan,name,cost}], total, offset, count}
 *   count は「読み進めた行数」で items.length とは一致しない(JAN不正行を除くため)。
 *   呼び出し側は offset を count ずつ進めること。
 */
function getProducts_(body) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_PRODUCTS);
    if (!sheet) {
      return { success: false, error: 'シート「' + SHEET_PRODUCTS + '」がありません。Apps Scriptで setupProductMaster() を1回実行してください。' };
    }
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) {
      return { success: false, error: 'シート「' + SHEET_PRODUCTS + '」にデータがありません。ファイル→インポートでスマレジCSVを取り込んでください。' };
    }

    var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var janIdx = findHeader_(header, HEADERS_JAN);
    var nameIdx = findHeader_(header, HEADERS_NAME);
    var costIdx = findHeader_(header, HEADERS_COST);
    // 位置決め打ちのフォールバックはしない。誤った列を黙って取り込まないため(設計判断#12)
    if (janIdx < 0 || nameIdx < 0) {
      return { success: false, error: '「商品マスタ」1行目の見出しが見つかりません(必要: ' +
        HEADERS_JAN[0] + ' / ' + HEADERS_NAME[0] + ')。1行目が見出し行になっているか確認してください。' };
    }

    var total = lastRow - 1;
    var offset = Math.max(0, Math.floor(Number(body.offset) || 0));
    var limit = Math.floor(Number(body.limit) || PRODUCTS_LIMIT_DEFAULT);
    if (!(limit > 0)) limit = PRODUCTS_LIMIT_DEFAULT;
    if (limit > PRODUCTS_LIMIT_MAX) limit = PRODUCTS_LIMIT_MAX;
    if (offset >= total) {
      return { success: true, data: { items: [], total: total, offset: offset, count: 0 } };
    }

    var count = Math.min(limit, total - offset);
    var values = sheet.getRange(2 + offset, 1, count, lastCol).getValues();
    var items = [];
    for (var i = 0; i < values.length; i++) {
      var jan = normCode_(values[i][janIdx]);
      if (!/^\d{4,14}$/.test(jan)) continue; // JANとして不正な行はスキップ(PWAのCSV取込と同じ判定)
      items.push({
        jan: jan,
        name: String(values[i][nameIdx] == null ? '' : values[i][nameIdx]).trim(),
        cost: costIdx >= 0 ? normCost_(values[i][costIdx]) : ''
      });
    }

    if (offset === 0) appendLog_('getProducts', '商品マスタ同期(全 ' + total + ' 行)');
    return { success: true, data: { items: items, total: total, offset: offset, count: count } };
  } catch (err) {
    return { success: false, error: '商品マスタを読み取れませんでした: ' + err.message };
  }
}

/** 見出し行から、候補文字列のいずれかを含む最初の列位置を返す(見つからなければ -1) */
function findHeader_(header, candidates) {
  for (var i = 0; i < header.length; i++) {
    var h = String(header[i] == null ? '' : header[i]).trim();
    if (!h) continue;
    for (var j = 0; j < candidates.length; j++) {
      if (h.indexOf(candidates[j]) >= 0) return i;
    }
  }
  return -1;
}

/** JAN等のコード値を文字列化。数値セルでも指数表記・小数点が付かないようにする */
function normCode_(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(Math.round(v));
  return String(v).trim();
}

/** 金額を数字だけの文字列に(空欄は空文字) */
function normCost_(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return String(v);
  return String(v).trim().replace(/[¥,\s]/g, '');
}

/** settingsシートからキー・バリュー取得(標準§3.3) */
function getSetting_(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!sheet) return null;
  var values = sheet.getDataRange().getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) return String(values[i][1]).trim();
  }
  return null;
}

/** 操作ログ(追記専用 — 標準§3.6) */
function appendLog_(op, detail) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_LOG) || ss.insertSheet(SHEET_LOG);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 3).setValues([['日時', '操作', '内容']]).setFontWeight('bold');
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 3).setValues([[
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'), op, detail
  ]]);
}

/** JSONレスポンス生成 */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
