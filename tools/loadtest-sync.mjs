#!/usr/bin/env node
/**
 * loadtest-sync.mjs — 商品マスタ同期の同時実行テスト(README 不具合ログ#4 / 検収手順書 ⓪-11)
 *
 * 複数の端末が同時に「スプレッドシートから同期」した状態を、PCから模擬する。
 * 各「端末」はアプリと同じく getProducts を 2,000件ずつ順番に呼ぶ(端末どうしは同時)。
 *
 * ■ 必ずテスト用のコピー環境に対して実行すること(本番のURLに向けない)
 *   - 呼ぶのは ping と getProducts(読み取り)だけ。提出(submit)は一切しない
 *   - それでも本番に向けると、同じGoogleアカウントの同時実行枠を使い、店舗の同期・提出を失敗させ得る
 *
 * ■ 使い方(Node.js 18以上。リポジトリ直下で)
 *   Git Bash:
 *     GAS_URL='https://script.google.com/macros/s/…/exec' GAS_TOKEN='テスト用トークン' \
 *       node tools/loadtest-sync.mjs --test-env --devices 10,20,30
 *   PowerShell:
 *     $env:GAS_URL='https://…/exec'; $env:GAS_TOKEN='テスト用トークン'; node tools/loadtest-sync.mjs --test-env --devices 10,20,30
 *
 * ■ オプション
 *   --test-env        テスト用環境に向けていることの確認(必須)
 *   --devices 10,20   同時に同期する台数。カンマ区切りで複数回(各回の間は --pause 秒あける)
 *   --pause 60        各回の間の待ち秒(既定60。GAS側の処理が落ち着くのを待つ)
 *   --retry           アプリv1.5.0と同じ自動再試行(最大3回・約1→2→4秒)を有効にして測る
 *   --limit 2000      1回に取る件数(既定はアプリと同じ2000)
 *   --spread 0        全端末の開始をこの秒数の範囲でばらつかせる(既定0=一斉)
 *
 * 結果は画面に要約を出し、詳細を tools/out/loadtest-<日時>.json に保存する(トークン・URLは保存しない)。
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const URL_ = process.env.GAS_URL || '';
const TOKEN = process.env.GAS_TOKEN || '';
const DEVICES = String(opt('devices', '10')).split(',').map(Number).filter(n => n > 0);
const PAUSE_S = Number(opt('pause', 60));
const RETRY = !!opt('retry', false);
const LIMIT = Number(opt('limit', 2000));
const SPREAD_S = Number(opt('spread', 0));
const TIMEOUT_MS = 60000;                 // アプリと同じ
const RETRY_MAX = 3, RETRY_BASE_MS = 1000; // アプリv1.5.0と同じ

if (!opt('test-env', false)) {
  console.error('中止: --test-env を付けてください(テスト用のコピー環境に向けていることの確認)。本番のURLには向けないでください。');
  process.exit(2);
}
if (!URL_ || !TOKEN) {
  console.error('中止: 環境変数 GAS_URL と GAS_TOKEN を設定してください(テスト用デプロイのURLとテスト用トークン)。');
  process.exit(2);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let inFlight = 0, peakInFlight = 0;

/** アプリの gasPost と同じ判定で、結果を分類して返す(例外は投げない) */
async function call(payload) {
  const t0 = Date.now();
  inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: TOKEN, ...payload }), signal: ctl.signal, redirect: 'follow'
    });
    if (!res.ok) return { ok: false, kind: `HTTP ${res.status}`, transient: true, ms: Date.now() - t0 };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch (e) { return { ok: false, kind: '応答を解釈できない(HTMLなど)', transient: true, ms: Date.now() - t0, sample: text.slice(0, 160).replace(/\s+/g, ' ') }; }
    if (!json.success) {
      const transient = /(読み取れませんでした|処理できませんでした): /.test(json.error || '');
      return { ok: false, kind: 'GASのエラー: ' + json.error, transient, ms: Date.now() - t0 };
    }
    return { ok: true, data: json.data, ms: Date.now() - t0 };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, kind: '応答なし(60秒)', transient: true, ms: Date.now() - t0 };
    return { ok: false, kind: '通信できない: ' + (e.cause && e.cause.code || e.message), transient: true, ms: Date.now() - t0 };
  } finally {
    clearTimeout(tm);
    inFlight--;
  }
}

