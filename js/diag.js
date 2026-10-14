/**
 * diag.js — カメラ診断ページ(管理者用 — README設計判断#27 / 不具合ログ#5)
 * 画箋堂 棚卸PWA
 *
 * - アプリ本体(scanner.js)には一切手を入れず、同じ手順でデコードして実機の状態を計測する
 * - 対策候補(レンズ・フォーカス・ズーム・解像度・読む範囲)を1回に1つずつ切り替えて比べる(標準§4 #17)
 * - 商品マスタ・棚卸データ・設定(localStorage/IndexedDB)には触れない
 *
 * 「アプリと同じ」条件は js/scanner.js(v1.4.0〜)に合わせてある。scanner.js を変えたら下の APP を合わせること
 */
'use strict';

const DIAG_VERSION = '1.5.0';
const APP = { intervalMs: 200, width: 1920, height: 1080, confirmCount: 2 };   // scanner.js と同じ
const SETTLE_MS = 1500;   // 起動直後はピント・露出が落ち着くまで待ってから計測する

const $ = (s) => document.querySelector(s);
let stream = null, track = null, running = false, torchOn = false;
let frameCanvas = null, frameCtx = null, mf = null;
let lastInfo = null, cameraList = [];
const results = [];

/* ───────── デコード(scanner.js と同じ) ───────── */

function makeReader() {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  const r = new ZXing.MultiFormatReader();
  r.setHints(hints);
  return r;
}

function decodeCanvas(canvas) {
  const src = ZXing.HTMLCanvasElementLuminanceSource
    ? new ZXing.HTMLCanvasElementLuminanceSource(canvas)
    : (() => { const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height); return new ZXing.RGBLuminanceSource(d.data, canvas.width, canvas.height); })();
  const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
  try {
    return mf.decodeWithState(bmp).getText();
  } catch (e) {
    return null;   // NotFound が大半
  } finally {
    try { mf.reset(); } catch (e) { /* noop */ }
  }
}

/** 今のフレームをcanvasへ取り込む。band=true なら中央の帯(高さ30%)だけ */
function grabFrame(band) {
  const v = $('#v');
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return null;
  const sy = band ? Math.round(h * 0.35) : 0;
  const ch = band ? Math.round(h * 0.30) : h;
  if (!frameCanvas || frameCanvas.width !== w || frameCanvas.height !== ch) {
    frameCanvas = document.createElement('canvas');
    frameCanvas.width = w; frameCanvas.height = ch;
    frameCtx = frameCanvas.getContext('2d');
  }
  frameCtx.drawImage(v, 0, sy, w, ch, 0, 0, w, ch);
  return frameCanvas;
}

/**
 * 鋭さ(ピントの目安): canvas中央付近の、横に隣り合う画素の明るさの差の平均。
 * 同じラベル・同じ距離での比較用(絶対値に意味は無い)
 */
function sharpness(canvas, band) {
  const w = canvas.width, h = canvas.height;
  const x0 = Math.round(w * 0.25), rw = Math.round(w * 0.5);
  // 画面全体なら赤線をはさむ高さ20%、中央の帯ならその帯の中央50%を見る
  const y0 = Math.round(h * (band ? 0.25 : 0.40)), rh = Math.max(2, Math.round(h * (band ? 0.50 : 0.20)));
  const d = canvas.getContext('2d').getImageData(x0, y0, rw, rh).data;
  let sum = 0, n = 0;
  for (let y = 0; y < rh; y += 2) {
    let prev = -1;
    for (let x = 0; x < rw; x += 1) {
      const i = (y * rw + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (prev >= 0) { sum += Math.abs(l - prev); n++; }
      prev = l;
    }
  }
  return n ? sum / n : 0;
}

/* ───────── カメラ ───────── */

function readCond() {
  const res = $('#c-res').value.split('x').map(Number);
  return {
    lens: $('#c-lens').value, focus: $('#c-focus').value, zoom: $('#c-zoom').value ? Number($('#c-zoom').value) : null,
    res, band: $('#c-roi').value === 'band'
  };
}

function condLabel(c) {
  const parts = [];
  if (c.lens) { const cam = cameraList.find(x => x.deviceId === c.lens); parts.push('レンズ:' + (cam ? cam.label || '(名前なし)' : c.lens.slice(0, 8))); }
  if (c.focus) parts.push('フォーカス:' + c.focus);
  if (c.zoom) parts.push('ズーム×' + c.zoom);
  if (c.res[0] !== APP.width) parts.push('解像度' + c.res.join('×'));
  if (c.band) parts.push('中央の帯');
  return parts.length ? parts.join(' / ') : 'アプリと同じ';
}

function changedCount(c) {
  return [c.lens, c.focus, c.zoom, c.res[0] !== APP.width, c.band].filter(Boolean).length;
}

async function stopCamera() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; track = null; torchOn = false;
  $('#v').srcObject = null;
  $('#b-torch').disabled = true; $('#b-shot').disabled = true;
}

