/**
 * scanner.js — カメラ・バーコード読取モジュール
 * 画箋堂 棚卸PWA
 *
 * - ZXing (js/zxing.min.js ローカルバンドル) でJAN(EAN-13/8)を連続読取
 * - **自前スキャンループ方式**(v1.0.6)。ZXingの連続モード(decodeFromConstraints)は使わない。
 *     理由: ZXingのキャプチャcanvasは getContext('2d',{willReadFrequently:true}) で
 *     ソフトウェア側に作られ、iOSではGPU上の動画フレームの転送に失敗して
 *     空/古い画素をデコードし続けることがある(実機で単発取込は成功・連続は失敗を確認)。
 *     → 既定コンテキストのcanvasへ drawImage する「成功が実証済みの経路」を毎周回使う。
 *     (README 不具合ログ#2続報4)
 * - 誤検出対策: 同一コードが2回連続で読めたときだけ確定(EAN_8の桁欠け誤検出を排除)
 * - タップでズーム3段階 → 4回目で等倍に戻る
 *     ハードウェアズーム(track capabilities.zoom)があればそれを使用、
 *     無い端末(iOS Safariの一部等)はCSS拡大でフォールバック
 * - ライトON/OFF(torch対応端末のみボタン表示。iPhoneは非対応機種あり)
 * - 同一コードの連続検出は2秒間抑制(二重登録防止)
 */
'use strict';