/** 1台ぶんの同期(アプリと同じく、ページを順番に取る) */
async function syncDevice(id, startDelayMs, log) {
  await sleep(startDelayMs);
  const t0 = Date.now();
  let offset = 0, total = 0, page = 0, retries = 0;
  for (;;) {
    page++;
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await call({ action: 'getProducts', offset, limit: LIMIT });
      log.push({ device: id, page, offset, attempt, ok: r.ok, kind: r.kind || 'ok', ms: r.ms, sample: r.sample });
      if (r.ok || !RETRY || !r.transient || attempt >= RETRY_MAX) break;
      retries++;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt) * (0.5 + Math.random()));
    }
    if (!r.ok) return { id, ok: false, kind: r.kind, page, retries, ms: Date.now() - t0 };
    total = Number(r.data.total) || 0;
    offset += Number(r.data.count) || 0;
    if (!r.data.count || offset >= total) return { id, ok: true, pages: page, total, retries, ms: Date.now() - t0 };
  }
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

async function round(n) {
  peakInFlight = 0;
  const log = [];
  const t0 = Date.now();
  const devices = await Promise.all(Array.from({ length: n }, (_, i) => syncDevice(i + 1, Math.random() * SPREAD_S * 1000, log)));
  const wall = Date.now() - t0;
  const okDev = devices.filter(d => d.ok);
  const fails = {};
  log.filter(x => !x.ok).forEach(x => { fails[x.kind] = (fails[x.kind] || 0) + 1; });
  const reqMs = log.map(x => x.ms);
  const summary = {
    devices: n, success: okDev.length, failed: n - okDev.length,
    requests: log.length, failedRequests: log.filter(x => !x.ok).length,
    retries: devices.reduce((a, d) => a + (d.retries || 0), 0),
    reqMs: { p50: pct(reqMs, 0.5), p90: pct(reqMs, 0.9), max: Math.max(0, ...reqMs) },
    deviceMs: { p50: pct(okDev.map(d => d.ms), 0.5), max: Math.max(0, ...okDev.map(d => d.ms)) },
    peakInFlight, wallMs: wall, failureKinds: fails,
    htmlSamples: [...new Set(log.filter(x => x.sample).map(x => x.sample))].slice(0, 3)
  };
  console.log(`\n■ ${n}台が同時に同期${RETRY ? '(再試行あり)' : '(再試行なし)'}${SPREAD_S ? ` 開始を${SPREAD_S}秒にばらつかせる` : ''}`);
  console.log(`  成功 ${summary.success}台 / 失敗 ${summary.failed}台   リクエスト ${summary.requests}回(失敗 ${summary.failedRequests}・再試行 ${summary.retries})`);
  console.log(`  1回の応答 中央値${summary.reqMs.p50}ms 90%${summary.reqMs.p90}ms 最大${summary.reqMs.max}ms   1台の同期 中央値${summary.deviceMs.p50}ms 最大${summary.deviceMs.max}ms`);
  console.log(`  同時に待っていた最大数 ${peakInFlight}   全体 ${(wall / 1000).toFixed(1)}秒`);
  Object.entries(fails).forEach(([k, v]) => console.log(`  失敗の内訳: ${k} … ${v}回`));
  summary.htmlSamples.forEach(s => console.log(`  HTMLの例: ${s}`));
  return { summary, log };
}

(async () => {
  console.log(`同期の同時実行テスト(テスト環境)  台数 ${DEVICES.join(',')}  1回${LIMIT}件  再試行${RETRY ? 'あり' : 'なし'}`);
  const ping = await call({ action: 'ping' });
  if (!ping.ok) { console.error('中止: 接続テストに失敗しました: ' + ping.kind); process.exit(1); }
  console.log(`接続OK(apiVersion ${ping.data.apiVersion ?? '不明'})`);
  const out = { startedAt: new Date().toISOString(), options: { DEVICES, PAUSE_S, RETRY, LIMIT, SPREAD_S }, rounds: [] };
  for (let i = 0; i < DEVICES.length; i++) {
    if (i > 0) { console.log(`\n(${PAUSE_S}秒待ちます)`); await sleep(PAUSE_S * 1000); }
    out.rounds.push(await round(DEVICES[i]));
  }
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  const name = `loadtest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(new URL('./out/' + name, import.meta.url), JSON.stringify(out, null, 2));
  console.log(`\n詳細を tools/out/${name} に保存しました(トークン・URLは含みません)。画面の要約とこのファイルを送ってください。`);
})();