async function startCamera(c) {
  await stopCamera();
  const video = { width: { ideal: c.res[0] }, height: { ideal: c.res[1] } };
  if (c.lens) video.deviceId = { exact: c.lens };
  else video.facingMode = { ideal: 'environment' };    // scanner.js と同じ
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  const v = $('#v');
  v.setAttribute('playsinline', 'true'); v.muted = true; v.srcObject = stream;
  try { await v.play(); } catch (e) { /* 以降の待機で判定 */ }
  for (let t = 0; t < 100 && !(v.videoWidth > 0 && v.readyState >= 2); t++) await new Promise(r => setTimeout(r, 50));
  track = stream.getVideoTracks()[0] || null;

  const applied = {};
  const caps = (track && track.getCapabilities) ? safe(() => track.getCapabilities()) : null;
  if (c.focus) {
    if (caps && Array.isArray(caps.focusMode) && caps.focusMode.includes(c.focus)) {
      try { await track.applyConstraints({ advanced: [{ focusMode: c.focus }] }); applied.focus = '適用'; }
      catch (e) { applied.focus = '失敗(' + e.name + ')'; }
    } else applied.focus = '非対応(この端末は選べない)';
  }
  if (c.zoom) {
    if (caps && caps.zoom && caps.zoom.max > caps.zoom.min) {
      const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, c.zoom));
      try { await track.applyConstraints({ advanced: [{ zoom: z }] }); applied.zoom = '適用 ×' + z; }
      catch (e) { applied.zoom = '失敗(' + e.name + ')'; }
    } else applied.zoom = '非対応(ハードウェアズーム無し)';
  }
  await refreshCameraList();
  $('#vp').classList.toggle('roi-on', c.band);
  $('#b-torch').disabled = !(caps && caps.torch);
  $('#b-shot').disabled = false;
  lastInfo = collectInfo(applied);
  renderInfo();
  return applied;
}

function safe(fn) { try { return fn(); } catch (e) { return null; } }

async function refreshCameraList() {
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  cameraList = devs.filter(d => d.kind === 'videoinput').map(d => ({ deviceId: d.deviceId, label: d.label }));
  const sel = $('#c-lens'), keep = sel.value;
  sel.innerHTML = '<option value="">アプリと同じ（背面カメラを自動選択）</option>';
  cameraList.forEach((cam, i) => {
    const o = document.createElement('option');
    o.value = cam.deviceId; o.textContent = `${i + 1}. ${cam.label || '(名前なし)'}`;
    sel.appendChild(o);
  });
  sel.value = cameraList.some(c => c.deviceId === keep) ? keep : '';
}

