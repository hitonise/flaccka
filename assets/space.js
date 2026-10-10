/* ============================================================================
   SpaceBG — cinematic 3D space engine (Three.js r128, classic script)
   Baked nebula + gas giant (computed once, sampled cheaply every frame),
   sculpted 3D asteroids with craters (3 LOD tiers), burning meteors,
   orbital station, rigged glTF astronaut (procedural fallback),
   half-res bloom, adaptive resolution that follows the real frame rate,
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

  /* CC-BY 3.0 — "Rigged Astronaut" by J-Toastie, via Poly Pizza (credited in page footers) */
  var ASTRO_MODEL = 'https://static.poly.pizza/d25085f1-dac6-462e-92b6-752c5af534bd.glb';

  var NOISE = [
    'float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }',
    'float noise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);',
    ' return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),',
    '            mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }',
    'float fbm(vec3 p){ float a=.5,s=0.; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.02; a*=.5; } return s; }',
    'vec3 dirFromUv(vec2 uv){ float ph = uv.x*6.2831853; float th = (1.0-uv.y)*3.1415927; return vec3(-cos(ph)*sin(th), cos(th), sin(ph)*sin(th)); }'
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
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uShift: { value: 0 }, uVig: { value: .55 }, uGrain: { value: .035 },
      uSat: { value: 1.1 }, uWarmKeep: { value: 0 }, uContrast: { value: 0 }, uCrush: { value: 0 }, uCool: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uTime,uShift,uVig,uGrain,uSat,uWarmKeep,uContrast,uCrush,uCool; varying vec2 vUv;',
      'void main(){',
      '  vec2 c = vUv-.5; float d = length(c);',
      '  vec2 off = c*uShift*(.4+d*1.6);',
      '  vec3 col; col.r = texture2D(tDiffuse, vUv+off).r; col.g = texture2D(tDiffuse, vUv).g; col.b = texture2D(tDiffuse, vUv-off).b;',
      '  col *= 1.0 - smoothstep(.32,.95,d)*uVig;',
      '  float g = fract(sin(dot(vUv*vec2(1920.,1080.)+uTime, vec2(12.9898,78.233)))*43758.5453);',
      '  col += (g-.5)*uGrain;',
      '  vec3 ac = (col*(2.51*col+.03))/(col*(2.43*col+.59)+.14);',
      '  col = mix(col, clamp(ac,0.,1.), .75);',
      /* film grade: split-tone, selective saturation (warm accents survive), S-curve contrast, crushed blacks */
      '  float l = dot(col, vec3(.299,.587,.114));',
      '  col = mix(col*vec3(.9,1.0,1.1), col*vec3(1.1,1.0,.88), smoothstep(.12,.7,l));',
      '  float warm = smoothstep(.12,.32, col.r - col.b);',
      '  col = mix(vec3(l), col, mix(uSat, 1.15, warm*uWarmKeep));',
      '  col += vec3(-.012,.0,.022)*(1.0-smoothstep(.0,.45,l))*uCool;',
      '  col = clamp(max(col - uCrush, 0.0)/(1.0 - uCrush), 0.0, 1.0);',
      '  col = mix(col, col*col*(3.0-2.0*col), uContrast);',
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
    /* a warm banded planet for the visor to reflect */
    x.save(); x.beginPath(); x.arc(190, 150, 34, 0, Math.PI * 2); x.clip();
    var pg = x.createLinearGradient(160, 120, 220, 184); pg.addColorStop(0, '#ffb066'); pg.addColorStop(.55, '#c8582a'); pg.addColorStop(1, '#2a0d06');
    x.fillStyle = pg; x.fillRect(150, 110, 80, 80);
    for (var bi = 0; bi < 7; bi++) { x.fillStyle = 'rgba(255,' + (150 + bi * 10) + ',90,.18)'; x.fillRect(150, 122 + bi * 9, 80, 3); }
    x.restore();
    var t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  }

  /* render a full-screen shader once into a texture (equirect: uv → direction via dirFromUv) */
  function bake(renderer, w, h, frag, uniforms) {
    var rt = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false, stencilBuffer: false });
    rt.texture.wrapS = THREE.RepeatWrapping;
    var sc = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var mat = new THREE.ShaderMaterial({ uniforms: uniforms || {}, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }', fragmentShader: frag });
    var q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); q.frustumCulled = false; sc.add(q);
    var prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.render(sc, cam); renderer.setRenderTarget(prev);
    q.geometry.dispose(); mat.dispose();
    return rt.texture;
  }

  /* ---------- CPU noise for sculpting rocks ---------- */
  function h3(x, y, z) { var n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return n - Math.floor(n); }
  function vnoise(x, y, z) {
    var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    var a = lerp(lerp(h3(ix, iy, iz), h3(ix + 1, iy, iz), fx), lerp(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), fx), fy);
    var b = lerp(lerp(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), fx), lerp(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), fx), fy);
    return lerp(a, b, fz);
  }
  function fbm3(x, y, z, o) { var s = 0, a = .5; for (var i = 0; i < o; i++) { s += a * vnoise(x, y, z); x *= 2.03; y *= 2.03; z *= 2.03; a *= .5; } return s; }
  function seeded(s) { return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

  /* sculpted asteroid: noise-displaced icosphere + craters with rims, smooth normals, baked vertex colour */
  function rockGeometry(detail, seed, stretch, craterN) {
    var ico = new THREE.IcosahedronGeometry(1, detail), p = ico.attributes.position;
    var map = {}, verts = [], idx = [];
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = Math.round(x * 1e4) + '_' + Math.round(y * 1e4) + '_' + Math.round(z * 1e4);
      var id = map[k]; if (id === undefined) { id = map[k] = verts.length / 3; verts.push(x, y, z); } idx.push(id);
    }
    ico.dispose();
    var R = seeded(seed * 7919 + 13), cr = [];
    for (var c = 0; c < craterN; c++) {
      var u = R() * 2 - 1, th = R() * TAU, s = Math.sqrt(1 - u * u);
      cr.push({ x: s * Math.cos(th), y: u, z: s * Math.sin(th), r: .16 + R() * .34, d: .05 + R() * .1 });
    }
    var n = verts.length / 3, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), so = seed * 13.7;
    var tint = [1, .93 + R() * .05, .84 + R() * .08];
    for (var v = 0; v < n; v++) {
      var nx = verts[v * 3], ny = verts[v * 3 + 1], nz = verts[v * 3 + 2];
      var d = 1 + (fbm3(nx * 1.25 + so, ny * 1.25, nz * 1.25, 4) - .5) * .75 + (fbm3(nx * 4.5, ny * 4.5 + so, nz * 4.5, 3) - .5) * .14;
      var cav = 0;
      for (var q = 0; q < cr.length; q++) {
        var C = cr[q], dx = nx - C.x, dy = ny - C.y, dz = nz - C.z, dd = Math.sqrt(dx * dx + dy * dy + dz * dz) / C.r;
        if (dd < 1) { d -= C.d * (1 - dd * dd); cav = Math.max(cav, 1 - dd); }
        else if (dd < 1.32) d += C.d * .42 * (1 - (dd - 1) / .32);
      }
      pos[v * 3] = nx * d * stretch[0]; pos[v * 3 + 1] = ny * d * stretch[1]; pos[v * 3 + 2] = nz * d * stretch[2];
      var sh = .58 + (fbm3(nx * 6 + so, ny * 6, nz * 6, 3) - .5) * .55 + (d - 1) * .45;
      sh *= 1 - cav * .38;
      if (vnoise(nx * 11 + so, ny * 11, nz * 11) > .82) sh *= 1.25;
      sh = clamp(sh, .18, 1.05);
      col[v * 3] = sh * tint[0]; col[v * 3 + 1] = sh * tint[1]; col[v * 3 + 2] = sh * tint[2];
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals(); geo.computeBoundingSphere();
    return geo;
  }

  /* ---------- procedural astronaut (fallback if the model cannot load) ---------- */
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
    var pack = new THREE.Mesh(new THREE.BoxGeometry(.62, .78, .26), suitShade); pack.position.set(0, .62, -.36); body.add(pack);
    [-.17, .17].forEach(function (x) {
      var tank = new THREE.Mesh(new THREE.CylinderGeometry(.095, .095, .56, 16), glossy); tank.position.set(x, .72, -.56); body.add(tank);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(.097, .014, 8, 20), orange); ring.rotation.x = Math.PI / 2; ring.position.set(x, .6, -.56); body.add(ring);
    });
    var antLed = new THREE.Mesh(new THREE.SphereGeometry(.03, 10, 8), led(0xff3040)); antLed.position.set(.22, 1.36, -.4); body.add(antLed);
    var head = new THREE.Group(); head.position.set(0, 1.4, 0); body.add(head);
    head.add(new THREE.Mesh(new THREE.SphereGeometry(.355, 40, 32), glossy));
    head.add(new THREE.Mesh(new THREE.SphereGeometry(.372, 40, 24, Math.PI / 2 - 1.05, 2.1, Math.PI * .27, Math.PI * .42), visorMat));
    function limb(side) {
      var sh = new THREE.Group(); sh.position.set(side * .45, .92, 0); body.add(sh);
      sh.add(new THREE.Mesh(new THREE.SphereGeometry(.16, 18, 14), joint));
      var up = new THREE.Mesh(capsuleGeo(.105, .26, 14), suit); up.position.y = -.24; sh.add(up);
      var el = new THREE.Group(); el.position.y = -.46; sh.add(el);
      el.add(new THREE.Mesh(new THREE.SphereGeometry(.1, 14, 12), joint));
      var fo = new THREE.Mesh(capsuleGeo(.095, .24, 14), suit); fo.position.y = -.22; el.add(fo);
      var glove = new THREE.Mesh(new THREE.SphereGeometry(.125, 16, 14), suitShade); glove.position.y = -.48; el.add(glove);
      return { sh: sh, el: el };
    }
    var armL = limb(-1), armR = limb(1);
    function leg(side) {
      var hip = new THREE.Group(); hip.position.set(side * .17, .08, 0); body.add(hip);
      var th = new THREE.Mesh(capsuleGeo(.14, .28, 16), suit); th.position.y = -.24; hip.add(th);
      var kn = new THREE.Group(); kn.position.y = -.47; hip.add(kn);
      kn.add(new THREE.Mesh(new THREE.SphereGeometry(.125, 14, 12), joint));
      var sn = new THREE.Mesh(capsuleGeo(.12, .26, 14), suit); sn.position.y = -.22; kn.add(sn);
      var boot = new THREE.Mesh(new THREE.BoxGeometry(.26, .16, .4), suitShade); boot.position.set(0, -.5, .07); kn.add(boot);
      return { hip: hip, kn: kn };
    }
    var legL = leg(-1), legR = leg(1);
    g.traverse(function (o) { if (o.isMesh && o.material && o.material.isMeshStandardMaterial) o.material.envMap = envTex; });
    g.userData = { rig: 'proc', body: body, head: head, armL: armL, armR: armR, legL: legL, legR: legR, antLed: antLed };
    return g;
  }

  /* ---------- auto-rig: give an unrigged T-pose astronaut a skeleton (hips, chest, head, arms, legs) ---------- */
  function ss(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function autoRig(root, envTex, yaw) {
    root.updateMatrixWorld(true);
    var parts = [];
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      var g = o.geometry.clone();
      g.deleteAttribute('skinIndex'); g.deleteAttribute('skinWeight');
      g.applyMatrix4(o.matrixWorld);
      if (yaw) g.rotateY(yaw);
      [].concat(o.material).forEach(function (m) {
        ['map', 'emissiveMap'].forEach(function (k) { if (m[k]) { m[k].encoding = THREE.LinearEncoding; m[k].needsUpdate = true; } });
        m.envMap = envTex; m.envMapIntensity = .6; if (m.metalness > .6 && !/visor|glass|helmet|mask/i.test(m.name || '')) m.metalness = .3; m.needsUpdate = true;
      });
      parts.push({ g: g, mat: o.material });
    });
    if (!parts.length) return null;
    var box = new THREE.Box3();
    parts.forEach(function (p) { p.g.computeBoundingBox(); box.union(p.g.boundingBox); });
    var size = box.getSize(new THREE.Vector3()), s = 2.75 / Math.max(.001, size.y), c = box.getCenter(new THREE.Vector3());
    var Hh = 2.75, y0 = -.99;
    parts.forEach(function (p) { p.g.translate(-c.x, -box.min.y, -c.z); p.g.scale(s, s, s); p.g.translate(0, y0, 0); });
    /* landmarks from the geometry itself */
    var torsoX = [], armY = [], armZ = [], legX = [], reach = 0, all = [];
    parts.forEach(function (p) { var a = p.g.attributes.position; for (var i = 0; i < a.count; i += 3) all.push(a.getX(i), a.getY(i), a.getZ(i)); });
    for (var i = 0; i < all.length; i += 3) { var fy = (all[i + 1] - y0) / Hh, ax = Math.abs(all[i]); if (fy > .55 && fy < .68) torsoX.push(ax); if (fy > .12 && fy < .35) legX.push(ax); reach = Math.max(reach, ax); }
    torsoX.sort(function (a, b) { return a - b; });
    var torsoHalf = torsoX.length ? torsoX[Math.floor(torsoX.length * .9)] : .25;
    for (i = 0; i < all.length; i += 3) if (Math.abs(all[i]) > torsoHalf * 1.35 && (all[i + 1] - y0) / Hh > .6) { armY.push(all[i + 1]); armZ.push(all[i + 2]); }
    function mean(a) { var t = 0; for (var k = 0; k < a.length; k++) t += a[k]; return a.length ? t / a.length : 0; }
    var shX = torsoHalf * .9, elX = shX + (reach - shX) * .47, aY = armY.length ? mean(armY) : y0 + .8 * Hh, aZ = mean(armZ), lgX = legX.length ? mean(legX) : .12;
    var hipY = y0 + .5 * Hh, kneeY = y0 + .27 * Hh, chestY = y0 + .62 * Hh, neckY = y0 + .82 * Hh;
    /* bones (identity rotations → local axes = model axes) */
    function bone(name, x, y, z, parent, px, py, pz) { var b = new THREE.Bone(); b.name = name; b.position.set(x - (px || 0), y - (py || 0), z - (pz || 0)); if (parent) parent.add(b); return b; }
    var hips = bone('Hips', 0, hipY, 0);
    var chest = bone('Spine2', 0, chestY, 0, hips, 0, hipY, 0);
    var head = bone('Head', 0, neckY, 0, chest, 0, chestY, 0);
    var lA = bone('LeftArm', shX, aY, aZ, chest, 0, chestY, 0), lF = bone('LeftForeArm', elX, aY, aZ, lA, shX, aY, aZ);
    var rA = bone('RightArm', -shX, aY, aZ, chest, 0, chestY, 0), rF = bone('RightForeArm', -elX, aY, aZ, rA, -shX, aY, aZ);
    var lU = bone('LeftUpLeg', lgX, hipY, 0, hips, 0, hipY, 0), lL = bone('LeftLeg', lgX, kneeY, 0, lU, lgX, hipY, 0);
    var rU = bone('RightUpLeg', -lgX, hipY, 0, hips, 0, hipY, 0), rL = bone('RightLeg', -lgX, kneeY, 0, rU, -lgX, hipY, 0);
    var list = [hips, chest, head, lA, lF, rA, rF, lU, lL, rU, rL];
    var model = new THREE.Group(); model.add(hips); model.updateMatrixWorld(true);
    var skeleton = new THREE.Skeleton(list);
    var bH = .07 * Hh;
    parts.forEach(function (p) {
      var a = p.g.attributes.position, n = a.count, si = new Float32Array(n * 4), sw = new Float32Array(n * 4);
      for (var v = 0; v < n; v++) {
        var x = a.getX(v), y = a.getY(v), fy = (y - y0) / Hh, ax = Math.abs(x), L = x >= 0;
        var arm = ss(shX - .035 * Hh, shX + .07 * Hh, ax) * (1 - ss(.1 * Hh, .17 * Hh, Math.abs(y - aY))) * (fy > .55 ? 1 : 0);
        var fore = ss(elX - .035 * Hh, elX + .035 * Hh, ax);
        var leg = 1 - ss(.45, .53, fy), shin = 1 - ss(.235, .3, fy);
        var hd = ss(.8, .845, fy) * (1 - ss(shX * .85, shX * 1.1, ax));
        var ch = ss(.55, .66, fy);
        var w = [], ix = [];
        if (arm > 0) { w.push(arm * (1 - fore), arm * fore); ix.push(L ? 3 : 5, L ? 4 : 6); }
        if (leg > 0) { w.push(leg * (1 - shin), leg * shin); ix.push(L ? 7 : 9, L ? 8 : 10); }
        var restA = 1 - (arm > 0 ? arm : 0) - (leg > 0 ? leg : 0); if (restA < 0) restA = 0;
        if (hd > 0) { w.push(restA * hd); ix.push(2); }
        var rem = restA * (1 - hd);
        w.push(rem * ch, rem * (1 - ch)); ix.push(1, 0);
        var order = w.map(function (vv, k) { return k; }).sort(function (p1, p2) { return w[p2] - w[p1]; }).slice(0, 4), tot = 0;
        order.forEach(function (k) { tot += w[k]; });
        for (var q = 0; q < 4; q++) { var k = order[q]; si[v * 4 + q] = k === undefined ? 0 : ix[k]; sw[v * 4 + q] = k === undefined || !tot ? 0 : w[k] / tot; }
        if (!tot) sw[v * 4] = 1;
      }
      p.g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      p.g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      [].concat(p.mat).forEach(function (m) { m.skinning = true; m.needsUpdate = true; });
      var sm = new THREE.SkinnedMesh(p.g, p.mat); sm.frustumCulled = false; model.add(sm);
      sm.bind(skeleton, new THREE.Matrix4());
    });
    var bones = {};
    list.forEach(function (b) { bones[b.name] = { b: b, bind: new THREE.Quaternion(), bw: new THREE.Quaternion(), bwi: new THREE.Quaternion() }; });
    return { model: model, bones: bones };
  }

  /* average normals across vertices that share a position: low-poly facets read as smooth, sculpted surfaces */
  function smoothNormals(g) {
    var p = g.attributes.position, n = g.attributes.normal; if (!p || !n) return;
    var acc = {}, keys = new Array(p.count), i, k, a;
    for (i = 0; i < p.count; i++) {
      k = Math.round(p.getX(i) * 1e4) + '_' + Math.round(p.getY(i) * 1e4) + '_' + Math.round(p.getZ(i) * 1e4); keys[i] = k;
      a = acc[k] || (acc[k] = [0, 0, 0]); a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
    }
    for (i = 0; i < p.count; i++) { a = acc[keys[i]]; var l = Math.hypot(a[0], a[1], a[2]) || 1; n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l); }
    n.needsUpdate = true;
  }

  /* ---------- glTF astronaut: tune materials, normalise size, prepare bone posing ---------- */
  function prepareModel(gltf, envTex, opts) {
    var model = gltf.scene, mixamo = false;
    model.traverse(function (o) { if (o.isMesh && o.geometry && o.geometry.attributes.normal && o.geometry.attributes.position.count < 120000) smoothNormals(o.geometry); });
    model.traverse(function (o) { if (o.isBone && /mixamorig/i.test(o.name)) mixamo = true; });
    if (!mixamo || (opts && opts.forceAuto)) return autoRig(model, envTex, opts && opts.yaw);
    model.traverse(function (o) {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      var m = o.material, nm = (m.name || '').toLowerCase();
      if (nm.indexOf('mask') >= 0) { m.color.setHex(0xd8a23f); m.metalness = 1; m.roughness = .08; m.envMapIntensity = 2.1; }
      else if (nm.indexOf('white') >= 0) { m.color.setHex(0xa9acb4); m.metalness = .03; m.roughness = .6; m.envMapIntensity = .5; }
      else if (nm.indexOf('gray') >= 0 || nm.indexOf('grey') >= 0) { m.color.setHex(0x4a4c55); m.metalness = .45; m.roughness = .45; m.envMapIntensity = .9; }
      else { m.metalness = Math.min(m.metalness, .2); m.envMapIntensity = .7; }
      m.envMap = envTex; m.needsUpdate = true;
    });
    model.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    var s = 2.75 / Math.max(.001, size.y);
    model.scale.setScalar(s);
    var c = box.getCenter(new THREE.Vector3());
    model.position.set(-c.x * s, -.99 - box.min.y * s, -c.z * s);
    var bones = {};
    model.traverse(function (o) {
      if (!o.isBone) return;
      var key = o.name.replace(/^mixamorig[:_]?/i, '');
      var wq = new THREE.Quaternion(); o.getWorldQuaternion(wq);
      bones[key] = { b: o, bind: o.quaternion.clone(), bw: wq, bwi: wq.clone().invert() };
    });
    return { model: model, bones: bones };
  }

  /* ============================== init =================================== */
  var SpaceBG = {};

  SpaceBG.init = function (options) {
    var o = {
      canvas: '#spaceBg', lite: false, astronaut: true, planet: true,
      astroModel: [{ url: 'assets/models/astronaut.glb', id: 'sketchfab' }, { url: ASTRO_MODEL, id: 'jtoastie' }], belt: true, bloom: true, station: true, meteors: true,
      path: DEFAULT_PATH, astroKeys: DEFAULT_ASTRO_KEYS, onFrame: null,
      nebula: [0x6a55ff, 0x1fd1b5, 0xff6a8a], sunPos: [-140, 70, -300], planetPos: [44, -6, -240]
    };
    for (var k in options) if (options.hasOwnProperty(k)) o[k] = options[k];

    var cv = typeof o.canvas === 'string' ? document.querySelector(o.canvas) : o.canvas;
    if (!cv || typeof THREE === 'undefined') return null;

    var mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);
    var cores = navigator.hardwareConcurrency || 8, mem = navigator.deviceMemory || 8;
    var weak = cores <= 4 || mem <= 4;
    var low = o.lite || mobile;
    var devDpr = window.devicePixelRatio || 1;
    /* quality state: resolution scale adapts to the measured frame rate */
    var Q = {
      max: o.lite ? .75 : mobile ? Math.min(devDpr, 1.15) : Math.min(devDpr, weak ? 1 : 1.5),
      min: o.lite ? .5 : .55
    };
    Q.dpr = o.lite ? .75 : mobile ? Math.min(devDpr, .9) : Math.min(devDpr, weak ? .9 : 1.2);
    Q.ceil = Q.max;

    var renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: SHOT }); }
    catch (e) { return null; }
    renderer.setPixelRatio(Q.dpr);
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
    /* studio rig: hard side key, strong cool back-rim, very little fill → sculpted, high-contrast subject */
    var studio = !!o.studio, backdrop = null;
    if (studio) {
      scene.children.forEach(function (c) { if (c.isAmbientLight) c.intensity = .08; if (c.isHemisphereLight) c.intensity = .22; });
      keyLight.intensity = 1.15; keyLight.color.setHex(0xeef1f8); keyLight.position.set(6, 4.5, 3.5);
      rimLight.intensity = 2.4; rimLight.distance = 30; rimLight.color.setHex(0xc4d0ff); sunLight.intensity = 1.1;
      var bdTex = radialTexture(256, [[0, 'rgba(150,160,180,.55)'], [.35, 'rgba(80,88,104,.28)'], [.7, 'rgba(30,34,44,.08)'], [1, 'rgba(0,0,0,0)']]);
      backdrop = new THREE.Sprite(new THREE.SpriteMaterial({ map: bdTex, transparent: true, depthWrite: false, opacity: .9 }));
      backdrop.renderOrder = -5; scene.add(backdrop);
    }

    /* nebula dome — baked once into an equirect texture instead of 15 noise lookups per pixel per frame */
    var nebTex = bake(renderer, low ? 1024 : 2048, low ? 512 : 1024,
      'uniform vec3 uA,uB,uC; varying vec2 vUv;\n' + NOISE + '\n' + [
        'void main(){',
        '  vec3 d = dirFromUv(vUv);',
        '  vec3 p = d*2.1;',
        '  float n1 = fbm(p); float n2 = fbm(p*2.2 + 7.1 + n1*1.4);',
        '  float m = smoothstep(.38,.9, n1*.65 + n2*.55);',
        '  vec3 col = mix(uA, uB, n2)*m*.42;',
        '  col += uC*pow(smoothstep(.5,1.,n2*n1*2.0),2.0)*.35;',
        '  float band = exp(-pow(d.y*3.2, 2.0))*.06;',
        '  col += vec3(.5,.55,.9)*band*fbm(p*5.);',
        '  gl_FragColor = vec4(col,1.0);',
        '}'].join('\n'),
      { uA: { value: new THREE.Color(o.nebula[0]) }, uB: { value: new THREE.Color(o.nebula[1]) }, uC: { value: new THREE.Color(o.nebula[2]) } });
    var dome = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), new THREE.MeshBasicMaterial({ map: nebTex, side: THREE.BackSide, depthWrite: false, fog: false }));
    dome.renderOrder = -20; dome.frustumCulled = false; scene.add(dome);
    if (o.studio) dome.material.color.setScalar(.55);

    /* stars */
    function makeStars(n, rMin, rMax, sizeMin, sizeMax, atten, tubeFn) {
      var pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3), ph = new Float32Array(n);
      var tints = [[1, .96, .9], [.7, .83, 1], [1, .85, .65], [.85, .8, 1]];
      for (var i = 0; i < n; i++) {
        if (tubeFn) { var q = tubeFn(); pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2]; }
        else {
          var r = rMin + Math.random() * (rMax - rMin), th = Math.random() * TAU, p = Math.acos(Math.random() * 2 - 1);
          pos[i * 3] = r * Math.sin(p) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(th); pos[i * 3 + 2] = r * Math.cos(p);
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
        uniforms: { uTime: { value: 0 }, uScale: { value: Q.dpr * 7 }, uAtten: { value: atten ? 1 : 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: [
          'attribute float aSize; attribute vec3 aColor; attribute float aPhase; uniform float uTime,uScale,uAtten;',
          'varying vec3 vColor; varying float vTw;',
          'void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0);',
          '  float tw = .62 + .38*sin(uTime*(1.1+aPhase*2.4) + aPhase*40.);',
          '  vTw = tw; vColor = aColor;',
          '  float att = mix(1.0, 26.0/max(1.0,-mv.z), uAtten);',
          '  gl_PointSize = clamp(aSize*uScale*att*(.7+.3*tw), 1.0, 48.0);',
          '  gl_Position = projectionMatrix*mv; }'
        ].join('\n'),
        fragmentShader: [
          'varying vec3 vColor; varying float vTw;',
          'void main(){ vec2 p = gl_PointCoord-.5; float d = length(p);',
          '  float core = 1.0-smoothstep(.0,.5,d); float glow = pow(core,2.4);',
          '  float cr = max((1.0-smoothstep(.0,.05,abs(p.x)))*(1.0-smoothstep(.0,.5,abs(p.y))), (1.0-smoothstep(.0,.05,abs(p.y)))*(1.0-smoothstep(.0,.5,abs(p.x))))*.55;',
          '  float a = (glow + cr*glow*2.0)*vTw;',
          '  gl_FragColor = vec4(vColor*a*1.5, a); }'
        ].join('\n')
      });
      var pts = new THREE.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);
      return pts;
    }
    var starsFar = makeStars(low ? 1400 : 3000, 500, 850, .7, 2.4, false);
    var dustPts = makeStars(low ? 500 : 1200, 0, 0, .35, 1.1, true, function () { return [rnd(-34, 34), rnd(-20, 20), rnd(-200, 44)]; });

    /* warp lines (attached to camera) */
    var warpN = low ? 100 : 220;
    var wp = new Float32Array(warpN * 2 * 3), wf = new Float32Array(warpN * 2);
    for (var wi = 0; wi < warpN; wi++) {
      var ang = Math.random() * TAU, rad = rnd(2, 26), zz = rnd(0, 80);
      for (var e = 0; e < 2; e++) { wp[(wi * 2 + e) * 3] = Math.cos(ang) * rad; wp[(wi * 2 + e) * 3 + 1] = Math.sin(ang) * rad * .6; wp[(wi * 2 + e) * 3 + 2] = zz; wf[wi * 2 + e] = e; }
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
    var sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(256, [[0, 'rgba(255,248,230,1)'], [.12, 'rgba(255,214,150,.75)'], [.4, 'rgba(255,150,70,.18)'], [1, 'rgba(255,120,40,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sunSprite.position.copy(sunPos); sunSprite.scale.set(150, 150, 1); scene.add(sunSprite);
    var streak = document.createElement('canvas'); streak.width = 512; streak.height = 8;
    var sx = streak.getContext('2d'), sg = sx.createLinearGradient(0, 0, 512, 0);
    sg.addColorStop(0, 'rgba(255,200,140,0)'); sg.addColorStop(.5, 'rgba(255,240,215,.9)'); sg.addColorStop(1, 'rgba(255,200,140,0)');
    sx.fillStyle = sg; sx.fillRect(0, 0, 512, 8);
    var sunStreak = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(streak), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .28 }));
    sunStreak.position.copy(sunPos); sunStreak.scale.set(360, 7, 1); scene.add(sunStreak);

    /* lens flare ghosts: camera-space sprites mirrored through the frame centre */
    var flares = [];
    (function () {
      var ring = radialTexture(128, [[0, 'rgba(255,255,255,0)'], [.62, 'rgba(255,255,255,0)'], [.78, 'rgba(255,255,255,.55)'], [.86, 'rgba(255,255,255,.12)'], [1, 'rgba(255,255,255,0)']]);
      var disc = radialTexture(128, [[0, 'rgba(255,255,255,.55)'], [.55, 'rgba(255,255,255,.28)'], [1, 'rgba(255,255,255,0)']]);
      [[.62, .5, disc, 0xffd9a0, .35], [.32, .22, disc, 0x9fd0ff, .4], [-.12, 1.1, ring, 0xffb070, .25], [-.38, .34, disc, 0x8affd0, .3], [-.72, 1.6, ring, 0x8fa8ff, .18], [-1.05, .7, disc, 0xff9ab0, .22]].forEach(function (f) {
        var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: f[2], color: f[3], blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, opacity: 0 }));
        s.renderOrder = 50; s.userData = { t: f[0], size: f[1], k: f[4] }; camera.add(s); flares.push(s);
      });
    })();
    var flareRay = new THREE.Ray(), planetSphere = new THREE.Sphere(planetPos.clone(), 27), flareAmt = 0;

    /* planet — surface baked once, only lighting is computed per frame */
    var planetGroup = new THREE.Group(), planet = null, ringMesh = null, moon = null, atmos = null;
    if (o.planet) {
      var R = 26;
      var pc = o.planetColors || [[.78, .52, .30], [.95, .82, .60], [.50, .28, .20], [.82, .62, .50]];
      var planetTex = bake(renderer, low ? 1024 : 2048, low ? 512 : 1024,
        'uniform vec3 uC1,uC2,uC3,uC4; varying vec2 vUv;\n' + NOISE + '\n' + [
          'void main(){',
          '  vec3 n = dirFromUv(vUv);',
          '  float warp = fbm(n*3.0);',
          '  float bands = sin((n.y + warp*.34)*24.0)*.5+.5;',
          '  float fine = fbm(vec3(n.x*4.,n.y*34.,n.z*4.) + warp*2.2);',
          '  float m = mix(bands, fine, .45);',
          '  vec3 col = mix(uC1, uC2, smoothstep(.18,.82,m));',
          '  col = mix(col, uC3, smoothstep(.55,.95,fine)*.65);',
          '  col = mix(col, uC4, smoothstep(.72,1.,warp)*.4);',
          '  float lon = atan(n.z,n.x);',
          '  vec2 sd = vec2((lon-.7)*.55, (n.y+.30)*1.7);',
          '  float storm = 1.0-smoothstep(.0,.24,length(sd));',
          '  col = mix(col, vec3(.86,.36,.20), storm*.75);',
          '  col += fbm(n*9.)*.05;',
          '  gl_FragColor = vec4(col,1.0);',
          '}'].join('\n'),
        { uC1: { value: new THREE.Color().fromArray(pc[0]) }, uC2: { value: new THREE.Color().fromArray(pc[1]) }, uC3: { value: new THREE.Color().fromArray(pc[2]) }, uC4: { value: new THREE.Color().fromArray(pc[3]) } });
      planet = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), new THREE.ShaderMaterial({
        uniforms: { uMap: { value: planetTex }, uSunDir: { value: sunDir } },
        vertexShader: 'varying vec2 vUv; varying vec3 vWN; void main(){ vUv=uv; vWN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: [
          'uniform sampler2D uMap; uniform vec3 uSunDir; varying vec2 vUv; varying vec3 vWN;',
          'void main(){',
          '  vec3 col = texture2D(uMap, vUv).rgb;',
          '  float d = dot(normalize(vWN), uSunDir);',
          '  float diff = smoothstep(-.22,.75,d);',
          '  vec3 lit = col*(diff*1.15 + .045) + vec3(.02,.03,.06)*(1.-diff);',
          '  lit += vec3(1.,.32,.1)*smoothstep(0.,.14,d)*(1.0-smoothstep(0.,.34,d))*.2;',
          '  gl_FragColor = vec4(lit,1.0);',
          '}'].join('\n')
      }));
      planetGroup.add(planet);

      atmos = new THREE.Mesh(new THREE.SphereGeometry(R * 1.07, 64, 48), new THREE.ShaderMaterial({
        uniforms: { uSunDir: { value: sunDir }, uColor: { value: new THREE.Color().fromArray(o.atmosColor || [1., .62, .34]) } },
        side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: 'varying vec3 vN; varying vec3 vWN; void main(){ vN=normalize(normalMatrix*normal); vWN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 uSunDir,uColor; varying vec3 vN; varying vec3 vWN; void main(){ float i = pow(max(0.,.74 - dot(vN, vec3(0.,0.,1.))), 3.2); float side = smoothstep(-.55,.55,dot(normalize(-vWN), uSunDir)*-1.0); gl_FragColor = vec4(uColor*i*(.25+side*1.4), 1.0); }'
      }));
      planetGroup.add(atmos);

      /* ring: radial profile baked into a 1D strip */
      var rc = o.ringColor || [.86, .74, .55];
      var ringTex = bake(renderer, 1024, 4,
        'uniform vec3 uC; varying vec2 vUv;\n' + NOISE + '\n' + [
          'void main(){ float t = vUv.x;',
          '  float n1 = noise(vec3(t*22.,1.3,2.7)); float n2 = noise(vec3(t*64.,4.,9.)); float n3 = noise(vec3(t*9.,7.,1.));',
          '  float dens = smoothstep(.0,.12,t)*(1.0-smoothstep(.82,1.,t));',
          '  float gap = smoothstep(.40,.44,t)*(1.0-smoothstep(.50,.54,t));',
          '  float gap2 = smoothstep(.72,.74,t)*(1.0-smoothstep(.76,.78,t));',
          '  float a = dens*(.35+.65*n3)*(.55+.45*n1)*(.75+.25*n2)*(1.-gap*.9)*(1.-gap2*.7);',
          '  vec3 col = mix(uC*.55, uC*1.15, n3*.6+n1*.4);',
          '  col = mix(col, vec3(.55,.62,.75), smoothstep(.6,1.,t)*.35);',
          '  gl_FragColor = vec4(col, a*.82); }'].join('\n'),
        { uC: { value: new THREE.Color().fromArray(rc) } });
      ringTex.wrapS = THREE.ClampToEdgeWrapping;
      ringMesh = new THREE.Mesh(new THREE.RingGeometry(38, 66, 160, 1), new THREE.ShaderMaterial({
        uniforms: { uMap: { value: ringTex }, uIn: { value: 38 }, uOut: { value: 66 } }, side: THREE.DoubleSide, transparent: true, depthWrite: false,
        vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: 'uniform sampler2D uMap; uniform float uIn,uOut; varying vec3 vP; void main(){ float t = clamp((length(vP.xy)-uIn)/(uOut-uIn),0.,1.); gl_FragColor = texture2D(uMap, vec2(t,.5)); }'
      }));
      ringMesh.rotation.x = -Math.PI / 2 + .38; ringMesh.rotation.y = .08;
      planetGroup.add(ringMesh);

      var moonGeo = rockGeometry(low ? 10 : 18, 77, [3.4, 3.3, 3.4], 14);
      moon = new THREE.Mesh(moonGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMap: envTex, envMapIntensity: .4 }));
      planetGroup.add(moon);
      planetGroup.position.copy(planetPos);
      planetGroup.rotation.z = .08;
      scene.add(planetGroup);
    }

    /* camera path */
    function curveFrom(arr) { return new THREE.CatmullRomCurve3(arr.map(function (a) { return new THREE.Vector3(a[0], a[1], a[2]); }), false, 'centripetal'); }
    var posCurve = curveFrom(o.path.pos), lookCurve = curveFrom(o.path.look);
    var rolls = o.path.roll || [0, 0];
    function rollAt(t) { var f = t * (rolls.length - 1), i = Math.min(rolls.length - 2, Math.floor(f)); return lerp(rolls[i], rolls[i + 1], smooth(f - i)); }
    var pathSamples = posCurve.getPoints(220);
    function nearPath(x, y, z, r2) { for (var si = 0; si < pathSamples.length; si += 2) { var sp = pathSamples[si], dx = sp.x - x, dy = sp.y - y, dz = sp.z - z; if (dx * dx + dy * dy + dz * dz < r2) return true; } return false; }

    /* orbital station */
    var station = null;
    if (o.station) {
      station = buildStation(envTex);
      var sp0 = posCurve.getPoint(.3);
      station.group.position.set(sp0.x - 24, sp0.y + 8, sp0.z - 18);
      station.group.rotation.set(.35, .6, .15);
      scene.add(station.group);
    }
    function buildStation(env) {
      var g = new THREE.Group();
      var metal = new THREE.MeshStandardMaterial({ color: 0xd9dce4, metalness: .55, roughness: .38, envMap: env, envMapIntensity: 1 });
      var dark = new THREE.MeshStandardMaterial({ color: 0x3a3f4c, metalness: .6, roughness: .45, envMap: env, envMapIntensity: .8 });
      var gold = new THREE.MeshStandardMaterial({ color: 0xc89b4a, metalness: 1, roughness: .28, envMap: env, envMapIntensity: 1.5 });
      var pc2 = document.createElement('canvas'); pc2.width = 256; pc2.height = 256;
      var px = pc2.getContext('2d'); px.fillStyle = '#0a1735'; px.fillRect(0, 0, 256, 256);
      for (var gy = 0; gy < 8; gy++) for (var gx = 0; gx < 8; gx++) { px.fillStyle = 'rgba(' + (40 + Math.random() * 20) + ',' + (80 + Math.random() * 30) + ',' + (160 + Math.random() * 40) + ',.55)'; px.fillRect(gx * 32 + 2, gy * 32 + 2, 28, 28); }
      px.strokeStyle = 'rgba(200,215,255,.35)'; px.lineWidth = 1.5;
      for (var li = 0; li <= 8; li++) { px.beginPath(); px.moveTo(li * 32, 0); px.lineTo(li * 32, 256); px.stroke(); px.beginPath(); px.moveTo(0, li * 32); px.lineTo(256, li * 32); px.stroke(); }
      var ptex = new THREE.CanvasTexture(pc2);
      var panelMat = new THREE.MeshStandardMaterial({ map: ptex, metalness: .55, roughness: .3, envMap: env, envMapIntensity: 1.3, emissive: 0x0b1d48, emissiveIntensity: .35 });
      var core = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 14, 28), metal); core.rotation.z = Math.PI / 2; g.add(core);
      [-7, 0, 7].forEach(function (x) { var nd = new THREE.Mesh(new THREE.SphereGeometry(1.7, 28, 18), metal); nd.position.x = x; g.add(nd); });
      var mod2 = new THREE.Mesh(new THREE.CylinderGeometry(.95, .95, 8, 24), metal); mod2.position.y = 3.5; g.add(mod2);
      var mod3 = new THREE.Mesh(new THREE.CylinderGeometry(.8, .8, 5, 20), dark); mod3.position.y = -2.6; g.add(mod3);
      for (var b = 0; b < 6; b++) { var band = new THREE.Mesh(new THREE.TorusGeometry(1.14, .07, 8, 28), dark); band.rotation.y = Math.PI / 2; band.position.x = -5 + b * 2; g.add(band); }
      [-7, 7].forEach(function (x) {
        var truss = new THREE.Mesh(new THREE.BoxGeometry(.32, .32, 26), dark); truss.position.x = x; g.add(truss);
        [-10, -4.5, 4.5, 10].forEach(function (z) {
          var pnl = new THREE.Mesh(new THREE.BoxGeometry(4.6, .08, 4.8), panelMat); pnl.position.set(x, 0, z); pnl.rotation.x = .35; g.add(pnl);
          var fr = new THREE.Mesh(new THREE.BoxGeometry(4.8, .1, .12), gold); fr.position.set(x, 0, z); g.add(fr);
        });
      });
      var ring = new THREE.Group(); g.add(ring);
      var hab = new THREE.Mesh(new THREE.TorusGeometry(6.2, .55, 18, 72), metal); hab.rotation.y = Math.PI / 2; ring.add(hab);
      for (var s2 = 0; s2 < 4; s2++) { var spoke = new THREE.Mesh(new THREE.CylinderGeometry(.14, .14, 6.2, 8), dark); var a2 = s2 * Math.PI / 2; spoke.position.set(0, Math.cos(a2) * 3.1, Math.sin(a2) * 3.1); spoke.rotation.x = a2; ring.add(spoke); }
      var dish = new THREE.Mesh(new THREE.SphereGeometry(1.6, 28, 12, 0, TAU, 0, .85), gold); dish.position.y = 8.6; dish.rotation.x = Math.PI; g.add(dish);
      var rod = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, 2.4, 6), dark); rod.position.y = 8.4; g.add(rod);
      var lights = [];
      [[0, 9.8, 0, 0xff3344], [7, 0, 13.2, 0x44ff88], [-7, 0, -13.2, 0xff3344], [7, 0, -13.2, 0xffffff], [-7, 0, 13.2, 0x44ff88], [0, -5.2, 0, 0xffffff]].forEach(function (L, i) {
        var m = new THREE.Mesh(new THREE.SphereGeometry(.16, 8, 6), new THREE.MeshBasicMaterial({ color: L[3] })); m.position.set(L[0], L[1], L[2]); m.userData.ph = i * .7; g.add(m); lights.push(m);
      });
      g.scale.setScalar(.85);
      return { group: g, ring: ring, lights: lights };
    }

    /* asteroid field: 3 LOD tiers of sculpted rocks */
    var rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .93, metalness: .02, envMap: envTex, envMapIntensity: .35 });
    var tiers = [], heroRocks = [], tmpc = new THREE.Color(), dummy = new THREE.Object3D();
    if (o.belt) {
      var nSmall = low ? 70 : 150, nMed = low ? 18 : 40;
      var defs = [
        { geos: [rockGeometry(low ? 4 : 5, 1, [1, .82, 1.1], 4), rockGeometry(low ? 4 : 5, 2, [1.15, .9, .85], 5)], n: nSmall, sMin: .18, sMax: 1.1 },
        { geos: [rockGeometry(low ? 7 : 10, 3, [1, .78, 1.2], 7), rockGeometry(low ? 7 : 10, 4, [1.2, .95, .9], 8)], n: nMed, sMin: 1.1, sMax: 2.6 }
      ];
      defs.forEach(function (d) {
        d.geos.forEach(function (geo, gi) {
          var cnt = Math.round(d.n / d.geos.length), mesh = new THREE.InstancedMesh(geo, rockMat, cnt), data = [];
          for (var ai = 0; ai < cnt; ai++) {
            var px, py, pz, ok = false, tries = 0;
            while (!ok && tries++ < 40) {
              pz = rnd(-200, 6); var rr = 9 + Math.pow(Math.random(), 1.2) * 60, aa = Math.random() * TAU;
              px = Math.cos(aa) * rr; py = Math.sin(aa) * rr * .62;
              ok = !nearPath(px, py, pz, 64);
              if (ok && pz > -60 && Math.abs(py) < 9 && px > -6 && px < 30) ok = false;
              if (ok && station && station.group.position.distanceToSquared(new THREE.Vector3(px, py, pz)) < 400) ok = false;
            }
            var sc = d.sMin + Math.pow(Math.random(), 2.2) * (d.sMax - d.sMin);
            var ad = { x: px, y: py, z: pz, s: sc, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, vx: rnd(-.22, .22), vy: rnd(-.22, .22), vz: rnd(-.22, .22), bob: Math.random() * TAU };
            data.push(ad);
            tmpc.setHSL(rnd(.05, .1), rnd(.05, .16), rnd(.68, .92)); mesh.setColorAt(ai, tmpc);
            dummy.position.set(px, py, pz); dummy.rotation.set(ad.rx, ad.ry, ad.rz); dummy.scale.setScalar(sc); dummy.updateMatrix(); mesh.setMatrixAt(ai, dummy.matrix);
          }
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.frustumCulled = false; scene.add(mesh);
          tiers.push({ mesh: mesh, data: data });
        });
      });
      /* a few big, highly detailed rocks that pass right by the camera for real depth */
      var heroDefs = [[.17, -12, -5.5, -10, 2.4], [.37, -11, 3.5, -12, 3.1], [.6, 12, 2.5, -15, 2.8], [.82, -10, -3.5, -12, 3.4]];
      heroDefs.forEach(function (hd, i) {
        var geo = rockGeometry(low ? 12 : 22, 20 + i, [1, .8 + i * .05, 1.15], 12);
        var m = new THREE.Mesh(geo, rockMat);
        var base = posCurve.getPoint(hd[0]);
        m.position.set(base.x + hd[1], base.y + hd[2], base.z + hd[3]);
        m.scale.setScalar(hd[4]); m.rotation.set(Math.random() * 6, Math.random() * 6, 0);
        m.userData = { vx: rnd(-.12, .12), vy: rnd(.06, .16), base: m.position.clone(), ph: i * 1.7 };
        scene.add(m); heroRocks.push(m);
      });
    }

    /* comet */
    var comet = { head: null, trail: null, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), hist: [], next: 4 };
    comet.head = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(64, [[0, 'rgba(255,255,255,1)'], [.4, 'rgba(160,220,255,.6)'], [1, 'rgba(160,220,255,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    comet.head.scale.set(3.2, 3.2, 1); comet.head.visible = false; scene.add(comet.head);
    var TRAIL = 36, trailGeo = new THREE.BufferGeometry(), trailPos = new Float32Array(TRAIL * 3), trailCol = new Float32Array(TRAIL * 3);
    for (var ti = 0; ti < TRAIL; ti++) { var ff = 1 - ti / TRAIL; trailCol[ti * 3] = .55 * ff; trailCol[ti * 3 + 1] = .8 * ff; trailCol[ti * 3 + 2] = ff; }
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3)); trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
    comet.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    comet.trail.frustumCulled = false; comet.trail.visible = false; scene.add(comet.trail);

    /* burning meteors: sculpted rock head + glow + particle trail */
    var meteors = [], MT = 28;
    if (o.meteors && !RM) {
      var metGeo = rockGeometry(4, 99, [1, .85, 1.2], 3);
      var metMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x8a5a3a, roughness: .9, emissive: 0xff5a14, emissiveIntensity: .9 });
      var glowTex = radialTexture(64, [[0, 'rgba(255,240,200,1)'], [.25, 'rgba(255,170,70,.75)'], [.6, 'rgba(255,90,20,.18)'], [1, 'rgba(255,60,0,0)']]);
      var trailMat = new THREE.ShaderMaterial({
        uniforms: { uScale: { value: Q.dpr } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: 'attribute float aAge; uniform float uScale; varying float vA; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vA = aAge; gl_PointSize = clamp((1.0-aAge)*420.0*uScale/max(1.0,-mv.z), 1.0, 40.0); gl_Position = projectionMatrix*mv; }',
        fragmentShader: 'varying float vA; void main(){ float d = length(gl_PointCoord-.5); float a = (1.0-smoothstep(.0,.5,d))*(1.0-vA); vec3 c = mix(vec3(1.,.92,.7), vec3(1.,.35,.08), vA); gl_FragColor = vec4(c*a, a); }'
      });
      for (var mi = 0; mi < (low ? 2 : 4); mi++) {
        var head = new THREE.Mesh(metGeo, metMat); head.visible = false; scene.add(head);
        var glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); glow.scale.set(5, 5, 1); glow.visible = false; scene.add(glow);
        var tg = new THREE.BufferGeometry(), tp = new Float32Array(MT * 3), ta = new Float32Array(MT);
        for (var tj = 0; tj < MT; tj++) ta[tj] = tj / MT;
        tg.setAttribute('position', new THREE.BufferAttribute(tp, 3)); tg.setAttribute('aAge', new THREE.BufferAttribute(ta, 1));
        var tpts = new THREE.Points(tg, trailMat); tpts.frustumCulled = false; tpts.visible = false; scene.add(tpts);
        meteors.push({ head: head, glow: glow, trail: tpts, tp: tp, hist: [], active: false, next: 1.5 + mi * 2.2, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, spin: new THREE.Vector3() });
      }
    }

    /* astronaut */
    var astro = null, astroKeys = [], rig = null, astroIn = 0;
    var tumble = new THREE.Quaternion(), tumbleVel = new THREE.Vector3(), waveTarget = 0, wave = 0;
    var hitSphere = null;
    if (o.astronaut) {
      astro = new THREE.Group(); scene.add(astro);
      hitSphere = new THREE.Mesh(new THREE.SphereGeometry(1.25, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
      hitSphere.position.y = .7; astro.add(hitSphere);
      var fellBack = false;
      var useFallback = function () { if (rig || fellBack) return; fellBack = true; var pa = buildAstronaut(envTex); astro.add(pa); rig = pa.userData; };
      /* models are tried in order: the local Sketchfab astronaut, then the hosted rigged one, then the procedural fallback */
      var models = [].concat(o.astroModel || []).filter(Boolean);
      var setCredit = function (id) { document.documentElement.setAttribute('data-astro', id); };
      if (models.length && THREE.GLTFLoader) {
        var to = setTimeout(function () { useFallback(); setCredit('proc'); }, 12000), loader = new THREE.GLTFLoader();
        var tryModel = function (i) {
          if (i >= models.length) { clearTimeout(to); useFallback(); setCredit('proc'); return; }
          var md = typeof models[i] === 'string' ? { url: models[i] } : models[i];
          try {
            loader.load(md.url, function (gltf) {
              if (fellBack) return;
              var pm = prepareModel(gltf, envTex, md);
              if (!pm) { tryModel(i + 1); return; }
              clearTimeout(to);
              astro.add(pm.model);
              rig = { rig: 'gltf', bones: pm.bones };
              astroIn = 0; setCredit(md.id || 'model');
            }, undefined, function () { tryModel(i + 1); });
          } catch (err) { tryModel(i + 1); }
        };
        tryModel(0);
      } else { useFallback(); setCredit('proc'); }
    }

    /* bone posing in the model's bind frame */
    var qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), eA = new THREE.Euler();
    function poseBone(name, x, y, z) {
      var B = rig.bones[name]; if (!B) return;
      eA.set(x, y, z, 'XYZ'); qA.setFromEuler(eA);
      qB.copy(B.bwi).multiply(qA).multiply(B.bw);
      B.b.quaternion.copy(B.bind).multiply(qB);
    }
    function poseGltf(t, wv, lx, ly) {
      var d = RM ? 0 : 1;
      poseBone('Hips', Math.sin(t * .6) * .06 * d, Math.sin(t * .4) * .05 * d, Math.sin(t * .5 + 1) * .05 * d);
      poseBone('Spine', .06, 0, 0);
      poseBone('Spine2', .1 + Math.sin(t * .8) * .03 * d, 0, 0);
      poseBone('Neck', -ly * .25, lx * .3, 0);
      poseBone('Head', -ly * .45, lx * .55, 0);
      var s1 = Math.sin(t * .9) * d;
      poseBone('LeftArm', .12 + s1 * .05, -.42, -1.08 - s1 * .08);
      poseBone('LeftForeArm', 0, -.75 + Math.sin(t * .8) * .1 * d, 0);
      poseBone('RightArm', lerp(.12 - s1 * .05, -.1, wv), lerp(.42, .15, wv), lerp(1.08 + s1 * .08, -.95, wv));
      poseBone('RightForeArm', 0, lerp(.75 + Math.sin(t * .8 + 1) * .1 * d, .1, wv), lerp(0, -1.1 + Math.sin(t * 7) * .45, wv));
      poseBone('LeftUpLeg', -.55 + Math.sin(t * .65) * .12 * d, 0, .06);
      poseBone('LeftLeg', .95 + Math.sin(t * .65 + 1) * .1 * d, 0, 0);
      poseBone('RightUpLeg', -.12 + Math.sin(t * .65 + 2) * .12 * d, 0, -.08);
      poseBone('RightLeg', .42 + Math.sin(t * .65 + 3) * .1 * d, 0, 0);
      poseBone('LeftFoot', .25, 0, 0); poseBone('RightFoot', .2, 0, 0);
    }
    function poseProc(U, bt, wv) {
      U.body.position.y = Math.sin(bt * .8) * .05;
      U.body.rotation.x = Math.sin(bt * .6) * .06; U.body.rotation.z = Math.sin(bt * .5 + 1) * .05;
      var sw = Math.sin(bt * .9);
      U.armL.sh.rotation.z = -.32 - sw * .1; U.armL.sh.rotation.x = -.55 + Math.sin(bt * .7 + 2) * .14; U.armL.el.rotation.x = -.85 + Math.sin(bt * .8) * .14;
      U.armR.sh.rotation.z = lerp(.42 + sw * .1, 2.55 + Math.sin(bt * 6) * .22, wv);
      U.armR.sh.rotation.x = lerp(.25 + Math.sin(bt * .7) * .14, 0, wv);
      U.armR.el.rotation.x = lerp(-.45 + Math.sin(bt * .8 + 1) * .14, -.15 + Math.sin(bt * 6 + 1) * .5, wv);
      U.legL.hip.rotation.x = -.62 + Math.sin(bt * .65) * .14; U.legL.kn.rotation.x = 1.0 + Math.sin(bt * .65 + 1) * .12; U.legL.hip.rotation.z = -.12;
      U.legR.hip.rotation.x = -.08 + Math.sin(bt * .65 + 2) * .14; U.legR.kn.rotation.x = .38 + Math.sin(bt * .65 + 3) * .12; U.legR.hip.rotation.z = .14;
      U.antLed.material.color.setRGB(.5 + Math.sin(bt * 4) * .5, .1, .15);
    }

    var docH = 1;
    function resolveKeys() {
      docH = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
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
            tilt: lerp(a.tilt || 0, b.tilt || 0, t), roll: lerp(a.roll == null ? -.28 : a.roll, b.roll == null ? -.28 : b.roll, t)
          };
        }
      }
      return last;
    }

    /* post-processing: bloom runs at half resolution */
    var composer = null, bloom = null, finalPass = null, postOn = false;
    /* the grading pass runs everywhere except tiny previews; bloom only where the GPU can afford it */
    var canPost = !o.lite && !/[?&]nopost/.test(location.search) && THREE.EffectComposer && THREE.RenderPass && THREE.ShaderPass && THREE.CopyShader;
    var G = o.grade || {};
    function setupPost() {
      composer = new THREE.EffectComposer(renderer);
      composer.setPixelRatio(Q.dpr); composer.setSize(W, H);
      composer.addPass(new THREE.RenderPass(scene, camera));
      if (o.bloom && !low && THREE.UnrealBloomPass) {
        bloom = new THREE.UnrealBloomPass(new THREE.Vector2(W / 2, H / 2), G.bloom != null ? G.bloom : .55, .5, .84);
        var bs = bloom.setSize.bind(bloom);
        bloom.setSize = function (w, h) { bs(Math.max(2, Math.round(w * .5)), Math.max(2, Math.round(h * .5))); };
        composer.addPass(bloom);
      }
      finalPass = new THREE.ShaderPass(FinalShader); finalPass.renderToScreen = true;
      var fu = finalPass.uniforms;
      if (G.sat != null) fu.uSat.value = G.sat; if (G.warm != null) fu.uWarmKeep.value = G.warm; if (G.contrast != null) fu.uContrast.value = G.contrast;
      if (G.crush != null) fu.uCrush.value = G.crush; if (G.cool != null) fu.uCool.value = G.cool; if (G.vig != null) fu.uVig.value = G.vig; if (G.grain != null) fu.uGrain.value = G.grain;
      composer.addPass(finalPass);
      postOn = true;
    }
    if (canPost) { try { setupPost(); } catch (e) { composer = null; postOn = false; } }

    function applyDpr(v) {
      Q.dpr = v;
      renderer.setPixelRatio(v); renderer.setSize(W, H, false);
      if (composer) { composer.setPixelRatio(v); composer.setSize(W, H); }
      starsFar.material.uniforms.uScale.value = v * 7; dustPts.material.uniforms.uScale.value = v * 7;
      if (meteors.length) meteors[0].trail.material.uniforms.uScale.value = v;
    }

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
      waveT = 1.6;
    });
    var waveT = 0;

    function onResize() {
      W = window.innerWidth; H = window.innerHeight;
      renderer.setSize(W, H, false);
      camera.aspect = W / H; camera.updateProjectionMatrix();
      if (composer) composer.setSize(W, H);
      resolveKeys();
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('load', function () { setTimeout(resolveKeys, 120); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(resolveKeys, 60); });
    resolveKeys();

    /* loop */
    var api = {
      renderer: renderer, scene: scene, camera: camera, astro: astro, state: { p: 0, vel: 0, t: 0 }, quality: Q,
      refresh: resolveKeys, setWave: function (v) { waveTarget = v; },
      kick: function () { tumbleVel.set(rnd(-4, 4), 9, rnd(-3, 3)); },
      setFps: function (f) { minFrame = f ? 1000 / f - 2 : 0; }
    };
    var minFrame = o.lite ? 1000 / 30 - 2 : 0;
    var introK = o.intro && !SHOT && !RM ? 1 : 0, introPlay = false, introT = 0, introDur = 3.4;
    api.playIntro = function (d) { if (!introK) return; introDur = d || introDur; introT = 0; introPlay = true; };
    api.skipIntro = function () { introK = 0; };
    var pS = 0, last = performance.now(), lastDraw = 0, velS = 0, lastY = window.scrollY, time = 0;
    var tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpF = new THREE.Vector3(), tmpR = new THREE.Vector3(), tmpU = new THREE.Vector3(), eul = new THREE.Euler(), dummy2 = new THREE.Object3D(), idQ = new THREE.Quaternion();
    var perf = { n: 0, t: 0, good: 0, warm: 1.5 };

    function adapt(realDt) {
      if (SHOT) return;
      perf.warm -= realDt; if (perf.warm > 0) return;
      perf.n++; perf.t += realDt;
      if (perf.t < 1) return;
      var fps = perf.n / perf.t; perf.n = 0; perf.t = 0;
      var target = minFrame ? 1000 / (minFrame + 2) - 4 : 50;
      if (fps < target) {
        perf.good = 0;
        if (bloom && bloom.enabled) { bloom.enabled = false; }
        else if (Q.dpr > Q.min + .02) { Q.ceil = Math.max(Q.min, Q.dpr - .05); applyDpr(Math.max(Q.min, Q.dpr * .8)); }
        else if (postOn) { postOn = false; document.documentElement.classList.add('perf-lite'); }
        else document.documentElement.classList.add('perf-lite');
      } else if (fps > target + 8) {
        if (++perf.good >= 4 && Q.dpr < Math.min(Q.ceil, Q.max) - .02) { applyDpr(Math.min(Q.ceil, Q.max, Q.dpr + .1)); perf.good = 0; }
      }
    }

    function frame(now) {
      requestAnimationFrame(frame);
      if (minFrame && now - lastDraw < minFrame) return;
      lastDraw = now;
      render(now);
    }
    api.step = function () { render(performance.now()); };
    function render(now) {
      if (document.hidden && !SHOT) { last = now; return; }
      var realDt = (now - last) / 1000;
      var dt = Math.min(.05, realDt); last = now; time += dt;
      adapt(Math.min(realDt, .5));

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
      /* opening shot: long telephoto dolly-in that settles into the hero framing */
      if (introK > 0) {
        if (introPlay) { introT += dt; var ik = clamp(introT / introDur, 0, 1); introK = 1 - (ik < .5 ? 4 * ik * ik * ik : 1 - Math.pow(-2 * ik + 2, 3) / 2); }
        tmpU.set(0, 0, -1).applyQuaternion(camera.quaternion);
        camera.position.addScaledVector(tmpU, -34 * introK * introK);
        camera.position.y += 6 * introK;
        camera.rotateZ(.14 * introK);
        baseFov *= 1 - .3 * introK;
      }
      camera.fov = baseFov + velN * (RM ? 0 : 9); camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);

      /* lens flare */
      if (flares.length) {
        tmpV.copy(sunPos).project(camera);
        var vis = tmpV.z < 1 && Math.abs(tmpV.x) < 1.25 && Math.abs(tmpV.y) < 1.25 ? 1 - Math.max(Math.abs(tmpV.x), Math.abs(tmpV.y)) / 1.25 : 0;
        if (vis > 0 && planet) { flareRay.origin.copy(camera.position); flareRay.direction.copy(sunPos).sub(camera.position).normalize(); if (flareRay.intersectsSphere(planetSphere)) vis = 0; }
        flareAmt = lerp(flareAmt, vis, 1 - Math.exp(-dt * 6));
        var fh = Math.tan(camera.fov * Math.PI / 360), FD = 10;
        for (var fi = 0; fi < flares.length; fi++) {
          var F = flares[fi], fu = F.userData, fs = fu.size * FD * fh * .5;
          F.position.set(tmpV.x * fu.t * fh * camera.aspect * FD, tmpV.y * fu.t * fh * FD, -FD);
          F.scale.set(fs, fs, 1); F.material.opacity = flareAmt * fu.k;
        }
      }

      if (astro) rimLight.position.copy(astro.position).addScaledVector(tmpF.set(0, 0, -1).applyQuaternion(camera.quaternion), 3).add(tmpU.set(2.5, 1.5, 0).applyQuaternion(camera.quaternion));
      dome.position.copy(camera.position); dome.rotation.y = pS * .5 + time * .004;
      starsFar.material.uniforms.uTime.value = time; dustPts.material.uniforms.uTime.value = time;
      starsFar.position.copy(camera.position); starsFar.rotation.y = time * .002;

      warpMat.uniforms.uTime.value = time;
      warpMat.uniforms.uLen.value = velN * 7; warpMat.uniforms.uAlpha.value = RM ? 0 : clamp((velN - .12) * 1.4, 0, .75);

      if (planet) {
        if (!RM) { planet.rotation.y += dt * .012; ringMesh.rotation.z += dt * .004; }
        var ma = time * .07;
        moon.position.set(Math.cos(ma) * 78, Math.sin(ma * .7) * 6, Math.sin(ma) * 78);
        moon.rotation.y += dt * .05;
      }
      sunSprite.material.opacity = .85 + Math.sin(time * 1.3) * .06;

      if (station) {
        if (!RM) { station.group.rotation.y += dt * .03; station.ring.rotation.x += dt * .25; }
        for (var li = 0; li < station.lights.length; li++) station.lights[li].visible = Math.sin(time * 3 + station.lights[li].userData.ph * 4) > .2;
      }

      /* asteroids */
      if (!RM) {
        for (var ti2 = 0; ti2 < tiers.length; ti2++) {
          var T = tiers[ti2];
          for (var i = 0; i < T.data.length; i++) {
            var a = T.data[i];
            a.rx += a.vx * dt; a.ry += a.vy * dt; a.rz += a.vz * dt;
            dummy2.position.set(a.x, a.y + Math.sin(time * .4 + a.bob) * .25, a.z);
            dummy2.rotation.set(a.rx, a.ry, a.rz); dummy2.scale.setScalar(a.s); dummy2.updateMatrix();
            T.mesh.setMatrixAt(i, dummy2.matrix);
          }
          T.mesh.instanceMatrix.needsUpdate = true;
        }
        for (var hr = 0; hr < heroRocks.length; hr++) {
          var HR = heroRocks[hr], ud = HR.userData;
          HR.rotation.x += ud.vx * dt; HR.rotation.y += ud.vy * dt;
          HR.position.y = ud.base.y + Math.sin(time * .35 + ud.ph) * .4;
        }
      }

      /* comet */
      if (!RM) {
        comet.next -= dt;
        if (!comet.active && comet.next <= 0) {
          comet.active = true; comet.hist.length = 0;
          comet.pos.set(camera.position.x + rnd(-60, -40), camera.position.y + rnd(18, 34), camera.position.z - rnd(30, 70));
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

      /* meteors */
      if (meteors.length) {
        tmpR.set(1, 0, 0).applyQuaternion(camera.quaternion); tmpU.set(0, 1, 0).applyQuaternion(camera.quaternion); tmpF.set(0, 0, -1).applyQuaternion(camera.quaternion);
        for (var m = 0; m < meteors.length; m++) {
          var M = meteors[m];
          if (!M.active) {
            M.next -= dt;
            if (M.next <= 0) {
              M.active = true; M.life = 0; M.hist.length = 0;
              M.pos.copy(camera.position).addScaledVector(tmpF, rnd(60, 130)).addScaledVector(tmpR, rnd(-80, 80)).addScaledVector(tmpU, rnd(32, 52));
              M.vel.copy(tmpR).multiplyScalar(rnd(-.7, .7)).addScaledVector(tmpU, -1).addScaledVector(tmpF, rnd(-.25, .15)).normalize().multiplyScalar(rnd(48, 72));
              M.spin.set(rnd(-3, 3), rnd(-3, 3), rnd(-3, 3));
              var ms = rnd(.35, .8); M.head.scale.setScalar(ms); M.glow.scale.setScalar(ms * 9);
              M.head.visible = M.glow.visible = M.trail.visible = true;
            }
            continue;
          }
          M.life += dt;
          M.pos.addScaledVector(M.vel, dt);
          M.head.position.copy(M.pos); M.glow.position.copy(M.pos);
          M.head.rotation.x += M.spin.x * dt; M.head.rotation.y += M.spin.y * dt;
          M.hist.unshift(M.pos.x, M.pos.y, M.pos.z); if (M.hist.length > MT * 3) M.hist.length = MT * 3;
          for (var q = 0; q < MT; q++) { var hi = Math.min(q, M.hist.length / 3 - 1) * 3; M.tp[q * 3] = M.hist[hi]; M.tp[q * 3 + 1] = M.hist[hi + 1]; M.tp[q * 3 + 2] = M.hist[hi + 2]; }
          M.trail.geometry.attributes.position.needsUpdate = true;
          if (M.life > 3.2) { M.active = false; M.head.visible = M.glow.visible = M.trail.visible = false; M.next = rnd(2.5, 7); }
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
        astroIn = SHOT ? 1 : Math.min(1, astroIn + dt * 1.4);
        var sc = (key.scale == null ? 1 : key.scale) * (rig ? (rig.rig === 'gltf' ? 1 - Math.pow(1 - astroIn, 3) : 1) : 0) * smooth(1 - introK * 1.6);
        astro.scale.setScalar(Math.max(.0001, sc));
        astro.visible = sc > .01 && Math.abs(key.sx) < 2.4;
        if (backdrop) {
          backdrop.position.copy(astro.position).addScaledVector(tmpF, 9).addScaledVector(tmpU, .6);
          backdrop.scale.set(18 + d * 1.5, 18 + d * 1.5, 1);
          backdrop.material.opacity = astro.visible ? .95 * smooth(1 - Math.abs(key.sx) / 1.4) * Math.min(1, sc * 1.2) : 0;
        }

        eul.set(.22 + (key.tilt || 0) + Math.sin(time * .45) * .06 * drift, (key.yaw || 0) + Math.sin(time * .3) * .14 * drift, (key.roll == null ? -.28 : key.roll) + Math.sin(time * .38) * .09 * drift);
        tmpQ.setFromEuler(eul);
        astro.quaternion.copy(camera.quaternion).multiply(tmpQ);

        var tv = tumbleVel.length();
        if (tv > .001) {
          var axis = tmpV.copy(tumbleVel).normalize();
          tumble.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, tv * dt));
          tumbleVel.multiplyScalar(Math.pow(.12, dt));
        }
        if (tv < .6) tumble.slerp(idQ, 1 - Math.pow(.03, dt));
        astro.quaternion.multiply(tumble);

        waveT = Math.max(0, waveT - dt);
        wave = lerp(wave, Math.max(waveTarget, key.wave || 0, waveT > 0 ? 1 : 0), 1 - Math.exp(-dt * 4));
        tmpV.copy(astro.position).project(camera);
        var lookX = clamp((ndc.x - tmpV.x) * .9, -.7, .7), lookY = clamp((ndc.y - tmpV.y) * .6, -.45, .45);
        if (rig && astro.visible) {
          if (rig.rig === 'gltf') {
            rig.lx = lerp(rig.lx || 0, lookX, 1 - Math.exp(-dt * 5)); rig.ly = lerp(rig.ly || 0, lookY, 1 - Math.exp(-dt * 5));
            poseGltf(time, wave, rig.lx, rig.ly);
          } else {
            poseProc(rig, time, wave);
            rig.head.rotation.y = lerp(rig.head.rotation.y, lookX, 1 - Math.exp(-dt * 5));
            rig.head.rotation.x = lerp(rig.head.rotation.x, -lookY, 1 - Math.exp(-dt * 5));
          }
        }

        ray.setFromCamera(ndc, camera);
        var hit = astro.visible && rig ? ray.intersectObject(hitSphere, false).length > 0 : false;
        if (hit !== hoverAstro) { hoverAstro = hit; document.documentElement.classList.toggle('astro-hover', hit); }
      }

      if (o.onFrame) o.onFrame(api.state, time, dt);

      if (postOn && composer) {
        finalPass.uniforms.uTime.value = time % 100;
        finalPass.uniforms.uShift.value = RM ? 0 : velN * .012;
        if (bloom) bloom.strength = (G.bloom != null ? G.bloom : .55) + velN * .45;
        composer.render(dt);
      } else renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
    api.ready = true;
    document.documentElement.classList.add('space-ready');
    return api;
  };

  window.SpaceBG = SpaceBG;
})();
