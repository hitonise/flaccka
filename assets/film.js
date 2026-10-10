/* ============================================================================
   Film — scroll-scrubbed pre-rendered sequence on a 2D canvas.
   Frames were rendered offline (supersampled, motion blur, depth of field, grade),
   so the page only decodes images: cinematic look at almost no GPU cost.
   - size tier picked from screen size and connection (xl / d / m / ms)
   - frames are fetched coarse-first as compressed blobs (a few MB in total)
   - only a small window of frames around the playhead is decoded (ImageBitmap),
     the rest stays compressed, so memory stays low on phones
   - redraws only when the picture changes; neighbours are cross-faded
   ========================================================================== */
(function () {
  'use strict';
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  var TIERS = { xl: [1920, 1080], d: [1280, 720], m: [720, 1280], ms: [540, 960] };

  window.Film = {
    init: function (o) {
      var cv = typeof o.canvas === 'string' ? document.querySelector(o.canvas) : o.canvas;
      if (!cv) return null;
      var ctx = cv.getContext('2d', { alpha: false });
      var N = o.frames || 200;
      var conn = navigator.connection || {};
      var slow = !!conn.saveData || /(^|-)2g|3g/.test(conn.effectiveType || '');
      var dpr = window.devicePixelRatio || 1;
      var portrait = window.innerWidth / window.innerHeight < .9;
      var need = Math.max(window.innerWidth, window.innerHeight * (portrait ? 9 / 16 : 16 / 9)) * dpr;
      var set = portrait ? (slow || need < 620 ? 'ms' : 'm') : (!slow && need > 1500 ? 'xl' : 'd');
      var IW = TIERS[set][0], IH = TIERS[set][1];
      /* on slow links every second frame is enough: the cross-fade hides the gaps */
      var STEP = slow ? 2 : 1;
      var blobs = new Array(N), bmps = {}, pending = {}, nBmp = 0, loaded = 0, want = 0;
      var canBitmap = typeof createImageBitmap === 'function';
      function url(i) { return o.base + set + '/' + ('000' + i).slice(-4) + '.webp'; }

      /* ---- fetching: coarse-first so any scroll position has a near frame early ---- */
      var order = [], seen = {};
      [32, 16, 8, 4, 2, 1].forEach(function (st) { if (st < STEP) return; for (var i = 0; i < N; i += st) if (!seen[i]) { seen[i] = 1; order.push(i); } });
      if (!seen[N - 1]) order.splice(1, 0, N - 1);
      want = order.length;
      var inflight = 0, qi = 0, MAX = slow ? 2 : 4;
      function pump() {
        while (inflight < MAX && qi < order.length) (function (i) {
          inflight++;
          fetch(url(i)).then(function (r) { if (!r.ok) throw 0; return r.blob(); }).then(function (b) {
            blobs[i] = b; loaded++; inflight--;
            if (i === 0) decode(0, true);
            pump();
          }, function () { inflight--; pump(); });
        })(order[qi++]);
      }
      pump();

      /* ---- decoding window around the playhead ---- */
      var KEEP = 18;
      function decode(i, first) {
        if (bmps[i] || pending[i] || !blobs[i]) return;
        pending[i] = true;
        var done = function (img) { pending[i] = false; bmps[i] = img; nBmp++; dirty = true; evict(); if (first && o.onFirst) o.onFirst(); };
        if (canBitmap) createImageBitmap(blobs[i]).then(done, function () { pending[i] = false; });
        else { var im = new Image(), u = URL.createObjectURL(blobs[i]); im.onload = function () { URL.revokeObjectURL(u); done(im); }; im.src = u; }
      }
      function evict() {
        if (nBmp <= KEEP) return;
        var keys = Object.keys(bmps).map(Number).sort(function (a, b) { return Math.abs(b - cur) - Math.abs(a - cur); });
        for (var k = 0; k < keys.length && nBmp > KEEP; k++) {
          var i = keys[k]; if (Math.abs(i - cur) <= 3 || i === 0) continue;
          if (bmps[i].close) bmps[i].close(); delete bmps[i]; nBmp--;
        }
      }
      function nearestBmp(i) {
        if (bmps[i]) return i;
        for (var d = 1; d < N; d++) { if (i - d >= 0 && bmps[i - d]) return i - d; if (i + d < N && bmps[i + d]) return i + d; }
        return -1;
      }

      /* ---- scroll → film position through section anchors ---- */
      var anchors = [];
      function resolve() {
        var maxS = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        anchors = (o.anchors || [{ s: 0, u: 0 }, { end: true, u: 1 }]).map(function (a) {
          var s = a.s || 0;
          if (a.at) { var el = document.querySelector(a.at); if (el) s = el.getBoundingClientRect()[a.edge || 'top'] + window.scrollY + (a.off || 0) * window.innerHeight; }
          else if (a.end) s = maxS;
          return { s: clamp(s, 0, maxS), u: a.u };
        }).sort(function (a, b) { return a.s - b.s; });
      }
      function uAt(y) {
        if (!anchors.length) return 0;
        if (y <= anchors[0].s) return anchors[0].u;
        for (var i = 0; i < anchors.length - 1; i++) {
          var a = anchors[i], b = anchors[i + 1];
          if (y <= b.s) return a.u + (b.u - a.u) * ((y - a.s) / Math.max(1, b.s - a.s));
        }
        return anchors[anchors.length - 1].u;
      }

      /* ---- canvas: never larger than the frames themselves (CSS does the rest of the upscale) ---- */
      var W = 0, H = 0;
      function size() {
        var k = Math.min(dpr, Math.max(IW / window.innerWidth, IH / window.innerHeight));
        W = Math.round(window.innerWidth * k); H = Math.round(window.innerHeight * k);
        cv.width = W; cv.height = H; dirty = true;
      }
      var rt;
      window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { size(); resolve(); }, 120); });
      window.addEventListener('load', function () { setTimeout(resolve, 100); });

      var api = { state: { u: 0, vel: 0 }, refresh: resolve, set: set, loadedRatio: function () { return loaded / want; } };
      var uS = 0, lastY = window.scrollY, dirty = true, lastA = -1, lastB = -1, lastFrac = -1, velS = 0, snapK = 0, last = performance.now(), cur = 0, dirSign = 1;
      size(); resolve();
      function draw(img, alpha) {
        var iw = img.width, ih = img.height, s = Math.max(W / iw, H / ih), dw = iw * s, dh = ih * s;
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, (W - dw) * .5, (H - dh) * .5, dw, dh);
      }
      function tick(now) { requestAnimationFrame(tick); if (document.hidden) { last = now; return; } step(now); }
      api.step = function () { step(performance.now()); };
      function step(now) {
        var dt = Math.min(.05, (now - last) / 1000); last = now;
        var y = window.scrollY;
        velS += ((y - lastY) / Math.max(dt, .001) - velS) * Math.min(1, dt * 6); lastY = y;
        var target = uAt(y);
        uS += (target - uS) * (1 - Math.exp(-dt * 5));
        if (Math.abs(target - uS) < 1e-5) uS = target;
        /* at rest, settle on a whole frame so no half-dissolved double image lingers */
        var idle = Math.abs(velS) < 40 && Math.abs(target - uS) < .003;
        snapK = idle ? Math.min(1, snapK + dt * 2.5) : Math.max(0, snapK - dt * 8);
        var uD = uS + (Math.round(uS * (N - 1) / STEP) * STEP / (N - 1) - uS) * snapK * snapK * (3 - 2 * snapK);
        api.state.u = uS; api.state.vel = clamp(Math.abs(velS) / 2600, 0, 1);
        var f = uD * (N - 1), i0 = Math.floor(f), frac = f - i0;
        if (velS > 30) dirSign = 1; else if (velS < -30) dirSign = -1;
        cur = i0;
        /* decode a few frames ahead in the direction of travel, one behind */
        for (var d = -2; d <= 6; d++) { var j = i0 + d * dirSign * STEP; if (j >= 0 && j < N) decode(j - (j % STEP)); }
        var a = nearestBmp(i0 - (i0 % STEP)), b = -1, bf = 0;
        if (a < 0) return;
        if (a === i0 - (i0 % STEP)) { var nb = a + STEP; if (nb < N && bmps[nb]) { b = nb; bf = (f - a) / STEP; } }
        if (!dirty && a === lastA && b === lastB && Math.abs(bf - lastFrac) < .006) return;
        dirty = false; lastA = a; lastB = b; lastFrac = bf;
        draw(bmps[a], 1);
        if (b >= 0 && bf > .02) draw(bmps[b], bf);
        ctx.globalAlpha = 1;
        if (o.onFrame) o.onFrame(api.state);
      }
      requestAnimationFrame(tick);
      return api;
    }
  };
})();