function collectInfo(applied) {
  const v = $('#v');
  const s = (track && track.getSettings) ? (safe(() => track.getSettings()) || {}) : {};
  const c = (track && track.getCapabilities) ? (safe(() => track.getCapabilities()) || {}) : {};
  const range = (r) => (r && typeof r === 'object' && 'min' in r) ? `${r.min}〜${r.max}` : (r == null ? '—' : String(r));
  return {
    選ばれたカメラ: track ? (track.label || '(名前なし)') : '—',
    映像の実寸: `${v.videoWidth}×${v.videoHeight}`,
    要求に対する設定値: `${s.width || '?'}×${s.height || '?'} ${s.frameRate ? Math.round(s.frameRate) + 'fps' : ''}`,
    向き: s.facingMode || '—',
    フォーカス現在: s.focusMode || '(取得できない)',
    フォーカス選べるもの: Array.isArray(c.focusMode) ? c.focusMode.join(', ') : '(取得できない)',
    ピント距離の現在: s.focusDistance != null ? String(s.focusDistance) : '—',
    ピント距離の範囲: range(c.focusDistance),
    ズーム現在: s.zoom != null ? String(s.zoom) : '—',
    ズームの範囲: range(c.zoom),
    ライト: c.torch ? 'あり' : 'なし/不明',
    適用した条件: applied && Object.keys(applied).length ? JSON.stringify(applied) : 'なし(アプリと同じ)'
  };
}

function renderInfo() {
  const lines = [];
  if (lastInfo) Object.entries(lastInfo).forEach(([k, v]) => lines.push(`${k}: ${v}`));
  lines.push('', '背面・前面を含むカメラの一覧:');
  cameraList.forEach((c, i) => lines.push(`  ${i + 1}. ${c.label || '(名前なし)'}  id=${c.deviceId.slice(0, 10)}…`));
  if (!cameraList.length) lines.push('  (取得できません)');
  $('#info').textContent = lines.join('\n');
}

/* ───────── 計測 ───────── */

async function runMeasure() {
  const c = readCond();
  const target = $('#target').value.trim();
  const durMs = Number($('#dur').value) * 1000;
  setBusy(true);
  let applied;
  try {
    applied = await startCamera(c);
  } catch (e) {
    $('#live').innerHTML = `<span class="err">カメラを起動できませんでした: ${e.name} ${e.message || ''}</span>`;
    setBusy(false);
    return;
  }
  mf = makeReader();
  running = true;
  $('#live').textContent = 'ピントと明るさが落ち着くのを待っています…';
  await new Promise(r => setTimeout(r, SETTLE_MS));
  // 映像が届いていないまま計測すると「読取率0%」と誤解されるので、計測せずに知らせる
  if ($('#v').videoWidth < 100) {
    running = false;
    $('#live').innerHTML = `<span class="err">カメラの映像が届いていません(実寸${$('#v').videoWidth}×${$('#v').videoHeight})。ページを開き直してから計測してください。</span>`;
    setBusy(false);
    return;
  }

  const st = { attempts: 0, raw: 0, hit: 0, others: new Set(), ms: [], sharp: [], firstHit: null, firstConfirm: null, confirms: 0 };
  let cand = '', candN = 0, tick = 0;
  const t0 = performance.now();
  while (running && performance.now() - t0 < durMs) {
    const cv = grabFrame(c.band);
    if (cv) {
      const d0 = performance.now();
      const code = decodeCanvas(cv);
      st.ms.push(performance.now() - d0);
      st.attempts++;
      if (tick++ % 2 === 0) st.sharp.push(sharpness(cv, c.band));
      if (code) {
        st.raw++;
        if (code === target) { st.hit++; if (st.firstHit == null) st.firstHit = (performance.now() - t0) / 1000; }
        else st.others.add(code);
        // アプリと同じ「同じコードが2回読めたら確定」(間の読めないフレームでは数え直さない)
        if (code !== cand) { cand = code; candN = 1; }
        else if (++candN >= APP.confirmCount) {
          if (code === target) { st.confirms++; if (st.firstConfirm == null) st.firstConfirm = (performance.now() - t0) / 1000; }
          cand = ''; candN = 0;
        }
      }
      const left = Math.max(0, Math.ceil((durMs - (performance.now() - t0)) / 1000));
      $('#live').textContent = `計測中… 残り${left}秒  試行${st.attempts}  目的のコード${st.hit}回  確定${st.confirms}回` +
        (st.others.size ? `  他のコード${st.others.size}種` : '') + `  鋭さ${st.sharp.length ? st.sharp[st.sharp.length - 1].toFixed(1) : '-'}`;
    }
    // scanner.js と同じく「1回のデコードのあと200ms待つ」(処理が遅い端末ほど試行/秒が下がる点も同じ)
    await new Promise(r => setTimeout(r, APP.intervalMs));
  }
  const elapsed = (performance.now() - t0) / 1000;
  lastInfo = collectInfo(applied);   // 計測後の値(フォーカス距離などは途中で変わる)
  renderInfo();
  running = false;
  const sorted = st.ms.slice().sort((a, b) => a - b);
  const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const row = {
    no: results.length + 1, at: new Date().toLocaleTimeString('ja-JP'), cond: condLabel(c), target,
    camera: lastInfo.選ばれたカメラ, size: lastInfo.映像の実寸, focus: lastInfo.フォーカス現在, zoom: lastInfo.ズーム現在,
    focusDist: lastInfo.ピント距離の現在, applied: lastInfo.適用した条件,
    perSec: st.attempts / elapsed, msMed: pct(0.5), ms90: pct(0.9),
    rate: st.attempts ? st.hit / st.attempts : 0, hit: st.hit, attempts: st.attempts,
    firstHit: st.firstHit, firstConfirm: st.firstConfirm, confirms: st.confirms,
    sharpAvg: avg(st.sharp), sharpMax: st.sharp.length ? Math.max(...st.sharp) : 0,
    others: [...st.others].slice(0, 5), stopped: elapsed * 1000 < durMs - 500
  };
  results.push(row);
  renderResults();
  $('#live').textContent = `計測終了（${row.cond}）: 目的のコード ${st.hit}/${st.attempts} フレーム、確定 ${st.confirms} 回。続けて計測するときは条件を1つだけ変えて「▶」`;
  setBusy(false);
}

