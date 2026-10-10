/* ============================================================================
   SpaceBG — cinematic 3D space engine (Three.js r128, classic script)
   Planet with procedural gas-giant shader + atmosphere + rings, moon,
   instanced asteroid field, detailed rigged astronaut, nebula dome, shader stars,
   warp lines, bloom + chromatic aberration post-processing,
   camera that flies along a spline driven by page scroll.
   ========================================================================== */
(function () {
  'use strict';

  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var SHOT = /[?&]shot/.test(location.search);
  var TAU = Math.PI * 2;
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  var NOISE = [
    'float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }',
    'float noise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);',
    ' return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),',
    '            mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }',
    'float fbm(vec3 p){ float a=.5,s=0.; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.02; a*=.5; } return s; }'
  ].join('\n');

  var DEFAULT_PATH = {
    pos:  [[0, 1.2, 36], [-4, 2.5, 18], [3.5, -1.5, 0], [-5, 1.5, -22], [4.5, 3, -48], [-2.5, -1.2, -76], [3, 1, -106], [9, 3, -136], [15, 2.4, -168]],
    look: [[2, .5, 0], [1, .5, -20], [-1, 0, -44], [2, 1, -70], [0, 0, -98], [8, 0, -132], [22, 0, -172], [34, -2, -212], [40, -4, -232]],
    roll: [0, .05, -.04, .06, -.05, .04, -.03, .05, 0]
  };

  var DEFAULT_ASTRO_KEYS = [
    { p: 0.0, sx: .52, sy: -.02, d: 4.4, yaw: -.55 },
    { p: 1.0, sx: .52, sy: -.02, d: 4.4, yaw: -.55 }
  ];

  var FinalShader = {
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uShift: { value: 0 }, uVig: { value: .55 }, uGrain: { value: .035 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uTime,uShift,uVig,uGrain; varying vec2 vUv;',
      'void main(){',
      '  vec2 c = vUv-.5; float d = length(c);',
      '  vec2 off = c*uShift*(.4+d*1.6);',
      '  vec3 col; col.r = texture2D(tDiffuse, vUv+off).r; col.g = texture2D(tDiffuse, vUv).g; col.b = texture2D(tDiffuse, vUv-off).b;',
      '  col *= 1.0 - smoothstep(.32,.95,d)*uVig;',
      '  float g = fract(sin(dot(vUv*vec2(1920.,1080.)+uTime, vec2(12.9898,78.233)))*43758.5453);',
      '  col += (g-.5)*uGrain;',
      '  vec3 ac = (col*(2.51*col+.03))/(col*(2.43*col+.59)+.14);',
      '  col = mix(col, clamp(ac,0.,1.), .75);',
      '  gl_FragColor = vec4(col,1.0);',
      '}'
    ].join('\n')
  };

  /* ---------- helpers ---------- */
  function radialTexture(size, stops) {
    var c = document.createElement('canvas'); c.width = c.height = size;
    var x = c.getContext('2d'), h = size / 2;
    var g = x.createRadialGradient(h, h, 0, h, h, h);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(c);
  }

  function capsuleGeo(r, len, seg) {
    var pts = [], n = 8, i, a;
    for (i = 0; i <= n; i++) { a = -Math.PI / 2 + (i / n) * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(.0001, Math.cos(a) * r), Math.sin(a) * r - len / 2)); }
    for (i = 0; i <= n; i++) { a = (i / n) * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(.0001, Math.cos(a) * r), Math.sin(a) * r + len / 2)); }
    return new THREE.LatheGeometry(pts, seg || 18);
  }

  function buildEnv() {
    var c = document.createElement('canvas'); c.width = 512; c.height = 256;
    var x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#0a0d1e'); g.addColorStop(.5, '#161420'); g.addColorStop(1, '#1e130c');
    x.fillStyle = g; x.fillRect(0, 0, 512, 256);
    function blob(cx, cy, r, col) { var rg = x.createRadialGradient(cx, cy, 0, cx, cy, r); rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = rg; x.fillRect(0, 0, 512, 256); }
    blob(110, 70, 110, 'rgba(255,236,210,1)');
    blob(300, 90, 70, 'rgba(255,255,255,.7)');
    blob(400, 130, 90, 'rgba(110,150,255,.85)');
    blob(256, 240, 140, 'rgba(255,120,60,.45)');
    blob(30, 140, 70, 'rgba(140,255,200,.35)');
    x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(0, 118, 512, 6);
    var t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  }
  function buildEnvPMREM(renderer) {
    var pm = new THREE.PMREMGenerator(renderer);
    var envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(
      new THREE.SphereGeometry(50, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: 'varying vec3 vP; void main(){ float h=normalize(vP).y; vec3 top=vec3(.02,.025,.06); vec3 mid=vec3(.04,.03,.05); vec3 bot=vec3(.06,.035,.02); vec3 c=mix(mid,top,smoothstep(0.,1.,h)); c=mix(c,bot,smoothstep(0.,-1.,h)); gl_FragColor=vec4(c,1.0); }'
      })
    ));
    function panel(w, h, col, k, pos) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide }));
      m.position.set(pos[0], pos[1], pos[2]); m.lookAt(0, 0, 0); envScene.add(m);
    }
    panel(46, 26, 0xfff0dc, .55, [-30, 24, 28]);
    panel(30, 44, 0x7ea9ff, .4, [36, 6, -22]);
    panel(60, 10, 0xff7a45, .22, [0, -28, 10]);
    panel(24, 24, 0xffffff, .2, [0, 42, -8]);
    var rt = pm.fromScene(envScene, 0.02);
    pm.dispose();
    return rt.texture;
  }

  /* ---------- astronaut ---------- */
  function buildAstronaut(envTex) {
    var g = new THREE.Group();
    var suit = new THREE.MeshStandardMaterial({ color: 0xc9cad2, roughness: .78, metalness: .04, envMapIntensity: .55 });
    var suitShade = new THREE.MeshStandardMaterial({ color: 0x9a9daa, roughness: .82, metalness: .1, envMapIntensity: .5 });
    var joint = new THREE.MeshStandardMaterial({ color: 0x5b5f6e, roughness: .55, metalness: .5, envMapIntensity: 1.1 });
    var glossy = new THREE.MeshPhysicalMaterial({ color: 0xd4d5dc, roughness: .3, metalness: .05, clearcoat: .7, clearcoatRoughness: .25, envMapIntensity: .8 });
    var visorMat = new THREE.MeshStandardMaterial({ color: 0xc89a48, roughness: .07, metalness: 1, envMapIntensity: 1.8 });
    var orange = new THREE.MeshStandardMaterial({ color: 0xff7a3d, roughness: .5, metalness: .1, emissive: 0xff4a10, emissiveIntensity: .25 });
    var led = function (c) { return new THREE.MeshBasicMaterial({ color: c }); };

    var body = new THREE.Group(); g.add(body);

    var torso = new THREE.Mesh(capsuleGeo(.33, .38, 20), suit); torso.position.y = .56; torso.scale.set(1.08, 1, .8); body.add(torso);
    var belt = new THREE.Mesh(new THREE.TorusGeometry(.33, .035, 10, 32), joint); belt.rotation.x = Math.PI / 2; belt.position.y = .2; belt.scale.set(1.08, .8, 1); body.add(belt);
    var neck = new THREE.Mesh(new THREE.TorusGeometry(.2, .05, 12, 28), joint); neck.rotation.x = Math.PI / 2; neck.position.y = 1.06; body.add(neck);

    var panelM = new THREE.Mesh(new THREE.BoxGeometry(.4, .24, .07), suitShade); panelM.position.set(0, .66, .27); body.add(panelM);
    var disp = document.createElement('canvas'); disp.width = 128; disp.height = 64;
    var dctx = disp.getContext('2d');
    var dtex = new THREE.CanvasTexture(disp);
    var dispMesh = new THREE.Mesh(new THREE.PlaneGeometry(.24, .1), new THREE.MeshBasicMaterial({ map: dtex })); dispMesh.position.set(0, .7, .31); body.add(dispMesh);
    [[-.12, 0xff4444], [0, 0x44ff88], [.12, 0xffc040]].forEach(function (b) {
      var bm = new THREE.Mesh(new THREE.BoxGeometry(.06, .035, .03), led(b[1])); bm.position.set(b[0], .6, .31); body.add(bm);
    });

    var pack = new THREE.Mesh(new THREE.BoxGeometry(.62, .78, .26), suitShade); pack.position.set(0, .62, -.36); body.add(pack);
    [-.17, .17].forEach(function (x) {
      var tank = new THREE.Mesh(new THREE.CylinderGeometry(.095, .095, .56, 16), glossy); tank.position.set(x, .72, -.56); body.add(tank);
      var cap = new THREE.Mesh(new THREE.SphereGeometry(.095, 14, 10, 0, TAU, 0, Math.PI / 2), glossy); cap.position.set(x, 1.0, -.56); body.add(cap);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(.097, .014, 8, 20), orange); ring.rotation.x = Math.PI / 2; ring.position.set(x, .6, -.56); body.add(ring);
    });
    var ant = new THREE.Mesh(new THREE.CylinderGeometry(.01, .01, .5, 8), joint); ant.position.set(.22, 1.1, -.4); body.add(ant);
    var antLed = new THREE.Mesh(new THREE.SphereGeometry(.03, 10, 8), led(0xff3040)); antLed.position.set(.22, 1.36, -.4); body.add(antLed);

    var head = new THREE.Group(); head.position.set(0, 1.4, 0); body.add(head);
    var helmet = new THREE.Mesh(new THREE.SphereGeometry(.355, 40, 32), glossy); head.add(helmet);
    var visor = new THREE.Mesh(new THREE.SphereGeometry(.372, 40, 24, Math.PI / 2 - 1.05, 2.1, Math.PI * .27, Math.PI * .42), visorMat); head.add(visor);
    var lamp = new THREE.Mesh(new THREE.BoxGeometry(.1, .05, .06), led(0xfff2c8)); lamp.position.set(.3, .15, .12); lamp.rotation.y = .9; head.add(lamp);

    function limb(side) {
      var sh = new THREE.Group(); sh.position.set(side * .45, .92, 0); body.add(sh);
      var ball = new THREE.Mesh(new THREE.SphereGeometry(.16, 18, 14), joint); sh.add(ball);
      var up = new THREE.Mesh(capsuleGeo(.105, .26, 14), suit); up.position.y = -.24; sh.add(up);
      var band = new THREE.Mesh(new THREE.TorusGeometry(.108, .018, 8, 22), orange); band.rotation.x = Math.PI / 2; band.position.y = -.2; sh.add(band);
      var el = new THREE.Group(); el.position.y = -.46; sh.add(el);
      el.add(new THREE.Mesh(new THREE.SphereGeometry(.1, 14, 12), joint));
      var fo = new THREE.Mesh(capsuleGeo(.095, .24, 14), suit); fo.position.y = -.22; el.add(fo);
      var glove = new THREE.Mesh(new THREE.SphereGeometry(.125, 16, 14), suitShade); glove.position.y = -.48; glove.scale.set(1, 1.1, .9); el.add(glove);
      var thumb = new THREE.Mesh(new THREE.SphereGeometry(.055, 10, 8), suitShade); thumb.position.set(side * .1, -.44, .06); el.add(thumb);
      return { sh: sh, el: el };
    }
    var armL = limb(-1), armR = limb(1);
    var patch = new THREE.Mesh(new THREE.PlaneGeometry(.14, .08), new THREE.MeshBasicMaterial({ color: 0x8dffb6 }));
    patch.position.set(-.455, .75, .115); patch.rotation.y = -.3; body.add(patch);

    function leg(side) {
      var hip = new THREE.Group(); hip.position.set(side * .17, .08, 0); body.add(hip);
      var th = new THREE.Mesh(capsuleGeo(.14, .28, 16), suit); th.position.y = -.24; hip.add(th);
      var kn = new THREE.Group(); kn.position.y = -.47; hip.add(kn);
      kn.add(new THREE.Mesh(new THREE.SphereGeometry(.125, 14, 12), joint));
      var sn = new THREE.Mesh(capsuleGeo(.12, .26, 14), suit); sn.position.y = -.22; kn.add(sn);
      var bandL = new THREE.Mesh(new THREE.TorusGeometry(.125, .016, 8, 22), orange); bandL.rotation.x = Math.PI / 2; bandL.position.y = -.33; kn.add(bandL);
      var boot = new THREE.Mesh(new THREE.BoxGeometry(.26, .16, .4), suitShade); boot.position.set(0, -.5, .07); kn.add(boot);
      var sole = new THREE.Mesh(new THREE.BoxGeometry(.28, .05, .43), joint); sole.position.set(0, -.6, .07); kn.add(sole);
      return { hip: hip, kn: kn };
    }
    var legL = leg(-1), legR = leg(1);

    var hit = new THREE.Mesh(new THREE.SphereGeometry(1.25, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = .7; g.add(hit);

    g.traverse(function (o) { if (o.isMesh && o.material && o.material.isMeshStandardMaterial) o.material.envMap = envTex; });
    g.userData = { body: body, head: head, armL: armL, armR: armR, legL: legL, legR: legR, antLed: antLed, hit: hit, disp: dctx, dtex: dtex };
    return g;
  }

  function drawAstroDisplay(ctx, tex, t) {
    ctx.fillStyle = '#031208'; ctx.fillRect(0, 0, 128, 64);
    ctx.strokeStyle = '#38ff9a'; ctx.lineWidth = 2; ctx.beginPath();
    for (var x = 0; x < 128; x += 4) {
      var y = 32 + Math.sin(x * .13 + t * 4) * 14 * (0.6 + 0.4 * Math.sin(t * 1.7 + x * .02));
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#38ff9a'; ctx.font = '9px monospace';
    ctx.fillText('O2 ' + (96 + Math.floor(Math.sin(t) * 3)) + '%', 4, 10);
    tex.needsUpdate = true;
  }

  /* ============================== init =================================== */
  var SpaceBG = {};

  SpaceBG.init = function (options) {
    var o = {
      canvas: '#spaceBg', lite: false, astronaut: true, planet: true, belt: true, bloom: true,
      path: DEFAULT_PATH, astroKeys: DEFAULT_ASTRO_KEYS, onFrame: null,
      nebula: [0x6a55ff, 0x1fd1b5, 0xff6a8a], sunPos: [-140, 70, -300], planetPos: [44, -6, -240]
    };
    for (var k in options) if (options.hasOwnProperty(k)) o[k] = options[k];

    var cv = typeof o.canvas === 'string' ? document.querySelector(o.canvas) : o.canvas;
    if (!cv || typeof THREE === 'undefined') return null;

    var mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    var weak = (navigator.hardwareConcurrency || 8) <= 4;
    var low = o.lite || mobile;
    var dpr = Math.min(window.devicePixelRatio || 1, low ? 1 : (weak ? 1.25 : 1.6));

    var renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: low, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: /[?&]shot/.test(location.search) }); }
    catch (e) { return null; }
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x04050a, 1);
    var W = window.innerWidth, H = window.innerHeight;
    renderer.setSize(W, H, false);
    cv.style.width = '100%'; cv.style.height = '100%';

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(55, W / H, .1, 1400);
    scene.add(camera);

    var envTex = /[?&]noenv/.test(location.search) ? null : buildEnv();

    /* lights */
    var sunPos = new THREE.Vector3().fromArray(o.sunPos);
    var planetPos = new THREE.Vector3().fromArray(o.planetPos);
    var sunLight = new THREE.DirectionalLight(0xfff0dc, 1.6);
    sunLight.position.copy(sunPos); scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x30323c, .22));
    scene.add(new THREE.HemisphereLight(0x8fa4ff, 0x3a2414, .55));
    var keyLight = new THREE.DirectionalLight(0xffe9d2, .95);
    keyLight.position.set(-4, 5, 6); camera.add(keyLight); keyLight.target.position.set(0, 0, -10); camera.add(keyLight.target);
    var rimLight = new THREE.PointLight(0x6f86ff, 1.4, 40); scene.add(rimLight);
    var sunDir = sunPos.clone().sub(planetPos).normalize();

    /* nebula dome */
    var nebU = { uTime: { value: 0 }, uProg: { value: 0 }, uA: { value: new THREE.Color(o.nebula[0]) }, uB: { value: new THREE.Color(o.nebula[1]) }, uC: { value: new THREE.Color(o.nebula[2]) } };
    var dome = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 20), new THREE.ShaderMaterial({
      uniforms: nebU, side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform float uTime,uProg; uniform vec3 uA,uB,uC; varying vec3 vDir;\n' + NOISE + '\n' + [
        'void main(){',
        '  vec3 d = normalize(vDir);',
        '  vec3 p = d*2.1 + vec3(uTime*.006, uProg*.8, uTime*.003);',
        '  float n1 = fbm(p); float n2 = fbm(p*2.2 + 7.1 + n1*1.4);',
        '  float m = smoothstep(.38,.9, n1*.65 + n2*.55);',
        '  vec3 col = mix(uA, uB, n2)*m*.42;',
        '  col += uC*pow(smoothstep(.5,1.,n2*n1*2.0),2.0)*.35;',
        '  float band = exp(-pow(d.y*3.2, 2.0))*.06;',
        '  col += vec3(.5,.55,.9)*band*fbm(p*5.);',
        '  gl_FragColor = vec4(col,1.0);',
        '}'].join('\n')
    }));
    dome.renderOrder = -20; dome.frustumCulled = false; scene.add(dome);

    /* stars */
    function makeStars(n, rMin, rMax, sizeMin, sizeMax, centered, atten, tubeFn) {
      var pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3), ph = new Float32Array(n);
      var tints = [[1, .96, .9], [.7, .83, 1], [1, .85, .65], [.85, .8, 1]];
      for (var i = 0; i < n; i++) {
        if (tubeFn) { var q = tubeFn(); pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2]; }
        else {
          var r = rMin + Math.random() * (rMax - rMin), th = Math.random() * TAU, p = Math.acos(Math.random() * 2 - 1);
          pos[i * 3] = r * Math.sin(p) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(th); pos[i * 3 + 2] = r * Math.cos(p) + (centered ? -70 : 0);
        }
        size[i] = sizeMin + Math.pow(Math.random(), 3) * (sizeMax - sizeMin);
        var tt = tints[(Math.random() * tints.length) | 0], br = .6 + Math.random() * .4;
        col[i * 3] = tt[0] * br; col[i * 3 + 1] = tt[1] * br; col[i * 3 + 2] = tt[2] * br;
        ph[i] = Math.random();
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
      var mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uScale: { value: dpr * 7 }, uAtten: { value: atten ? 1 : 0 }, uVel: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: [
          'attribute float aSize; attribute vec3 aColor; attribute float aPhase; uniform float uTime,uScale,uAtten,uVel;',
          'varying vec3 vColor; varying float vTw;',
          'void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0);',
          '  float tw = .62 + .38*sin(uTime*(1.1+aPhase*2.4) + aPhase*40.);',
          '  vTw = tw; vColor = aColor;',
          '  float att = mix(1.0, 26.0/max(1.0,-mv.z), uAtten);',
          '  gl_PointSize = clamp(aSize*uScale*att*(.7+.3*tw), 1.0, 64.0);',
          '  gl_Position = projectionMatrix*mv; }'
        ].join('\n'),
        fragmentShader: [
          'varying vec3 vColor; varying float vTw;',
          'void main(){ vec2 p = gl_PointCoord-.5; float d = length(p);',
          '  float core = smoothstep(.5,.0,d); float glow = pow(core,2.4);',
          '  float cr = max(smoothstep(.05,.0,abs(p.x))*smoothstep(.5,.0,abs(p.y)), smoothstep(.05,.0,abs(p.y))*smoothstep(.5,.0,abs(p.x)))*.55;',
          '  float a = (glow + cr*glow*2.0)*vTw;',
          '  gl_FragColor = vec4(vColor*a*1.5, a); }'
        ].join('\n')
      });
      var pts = new THREE.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);
      return pts;
    }
    var starsFar = makeStars(low ? 1800 : 3600, 500, 850, .7, 2.4, false, false);
    var dustPts = makeStars(low ? 700 : 1500, 0, 0, .35, 1.1, false, true, function () {
      return [rnd(-34, 34), rnd(-20, 20), rnd(-200, 44)];
    });

    /* warp lines (attached to camera) */
    var warpN = low ? 120 : 260;
    var wp = new Float32Array(warpN * 2 * 3), wf = new Float32Array(warpN * 2);
    for (var wi = 0; wi < warpN; wi++) {
      var ang = Math.random() * TAU, rad = rnd(2, 26), zz = rnd(0, 80);
      for (var e = 0; e < 2; e++) {
        wp[(wi * 2 + e) * 3] = Math.cos(ang) * rad; wp[(wi * 2 + e) * 3 + 1] = Math.sin(ang) * rad * .6; wp[(wi * 2 + e) * 3 + 2] = zz; wf[wi * 2 + e] = e;
      }
    }
    var wGeo = new THREE.BufferGeometry();
    wGeo.setAttribute('position', new THREE.BufferAttribute(wp, 3));
    wGeo.setAttribute('aEnd', new THREE.BufferAttribute(wf, 1));
    var warpMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLen: { value: 0 }, uAlpha: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'attribute float aEnd; uniform float uTime,uLen; varying float vE; void main(){ vec3 p = position; float z = -mod(p.z + uTime*60., 80.); p.z = z - aEnd*uLen; vE = aEnd; gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0); }',
      fragmentShader: 'uniform float uAlpha; varying float vE; void main(){ gl_FragColor = vec4(vec3(.7,.8,1.)*(1.-vE*.9), (1.-vE)*uAlpha); }'
    });
    var warp = new THREE.LineSegments(wGeo, warpMat); warp.frustumCulled = false; camera.add(warp);

    /* sun glow */
    var sunGlowTex = radialTexture(256, [[0, 'rgba(255,248,230,1)'], [.12, 'rgba(255,214,150,.75)'], [.4, 'rgba(255,150,70,.18)'], [1, 'rgba(255,120,40,0)']]);
    var sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    sunSprite.position.copy(sunPos); sunSprite.scale.set(150, 150, 1); scene.add(sunSprite);
    var streak = document.createElement('canvas'); streak.width = 512; streak.height = 8;
    var sx = streak.getContext('2d'), sg = sx.createLinearGradient(0, 0, 512, 0);
    sg.addColorStop(0, 'rgba(255,200,140,0)'); sg.addColorStop(.5, 'rgba(255,240,215,.9)'); sg.addColorStop(1, 'rgba(255,200,140,0)');
    sx.fillStyle = sg; sx.fillRect(0, 0, 512, 8);
    var sunStreak = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(streak), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .28 }));
    sunStreak.position.copy(sunPos); sunStreak.scale.set(360, 7, 1); scene.add(sunStreak);

    /* planet */
    var planetGroup = new THREE.Group(), planet = null, ringMesh = null, moon = null, atmos = null;
    var planetU = { uTime: { value: 0 }, uSunDir: { value: sunDir }, uC1: { value: new THREE.Color(.78, .52, .30) }, uC2: { value: new THREE.Color(.95, .82, .60) }, uC3: { value: new THREE.Color(.50, .28, .20) }, uC4: { value: new THREE.Color(.82, .62, .50) } };
    if (o.planet) {
      var R = 26;
      planet = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), new THREE.ShaderMaterial({
        uniforms: planetU,
        vertexShader: 'varying vec3 vObj; varying vec3 vWN; void main(){ vObj=position; vWN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: 'uniform float uTime; uniform vec3 uSunDir,uC1,uC2,uC3,uC4; varying vec3 vObj; varying vec3 vWN;\n' + NOISE + '\n' + [
          'void main(){',
          '  vec3 n = normalize(vObj);',
          '  float warp = fbm(n*3.0 + vec3(uTime*.012,0.,uTime*.006));',
          '  float bands = sin((n.y + warp*.34)*24.0)*.5+.5;',
          '  float fine = fbm(vec3(n.x*4.,n.y*34.,n.z*4.) + warp*2.2);',
          '  float m = mix(bands, fine, .45);',
          '  vec3 col = mix(uC1, uC2, smoothstep(.18,.82,m));',
          '  col = mix(col, uC3, smoothstep(.55,.95,fine)*.65);',
          '  col = mix(col, uC4, smoothstep(.72,1.,warp)*.4);',
          '  float lon = mod(atan(n.z,n.x) + uTime*.02 + 3.14159, 6.28318) - 3.14159;',
          '  vec2 sd = vec2((lon-.7)*.55, (n.y+.30)*1.7);',
          '  float storm = smoothstep(.24,.0,length(sd));',
          '  col = mix(col, vec3(.86,.36,.20), storm*.75);',
          '  col += fbm(n*9.+uTime*.02)*.05;',
          '  float d = dot(normalize(vWN), uSunDir);',
          '  float diff = smoothstep(-.22,.75,d);',
          '  vec3 lit = col*(diff*1.15 + .045) + vec3(.02,.03,.06)*(1.-diff);',
          '  lit += vec3(1.,.32,.1)*smoothstep(0.,.14,d)*smoothstep(.34,.0,d)*.2;',
          '  gl_FragColor = vec4(lit,1.0);',
          '}'].join('\n')
      }));
      planetGroup.add(planet);

      atmos = new THREE.Mesh(new THREE.SphereGeometry(R * 1.07, 64, 48), new THREE.ShaderMaterial({
        uniforms: { uSunDir: { value: sunDir }, uColor: { value: new THREE.Color(1., .62, .34) } },
        side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: 'varying vec3 vN; varying vec3 vWN; void main(){ vN=normalize(normalMatrix*normal); vWN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 uSunDir,uColor; varying vec3 vN; varying vec3 vWN; void main(){ float i = pow(max(0.,.74 - dot(vN, vec3(0.,0.,1.))), 3.2); float side = smoothstep(-.55,.55,dot(normalize(-vWN), uSunDir)*-1.0); gl_FragColor = vec4(uColor*i*(.25+side*1.4), 1.0); }'
      }));
      planetGroup.add(atmos);

      var ringU = { uIn: { value: 38 }, uOut: { value: 66 }, uC: { value: new THREE.Color(.86, .74, .55) } };
      ringMesh = new THREE.Mesh(new THREE.RingGeometry(38, 66, 160, 6), new THREE.ShaderMaterial({
        uniforms: ringU, side: THREE.DoubleSide, transparent: true, depthWrite: false,
        vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: 'uniform float uIn,uOut; uniform vec3 uC; varying vec3 vP;\n' + NOISE + '\n' + [
          'void main(){',
          '  float r = length(vP.xy); float t = (r-uIn)/(uOut-uIn);',
          '  float n1 = noise(vec3(t*22.,1.3,2.7)); float n2 = noise(vec3(t*64.,4.,9.)); float n3 = noise(vec3(t*9.,7.,1.));',
          '  float dens = smoothstep(.0,.12,t)*smoothstep(1.,.82,t);',
          '  float gap = smoothstep(.40,.44,t)*smoothstep(.54,.50,t);',
          '  float gap2 = smoothstep(.72,.74,t)*smoothstep(.78,.76,t);',
          '  float a = dens*(.35+.65*n3)*(.55+.45*n1)*(.75+.25*n2)*(1.-gap*.9)*(1.-gap2*.7);',
          '  vec3 col = mix(uC*.55, uC*1.15, n3*.6+n1*.4);',
          '  col = mix(col, vec3(.55,.62,.75), smoothstep(.6,1.,t)*.35);',
          '  gl_FragColor = vec4(col, a*.82);',
          '}'].join('\n')
      }));
      ringMesh.rotation.x = -Math.PI / 2 + .38; ringMesh.rotation.y = .08;
      planetGroup.add(ringMesh);

      var moonCv = document.createElement('canvas'); moonCv.width = 256; moonCv.height = 128;
      var mc = moonCv.getContext('2d'); mc.fillStyle = '#8a8680'; mc.fillRect(0, 0, 256, 128);
      for (var mi = 0; mi < 140; mi++) { var mr = rnd(2, 12); mc.fillStyle = 'rgba(' + (Math.random() < .5 ? '40,38,36' : '210,205,195') + ',' + rnd(.08, .3).toFixed(2) + ')'; mc.beginPath(); mc.arc(rnd(0, 256), rnd(0, 128), mr, 0, TAU); mc.fill(); }
      moon = new THREE.Mesh(new THREE.SphereGeometry(3.4, 40, 30), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(moonCv), roughness: 1, metalness: 0, envMapIntensity: .5 }));
      planetGroup.add(moon);

      if (o.planetColors) ['uC1', 'uC2', 'uC3', 'uC4'].forEach(function (u, i) { if (o.planetColors[i]) planetU[u].value.fromArray(o.planetColors[i]); });
      if (o.ringColor) ringU.uC.value.fromArray(o.ringColor);
      if (o.atmosColor) atmos.material.uniforms.uColor.value.fromArray(o.atmosColor);
      planetGroup.position.copy(planetPos);
      planetGroup.rotation.z = .08;
      scene.add(planetGroup);
    }

    /* camera path */
    function curveFrom(arr) { return new THREE.CatmullRomCurve3(arr.map(function (a) { return new THREE.Vector3(a[0], a[1], a[2]); }), false, 'centripetal'); }
    var posCurve = curveFrom(o.path.pos), lookCurve = curveFrom(o.path.look);
    var rolls = o.path.roll || [0, 0];
    function rollAt(t) { var f = t * (rolls.length - 1), i = Math.min(rolls.length - 2, Math.floor(f)); return lerp(rolls[i], rolls[i + 1], smooth(f - i)); }

    /* asteroid field */
    var asteroids = null, astData = [];
    if (o.belt) {
      var N = low ? 110 : 220;
      var rg = new THREE.IcosahedronGeometry(1, 1), pa = rg.attributes.position;
      var seen = {};
      for (var vi = 0; vi < pa.count; vi++) {
        var vx = pa.getX(vi), vy = pa.getY(vi), vz = pa.getZ(vi), key = vx.toFixed(3) + vy.toFixed(3) + vz.toFixed(3);
        if (!seen[key]) seen[key] = 1 + (Math.abs(Math.sin(vx * 12.9898 + vy * 78.233 + vz * 37.719) * 43758.5453) % 1) * .55 - .3;
        var s = seen[key]; pa.setXYZ(vi, vx * s, vy * s * .85, vz * s * 1.1);
      }
      rg.computeVertexNormals();
      asteroids = new THREE.InstancedMesh(rg, new THREE.MeshStandardMaterial({ color: 0x8a847c, roughness: .96, metalness: .04, flatShading: true, envMapIntensity: .55 }), N);
      var samples = posCurve.getPoints(220), tmpc = new THREE.Color(), dummy = new THREE.Object3D();
      for (var ai = 0; ai < N; ai++) {
        var px, py, pz, ok = false, tries = 0;
        while (!ok && tries++ < 40) {
          pz = rnd(-200, 6); var rr = 9 + Math.pow(Math.random(), 1.2) * 60, aa = Math.random() * TAU;
          px = Math.cos(aa) * rr; py = Math.sin(aa) * rr * .62;
          ok = true;
          for (var si = 0; si < samples.length; si += 2) { var sp = samples[si]; var dx = sp.x - px, dy = sp.y - py, dz = sp.z - pz; if (dx * dx + dy * dy + dz * dz < 64) { ok = false; break; } }
          if (ok && pz > -60 && Math.abs(py) < 9 && px > -6 && px < 30) ok = false;
        }
        var sc = Math.pow(Math.random(), 3) * 2.4 + .2;
        astData.push({ x: px, y: py, z: pz, s: sc, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, vx: rnd(-.25, .25), vy: rnd(-.25, .25), vz: rnd(-.25, .25), bob: Math.random() * TAU });
        tmpc.setHSL(rnd(.05, .1), rnd(.08, .2), rnd(.55, .85)); asteroids.setColorAt(ai, tmpc);
        dummy.position.set(px, py, pz); dummy.rotation.set(astData[ai].rx, astData[ai].ry, astData[ai].rz); dummy.scale.setScalar(sc); dummy.updateMatrix(); asteroids.setMatrixAt(ai, dummy.matrix);
      }
      asteroids.frustumCulled = false; scene.add(asteroids);
    }

    /* comet */
    var comet = { head: null, trail: null, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), hist: [], next: 4 };
    comet.head = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(64, [[0, 'rgba(255,255,255,1)'], [.4, 'rgba(160,220,255,.6)'], [1, 'rgba(160,220,255,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    comet.head.scale.set(3.2, 3.2, 1); comet.head.visible = false; scene.add(comet.head);
    var TRAIL = 36, trailGeo = new THREE.BufferGeometry(), trailPos = new Float32Array(TRAIL * 3), trailCol = new Float32Array(TRAIL * 3);
    for (var ti = 0; ti < TRAIL; ti++) { var f = 1 - ti / TRAIL; trailCol[ti * 3] = .55 * f; trailCol[ti * 3 + 1] = .8 * f; trailCol[ti * 3 + 2] = f; }
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3)); trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
    comet.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    comet.trail.frustumCulled = false; comet.trail.visible = false; scene.add(comet.trail);

    /* astronaut */
    var astro = null, astroKeys = [];
    var tumble = new THREE.Quaternion(), tumbleVel = new THREE.Vector3(), waveTarget = 0, wave = 0;
    if (o.astronaut) { astro = buildAstronaut(envTex); scene.add(astro); }

    function resolveKeys() {
      var docH = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      var srcKeys = typeof o.astroKeys === 'function' ? o.astroKeys(window.innerWidth / window.innerHeight) : o.astroKeys;
      astroKeys = srcKeys.map(function (kk) {
        var p = kk.p;
        if (kk.at) {
          var el = typeof kk.at === 'string' ? document.querySelector(kk.at) : kk.at;
          if (el) { var r = el.getBoundingClientRect(); p = clamp((r.top + window.scrollY + (kk.off || 0) * window.innerHeight) / docH, 0, 1); }
        }
        var c = {}; for (var x in kk) c[x] = kk[x]; c.p = p; return c;
      }).sort(function (a, b) { return a.p - b.p; });
    }

    function keyAt(p) {
      if (!astroKeys.length) return { sx: .5, sy: 0, d: 5, yaw: -.5, scale: 1, wave: 0 };
      if (p <= astroKeys[0].p) return astroKeys[0];
      var last = astroKeys[astroKeys.length - 1];
      if (p >= last.p) return last;
      for (var i = 0; i < astroKeys.length - 1; i++) {
        var a = astroKeys[i], b = astroKeys[i + 1];
        if (p >= a.p && p <= b.p) {
          var t = smooth((p - a.p) / Math.max(1e-5, b.p - a.p));
          return {
            sx: lerp(a.sx, b.sx, t), sy: lerp(a.sy, b.sy, t), d: lerp(a.d, b.d, t), yaw: lerp(a.yaw || 0, b.yaw || 0, t),
            scale: lerp(a.scale == null ? 1 : a.scale, b.scale == null ? 1 : b.scale, t), wave: lerp(a.wave || 0, b.wave || 0, t),
            tilt: lerp(a.tilt || 0, b.tilt || 0, t)
          };
        }
      }
      return last;
    }

    /* post-processing */
    var composer = null, bloom = null, finalPass = null;
    var canPost = o.bloom && !low && !/[?&]nopost/.test(location.search) && THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass && THREE.ShaderPass && THREE.CopyShader;
    function setupPost() {
      composer = new THREE.EffectComposer(renderer);
      composer.setPixelRatio(dpr); composer.setSize(W, H);
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloom = new THREE.UnrealBloomPass(new THREE.Vector2(W, H), .55, .55, .84);
      composer.addPass(bloom);
      finalPass = new THREE.ShaderPass(FinalShader); finalPass.renderToScreen = true;
      composer.addPass(finalPass);
    }
    if (canPost) { try { setupPost(); } catch (e) { composer = null; } }

    /* interaction */
    var mx = 0, my = 0, tmx = 0, tmy = 0, ndc = new THREE.Vector2(9, 9), ray = new THREE.Raycaster(), hoverAstro = false;
    window.addEventListener('pointermove', function (e) {
      tmx = e.clientX / window.innerWidth - .5; tmy = e.clientY / window.innerHeight - .5;
      ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    }, { passive: true });
    window.addEventListener('pointerdown', function (e) {
      if (!astro || !hoverAstro) return;
      if (e.target.closest && e.target.closest('a,button,input,textarea,select,[data-cur]:not([data-cur=""]),.no-astro')) return;
      tumbleVel.set(rnd(-4, 4), rnd(6, 11) * (Math.random() < .5 ? -1 : 1), rnd(-3, 3));
    });

    function onResize() {
      W = window.innerWidth; H = window.innerHeight;
      renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
      camera.aspect = W / H; camera.updateProjectionMatrix();
      if (composer) { composer.setPixelRatio(dpr); composer.setSize(W, H); bloom.setSize(W, H); }
      resolveKeys();
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('load', function () { setTimeout(resolveKeys, 120); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(resolveKeys, 60); });
    resolveKeys();

    /* loop */
    var api = { renderer: renderer, scene: scene, camera: camera, astro: astro, state: { p: 0, vel: 0, t: 0 }, refresh: resolveKeys, setWave: function (v) { waveTarget = v; }, kick: function () { tumbleVel.set(rnd(-4, 4), 9, rnd(-3, 3)); } };
    var pS = 0, last = performance.now(), velS = 0, lastY = window.scrollY, time = 0;
    var tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpF = new THREE.Vector3(), tmpR = new THREE.Vector3(), tmpU = new THREE.Vector3(), eul = new THREE.Euler(), dummy2 = new THREE.Object3D(), idQ = new THREE.Quaternion();
    var dispTick = 0;

    function frame(now) {
      requestAnimationFrame(frame);
      render(now);
    }
    api.step = function () { render(performance.now()); };
    function render(now) {
      if (document.hidden && !SHOT) { last = now; return; }
      var dt = Math.min(.05, (now - last) / 1000); last = now; time += dt;

      var docH = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      var y = window.scrollY, pRaw = clamp(y / docH, 0, 1);
      var pxv = (y - lastY) / Math.max(dt, .001); lastY = y;
      velS = lerp(velS, pxv, 1 - Math.exp(-dt * 6));
      var velN = clamp(Math.abs(velS) / 2600, 0, 1);
      pS = lerp(pS, pRaw, 1 - Math.exp(-dt * 4.2));
      if (SHOT) { pS = pRaw; velN = 0; }
      mx = lerp(mx, tmx, 1 - Math.exp(-dt * 3)); my = lerp(my, tmy, 1 - Math.exp(-dt * 3));
      api.state.p = pS; api.state.vel = velN; api.state.t = time; api.state.scrollVel = velS;

      /* camera */
      posCurve.getPoint(pS, tmpV); camera.position.copy(tmpV);
      camera.position.x += mx * 1.1; camera.position.y -= my * .7;
      lookCurve.getPoint(pS, tmpF); camera.lookAt(tmpF);
      camera.rotateZ(rollAt(pS) + (RM ? 0 : Math.sin(time * .35) * .008));
      camera.rotateY(-mx * .07); camera.rotateX(-my * .05);
      var baseFov = camera.aspect < 1 ? 55 + (1 - camera.aspect) * 34 : 55;
      camera.fov = baseFov + velN * (RM ? 0 : 9); camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);

      if (astro) rimLight.position.copy(astro.position).addScaledVector(tmpF.set(0, 0, -1).applyQuaternion(camera.quaternion), 3).add(tmpU.set(2.5, 1.5, 0).applyQuaternion(camera.quaternion));
      dome.position.copy(camera.position);
      nebU.uTime.value = time; nebU.uProg.value = pS;
      starsFar.material.uniforms.uTime.value = time; dustPts.material.uniforms.uTime.value = time;
      starsFar.position.copy(camera.position); starsFar.rotation.y = time * .002;

      warpMat.uniforms.uTime.value = time;
      var wl = velN * 7;
      warpMat.uniforms.uLen.value = wl; warpMat.uniforms.uAlpha.value = RM ? 0 : clamp((velN - .12) * 1.4, 0, .75);

      /* planet */
      if (planet) {
        planetU.uTime.value = time;
        if (!RM) { planet.rotation.y += dt * .012; ringMesh.rotation.z += dt * .004; }
        var ma = time * .07;
        moon.position.set(Math.cos(ma) * 78, Math.sin(ma * .7) * 6, Math.sin(ma) * 78);
        moon.rotation.y += dt * .05;
      }
      sunSprite.material.opacity = .85 + Math.sin(time * 1.3) * .06;

      /* asteroids */
      if (asteroids && !RM) {
        for (var i = 0; i < astData.length; i++) {
          var a = astData[i];
          a.rx += a.vx * dt; a.ry += a.vy * dt; a.rz += a.vz * dt;
          dummy2.position.set(a.x, a.y + Math.sin(time * .4 + a.bob) * .25, a.z);
          dummy2.rotation.set(a.rx, a.ry, a.rz); dummy2.scale.setScalar(a.s); dummy2.updateMatrix();
          asteroids.setMatrixAt(i, dummy2.matrix);
        }
        asteroids.instanceMatrix.needsUpdate = true;
      }

      /* comet */
      if (!RM) {
        comet.next -= dt;
        if (!comet.active && comet.next <= 0) {
          comet.active = true; comet.hist.length = 0;
          var cz = camera.position.z - rnd(30, 70);
          comet.pos.set(camera.position.x + rnd(-60, -40), camera.position.y + rnd(18, 34), cz);
          comet.vel.set(rnd(42, 60), rnd(-14, -8), rnd(-6, 6));
          comet.head.visible = true; comet.trail.visible = true;
        }
        if (comet.active) {
          comet.pos.addScaledVector(comet.vel, dt);
          comet.hist.unshift(comet.pos.clone()); if (comet.hist.length > TRAIL) comet.hist.pop();
          for (var h = 0; h < TRAIL; h++) { var hp = comet.hist[Math.min(h, comet.hist.length - 1)]; trailPos[h * 3] = hp.x; trailPos[h * 3 + 1] = hp.y; trailPos[h * 3 + 2] = hp.z; }
          trailGeo.attributes.position.needsUpdate = true; comet.head.position.copy(comet.pos);
          if (comet.pos.x - camera.position.x > 80) { comet.active = false; comet.head.visible = false; comet.trail.visible = false; comet.next = rnd(7, 14); }
        }
      }

      /* astronaut */
      if (astro) {
        var key = keyAt(pS);
        var halfH = Math.tan(camera.fov * Math.PI / 360);
        tmpF.set(0, 0, -1).applyQuaternion(camera.quaternion);
        tmpR.set(1, 0, 0).applyQuaternion(camera.quaternion);
        tmpU.set(0, 1, 0).applyQuaternion(camera.quaternion);
        var d = key.d, drift = RM ? 0 : 1;
        astro.position.copy(camera.position)
          .addScaledVector(tmpF, d)
          .addScaledVector(tmpR, key.sx * d * halfH * camera.aspect + Math.sin(time * .5) * .12 * drift)
          .addScaledVector(tmpU, key.sy * d * halfH + Math.sin(time * .7) * .16 * drift);
        var sc = key.scale == null ? 1 : key.scale;
        astro.scale.setScalar(Math.max(.0001, sc));
        astro.visible = sc > .01 && Math.abs(key.sx) < 2.4;

        eul.set(.22 + (key.tilt || 0) + Math.sin(time * .45) * .06 * drift, (key.yaw || 0) + Math.sin(time * .3) * .14 * drift, -.28 + Math.sin(time * .38) * .09 * drift);
        tmpQ.setFromEuler(eul);
        astro.quaternion.copy(camera.quaternion).multiply(tmpQ);

        var tv = tumbleVel.length();
        if (tv > .001) {
          var axis = tmpV.copy(tumbleVel).normalize();
          var dq = new THREE.Quaternion().setFromAxisAngle(axis, tv * dt);
          tumble.premultiply(dq);
          tumbleVel.multiplyScalar(Math.pow(.12, dt));
        }
        if (tv < .6) tumble.slerp(idQ, 1 - Math.pow(.03, dt));
        astro.quaternion.multiply(tumble);

        var U = astro.userData, bt = time;
        U.body.position.y = Math.sin(bt * .8) * .05;
        U.body.rotation.x = Math.sin(bt * .6) * .06; U.body.rotation.z = Math.sin(bt * .5 + 1) * .05;
        wave = lerp(wave, Math.max(waveTarget, key.wave || 0), 1 - Math.exp(-dt * 4));
        var sw = Math.sin(bt * .9);
        U.armL.sh.rotation.z = -.32 - sw * .1; U.armL.sh.rotation.x = -.55 + Math.sin(bt * .7 + 2) * .14; U.armL.el.rotation.x = -.85 + Math.sin(bt * .8) * .14;
        U.armR.sh.rotation.z = lerp(.42 + sw * .1, 2.55 + Math.sin(bt * 6) * .22, wave);
        U.armR.sh.rotation.x = lerp(.25 + Math.sin(bt * .7) * .14, 0, wave);
        U.armR.el.rotation.x = lerp(-.45 + Math.sin(bt * .8 + 1) * .14, -.15 + Math.sin(bt * 6 + 1) * .5, wave);
        U.legL.hip.rotation.x = -.62 + Math.sin(bt * .65) * .14; U.legL.kn.rotation.x = 1.0 + Math.sin(bt * .65 + 1) * .12; U.legL.hip.rotation.z = -.12;
        U.legR.hip.rotation.x = -.08 + Math.sin(bt * .65 + 2) * .14; U.legR.kn.rotation.x = .38 + Math.sin(bt * .65 + 3) * .12; U.legR.hip.rotation.z = .14;

        tmpV.copy(astro.position).project(camera);
        var ax = tmpV.x, ay = tmpV.y;
        var lookX = clamp((ndc.x - ax) * .9, -.7, .7), lookY = clamp((ndc.y - ay) * .6, -.45, .45);
        U.head.rotation.y = lerp(U.head.rotation.y, lookX, 1 - Math.exp(-dt * 5));
        U.head.rotation.x = lerp(U.head.rotation.x, -lookY, 1 - Math.exp(-dt * 5));
        U.antLed.material.color.setRGB(.5 + Math.sin(bt * 4) * .5, .1, .15);

        dispTick += dt; if (dispTick > .12) { dispTick = 0; drawAstroDisplay(U.disp, U.dtex, bt); }

        ray.setFromCamera(ndc, camera);
        var hit = astro.visible ? ray.intersectObject(U.hit, false).length > 0 : false;
        if (hit !== hoverAstro) { hoverAstro = hit; document.documentElement.classList.toggle('astro-hover', hit); }
      }

      if (o.onFrame) o.onFrame(api.state, time, dt);

      if (finalPass) {
        finalPass.uniforms.uTime.value = time % 100;
        finalPass.uniforms.uShift.value = RM ? 0 : velN * .012;
        bloom.strength = .55 + velN * .45;
      }
      if (composer) composer.render(dt); else renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
    api.ready = true;
    document.documentElement.classList.add('space-ready');
    return api;
  };

  window.SpaceBG = SpaceBG;
})();