const Scanner = (() => {
  let stream = null;        // MediaStream
  let track = null;         // ビデオトラック
  let videoEl = null;
  let onDecodeCb = null;
  let running = false;

  // 自前スキャンループ
  const SCAN_INTERVAL_MS = 200;   // 5回/秒。実測デコードは24ms程度なので余裕がある
  const CONFIRM_COUNT = 2;        // 同一コードがこの回数連続で読めたら確定
  let _timer = null;
  let _mf = null;                 // ZXing MultiFormatReader(低レベル)
  let _hints = null;
  let _frameCanvas = null;        // 取り込み用canvas(既定コンテキスト)
  let _frameCtx = null;
  let _candidate = '';            // 確定待ちのコード
  let _candidateCount = 0;

  // ズーム
  const CSS_ZOOM_LEVELS = [1, 1.5, 2, 3];
  let zoomIdx = 0;
  let hwZoomLevels = null;  // ハードウェアズームの段階 [1, x, y, z]
  let torchOn = false;

  let lastCode = '';
  let lastCodeAt = 0;

  // ── 計測用(v1.0.5診断強化) ──
  let _stats = null;
  function _resetStats() {
    _stats = {
      startedAt: Date.now(), attempts: 0, results: 0, confirmed: 0, pending: 0,
      errorCounts: {}, lastErrorName: null, callbackError: null
    };
  }
  function _errName(e) {
    return (e && (e.name || (e.constructor && e.constructor.name))) || 'UnknownError';
  }
  function _noteError(e) {
    const n = _errName(e);
    _stats.lastErrorName = n;
    _stats.errorCounts[n] = (_stats.errorCounts[n] || 0) + 1;
  }

  /**
   * 読取対象はJAN(EAN-13/8)のみに限定する。
   * ITF・CODE_39・CODE_128 を含めると、ITFが13桁EAN-13の一部を短い桁数として
   * 部分誤読し「桁が欠ける」読取不良を起こす(ITFは既定でチェックデジット無し・
   * 許容長[6,8,10,12,14])。また多フォーマット総当たりはSafariで低速化する。
   * → JAN系に限定(README 設計判断#8 / 不具合ログ#2)。
   */
  function _buildHints() {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    return hints;
  }

  /** canvasから輝度ソースを作る(環境により利用可能なクラスへフォールバック) */
  function _luminance(canvas) {
    if (ZXing.HTMLCanvasElementLuminanceSource) {
      return new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    }
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return new ZXing.RGBLuminanceSource(d.data, canvas.width, canvas.height);
  }

  /** canvasを1回デコードする。見つからなければ例外(NotFoundException)を投げる */
  function _decodeCanvas(canvas, mfReader) {
    const r = mfReader || _mf;
    const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(_luminance(canvas)));
    try {
      return (typeof r.decodeWithState === 'function') ? r.decodeWithState(bmp) : r.decode(bmp, _hints);
    } finally {
      try { r.reset(); } catch (e) { /* noop */ }
    }
  }

  /** videoが実寸を持つまで待つ(iOSでメタデータ到着が遅れることがある) */
  function _waitVideoReady(video, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        if (video.videoWidth > 0 && video.readyState >= 2) return resolve(true);
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * カメラを起動して連続読取を開始
   * @param {HTMLVideoElement} video
   * @param {(code:string)=>void} onDecode 読取成功コールバック
   * @returns {Promise<{torchSupported:boolean, diag:object}>}
   */
  async function start(video, onDecode) {
    if (running) await stop();
    videoEl = video;
    onDecodeCb = onDecode;
    zoomIdx = 0; torchOn = false; hwZoomLevels = null;
    _candidate = ''; _candidateCount = 0;
    _frameCanvas = null; _frameCtx = null;
    _resetStats();
    _applyCssZoom(1);

    // 背面カメラを優先
    // 解像度: 実機計測(iPad Pro第3世代)で 720×1280 しか出ていなかったため 1080p を要求する。
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

    // 自前でカメラを取得してvideoへ接続する(ZXingの連続モードは使わない。冒頭コメント参照)
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* 再生制限時も以降のreadyState待ちで判定 */ }
    await _waitVideoReady(video, 5000);

    track = stream.getVideoTracks()[0] || null;

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

    // 低レベルデコーダを用意して自前ループを開始
    _hints = _buildHints();
    _mf = new ZXing.MultiFormatReader();
    _mf.setHints(_hints);

    running = true;
    _tick();

    return { torchSupported, diag: _collectDiag() };
  }

  /** 自前スキャンループ */
  function _tick() {
    if (!running) return;
    try { _decodeCurrentFrame(); } catch (e) { _noteError(e); }
    if (running) _timer = setTimeout(_tick, SCAN_INTERVAL_MS);
  }

  function _decodeCurrentFrame() {
    if (!videoEl) return;
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (!w || !h) return;

    // 取り込み用canvasは既定コンテキストで作る。
    // willReadFrequently:true にするとiOSで動画フレームの転送に失敗し得るため使わない。
    if (!_frameCanvas || _frameCanvas.width !== w || _frameCanvas.height !== h) {
      _frameCanvas = document.createElement('canvas');
      _frameCanvas.width = w; _frameCanvas.height = h;
      _frameCtx = _frameCanvas.getContext('2d');
    }
    _frameCtx.drawImage(videoEl, 0, 0, w, h);

    _stats.attempts++;
    let res = null;
    try {
      res = _decodeCanvas(_frameCanvas);
    } catch (e) {
      _noteError(e); // NotFoundExceptionが大半
      return;
    }
    if (!res) return;
    _stats.results++;
    _handleCode(res.getText());
  }

  /** 2回連続一致で確定 → 2秒の重複抑制 → コールバック */
  function _handleCode(code) {
    if (code !== _candidate) {
      _candidate = code; _candidateCount = 1; _stats.pending++;
      return; // 1回目は保留(EAN_8の誤検出などの単発ノイズを排除)
    }
    _candidateCount++;
    if (_candidateCount < CONFIRM_COUNT) return;
    _candidate = ''; _candidateCount = 0;

    const now = Date.now();
    if (code === lastCode && now - lastCodeAt < 2000) return; // 二重検出抑制
    lastCode = code; lastCodeAt = now;
    _stats.confirmed++;

    // 読取は成功しているのに後段(openConfirm/IndexedDB等)の例外で無反応に見える
    // ケースを捕捉するため、呼び出しを保護する
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
  }

  /**
   * 実機のカメラ設定を計測するための診断情報を返す(計測用)。
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
      video: videoEl ? {
        w: videoEl.videoWidth, h: videoEl.videoHeight,
        readyState: videoEl.readyState, paused: videoEl.paused
      } : null,
      // 自前ループが取り込んでいるcanvasの寸法
      frameCanvas: _frameCanvas ? { w: _frameCanvas.width, h: _frameCanvas.height } : null,
      loop: { intervalMs: SCAN_INTERVAL_MS, confirmCount: CONFIRM_COUNT },
      stats: _stats ? {
        attempts: _stats.attempts,
        results: _stats.results,
        confirmed: _stats.confirmed,
        pending: _stats.pending,
        perSec: Math.round(_stats.attempts / Math.max(1, (Date.now() - _stats.startedAt) / 1000) * 10) / 10,
        lastErrorName: _stats.lastErrorName,
        errorCounts: _stats.errorCounts,
        callbackError: _stats.callbackError
      } : null
    };
  }

  /**
   * 📸 フレーム取り込みテスト(計測用)。
   * 同一フレームを A:既定canvas / B:willReadFrequently canvas の両方へ描いて比較する。
   * Bだけ真っ黒・デコード失敗なら「iOSでソフトウェアcanvasへの動画転送が失敗する」
   * という機序が確定する(README 不具合ログ#2続報4)。
   */
  async function captureFrameTest() {
    if (!videoEl || !videoEl.videoWidth) {
      return { ok: false, reason: 'ビデオ未準備(videoWidth=0)' };
    }
    const w = videoEl.videoWidth, h = videoEl.videoHeight;

    const grab = (ctxOpts) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = ctxOpts ? c.getContext('2d', ctxOpts) : c.getContext('2d');
      ctx.drawImage(videoEl, 0, 0, w, h);
      return { c, ctx };
    };
    const A = grab(null);                          // 既定 = 自前ループと同条件
    const B = grab({ willReadFrequently: true });  // 旧ZXing連続モードと同条件

    const brightness = (ctx) => {
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
      return n ? Math.round(sum / n) : -1;
    };

    const tryDecode = (canvas) => {
      const mf = new ZXing.MultiFormatReader();
      mf.setHints(_buildHints());
      try { return { ok: true, text: _decodeCanvas(canvas, mf).getText() }; }
      catch (e) { return { ok: false, err: _errName(e) }; }
    };

    const thumb = (canvas) => {
      const tw = 320, th = Math.max(1, Math.round(canvas.height * (tw / canvas.width)));
      const tc = document.createElement('canvas');
      tc.width = tw; tc.height = th;
      tc.getContext('2d').drawImage(canvas, 0, 0, tw, th);
      return tc.toDataURL('image/jpeg', 0.7);
    };

    // 中央帯(ROI)。赤いガイド線はビューポート中央にあり、object-fit:coverで
    // 上下が均等に切られるため、映像の中央帯がおおよそ赤線周辺に対応する
    const bandH = Math.max(1, Math.round(h * 0.3));
    const bandY = Math.round((h - bandH) / 2);
    const rc = document.createElement('canvas');
    rc.width = w; rc.height = bandH;
    rc.getContext('2d').drawImage(A.c, 0, bandY, w, bandH, 0, 0, w, bandH);

    return {
      ok: true, w, h, bandH,
      normal: { brightness: brightness(A.ctx), decode: tryDecode(A.c), thumbUrl: thumb(A.c) },
      swCanvas: { brightness: brightness(B.ctx), decode: tryDecode(B.c), thumbUrl: thumb(B.c) },
      roi: tryDecode(rc)
    };
  }

  async function stop() {
    running = false;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    lastCode = ''; lastCodeAt = 0;
    _candidate = ''; _candidateCount = 0;
    try { if (_mf && _mf.reset) _mf.reset(); } catch (e) { /* noop */ }
    _mf = null;
    _frameCanvas = null; _frameCtx = null;
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