function setBusy(b) {
  $('#b-run').disabled = b; $('#b-cam').disabled = b; $('#b-stop').disabled = !b;
  ['#c-lens', '#c-focus', '#c-zoom', '#c-res', '#c-roi', '#dur', '#target'].forEach(s => { $(s).disabled = b; });
}

const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const sec = (n) => n == null ? '読めず' : f1(n) + '秒';

function renderResults() {
  const tb = $('#res tbody');
  tb.innerHTML = '';
  for (const r of results) {
    const tr = document.createElement('tr');
    const cells = [
      String(r.no),
      r.cond + (r.stopped ? '（途中で停止）' : ''),
      `${r.camera}\n${r.size}・フォーカス${r.focus}・ズーム${r.zoom}\n適用: ${r.applied}`,
      `${f1(r.perSec)}回/秒\n中央値${Math.round(r.msMed)}ms・90%${Math.round(r.ms90)}ms`,
      `${Math.round(r.rate * 100)}%\n(${r.hit}/${r.attempts})`,
      `${sec(r.firstHit)}\n確定${sec(r.firstConfirm)}・${r.confirms}回`,
      `平均${f1(r.sharpAvg)}\n最大${f1(r.sharpMax)}`,
      r.others.length ? '他のコード: ' + r.others.join(', ') : ''
    ];
    cells.forEach(t => { const td = document.createElement('td'); td.textContent = t; td.style.whiteSpace = 'pre-line'; tr.appendChild(td); });
    tb.appendChild(tr);
  }
}

