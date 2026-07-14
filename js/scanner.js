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
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.ITF
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
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
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
    return { torchSupported };
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

  return { start, stop, cycleZoom, toggleTorch, get running() { return running; } };
})();
