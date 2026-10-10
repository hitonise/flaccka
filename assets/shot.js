/* dev-only snapshot helper, loaded only with ?shot — renders the viewport (DOM + WebGL) to an image */
(function () {
  if (!/[?&]shot/.test(location.search)) return;
  function loadH2C() {
    return new Promise(function (res) {
      if (window.html2canvas) return res();
      var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; s.onload = res; document.head.appendChild(s);
    });
  }
  window.psnap = async function (name, y, settle) {
    await loadH2C();
    if (y != null) { window.scrollTo(0, y); }
    if (window.ScrollTrigger) ScrollTrigger.update();
    await new Promise(function (r) { setTimeout(r, settle || 60); });
    window.ffwd();
    if (window.space && space.step) for (var i = 0; i < 3; i++) space.step();
    var c = await html2canvas(document.body, { backgroundColor: '#05060a', x: window.scrollX, y: window.scrollY, width: innerWidth, height: innerHeight, windowWidth: innerWidth, windowHeight: innerHeight, scale: 1, logging: false, useCORS: true, ignoreElements: function (el) { return el.id === 'loader' || el.tagName === 'IFRAME'; } });
    await fetch('/shot?n=' + name, { method: 'POST', body: c.toDataURL('image/jpeg', .78) });
    return 'ok';
  };
  /* fast-forward running tweens so a snapshot shows the settled state */
  window.ffwd = function () {
    if (!window.gsap) return;
    if (window.ScrollTrigger) ScrollTrigger.update();
    gsap.globalTimeline.getChildren(true, true, false).forEach(function (t) {
      var st = t.scrollTrigger;
      if (!st) { if (t.progress() < 1) t.progress(1); return; }
      if (!st.vars.scrub && st.progress > 0 && t.progress() < 1) t.progress(1);
    });
  };
})();
