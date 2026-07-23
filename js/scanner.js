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
      if (!result) return; // errはNotFoundExceptionが頻発するので無視
      const code = result.getText();
      const now = Date.now();
      if (code === lastCode && now - lastCodeAt < 2000) return; // 二重検出抑制
      lastCode = code; lastCodeAt = now;
      if (onDecodeCb) onDecodeCb(code);
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
      label: track.label || ''
    };
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

  return { start, stop, cycleZoom, toggleTorch, readDiag: _collectDiag, get running() { return running; } };
})();
