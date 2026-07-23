/**
 * scanner.js — カメラ・バーコード読取モジュール
 * 画箋堂 棚卸PWA
 *
 * - ZXing (js/zxing.min.js ローカルバンドル) でJAN(EAN-13/8)等を連続読取
 * - タップでズーム3段階 → 4回目で等倍に戻る
 *     ハードウェアズーム(track capabilities.zoom)があればそれを使用、
 *     無い端末(iOS Safariの一部等)はCSS拡大でフォールバック
 * - ライトON/OFF(torch対応端末のみボタン表示。iPhoneは非対応機種あり)
 * - 同一コードの連続検出は2秒間抑制(二重登録防止)
 */
'use strict';

const Scanner = (() => {
  let reader = null;        // ZXing BrowserMultiFormatReader
  let stream = null;        // MediaStream
  let track = null;         // ビデオトラック
  let videoEl = null;
  let onDecodeCb = null;
  let running = false;

  // ズーム
  const CSS_ZOOM_LEVELS = [1, 1.5, 2, 3];
  let zoomIdx = 0;
  let hwZoomLevels = null;  // ハードウェアズームの段階 [1, x, y, z]
  let torchOn = false;

  let lastCode = '';
  let lastCodeAt = 0;

  // ── 計測用(v1.0.5診断強化)。読取の判定条件には一切影響させない ──
  let _stats = null;
  function _resetStats() {
    _stats = {
      startedAt: Date.now(), attempts: 0, results: 0,
      errorCounts: {}, lastErrorName: null, callbackError: null
    };
  }

  function _buildReader() {
    const hints = new Map();
    // 読取対象はJAN(EAN-13/8)のみに限定する。
    // ITF・CODE_39・CODE_128 を含めると、ITFが13桁EAN-13の一部を短い桁数として
    // 部分誤読し「桁が欠ける」読取不良を起こす(ITFは既定でチェックデジット無し・
    // 許容長[6,8,10,12,14])。また多フォーマット総当たりはSafariで低速化する。
    // → JAN系に限定して誤読と低速を同時に解消(README 設計判断#8 / 不具合ログ#2)。
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    return new ZXing.BrowserMultiFormatReader(hints, 300 /* 読取間隔ms */);
  }

  /**
   * カメラを起動して連続読取を開始
   * @param {HTMLVideoElement} video
   * @param {(code:string)=>void} onDecode 読取成功コールバック
   * @returns {Promise<{torchSupported:boolean}>}
   */
  async function start(video, onDecode) {
    if (running) await stop();
    videoEl = video;
    onDecodeCb = onDecode;
    reader = _buildReader();
    zoomIdx = 0; torchOn = false; hwZoomLevels = null;
    _resetStats();
    _applyCssZoom(1);

    // 背面カメラを優先
    // 解像度: 実機計測(iPad Pro第3世代)で 720×1280 しか出ておらず、小さいJANの
    // 1モジュールが1〜2pxに潰れて復号できなかったため 1080p を要求する。
    // (短辺720→1080で1モジュールあたりの画素が約1.5倍。README 不具合ログ#2続報2)
    // ※ min/exact は OverconstrainedError でカメラ起動自体が失敗し得るため使わず、
    //   ideal のみにして非対応端末では自動的に近い値へフォールバックさせる。
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };

    await reader.decodeFromConstraints(constraints, video, (result, err) => {
      // ── 計測(v1.0.5)。以降の判定条件は従来と同一 ──
      _stats.attempts++;
      if (err) {
        const n = err.name || (err.constructor && err.constructor.name) || 'UnknownError';
        _stats.lastErrorName = n;
        _stats.errorCounts[n] = (_stats.errorCounts[n] || 0) + 1;
      }
      if (!result) return; // errはNotFoundExceptionが頻発するので無視
      _stats.results++;
      const code = result.getText();
      const now = Date.now();
      if (code === lastCode && now - lastCodeAt < 2000) return; // 二重検出抑制
      lastCode = code; lastCodeAt = now;
      // 読取は成功しているのに後段(openConfirm/IndexedDB等)の例外で無反応に見える
      // ケースを捕捉するため、呼び出しを保護する(v1.0.5計測)
      if (onDecodeCb) {
        try {
          const ret = onDecodeCb(code);
          if (ret && typeof ret.catch === 'function') {
            ret.catch(e => { _stats.callbackError = (e && e.message) ? e.message : String(e); });
          }
        } catch (e) {
          _stats.callbackError = (e && e.message) ? e.message : String(e);
        }
      }
    });

    running = true;
    stream = video.srcObject;
    track = stream ? stream.getVideoTracks()[0] : null;

    // ハードウェアズーム段階の決定
    let torchSupported = false;
    if (track && track.getCapabilities) {
      const cap = track.getCapabilities();
      if (cap.zoom && cap.zoom.max > cap.zoom.min) {
        const min = Math.max(cap.zoom.min, 1);
        const max = Math.min(cap.zoom.max, min * 4);
        hwZoomLevels = [min, min + (max - min) / 3, min + (max - min) * 2 / 3, max]
          .map(v => Math.round(v * 10) / 10);
      }
      torchSupported = !!cap.torch;
    }
    return { torchSupported, diag: _collectDiag() };
  }

  /**
   * 実機のカメラ設定を計測するための診断情報を返す(施策3・計測用)。
   * iOS Safari では getSettings / getCapabilities が一部未対応のことがあり、
   * 取得できない値は null / undefined になる(それ自体が切り分けの材料になる)。
   */
  function _collectDiag() {
    if (!track) return { available: false };
    let s = {}, caps = {};
    try { s = track.getSettings ? track.getSettings() : {}; } catch (e) { /* noop */ }
    try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { /* noop */ }
    return {
      available: true,
      hasGetCapabilities: !!track.getCapabilities,
      width: s.width, height: s.height, frameRate: s.frameRate,
      focusMode: s.focusMode,
      focusModesSupported: caps.focusMode || null,
      zoom: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step, current: s.zoom } : null,
      torch: ('torch' in caps) ? !!caps.torch : undefined,
      facing: s.facingMode,
      label: track.label || '',
      // ── v1.0.5 診断強化 ──
      // video要素が実際に持っている寸法(trackの設定値と食い違うことがある)
      video: videoEl ? {
        w: videoEl.videoWidth, h: videoEl.videoHeight,
        readyState: videoEl.readyState, paused: videoEl.paused
      } : null,
      // ZXingが実際に取り込んでいるcanvasの寸法。0×0なら空画像をデコードし続けている
      capture: (reader && reader.captureCanvas) ? {
        w: reader.captureCanvas.width, h: reader.captureCanvas.height
      } : null,
      stats: _stats ? {
        attempts: _stats.attempts,
        results: _stats.results,
        perSec: Math.round(_stats.attempts / Math.max(1, (Date.now() - _stats.startedAt) / 1000) * 10) / 10,
        lastErrorName: _stats.lastErrorName,
        errorCounts: _stats.errorCounts,
        callbackError: _stats.callbackError
      } : null
    };
  }

  /**
   * 📸 フレーム取り込みテスト(v1.0.5計測)。
   * いま映っているフレームを取り込み、①サムネイル ②平均輝度 ③全画面デコード
   * ④中央帯(ROI)デコード を返す。取込経路の不具合とROI化の効果を一度に切り分ける。
   */
  async function captureFrameTest() {
    if (!videoEl || !videoEl.videoWidth) {
      return { ok: false, reason: 'ビデオ未準備(videoWidth=0)' };
    }
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, w, h);

    // 平均輝度(間引きサンプル)。0付近なら取り込みが真っ黒＝描画経路の不具合
    let sum = 0, n = 0;
    try {
      const step = Math.max(1, Math.floor(h / 40));
      for (let y = 0; y < h; y += step) {
        const row = ctx.getImageData(0, y, w, 1).data;
        for (let i = 0; i < row.length; i += 4 * 20) {
          sum += row[i] * 0.299 + row[i + 1] * 0.587 + row[i + 2] * 0.114;
          n++;
        }
      }
    } catch (e) { /* 取得不可時は -1 */ }
    const brightness = n ? Math.round(sum / n) : -1;

    // 中央帯(ROI)。赤いガイド線はビューポート中央にあり、object-fit:coverで
    // 上下が均等に切られるため、映像の中央帯がおおよそ赤線周辺に対応する
    const bandH = Math.max(1, Math.round(h * 0.3));
    const bandY = Math.round((h - bandH) / 2);
    const rc = document.createElement('canvas');
    rc.width = w; rc.height = bandH;
    rc.getContext('2d').drawImage(c, 0, bandY, w, bandH, 0, 0, w, bandH);

    // 表示用サムネイル(実際に何が取り込まれたかを目視確認するため)
    const tw = 320, th = Math.max(1, Math.round(h * (tw / w)));
    const tc = document.createElement('canvas');
    tc.width = tw; tc.height = th;
    tc.getContext('2d').drawImage(c, 0, 0, tw, th);

    const decode = async (url) => {
      const r = _buildReader();
      try {
        const res = await r.decodeFromImageUrl(url);
        return { ok: true, text: res.getText() };
      } catch (e) {
        return { ok: false, err: (e && (e.name || (e.constructor && e.constructor.name))) || String(e) };
      } finally { try { r.reset(); } catch (_) { /* noop */ } }
    };

    const full = await decode(c.toDataURL('image/jpeg', 0.95));
    const roi = await decode(rc.toDataURL('image/jpeg', 0.95));
    return { ok: true, w, h, brightness, bandH, full, roi, thumbUrl: tc.toDataURL('image/jpeg', 0.7) };
  }

  async function stop() {
    running = false;
    lastCode = ''; lastCodeAt = 0;
    try { if (reader) reader.reset(); } catch (e) { /* noop */ }
    reader = null;
    // reader.reset()でstreamは停止されるが念のため
    try {
      if (stream) stream.getTracks().forEach(t => t.stop());
    } catch (e) { /* noop */ }
    stream = null; track = null;
    if (videoEl) { videoEl.srcObject = null; _applyCssZoom(1); }
  }

  /** タップごとに 1 → 2 → 3段階 → 等倍 に循環。表示用倍率文字列を返す */
  async function cycleZoom() {
    zoomIdx = (zoomIdx + 1) % 4;
    if (hwZoomLevels && track) {
      const z = hwZoomLevels[zoomIdx];
      try {
        await track.applyConstraints({ advanced: [{ zoom: z }] });
        _applyCssZoom(1);
        return '×' + z;
      } catch (e) { /* ハードズーム失敗→CSSへフォールバック */ }
    }
    const z = CSS_ZOOM_LEVELS[zoomIdx];
    _applyCssZoom(z);
    return '×' + z;
  }

  function _applyCssZoom(z) {
    if (videoEl) videoEl.style.transform = z === 1 ? '' : `scale(${z})`;
  }

  /** ライトON/OFF切替。新しい状態(true=点灯)を返す */
  async function toggleTorch() {
    if (!track) return false;
    torchOn = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    } catch (e) {
      torchOn = false;
    }
    return torchOn;
  }

  return {
    start, stop, cycleZoom, toggleTorch,
    readDiag: _collectDiag, captureFrameTest,
    get running() { return running; }
  };
})();
