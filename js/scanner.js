/**
 * scanner.js — カメラ・バーコード読取モジュール
 * 画箋堂 棚卸PWA
 *
 * - ZXing (js/zxing.min.js ローカルバンドル) でJAN(EAN-13/8)を連続読取
 * - **自前スキャンループ方式**(v1.0.6)。ZXingの連続モード(decodeFromConstraints)は使わない。
 *     経緯: ZXing内蔵の連続デコードでは実機(iPad Pro/iPhone)でほぼ読み取れなかったが、
 *     同じカメラ・同じバーコードでも「1フレームを取り込んでデコードする」単発処理では
 *     成功していた。そこで毎周回 明示的に drawImage(video) して低レベルAPIで
 *     デコードする方式に置き換えたところ解決した。
 *     ※内蔵経路が失敗した正確な理由は未確定(README 不具合ログ#2)。
 *       ZXingの連続モードに戻す変更は、実機で再検証しない限り行わないこと。
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
  const SCAN_INTERVAL_MS = 200;   // 5回/秒。1回のデコードは数十ms程度
  const CONFIRM_COUNT = 2;        // 同一コードがこの回数連続で読めたら確定
  let _timer = null;
  let _mf = null;                 // ZXing MultiFormatReader(低レベル)
  let _hints = null;
  let _frameCanvas = null;        // 取り込み用canvas
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
  function _decodeCanvas(canvas) {
    const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(_luminance(canvas)));
    try {
      return (typeof _mf.decodeWithState === 'function') ? _mf.decodeWithState(bmp) : _mf.decode(bmp, _hints);
    } finally {
      try { _mf.reset(); } catch (e) { /* noop */ }
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
   * @returns {Promise<{torchSupported:boolean}>}
   */
  async function start(video, onDecode) {
    if (running) await stop();
    videoEl = video;
    onDecodeCb = onDecode;
    zoomIdx = 0; torchOn = false; hwZoomLevels = null;
    _candidate = ''; _candidateCount = 0;
    _frameCanvas = null; _frameCtx = null;
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

    return { torchSupported };
  }

  /** 自前スキャンループ */
  function _tick() {
    if (!running) return;
    try { _decodeCurrentFrame(); } catch (e) { /* NotFoundExceptionが大半。無視 */ }
    if (running) _timer = setTimeout(_tick, SCAN_INTERVAL_MS);
  }

  function _decodeCurrentFrame() {
    if (!videoEl) return;
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (!w || !h) return;

    if (!_frameCanvas || _frameCanvas.width !== w || _frameCanvas.height !== h) {
      _frameCanvas = document.createElement('canvas');
      _frameCanvas.width = w; _frameCanvas.height = h;
      _frameCtx = _frameCanvas.getContext('2d');
    }
    _frameCtx.drawImage(videoEl, 0, 0, w, h);

    let res = null;
    try {
      res = _decodeCanvas(_frameCanvas);
    } catch (e) {
      return; // 見つからないのは通常状態
    }
    if (res) _handleCode(res.getText());
  }

  /** 2回連続一致で確定 → 2秒の重複抑制 → コールバック */
  function _handleCode(code) {
    if (code !== _candidate) {
      _candidate = code; _candidateCount = 1;
      return; // 1回目は保留(EAN_8の誤検出などの単発ノイズを排除)
    }
    _candidateCount++;
    if (_candidateCount < CONFIRM_COUNT) return;
    _candidate = ''; _candidateCount = 0;

    const now = Date.now();
    if (code === lastCode && now - lastCodeAt < 2000) return; // 二重検出抑制
    lastCode = code; lastCodeAt = now;

    // 読取は成功しているのに後段(openConfirm/IndexedDB等)の例外で「無反応」に
    // 見えることを防ぐため、呼び出しを保護する(呼び出し側でも画面に通知する)
    if (onDecodeCb) {
      try {
        const ret = onDecodeCb(code);
        if (ret && typeof ret.catch === 'function') ret.catch(e => console.error(e));
      } catch (e) {
        console.error(e);
      }
    }
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

  return { start, stop, cycleZoom, toggleTorch, get running() { return running; } };
})();