function resultsText() {
  const lines = [
    `画箋堂 棚卸 カメラ診断 v${DIAG_VERSION}（${new Date().toLocaleString('ja-JP')}）`,
    `端末: ${navigator.userAgent}`,
    `画面: ${screen.width}×${screen.height} @${window.devicePixelRatio}`,
    ''
  ];
  for (const r of results) {
    lines.push(`#${r.no} ${r.at} 条件: ${r.cond}${r.stopped ? '（途中で停止）' : ''} 目的: ${r.target}`,
      `  カメラ: ${r.camera} / ${r.size} / フォーカス ${r.focus} / ピント距離 ${r.focusDist} / ズーム ${r.zoom} / 適用 ${r.applied}`,
      `  試行 ${f1(r.perSec)}回/秒・処理 中央値${Math.round(r.msMed)}ms 90%${Math.round(r.ms90)}ms`,
      `  読取率 ${Math.round(r.rate * 100)}% (${r.hit}/${r.attempts})・最初に読めた ${sec(r.firstHit)}・確定 ${sec(r.firstConfirm)} ${r.confirms}回`,
      `  鋭さ 平均${f1(r.sharpAvg)} 最大${f1(r.sharpMax)}` + (r.others.length ? ` ・他のコード ${r.others.join(', ')}` : ''));
  }
  lines.push('', '― カメラの情報 ―', $('#info').textContent);
  return lines.join('\n');
}

async function copyResults() {
  const text = resultsText();
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } ta.remove();
  }
  alert(ok ? '結果をコピーしました。メール等に貼り付けて送ってください。' : 'コピーできませんでした。結果の表を画面ごと保存してください。');
}

/* ───────── フレーム画像 ───────── */

function takeShot() {
  const v = $('#v');
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return;
  const full = document.createElement('canvas'); full.width = w; full.height = h;
  full.getContext('2d').drawImage(v, 0, 0, w, h);
  // 画面全体の縮小
  const tw = 360, th = Math.round(h * tw / w);
  const thumb = document.createElement('canvas'); thumb.width = tw; thumb.height = th;
  thumb.getContext('2d').drawImage(full, 0, 0, tw, th);
  // 赤線付近を等倍で切り出し(拡大・縮小しない = カメラが実際に得ている細かさ)
  const cw = Math.min(w, 480), ch = Math.min(h, 200);
  const crop = document.createElement('canvas'); crop.width = cw; crop.height = ch;
  crop.getContext('2d').drawImage(full, Math.round((w - cw) / 2), Math.round((h - ch) / 2), cw, ch, 0, 0, cw, ch);
  if (!mf) mf = makeReader();
  const code = decodeCanvas(full);
  const box = document.createElement('div');
  box.innerHTML = `<p class="note">${new Date().toLocaleTimeString('ja-JP')}　${condLabel(readCond())}　実寸${w}×${h}　鋭さ${f1(sharpness(full, false))}　この1枚のデコード: ${code ? code : '読めず'}</p>`;
  const i1 = new Image(); i1.src = thumb.toDataURL('image/jpeg', 0.8); i1.alt = '画面全体';
  const i2 = new Image(); i2.src = crop.toDataURL('image/png'); i2.alt = '赤線付近(等倍)';
  box.append(i1, i2);
  $('#shots').prepend(box);
}

/* ───────── 初期化 ───────── */

document.addEventListener('DOMContentLoaded', () => {
  $('#diag-ver').textContent = DIAG_VERSION;
  const checkCond = () => { $('#cond-warn').hidden = changedCount(readCond()) <= 1; };
  ['#c-lens', '#c-focus', '#c-zoom', '#c-res', '#c-roi'].forEach(s => $(s).addEventListener('change', checkCond));
  $('#b-cam').addEventListener('click', async () => {
    try { await startCamera(readCond()); $('#live').textContent = 'カメラを起動しました。「▶ この条件で計測」で計測します。'; }
    catch (e) { $('#live').innerHTML = `<span class="err">カメラを起動できませんでした: ${e.name} ${e.message || ''}</span>`; }
  });
  $('#b-run').addEventListener('click', runMeasure);
  $('#b-stop').addEventListener('click', () => { running = false; });
  $('#b-torch').addEventListener('click', async () => {
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
    $('#b-torch').textContent = torchOn ? '💡 ライト（ON）' : '💡 ライト';
  });
  $('#b-shot').addEventListener('click', takeShot);
  $('#b-copy').addEventListener('click', copyResults);
  $('#b-clear').addEventListener('click', () => { if (confirm('結果を消しますか？')) { results.length = 0; renderResults(); } });
  // 画面を離れたらカメラを止める
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
});
