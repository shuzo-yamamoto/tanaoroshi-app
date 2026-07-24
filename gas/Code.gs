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

// 商品マスタの列は「1行目の見出し名」で探す(README設計判断#12)。
// スマレジCSVをそのままインポートしても、出力列が増減しても壊れないようにするため。
var HEADERS_JAN = ['商品コード', 'JAN', 'jan', 'バーコード'];
var HEADERS_NAME = ['商品名', '品名'];
var HEADERS_COST = ['原価', '仕入原価', '仕入価格', '仕入単価'];

var PRODUCTS_LIMIT_DEFAULT = 2000;
var PRODUCTS_LIMIT_MAX = 5000;

// G列は v1.1.0 で「単価(売価)」→「原価」に変更(README設計判断#9)。
// 見出しはシート新規作成時のみ書き込むため、運用中のシートは G1 を手動で直すこと。
var HEADER = ['提出日時', '棚卸名', '棚卸ID', '担当者', 'JANコード', '商品名', '原価', '数量', 'マスタ登録', '読取日時'];

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
      return json_({ success: true, data: { message: '棚卸提出先に接続できています。' } });
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
    var sheet = ss.getSheetByName(SHEET_DATA);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_DATA);
      sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
      // JAN列(E)・棚卸ID列(C)は日付誤変換を防ぐためプレーンテキスト書式(標準§4-1)
      sheet.getRange('C:C').setNumberFormat('@');
      sheet.getRange('E:E').setNumberFormat('@');
      sheet.getRange('J:J').setNumberFormat('@');
    }

    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    var items = body.items || [];
    if (items.length === 0) return { success: false, error: '明細が0件です。' };

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
        cost === '' || cost == null ? '' : Number(cost),
        Number(it.qty || 0),
        it.inMaster ? '○' : '×',
        String(it.scannedAt || '')
      ];
    });

    // 一括書き込みのみ(セル単位set禁止 — 標準§3.2)
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADER.length).setValues(rows);

    appendLog_('submit', (body.staff || '不明') + ' が「' + (body.session && body.session.name) + '」を提出(' + rows.length + '行)');
    return { success: true, data: { rows: rows.length } };
  } catch (err) {
    return { success: false, error: '保存に失敗しました: ' + err.message };
  } finally {
    lock.releaseLock();
  }
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
