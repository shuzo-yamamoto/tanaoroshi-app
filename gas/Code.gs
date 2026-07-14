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

var HEADER = ['提出日時', '棚卸名', '棚卸ID', '担当者', 'JANコード', '商品名', '単価', '数量', 'マスタ登録', '読取日時'];

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
      return [
        now,
        String(body.session && body.session.name || ''),
        String(body.session && body.session.id || ''),
        String(body.staff || ''),
        String(it.jan || ''),
        String(it.name || ''),
        it.price === '' || it.price == null ? '' : Number(it.price),
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
