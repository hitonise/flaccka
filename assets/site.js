/* shared helpers for all flaccka pages (classic script, no modules → works from file://) */
(function () {
  'use strict';
  var RM = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var embed = /[?&]embed=1/.test(location.search);
  if (embed) document.documentElement.classList.add('embed');

  function $(s, c) { return (c || document).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  /* wrap every character (keeps <em>, <br>, nested tags) */
  function splitChars(el) {
    var chars = [];
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(function (tok) {
            if (!tok) return;
            if (/^\s+$/.test(tok)) { frag.appendChild(document.createTextNode(' ')); return; }
            var w = document.createElement('span'); w.className = 'word';
            tok.split('').forEach(function (ch) {
              var c = document.createElement('span'); c.className = 'char'; c.textContent = ch; w.appendChild(c); chars.push(c);
            });
            frag.appendChild(w);
          });
          node.replaceChild(frag, n);
        } else if (n.nodeType === 1 && n.tagName !== 'BR') walk(n);
      });
    })(el);
    return chars;
  }

  /* wrap words, each inside its own overflow mask (slide-up reveal) */
  function splitWords(el, masked) {
    var words = [];
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(function (tok) {
            if (!tok) return;
            if (/^\s+$/.test(tok)) { frag.appendChild(document.createTextNode(' ')); return; }
            var outer = document.createElement('span');
            outer.style.display = 'inline-block'; if (masked) { outer.style.overflow = 'hidden'; outer.style.verticalAlign = 'top'; outer.style.paddingBottom = '.12em'; outer.style.marginBottom = '-.12em'; }
            var inner = document.createElement('span'); inner.className = 'wd'; inner.style.display = 'inline-block'; inner.style.willChange = 'transform,opacity'; inner.textContent = tok;
            outer.appendChild(inner); frag.appendChild(outer); words.push(inner);
          });
          node.replaceChild(frag, n);
        } else if (n.nodeType === 1 && n.tagName !== 'BR') walk(n);
      });
    })(el);
    return words;
  }

  function cursor() {
    if (matchMedia('(pointer:coarse)').matches) return;
    var dot = $('.cur'), ring = $('.cur-r');
    if (!dot) { dot = document.createElement('div'); dot.className = 'cur'; document.body.appendChild(dot); }
    if (!ring) { ring = document.createElement('div'); ring.className = 'cur-r'; ring.innerHTML = '<span></span>'; document.body.appendChild(ring); }
    var lbl = $('span', ring);
    var mx = innerWidth / 2, my = innerHeight / 2, rx = mx, ry = my;
    window.addEventListener('pointermove', function (e) {
      mx = e.clientX; my = e.clientY; dot.style.left = mx + 'px'; dot.style.top = my + 'px';
      var t = e.target.closest && e.target.closest('[data-cur],a,button,input,textarea,select');
      var text = t && t.getAttribute && t.getAttribute('data-cur');
      ring.classList.toggle('hot', !!t && !text);
      ring.classList.toggle('lbl', !!text);
      lbl.textContent = text || '';
    }, { passive: true });
    (function loop() { rx += (mx - rx) * .18; ry += (my - ry) * .18; ring.style.left = rx + 'px'; ring.style.top = ry + 'px'; requestAnimationFrame(loop); })();
  }

  function magnetic(sel, strength) {
    if (RM || matchMedia('(pointer:coarse)').matches) return;
    $$(sel).forEach(function (el) {
      var s = strength || .35;
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var x = (e.clientX - (r.left + r.width / 2)) * s, y = (e.clientY - (r.top + r.height / 2)) * s;
        el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      });
      el.addEventListener('pointerleave', function () { el.style.transition = 'transform .5s cubic-bezier(.2,.9,.3,1.4)'; el.style.transform = ''; setTimeout(function () { el.style.transition = ''; }, 520); });
    });
  }

  function tilt(sel, max, glare) {
    if (RM || matchMedia('(pointer:coarse)').matches) return;
    $$(sel).forEach(function (el) {
      var g = null;
      if (glare) { g = document.createElement('i'); g.style.cssText = 'position:absolute;inset:0;pointer-events:none;border-radius:inherit;opacity:0;transition:opacity .3s;mix-blend-mode:overlay;z-index:3'; if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; el.appendChild(g); }
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        el.style.transition = 'transform .08s linear';
        el.style.transform = 'perspective(900px) rotateY(' + ((px - .5) * max * 2).toFixed(2) + 'deg) rotateX(' + ((.5 - py) * max * 2).toFixed(2) + 'deg) translateZ(0)';
        if (g) { g.style.opacity = '1'; g.style.background = 'radial-gradient(circle at ' + (px * 100) + '% ' + (py * 100) + '%, rgba(255,255,255,.55), transparent 55%)'; }
      });
      el.addEventListener('pointerleave', function () { el.style.transition = 'transform .6s cubic-bezier(.2,.9,.3,1.2)'; el.style.transform = ''; if (g) g.style.opacity = '0'; });
    });
  }

  function counter(el, to, dur, fmt) {
    var o = { v: 0 };
    gsap.to(o, { v: to, duration: dur || 2, ease: 'power2.out', onUpdate: function () { el.textContent = fmt ? fmt(o.v) : Math.round(o.v); } });
  }

  function loader(minMs) {
    var ld = $('#loader'); if (!ld) return;
    var bar = $('.ld-bar i', ld); if (bar) requestAnimationFrame(function () { bar.style.transform = 'scaleX(.65)'; });
    var start = performance.now(), fired = false;
    setTimeout(function () { done(); }, 2600);
    function done() {
      if (fired) return; fired = true;
      var wait = Math.max(0, (minMs || 900) - (performance.now() - start));
      setTimeout(function () { if (bar) bar.style.transform = 'scaleX(1)'; setTimeout(function () { ld.classList.add('done'); document.documentElement.classList.add('loaded'); window.dispatchEvent(new Event('site:loaded')); }, 260); }, wait);
    }
    if (document.readyState === 'complete') done(); else window.addEventListener('load', done);
  }

  function toast(msg) {
    var t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translate(-50%,24px);background:#f4f2ee;color:#07070a;font-family:var(--f-mono);font-size:12px;padding:11px 20px;border-radius:999px;opacity:0;z-index:9000;pointer-events:none;transition:all .35s cubic-bezier(.2,.9,.3,1.2)'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1'; t.style.transform = 'translate(-50%,0)';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translate(-50%,24px)'; }, 1900);
  }

  function copyEmail(el, mail) {
    el.addEventListener('click', function (e) {
      if (navigator.clipboard) { e.preventDefault(); navigator.clipboard.writeText(mail).then(function () { toast('почта скопирована'); }, function () { location.href = 'mailto:' + mail; }); }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var bl = $('.back-link'); if (!bl) return;
    function upd() { bl.classList.toggle('hide', window.scrollY > document.documentElement.scrollHeight - window.innerHeight - 180); }
    window.addEventListener('scroll', upd, { passive: true }); upd();
  });

  window.Site = { RM: RM, embed: embed, $: $, $$: $$, clamp: clamp, splitChars: splitChars, splitWords: splitWords, cursor: cursor, magnetic: magnetic, tilt: tilt, counter: counter, loader: loader, toast: toast, copyEmail: copyEmail };
})();
