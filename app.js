/* ============================================================
   원탭 이미지·썸네일 스튜디오 · app.js
   캔버스 렌더 · 사진 누끼 · Pro API · 프롬프트 브리지
   ============================================================ */
(function () {
  'use strict';

  var C = window.ImageStudioCore;
  var D = window.DesignRef || null;
  var P = window.CopyPsych || null;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 120);
    };
  }

  /* ── 상태 ─────────────────────────────────────────── */
  var DEFAULTS = {
    view: 'make',
    ratio: 'yt',
    theme: 'editorial',
    title: '겨울 가습기, **3만원대**랑 12만원대 차이',
    sub: '직접 뜯어보고 6가지로 정리했습니다',
    badge: '직접 비교',
    handle: '@your.channel',
    align: 'auto',
    showBadge: true, showSub: true, showHandle: true,
    bgMode: 'theme',
    bgColor: '#F3EADD',
    accentColor: '#A8431F',
    texture: 40, grain: 22, vignette: 30,
    format: 'png', quality: 92, scale: 1, safe: false,
    subject: { x: 50, y: 50, scale: 100, shadow: 45, removed: true, algo: 'flood', strength: 45, tolerance: 38, feather: 3 },
    prompt: { style: 'photo', mood: 'warm', lighting: 'natural', extra: '' },
    pro: {
      provider: 'openai',
      configs: {
        openai: { key: '', model: 'gpt-image-1', quality: 'medium' },
        gemini: { key: '', model: 'imagen-3.0-generate-002' },
        claude: { key: '', model: 'claude-sonnet-4-5' },
        custom: {
          url: '', method: 'POST',
          headers: '{"Content-Type": "application/json"}',
          bodyTemplate: '{"prompt": {{promptJson}}, "aspect": "{{aspect}}"}',
          responsePath: 'data.0.b64_json', responseType: 'image'
        }
      }
    },
    bridgeTool: 'chatgpt'
  };
  var STORE_KEY = 'oneTapImageStudio.v1';

  function deepMerge(base, patch) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!patch || typeof patch !== 'object') return out;
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], v);
      } else if (v !== undefined) out[k] = v;
    });
    return out;
  }

  var state = C.clone(DEFAULTS);

  var photo = { canvas: null, cut: null, stats: null, edge: null, srcName: '', processing: false };
  var bgImage = null;           // Image | Canvas
  var bgImageInfo = { source: '', prompt: '' };
  var generated = [];           // { src, prompt, provider, at }
  var abortCtl = null;
  var lastBuiltPrompt = null;
  var previewOriginal = false;

  /* ── 부팅: 디자인 엔진 팔레트 반영 ───────────────── */
  function useEnginePalettes() {
    if (!D || typeof D.tokens !== 'function') return;
    C.THEMES.forEach(function (t) {
      try {
        var tk = D.tokens(t.ref);
        if (tk && tk.color) {
          ['bg', 'surface', 'ink', 'sub', 'line', 'accent'].forEach(function (k) {
            if (tk.color[k]) t.palette[k] = String(tk.color[k]).toUpperCase();
          });
          if (tk.color.accentSoft) t.palette.accentSoft = String(tk.color.accentSoft).toUpperCase();
        }
      } catch (e) { /* 기본 팔레트 유지 */ }
    });
  }
  useEnginePalettes();

  function themePalette(theme) { return theme.palette; }
  function paletteFor(theme) {
    var pal = themePalette(theme);
    return {
      bg: state.bgMode === 'color' && state.bgColor ? state.bgColor : pal.bg,
      surface: pal.surface, ink: pal.ink, sub: pal.sub, line: pal.line,
      accent: state.accentColor || pal.accent, accentSoft: pal.accentSoft
    };
  }

  /* ── DOM refs ─────────────────────────────────────── */
  var el = {};

  function cacheEls() {
    el.canvas = $('#canvas');
    el.ctx = el.canvas.getContext('2d');
    el.ratioGrid = $('#ratioGrid');
    el.themeGrid = $('#themeGrid');
    el.providerGrid = $('#providerGrid');
    el.configFields = $('#configFields');
    el.title = $('#titleInput');
    el.sub = $('#subInput');
    el.badge = $('#badgeInput');
    el.handle = $('#handleInput');
    el.titleCount = $('#titleCount');
    el.scoreChip = $('#headlineScore');
    el.scoreTip = $('#scoreTip');
    el.stageDims = $('#stageDims');
    el.stageRatioName = $('#stageRatioName');
    el.ratioHint = $('#ratioHint');
    el.ratioChip = $('#ratioChip');
    el.bgColor = $('#bgColor');
    el.accentColor = $('#accentColor');
    el.bgColorVal = $('#bgColorVal');
    el.accentColorVal = $('#accentColorVal');
    el.dropzone = $('#dropzone');
    el.photoInput = $('#photoInput');
    el.photoState = $('#photoState');
    el.cutBox = $('#cutBox');
    el.subjectBox = $('#subjectBox');
    el.cutToggle = $('#cutToggle');
    el.cutStats = $('#cutStats');
    el.promptPreview = $('#promptPreview');
    el.promptAspect = $('#promptAspect');
    el.styleChips = $('#styleChips');
    el.topic = $('#topicInput');
    el.themeName = $('#themeName');
    el.saveState = $('#saveState');
    el.toast = $('#toast');
  }

  /* ── 저장 ─────────────────────────────────────────── */
  var saveNow = function () {
    try {
      var snap = C.clone(state);
      delete snap.bgImage;
      sessionStorage.setItem(STORE_KEY, JSON.stringify(snap));
      if (el.saveState) { el.saveState.textContent = '자동 저장됨'; el.saveState.classList.remove('is-dirty'); }
    } catch (e) {
      if (el.saveState) el.saveState.textContent = '저장 공간 부족';
    }
  };
  var save = debounce(saveNow, 350);
  function markDirty() {
    if (el.saveState) { el.saveState.textContent = '저장 중…'; el.saveState.classList.add('is-dirty'); }
    save();
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      state = deepMerge(DEFAULTS, parsed);
      state.view = 'make';
    } catch (e) { /* 무시 */ }
  }

  /* ── 토스트 ───────────────────────────────────────── */
  var toastTimer = 0;
  function toast(msg, ms) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.hidden = false;
    requestAnimationFrame(function () { el.toast.classList.add('is-show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('is-show');
      setTimeout(function () { el.toast.hidden = true; }, 220);
    }, ms || 2600);
  }

  /* ══════════════════════════════════════════════════
     UI 구성
     ══════════════════════════════════════════════════ */
  function buildRatioGrid() {
    el.ratioGrid.innerHTML = C.RATIOS.map(function (r) {
      var ratio = r.w / r.h;
      var h = 20, w = Math.round(h * ratio);
      if (w > 24) { w = 24; h = Math.round(24 / ratio); }
      return '<button type="button" class="ratio-card' + (state.ratio === r.id ? ' is-active' : '') + '"' +
        ' role="radio" aria-checked="' + (state.ratio === r.id) + '" data-ratio="' + r.id + '">' +
        '<span class="ratio-ico"><i style="width:' + w + 'px;height:' + h + 'px"></i></span>' +
        '<span class="ratio-meta"><b>' + escapeHtml(r.short) + '</b><small>' + r.ratio + ' · ' + r.w + '×' + r.h + '</small></span>' +
        '</button>';
    }).join('');
  }

  function buildThemeGrid() {
    el.themeGrid.innerHTML = C.THEMES.map(function (t) {
      var p = t.palette;
      return '<button type="button" class="theme-card' + (state.theme === t.id ? ' is-active' : '') + '"' +
        ' role="radio" aria-checked="' + (state.theme === t.id) + '" data-theme="' + t.id + '"' +
        ' style="color:' + p.accent + '">' +
        '<span class="theme-swatch" style="background:linear-gradient(135deg,' + p.bg + ' 0%,' + p.surface + ' 100%)">' +
        '<span style="position:absolute;left:8%;top:16%;width:22%;height:52%;background:' + p.accent + ';opacity:.85;border-radius:2px"></span>' +
        '</span>' +
        '<b>' + escapeHtml(t.short) + '</b><small>' + escapeHtml(t.tag) + '</small></button>';
    }).join('');
  }

  function styleMark(id) {
    var marks = {
      openai: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3.6v16.8M3.6 12h16.8" stroke="currentColor" stroke-width="1.2" opacity=".55"/></svg>',
      gemini: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 2.6l2.4 6.6 6.6 2.4-6.6 2.4L12 20.6 9.6 14 3 11.6l6.6-2.4z" fill="currentColor"/></svg>',
      claude: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M5 18.5L11 4h2.4l6 14.5h-2.6l-1.6-4H9.1l-1.5 4z" fill="currentColor"/><path d="M9.9 12.4h4.4L12.1 7z" fill="var(--surface)"/></svg>',
      custom: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><rect x="3.4" y="4.4" width="17.2" height="6" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="3.4" y="13.6" width="17.2" height="6" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="7" cy="7.4" r="1" fill="currentColor"/><circle cx="7" cy="16.6" r="1" fill="currentColor"/></svg>'
    };
    return marks[id] || '';
  }

  function buildProviderGrid() {
    el.providerGrid.innerHTML = C.PROVIDERS.map(function (p) {
      var active = state.pro.provider === p.id;
      var isWarn = p.kinds.indexOf('image') < 0;
      return '<button type="button" class="provider-card' + (active ? ' is-active' : '') + '"' +
        ' role="radio" aria-checked="' + active + '" data-provider="' + p.id + '">' +
        '<span class="provider-rank">' + p.rank + '</span>' +
        '<span class="provider-mark" aria-hidden="true">' + styleMark(p.id) + '</span>' +
        '<b>' + escapeHtml(p.name) + '</b>' +
        '<small>' + escapeHtml(p.product) + '</small>' +
        '<span class="provider-badge' + (isWarn ? ' is-warn' : '') + '">' + escapeHtml(p.badge) + '</span>' +
        '</button>';
    }).join('');
  }

  function buildSelects() {
    var mood = $('#moodSelect'), light = $('#lightSelect');
    mood.innerHTML = C.MOODS.map(function (m) { return '<option value="' + m.id + '">' + m.name + '</option>'; }).join('');
    light.innerHTML = C.LIGHTS.map(function (l) { return '<option value="' + l.id + '">' + l.name + '</option>'; }).join('');
    mood.value = state.prompt.mood;
    light.value = state.prompt.lighting;

    el.styleChips.innerHTML = C.STYLES.map(function (s) {
      return '<button type="button" class="style-chip' + (state.prompt.style === s.id ? ' is-active' : '') + '"' +
        ' data-style="' + s.id + '" aria-pressed="' + (state.prompt.style === s.id) + '">' + escapeHtml(s.name) + '</button>';
    }).join('');
  }

  /* ══════════════════════════════════════════════════
     캔버스 렌더
     ══════════════════════════════════════════════════ */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawCover(ctx, img, x, y, w, h) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var s = Math.max(w / iw, h / ih);
    var dw = iw * s, dh = ih * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function drawContain(ctx, img, x, y, w, h) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return { x: x, y: y, w: 0, h: 0 };
    var s = Math.min(w / iw, h / ih);
    var dw = iw * s, dh = ih * s;
    var dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
    return { x: dx, y: dy, w: dw, h: dh };
  }

  function paintBackdrop(ctx, W, H, theme, pal, st) {
    var g = ctx.createLinearGradient(0, 0, W * 0.9, H);
    g.addColorStop(0, pal.bg);
    g.addColorStop(1, C.mixHex(pal.bg, pal.surface, theme.dark ? 0.32 : 0.55));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    if (st.bgMode === 'color' && st.bgColor) {
      ctx.fillStyle = st.bgColor;
      ctx.fillRect(0, 0, W, H);
      var lg = ctx.createLinearGradient(0, 0, 0, H);
      lg.addColorStop(0, 'rgba(255,255,255,.08)');
      lg.addColorStop(1, 'rgba(0,0,0,.10)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, W, H);
      return;
    }

    var t = st.texture / 100;
    var rand = mulberry32(7);

    if (theme.texture === 'paper') {
      var rg = ctx.createRadialGradient(W * 0.18, H * 0.06, 0, W * 0.18, H * 0.06, Math.max(W, H) * 0.85);
      rg.addColorStop(0, 'rgba(255,255,255,.65)');
      rg.addColorStop(0.55, 'rgba(255,255,255,0)');
      rg.addColorStop(1, 'rgba(120,80,40,.10)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
      // 오른쪽 사진 패널
      ctx.fillStyle = 'rgba(255,252,246,.55)';
      ctx.fillRect(W * 0.53, H * 0.07, W * 0.4, H * 0.86);
      ctx.strokeStyle = C.mixHex(pal.line, pal.ink, 0.12);
      ctx.lineWidth = Math.max(1, W * 0.0014);
      ctx.strokeRect(W * 0.53, H * 0.07, W * 0.4, H * 0.86);
      // 종이 섬유
      ctx.save();
      ctx.globalAlpha = 0.1 + t * 0.22;
      for (var i = 0; i < 460; i++) {
        var x = rand() * W, y = rand() * H, len = (2 + rand() * 16) * (W / 1280);
        ctx.strokeStyle = rand() > 0.5 ? '#8a6f52' : '#ffffff';
        ctx.lineWidth = Math.max(0.5, rand() * 1.2);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y + (rand() - 0.5) * 2); ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = pal.accent;
      ctx.fillRect(0, 0, W * 0.012, H);
    } else if (theme.texture === 'grid') {
      var step = W / 14;
      ctx.save();
      ctx.strokeStyle = 'rgba(20,20,20,' + (0.05 + t * 0.08) + ')';
      ctx.lineWidth = Math.max(0.6, W * 0.0008);
      for (var gx = step; gx < W; gx += step) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
      for (var gy = step; gy < H; gy += step) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
      ctx.restore();
      ctx.fillStyle = pal.accent;
      ctx.fillRect(W * 0.8, 0, W * 0.2, H * 0.055);
      ctx.fillStyle = C.mixHex(pal.bg, pal.ink, 0.06);
      ctx.fillRect(W * 0.5, H * 0.36, W * 0.5, H * 0.64);
    } else if (theme.texture === 'glow') {
      var g1 = ctx.createRadialGradient(W * 0.78, H * 0.28, 0, W * 0.78, H * 0.28, W * 0.6);
      g1.addColorStop(0, 'rgba(57,230,255,' + (0.16 + t * 0.22) + ')');
      g1.addColorStop(0.55, 'rgba(57,230,255,0.03)');
      g1.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);
      var g2 = ctx.createRadialGradient(W * 0.12, H * 0.92, 0, W * 0.12, H * 0.92, W * 0.55);
      g2.addColorStop(0, 'rgba(123,92,255,' + (0.22 + t * 0.2) + ')');
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = 0.05 + t * 0.05;
      ctx.fillStyle = '#000';
      for (var sy = 0; sy < H; sy += 4) ctx.fillRect(0, sy, W, 1);
      ctx.restore();
      var scrim = ctx.createLinearGradient(0, H * 0.28, 0, H);
      scrim.addColorStop(0, 'rgba(5,7,12,0)');
      scrim.addColorStop(1, 'rgba(5,7,12,.88)');
      ctx.fillStyle = scrim; ctx.fillRect(0, 0, W, H);
    } else if (theme.texture === 'none') {
      ctx.save();
      ctx.strokeStyle = C.mixHex(pal.line, pal.ink, 0.2);
      ctx.lineWidth = Math.max(0.8, W * 0.001);
      ctx.beginPath(); ctx.arc(W * 0.78, H * 0.36, Math.min(W, H) * 0.27, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.beginPath(); ctx.arc(W * 0.78, H * 0.36, Math.min(W, H) * 0.25, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pal.surface;
      ctx.fillRect(0, H * 0.9, W, H * 0.1);
    } else if (theme.texture === 'soft') {
      var rs = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.62);
      rs.addColorStop(0, 'rgba(255,255,255,.95)');
      rs.addColorStop(0.6, 'rgba(255,255,255,.35)');
      rs.addColorStop(1, 'rgba(230,235,242,.2)');
      ctx.fillStyle = rs; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.fillRect(0, H * 0.72, W, H * 0.28);
      ctx.strokeStyle = 'rgba(16,20,24,.06)';
      ctx.lineWidth = Math.max(1, W * 0.0012);
      ctx.beginPath(); ctx.moveTo(0, H * 0.72); ctx.lineTo(W, H * 0.72); ctx.stroke();
    } else if (theme.texture === 'blocks') {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = C.mixHex(pal.bg, '#ffffff', 0.4);
      ctx.beginPath(); ctx.arc(W * 0.16, H * 0.24, W * 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = pal.accent;
      roundRect(ctx, W * 0.58, H * 0.58, W * 0.5, H * 0.5, W * 0.05);
      ctx.fill();
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#000';
      for (var dx = 0; dx < W * 0.24; dx += W * 0.016) {
        for (var dy = 0; dy < H * 0.18; dy += W * 0.016) {
          ctx.beginPath(); ctx.arc(W * 0.06 + dx, H * 0.08 + dy, W * 0.0035, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  function paintImageBackground(ctx, W, H, theme, pal, st) {
    if (!st.bgImage) return false;
    drawCover(ctx, st.bgImage, 0, 0, W, H);
    var light = (theme.id === 'minimal' || theme.id === 'retail');
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    if (light) {
      grad.addColorStop(0, 'rgba(255,255,255,.30)');
      grad.addColorStop(0.45, 'rgba(255,255,255,.42)');
      grad.addColorStop(1, 'rgba(255,255,255,.80)');
    } else {
      grad.addColorStop(0, 'rgba(4,6,12,.12)');
      grad.addColorStop(0.42, 'rgba(4,6,12,.34)');
      grad.addColorStop(1, 'rgba(4,6,12,.80)');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return true;
  }

  function paintDecor(ctx, W, H, theme, pal, st) {
    var accent = pal.accent;
    ctx.save();
    if (theme.id === 'editorial') {
      ctx.strokeStyle = C.mixHex(pal.line, pal.ink, 0.25);
      ctx.lineWidth = Math.max(0.8, W * 0.0012);
      ctx.beginPath(); ctx.moveTo(W * 0.07, H * 0.5); ctx.lineTo(W * 0.5, H * 0.5); ctx.stroke();
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(W * 0.07, H * 0.5, W * 0.006, 0, Math.PI * 2); ctx.fill();
    } else if (theme.id === 'magazine') {
      ctx.fillStyle = pal.accent;
      ctx.fillRect(W * 0.07, H * 0.05, W * 0.11, H * 0.008);
      ctx.font = C.fontString(Math.round(W * 0.0115), 600, '"PlexKR", sans-serif');
      ctx.fillStyle = C.mixHex(pal.ink, pal.bg, 0.45);
      ctx.textBaseline = 'top';
      if ('letterSpacing' in ctx) { try { ctx.letterSpacing = (W * 0.0012).toFixed(2) + 'px'; } catch (e) { } }
      ctx.fillText('THUMBNAIL / ' + C.ratioById(st.ratio).ratio, W * 0.07, H * 0.072);
      if ('letterSpacing' in ctx) { try { ctx.letterSpacing = '0px'; } catch (e) { } }
      ctx.strokeStyle = C.mixHex(pal.line, pal.ink, 0.28);
      ctx.lineWidth = Math.max(0.8, W * 0.001);
      ctx.beginPath(); ctx.moveTo(W * 0.07, H * 0.93); ctx.lineTo(W * 0.93, H * 0.93); ctx.stroke();
    } else if (theme.id === 'neon') {
      ctx.strokeStyle = 'rgba(57,230,255,.55)';
      ctx.lineWidth = Math.max(1.2, W * 0.0018);
      ctx.shadowColor = 'rgba(57,230,255,.8)';
      ctx.shadowBlur = W * 0.012;
      ctx.beginPath(); ctx.moveTo(W * 0.07, H * 0.44); ctx.lineTo(W * 0.62, H * 0.44); ctx.stroke();
      ctx.shadowBlur = 0;
      // 코너 브래킷
      var b = W * 0.03;
      ctx.strokeStyle = 'rgba(245,247,255,.35)';
      ctx.lineWidth = Math.max(1, W * 0.0015);
      [[W * 0.05, H * 0.05, 1, 1], [W * 0.95, H * 0.05, -1, 1], [W * 0.05, H * 0.95, 1, -1], [W * 0.95, H * 0.95, -1, -1]].forEach(function (k) {
        ctx.beginPath();
        ctx.moveTo(k[0] + b * k[2], k[1]);
        ctx.lineTo(k[0], k[1]);
        ctx.lineTo(k[0], k[1] + b * k[3]);
        ctx.stroke();
      });
    } else if (theme.id === 'minimal') {
      ctx.strokeStyle = C.mixHex(pal.line, pal.ink, 0.18);
      ctx.lineWidth = Math.max(0.7, W * 0.0009);
      ctx.strokeRect(W * 0.045, H * 0.045, W * 0.91, H * 0.91);
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(W * 0.5, H * 0.585, W * 0.004, 0, Math.PI * 2); ctx.fill();
    } else if (theme.id === 'retail') {
      ctx.fillStyle = 'rgba(224,50,43,.06)';
      ctx.beginPath(); ctx.arc(W * 0.5, H * 0.55, W * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pal.accent;
      ctx.fillRect(W * 0.5 - W * 0.06, H * 0.255, W * 0.12, H * 0.007);
    } else if (theme.id === 'vivid') {
      ctx.save();
      ctx.translate(W * 0.86, H * 0.17);
      ctx.rotate(-0.14);
      ctx.fillStyle = pal.ink;
      roundRect(ctx, -W * 0.075, -H * 0.045, W * 0.15, H * 0.09, W * 0.012);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = C.fontString(Math.round(W * 0.021), 800, '"PlexKR", sans-serif');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('NEW', 0, H * 0.002);
      ctx.restore();
    }
    ctx.restore();
  }

  function subjectZone(theme, ratio) {
    var z = theme.layout.subject;
    var W = ratio.w, H = ratio.h;
    var wide = W / H > 1.45;
    var scale = state.subject.scale / 100;
    var bw = z.w * W * scale, bh = z.h * H * scale;
    if (wide) { bw *= 0.92; bh *= 0.92; }
    var cx = z.x * W + z.w * W / 2 + (state.subject.x - 50) / 100 * W * 0.18;
    var cy = z.y * H + z.h * H / 2 + (state.subject.y - 50) / 100 * H * 0.18;
    var x = cx - bw / 2, y = cy - bh / 2;
    // 캔버스 밖으로 나가지 않게 (피사체가 잘리면 완성도가 떨어진다)
    bw = Math.min(bw, W * 0.94);
    bh = Math.min(bh, H * 0.9);
    x = Math.max(W * 0.03, Math.min(x, W * 0.97 - bw));
    y = Math.max(H * 0.03, Math.min(y, H * 0.95 - bh));
    return { x: x, y: y, w: bw, h: bh };
  }

  function currentSubjectImage() {
    if (!photo.canvas) return null;
    if (state.subject.removed && photo.cut) return photo.cut;
    return photo.canvas;
  }

  function paintSubject(ctx, W, H, theme, pal) {
    var img = currentSubjectImage();
    if (!img) return null;
    var zone = subjectZone(theme, { w: W, h: H });
    var shadow = state.subject.shadow / 100;

    // 바닥 그림자
    if (shadow > 0.02) {
      var sx = zone.x + zone.w / 2;
      var sy = zone.y + zone.h * 0.93;
      var rw = zone.w * 0.44, rh = Math.max(8, H * 0.022);
      var rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, rw);
      rg.addColorStop(0, 'rgba(10,12,16,' + (0.42 * shadow) + ')');
      rg.addColorStop(0.55, 'rgba(10,12,16,' + (0.2 * shadow) + ')');
      rg.addColorStop(1, 'rgba(10,12,16,0)');
      ctx.save();
      ctx.translate(sx, sy); ctx.scale(1, rh / rw);
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(0, 0, rw, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    ctx.save();
    if (shadow > 0.02) {
      ctx.shadowColor = 'rgba(8,10,14,' + (0.32 * shadow) + ')';
      ctx.shadowBlur = zone.w * 0.045;
      ctx.shadowOffsetY = zone.h * 0.012;
    }
    var drawn = drawContain(ctx, img, zone.x, zone.y, zone.w, zone.h);
    ctx.restore();
    return drawn;
  }

  function wrapCtx(ctx, text, maxW) {
    var tokens = C.parseRich(text);
    return C.wrapRich(ctx, tokens, maxW);
  }

  function lineWidth(line) {
    var w = 0;
    for (var i = 0; i < line.length; i++) w += line[i].w;
    return w;
  }

  function drawRichLine(ctx, line, x, y, align, maxW, baseColor, emColor) {
    var w = lineWidth(line);
    var cx = x;
    if (align === 'center') cx = x + (maxW - w) / 2;
    if (align === 'right') cx = x + maxW - w;
    for (var i = 0; i < line.length; i++) {
      var seg = line[i];
      ctx.fillStyle = seg.em ? emColor : baseColor;
      ctx.fillText(seg.t, cx, y);
      cx += seg.w;
    }
  }

  function drawBadge(ctx, theme, x, y, maxW, text, accent, inkOnAccent, W, H, align) {
    var size = Math.max(12, Math.round(W * 0.0165));
    var font = size + 'px "PlexKR", sans-serif';
    var t = String(text || '').toUpperCase();
    ctx.save();
    ctx.textBaseline = 'middle';
    var padX = size * 0.85, hgt = size * 1.95;
    var tw = 0;
    if (theme.layout.badge === 'line') {
      ctx.font = '600 ' + size + 'px "PlexKR", sans-serif';
      tw = ctx.measureText(t).width;
      var lx = align === 'center' ? x + (maxW - tw) / 2 : x;
      ctx.fillStyle = accent;
      ctx.fillRect(lx, y + hgt * 0.48, tw, Math.max(1, size * 0.08));
      ctx.fillStyle = inkOnAccent === '#FFFFFF' ? accent : accent;
      ctx.fillText(t, lx, y + hgt * 0.18);
      ctx.restore();
      return hgt;
    }
    ctx.font = '700 ' + size + 'px "PlexKR", sans-serif';
    tw = ctx.measureText(t).width;
    var bw = Math.min(maxW, tw + padX * 2);
    var bx = align === 'center' ? x + (maxW - bw) / 2 : x;
    if (theme.layout.badge === 'pill') {
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      roundRect(ctx, bx, y, bw, hgt, hgt / 2); ctx.fill();
      ctx.strokeStyle = accent; ctx.lineWidth = Math.max(1.2, size * 0.09); ctx.stroke();
      ctx.fillStyle = accent;
    } else if (theme.layout.badge === 'bar') {
      ctx.fillStyle = accent;
      ctx.fillRect(bx, y, Math.max(3, size * 0.22), hgt);
      ctx.fillStyle = accent;
      ctx.fillText(t, bx + size * 0.7, y + hgt / 2);
      ctx.restore();
      return hgt;
    } else if (theme.layout.badge === 'sticker') {
      ctx.save();
      ctx.translate(bx + bw / 2, y + hgt / 2);
      ctx.rotate(-0.035);
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, -bw / 2 - 3, -hgt / 2 - 3, bw + 6, hgt + 6, hgt / 2); ctx.fill();
      ctx.fillStyle = accent;
      roundRect(ctx, -bw / 2, -hgt / 2, bw, hgt, hgt / 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(t, 0, size * 0.04);
      ctx.restore();
      ctx.restore();
      return hgt;
    } else { // tab
      ctx.fillStyle = accent;
      roundRect(ctx, bx, y, bw, hgt, Math.min(6, hgt * 0.2)); ctx.fill();
      ctx.fillStyle = '#fff';
    }
    ctx.textAlign = 'left';
    ctx.fillText(t, bx + padX, y + hgt / 2 + size * 0.02);
    ctx.restore();
    return hgt;
  }

  function paintCopy(ctx, W, H, theme, pal, onImage) {
    var z = theme.layout.text;
    var zone = { x: z.x * W, y: z.y * H, w: z.w * W, h: z.h * H };
    var align = state.align === 'auto' ? theme.layout.align : state.align;
    var ink = onImage ? (theme.id === 'minimal' || theme.id === 'retail' ? '#15130F' : '#FFFFFF') : pal.ink;
    var subInk = onImage ? (theme.id === 'minimal' || theme.id === 'retail' ? 'rgba(20,18,14,.72)' : 'rgba(255,255,255,.78)') : pal.sub;
    var accent = pal.accent;
    if (onImage && theme.id !== 'minimal' && theme.id !== 'retail') {
      accent = C.mixHex(accent, '#FFFFFF', 0.35);
    }
    var accentInk = C.readableInk(accent).hex;
    var gap = H * 0.02;
    var y = zone.y;
    var badgeH = 0;

    var platform = C.ratioById(state.ratio).platform;
    var kicker = (platform.split(' ')[0] || 'STUDIO').toUpperCase();
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    if (state.showBadge && state.badge.trim()) {
      badgeH = drawBadge(ctx, theme, zone.x, y, zone.w, state.badge, accent, accentInk, W, H, align);
      y += badgeH + gap * 1.25;
    } else {
      ctx.font = '700 ' + Math.round(W * 0.0125) + 'px "PlexKR", sans-serif';
      ctx.fillStyle = onImage ? 'rgba(255,255,255,.7)' : C.mixHex(pal.sub, pal.bg, 0.15);
      if (theme.id !== 'vivid') {
        var kw = ctx.measureText(kicker).width;
        var kx = align === 'center' ? zone.x + (zone.w - kw) / 2 : zone.x;
        ctx.fillText(kicker, kx, y + H * 0.004);
        ctx.fillRect(kx, y + H * 0.024, kw, Math.max(1, W * 0.0012));
        y += H * 0.038;
      }
    }

    var subSize = Math.max(11, Math.round(W * 0.0145));
    var handleSize = Math.max(10, Math.round(W * 0.0118));
    var subLinesCount = 0, subH = 0;
    if (state.showSub && state.sub.trim()) {
      ctx.font = '400 ' + subSize + 'px "PlexKR", sans-serif';
      var sl = wrapCtx(ctx, state.sub, zone.w);
      subLinesCount = Math.min(2, sl.length);
      subH = subLinesCount * subSize * 1.42;
    }
    var handleH = state.showHandle && state.handle.trim() ? handleSize * 2.2 : 0;
    var availH = Math.max(H * 0.06, zone.h - (y - zone.y) - Math.min(subH, H * 0.14) - handleH - gap);

    var fit = C.fitTitle(ctx, state.title || '제목을 입력하세요', {
      maxW: zone.w, maxH: availH,
      maxSize: Math.min(zone.w * 0.2, zone.h * 0.46, H * 0.185),
      minSize: Math.max(14, W * 0.022),
      weight: theme.titleWeight,
      lineHeight: theme.lineHeight,
      tracking: theme.titleTracking,
      family: '"PlexKR", sans-serif',
      maxLines: C.ratioById(state.ratio).purpose === 'video' ? 3 : 4
    });

    // 제목
    ctx.font = C.fontString(fit.size, theme.titleWeight, '"PlexKR", sans-serif');
    if ('letterSpacing' in ctx) {
      try { ctx.letterSpacing = (theme.titleTracking * fit.size).toFixed(2) + 'px'; } catch (e) { /* noop */ }
    }
    ctx.fillStyle = ink;
    var lineY = y;
    fit.lines.forEach(function (line) {
      drawRichLine(ctx, line, zone.x, lineY, align, zone.w, ink, accent);
      lineY += fit.lineHeight * 0.98;
    });
    if ('letterSpacing' in ctx) { try { ctx.letterSpacing = '0px'; } catch (e) { /* noop */ } }
    y = lineY + gap * 0.85;

    // 포인트 룰
    if (theme.id === 'editorial' || theme.id === 'vivid' || theme.id === 'magazine') {
      var ruleW = Math.min(zone.w, align === 'center' ? W * 0.14 : W * 0.1);
      var rx = align === 'center' ? zone.x + (zone.w - ruleW) / 2 : zone.x;
      ctx.fillStyle = accent;
      ctx.fillRect(rx, y + H * 0.004, ruleW, Math.max(2, H * 0.005));
      y += H * 0.024;
    }

    // 부제 — 남은 공간에 들어갈 줄만 그린다(제목/핸들과 겹치지 않게)
    if (state.showSub && state.sub.trim()) {
      var room = zone.y + zone.h - handleH - gap * 0.4 - y;
      var maxSubLines = Math.max(0, Math.min(2, Math.floor(room / (subSize * 1.42))));
      if (maxSubLines > 0) {
        ctx.font = '400 ' + subSize + 'px "PlexKR", sans-serif';
        ctx.fillStyle = subInk;
        var lines = wrapCtx(ctx, state.sub, zone.w).slice(0, maxSubLines);
        lines.forEach(function (line, i) {
          drawRichLine(ctx, line, zone.x, y + i * subSize * 1.42, align, zone.w, subInk, accent);
        });
        y += lines.length * subSize * 1.42;
      }
    }

    // 핸들 — 부제와 겹치면 생략
    if (state.showHandle && state.handle.trim() && (zone.y + zone.h - handleSize * 0.9) - y > handleSize * 1.1) {
      ctx.font = '600 ' + handleSize + 'px "PlexKR", sans-serif';
      ctx.fillStyle = onImage ? 'rgba(255,255,255,.62)' : C.mixHex(pal.sub, pal.bg, 0.05);
      var hw = ctx.measureText(state.handle).width;
      var hx = align === 'center' ? zone.x + (zone.w - hw) / 2 : zone.x;
      var hy = zone.y + zone.h - handleSize * 0.9;
      ctx.fillText(state.handle, hx, hy);
      if (theme.id === 'minimal' || theme.id === 'editorial') {
        ctx.fillStyle = onImage ? 'rgba(255,255,255,.3)' : C.mixHex(pal.line, pal.ink, 0.1);
        ctx.fillRect(hx, hy - handleSize * 0.7, Math.min(zone.w, hw + handleSize * 1.2), Math.max(1, W * 0.0008));
      }
    }
    ctx.restore();
  }

  var grainCanvas = null;
  function getGrain(W, H) {
    if (grainCanvas) return grainCanvas;
    var size = 220;
    grainCanvas = document.createElement('canvas');
    grainCanvas.width = size; grainCanvas.height = size;
    var g = grainCanvas.getContext('2d');
    var img = g.createImageData(size, size);
    for (var i = 0; i < img.data.length; i += 4) {
      var v = 128 + (Math.random() - 0.5) * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    void W; void H;
    return grainCanvas;
  }

  function paintGrain(ctx, W, H, st) {
    if (st.grain <= 0) return;
    var pat = ctx.createPattern(getGrain(), 'repeat');
    if (!pat) return;
    ctx.save();
    ctx.globalAlpha = st.grain / 100 * 0.3;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function paintVignette(ctx, W, H, st) {
    if (st.vignette <= 0) return;
    var g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.74);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,' + (st.vignette / 100 * 0.46) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function paintSafe(ctx, W, H) {
    var inset = Math.min(W, H) * 0.06;
    ctx.save();
    ctx.setLineDash([Math.max(4, W * 0.008), Math.max(4, W * 0.008)]);
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = Math.max(1.2, W * 0.0018);
    ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    roundRect(ctx, inset, inset - H * 0.045, W * 0.135, H * 0.042, H * 0.012);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.font = '600 ' + Math.round(W * 0.0115) + 'px "PlexKR", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('안전영역', inset + W * 0.011, inset - H * 0.0245);
    ctx.restore();
  }

  function compose(ctx, W, H, st) {
    var theme = C.themeById(st.theme);
    var pal = paletteFor(theme);
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    var onImage = false;
    if (st.bgMode === 'image' && st.bgImage) {
      onImage = paintImageBackground(ctx, W, H, theme, pal, st);
    } else {
      paintBackdrop(ctx, W, H, theme, pal, st);
    }
    paintDecor(ctx, W, H, theme, pal, st);
    paintSubject(ctx, W, H, theme, pal);
    paintCopy(ctx, W, H, theme, pal, onImage);
    paintGrain(ctx, W, H, st);
    paintVignette(ctx, W, H, st);
    if (st.safe) paintSafe(ctx, W, H);
  }

  var renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      var ratio = C.ratioById(state.ratio);
      var cv = el.canvas;
      if (cv.width !== ratio.w || cv.height !== ratio.h) {
        cv.width = ratio.w; cv.height = ratio.h;
      }
      state.bgImage = bgImage;
      compose(el.ctx, ratio.w, ratio.h, state);
      var empty = $('#canvasEmpty');
      if (empty) empty.hidden = true;
    });
  }

  /* ══════════════════════════════════════════════════
     사진 · 누끼
     ══════════════════════════════════════════════════ */
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function fitPhotoCanvas(img) {
    var maxSide = 1500;
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var s = Math.min(1, maxSide / Math.max(iw, ih));
    var c = makeCanvas(Math.round(iw * s), Math.round(ih * s));
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function loadPhotoFromFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast('이미지 파일만 넣을 수 있습니다.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        setPhotoSource(fitPhotoCanvas(img), file.name || '사진');
      };
      img.onerror = function () { toast('이미지를 읽지 못했습니다.'); };
      img.src = String(reader.result);
    };
    reader.onerror = function () { toast('파일을 읽지 못했습니다.'); };
    reader.readAsDataURL(file);
  }

  function setPhotoSource(canvas, name) {
    photo.canvas = canvas;
    photo.cut = null;
    photo.stats = null;
    photo.srcName = name || '';
    photo.origDirty = true;
    processCut(true);
    refreshPhotoUI();
  }

  function refreshPhotoUI() {
    var has = !!photo.canvas;
    el.cutBox.hidden = !has;
    el.subjectBox.hidden = !has;
    el.photoState.textContent = has ? (photo.srcName ? photo.srcName.slice(0, 14) : '있음') : '없음';
    $('#photoClear').disabled = !has;
    el.photoState.title = photo.srcName || '';
    if (has) {
      var s = photo.stats;
      if (s) {
        var pct = Math.round(s.transparentRatio * 100);
        var edge = photo.edge && photo.edge.colors && photo.edge.colors[0] ? photo.edge.colors[0].hex : '—';
        el.cutStats.textContent = '배경 ' + pct + '% 제거 · 가장자리 색 ' + edge + (s.softRatio > 0.02 ? ' · 경계 ' + Math.round(s.softRatio * 100) + '%' : '');
      } else {
        el.cutStats.textContent = '테두리 색을 읽어 배경을 지웁니다. 남는 부분은 허용 오차를 올리세요.';
      }
    }
  }

  function alphaBounds(alpha, w, h, threshold) {
    var t = threshold == null ? 0.06 : threshold;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        if (alpha[row + x] > t) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    var padX = Math.round((maxX - minX + 1) * 0.03) + 2;
    var padY = Math.round((maxY - minY + 1) * 0.03) + 2;
    minX = Math.max(0, minX - padX); minY = Math.max(0, minY - padY);
    maxX = Math.min(w - 1, maxX + padX); maxY = Math.min(h - 1, maxY + padY);
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  var processCut = debounce(function (immediate) {
    if (!photo.canvas) return;
    var w = photo.canvas.width, h = photo.canvas.height;
    var src = photo.canvas.getContext('2d').getImageData(0, 0, w, h);
    var opts = {
      algorithm: state.subject.algo,
      strength: state.subject.strength,
      tolerance: state.subject.tolerance,
      feather: state.subject.feather
    };
    var res;
    try {
      res = C.removeBackground(src.data, w, h, opts);
    } catch (e) {
      toast('누끼 처리 중 문제가 생겼습니다.');
      return;
    }
    var full = makeCanvas(w, h);
    full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res.data), w, h), 0, 0);
    // 투명 여백을 잘라 피사체가 프레임을 채우게 한다.
    var box = alphaBounds(res.alpha, w, h, 0.06);
    var cut;
    if (box && box.w * box.h < w * h * 0.995) {
      cut = makeCanvas(box.w, box.h);
      cut.getContext('2d').drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    } else {
      cut = full;
    }
    photo.cut = cut;
    photo.cutBox = box;
    photo.stats = res.stats;
    photo.edge = res.edge;
    refreshPhotoUI();
    render();
    void immediate;
  }, 140);

  function sampleProduct() {
    var w = 1200, h = 1200;
    var c = makeCanvas(w, h);
    var g = c.getContext('2d');
    var rand = mulberry32(23);
    // 배경
    var bg = g.createRadialGradient(w * 0.32, h * 0.18, 0, w * 0.5, h * 0.5, w * 0.9);
    bg.addColorStop(0, '#F6F1E9');
    bg.addColorStop(0.62, '#EDE5D9');
    bg.addColorStop(1, '#DFD4C4');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // 이음새 없는 배경(제품컷) — 바닥선·그림자는 캔버스가 그린다.

    // 병 본체
    var bx = w * 0.35, by = h * 0.26, bw = w * 0.3, bh = h * 0.6, br = w * 0.06;
    var body = g.createLinearGradient(bx, by, bx + bw, by + bh);
    body.addColorStop(0, '#C0713F');
    body.addColorStop(0.26, '#E0A06B');
    body.addColorStop(0.6, '#A8582C');
    body.addColorStop(1, '#5C2C18');
    g.fillStyle = body;
    roundRect(g, bx, by, bw, bh, br);
    g.fill();
    // 하이라이트
    g.save();
    g.globalAlpha = 0.5;
    var hl = g.createLinearGradient(bx, by, bx + bw * 0.5, by);
    hl.addColorStop(0, 'rgba(255,255,255,.85)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl;
    roundRect(g, bx + bw * 0.08, by + bh * 0.04, bw * 0.16, bh * 0.86, bw * 0.08);
    g.fill();
    g.restore();
    // 라벨 (짙은 올리브 — 크림 배경과 확실히 분리)
    g.fillStyle = '#2F4038';
    g.fillRect(bx + bw * 0.07, by + bh * 0.34, bw * 0.86, bh * 0.26);
    g.fillStyle = 'rgba(234,223,198,.86)';
    g.fillRect(bx + bw * 0.18, by + bh * 0.4, bw * 0.3, 5);
    g.fillStyle = 'rgba(234,223,198,.72)';
    g.fillRect(bx + bw * 0.18, by + bh * 0.45, bw * 0.46, 5);
    g.fillRect(bx + bw * 0.18, by + bh * 0.5, bw * 0.22, 5);
    g.fillStyle = 'rgba(84,48,28,.24)';
    g.fillStyle = 'rgba(234,223,198,.3)';
    g.fillRect(bx + bw * 0.18, by + bh * 0.545, bw * 0.55, 3);

    // 펌프
    g.fillStyle = '#39443B';
    roundRect(g, bx + bw * 0.31, by - h * 0.075, bw * 0.38, h * 0.08, w * 0.012);
    g.fill();
    g.fillStyle = '#2C352E';
    roundRect(g, bx + bw * 0.28, by - h * 0.088, bw * 0.44, h * 0.024, w * 0.01);
    g.fill();
    g.fillStyle = '#4A564C';
    roundRect(g, bx + bw * 0.6, by - h * 0.058, bw * 0.2, h * 0.016, w * 0.008);
    g.fill();

    // 질감 노이즈
    g.save();
    g.globalAlpha = 0.035;
    var img = g.getImageData(0, 0, w, h);
    for (var i = 0; i < img.data.length; i += 4) {
      var n = (rand() - 0.5) * 46;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    g.restore();

    setPhotoSource(c, '샘플 제품컷');
    toast('샘플 제품컷을 넣었습니다. 배경 지우기를 그대로 확인해 보세요.');
  }

  function makeSampleBackground() {
    var w = 1600, h = 1067;
    var c = makeCanvas(w, h);
    var g = c.getContext('2d');
    var rand = mulberry32(91);
    var sky = g.createLinearGradient(0, 0, w * 0.3, h);
    sky.addColorStop(0, '#FBF3E6');
    sky.addColorStop(0.55, '#F3E3CE');
    sky.addColorStop(1, '#E4CDB2');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);

    // 창문 빛
    g.save();
    g.filter = 'blur(38px)';
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.beginPath();
    g.moveTo(w * 0.05, 0); g.lineTo(w * 0.36, 0); g.lineTo(w * 0.2, h * 0.72); g.lineTo(0, h * 0.6);
    g.closePath(); g.fill();
    g.restore();

    // 테이블
    g.fillStyle = '#C9A47C';
    g.fillRect(0, h * 0.68, w, h * 0.32);
    var tf = g.createLinearGradient(0, h * 0.68, 0, h);
    tf.addColorStop(0, 'rgba(255,240,215,.55)');
    tf.addColorStop(1, 'rgba(110,75,40,.35)');
    g.fillStyle = tf; g.fillRect(0, h * 0.68, w, h * 0.32);
    g.fillStyle = 'rgba(90,60,30,.25)';
    g.fillRect(0, h * 0.685, w, 5);

    // 화분 그림자 + 실루엣
    g.save();
    g.filter = 'blur(16px)';
    g.fillStyle = 'rgba(70,50,30,.30)';
    g.beginPath(); g.ellipse(w * 0.76, h * 0.715, w * 0.1, h * 0.022, 0, 0, Math.PI * 2); g.fill();
    g.restore();
    g.save();
    g.filter = 'blur(6px)';
    g.fillStyle = 'rgba(62,72,52,.75)';
    g.beginPath(); g.ellipse(w * 0.78, h * 0.55, w * 0.045, h * 0.14, 0.08, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(48,58,42,.8)';
    g.beginPath();
    g.moveTo(w * 0.75, h * 0.68); g.quadraticCurveTo(w * 0.72, h * 0.5, w * 0.76, h * 0.36);
    g.quadraticCurveTo(w * 0.79, h * 0.5, w * 0.79, h * 0.68);
    g.closePath(); g.fill();
    g.restore();

    // 빛 번짐
    var glow = g.createRadialGradient(w * 0.22, h * 0.1, 0, w * 0.22, h * 0.1, w * 0.55);
    glow.addColorStop(0, 'rgba(255,250,235,.55)');
    glow.addColorStop(1, 'rgba(255,250,235,0)');
    g.fillStyle = glow; g.fillRect(0, 0, w, h);

    // 그레인
    g.save();
    g.globalAlpha = 0.05;
    for (var i = 0; i < 9000; i++) {
      g.fillStyle = rand() > 0.5 ? '#fff' : '#5a4028';
      g.fillRect(rand() * w, rand() * h, 1.4, 1.4);
    }
    g.restore();
    return c;
  }

  /* ══════════════════════════════════════════════════
     프롬프트
     ══════════════════════════════════════════════════ */
  function currentRatio() { return C.ratioById(state.ratio); }

  function buildPrompt() {
    var r = currentRatio();
    var built = C.buildImagePrompt({
      title: state.title,
      topic: state.topic || state.title,
      style: state.prompt.style,
      mood: state.prompt.mood,
      lighting: state.prompt.lighting,
      extra: state.prompt.extra,
      ratio: r.ratio,
      width: r.w, height: r.h,
      platform: r.platform,
      textSide: state.align === 'center' ? 'center' : 'left'
    });
    lastBuiltPrompt = built;
    return built;
  }

  function updatePromptUI() {
    var built = buildPrompt();
    el.promptPreview.textContent = built.prompt;
    el.promptAspect.textContent = built.aspect;
    $('#bridgeAspect').textContent = built.aspect;
    var variants = C.promptVariants(built);
    var tool = state.bridgeTool;
    var box = $('#bridgePrompt');
    if (box) {
      box.textContent = tool === 'negative' ? variants.negative : (variants[tool] || variants.chatgpt);
    }
  }

  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? (okMsg || '복사했습니다.') : '복사가 막혔습니다. 직접 선택해 복사하세요.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg || '복사했습니다.');
      }).catch(fallback);
    } else fallback();
  }

  /* ══════════════════════════════════════════════════
     Pro API
     ══════════════════════════════════════════════════ */
  function provider() { return C.providerById(state.pro.provider); }
  function config() { return state.pro.configs[state.pro.provider]; }

  function buildConfigFields() {
    var p = provider();
    var cfg = config();
    var html = '';
    if (p.id === 'openai') {
      html += fieldKey(cfg.key) +
        fieldSelect('모델', 'cfgModel', p.models.map(function (m) { return { v: m.id, t: m.name }; }), cfg.model) +
        fieldSelect('품질', 'cfgQuality', [{ v: 'low', t: 'low · 가장 저렴' }, { v: 'medium', t: 'medium · 권장' }, { v: 'high', t: 'high · 가장 선명' }], cfg.quality);
    } else if (p.id === 'gemini') {
      html += fieldKey(cfg.key) +
        fieldSelect('모델', 'cfgModel', p.models.map(function (m) { return { v: m.id, t: m.name }; }), cfg.model);
    } else if (p.id === 'claude') {
      html += fieldKey(cfg.key) +
        fieldSelect('모델', 'cfgModel', p.models.map(function (m) { return { v: m.id, t: m.name }; }), cfg.model) +
        '<div class="callout callout-warn"><b>이미지 생성은 지원하지 않습니다.</b><span>Claude는 썸네일용 프롬프트를 다듬는 데 씁니다. 결과를 복사해 ChatGPT·Gemini·Midjourney에 붙여넣으면 됩니다.</span></div>';
    } else {
      html +=
        '<label class="field"><span>서버 URL</span><input type="url" id="cfgUrl" placeholder="https://my-proxy.example.com/generate" value="' + escapeHtml(cfg.url) + '" autocomplete="off" spellcheck="false" /></label>' +
        '<div class="two-col">' +
        '<label class="field"><span>메서드</span><select id="cfgMethod">' + ['POST', 'GET', 'PUT'].map(function (m) {
          return '<option value="' + m + '"' + (cfg.method === m ? ' selected' : '') + '>' + m + '</option>';
        }).join('') + '</select></label>' +
        '<label class="field"><span>응답 형식</span><select id="cfgRespType">' +
        '<option value="image"' + (cfg.responseType === 'image' ? ' selected' : '') + '>이미지</option>' +
        '<option value="text"' + (cfg.responseType === 'text' ? ' selected' : '') + '>텍스트</option></select></label>' +
        '</div>' +
        '<label class="field"><span>헤더 (JSON)</span><textarea id="cfgHeaders" rows="2" spellcheck="false" placeholder=\'{"Authorization":"Bearer ..."}\'>' + escapeHtml(cfg.headers) + '</textarea></label>' +
        '<label class="field"><span>본문 템플릿</span><textarea id="cfgBody" rows="3" spellcheck="false">' + escapeHtml(cfg.bodyTemplate) + '</textarea></label>' +
        '<p class="hint">{{prompt}} · {{promptJson}} · {{aspect}} · {{size}} · {{model}} · {{negative}} 자리에 값이 들어갑니다.</p>' +
        '<label class="field"><span>응답 이미지 경로</span><input type="text" id="cfgPath" placeholder="data.0.b64_json" value="' + escapeHtml(cfg.responsePath) + '" autocomplete="off" spellcheck="false" /></label>';
    }
    el.configFields.innerHTML = html;
    bindConfigInputs();
    $('#configChip').textContent = p.name;
    $('#providerNote').textContent = p.note;
    var link = $('#keyLink');
    if (p.docs) { link.href = p.docs; link.hidden = false; } else link.hidden = true;
    updateProState();
    updateCost();
    updateGenerateLabel();
  }

  function fieldKey(value) {
    return '<label class="field"><span>API 키</span>' +
      '<input type="password" id="cfgKey" placeholder="API 키 붙여넣기" value="' + escapeHtml(value) + '" autocomplete="off" spellcheck="false" />' +
      '</label>';
  }
  function fieldSelect(label, id, opts, value) {
    return '<label class="field"><span>' + label + '</span><select id="' + id + '">' +
      opts.map(function (o) {
        return '<option value="' + escapeHtml(o.v) + '"' + (String(value) === String(o.v) ? ' selected' : '') + '>' + escapeHtml(o.t) + '</option>';
      }).join('') + '</select></label>';
  }

  function bindConfigInputs() {
    var p = provider(), cfg = config();
    function bind(id, key, ev) {
      var node = document.getElementById(id);
      if (!node) return;
      node.addEventListener(ev || 'input', function () {
        cfg[key] = node.value;
        markDirty();
        updateProState();
        if (id === 'cfgModel') { updateCost(); updateGenerateLabel(); }
      });
    }
    bind('cfgKey', 'key');
    bind('cfgModel', 'model', 'change');
    bind('cfgQuality', 'quality', 'change');
    bind('cfgUrl', 'url');
    bind('cfgMethod', 'method', 'change');
    bind('cfgHeaders', 'headers');
    bind('cfgBody', 'bodyTemplate');
    bind('cfgPath', 'responsePath');
    bind('cfgRespType', 'responseType', 'change');
    void p;
  }

  function updateProState() {
    var p = provider();
    var hasKey = !!(config() && String(config().key || '').trim());
    var pill = $('#proState');
    if (p.id === 'custom') {
      pill.textContent = String(config().url || '').trim() ? '자체 서버 연결 설정됨' : '무료 모드 · 서버 주소 없음';
    } else if (p.id === 'claude') {
      pill.textContent = hasKey ? 'Claude 연결됨 · 프롬프트 고도화' : '무료 모드 · 키 없이 사용 중';
    } else {
      pill.textContent = hasKey ? p.name + ' 연결됨 · 이미지 생성 가능' : '무료 모드 · 키 없이 사용 중';
    }
    var badge = $('#configChip');
    if (badge) badge.textContent = p.name;
  }

  function updateCost() {
    var p = provider();
    var model = p.models.filter(function (m) { return m.id === config().model; })[0] || p.models[0];
    var chip = $('#costChip');
    if (p.id === 'custom') chip.textContent = '서버 정책';
    else if (!String(config().key || '').trim()) chip.textContent = '키 필요';
    else chip.textContent = model.cost;
  }

  function updateGenerateLabel() {
    var p = provider();
    var label = $('#generateLabel');
    if (!label) return;
    if (p.id === 'claude') label.textContent = '프롬프트 고도화';
    else if (p.id === 'custom') label.textContent = '내 서버로 생성';
    else label.textContent = p.name + '로 배경 생성';
  }

    /* 상태 로그 */
  function setRunStatus(text, kind) {
    var s = $('#runStatus');
    s.textContent = text;
    s.className = 'run-status' + (kind ? ' is-' + kind : '');
  }
  function stepList(items) {
    var ol = $('#runSteps');
    ol.hidden = false;
    ol.innerHTML = items.map(function (t, i) {
      return '<li data-step="' + i + '"' + (t.state ? ' class="' + t.state + '"' : '') + '>' + escapeHtml(t.text) + '</li>';
    }).join('');
  }
  function markStep(i, stateName) {
    var li = $('#runSteps li[data-step="' + i + '"]');
    if (li) li.className = stateName || '';
  }
  function pushStep(text, stateName) {
    var ol = $('#runSteps');
    ol.hidden = false;
    var li = document.createElement('li');
    li.textContent = text;
    if (stateName) li.className = stateName;
    ol.appendChild(li);
    return li;
  }

  function setBusy(busy) {
    var btn = $('#generateBtn');
    btn.classList.toggle('is-busy', busy);
    btn.disabled = busy;
    $('#sampleGenerate').disabled = busy;
    $('#cancelBtn').hidden = !busy;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('이미지를 불러오지 못했습니다.')); };
      img.src = src;
    });
  }

  function applyImage(img, meta) {
    bgImage = img;
    state.bgMode = 'image';
    state.bgImage = img;
    bgImageInfo = { source: (meta && meta.source) || 'ai', prompt: (meta && meta.prompt) || '' };
    $('#bgSeg').querySelectorAll('.seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.bg === 'image');
    });
    render();
    updateBridgeStatus(meta);
  }

  function updateBridgeStatus(meta) {
    var s = $('#bridgeStatus');
    if (!s) return;
    if (meta && meta.source === 'ai') s.textContent = 'AI가 만든 이미지를 배경으로 깔았습니다. 제목과 배지가 위에 얹혀 있습니다.';
    else if (photo.canvas) s.textContent = '사진을 배경으로 깔았습니다.';
    else s.textContent = '가져온 이미지가 없습니다.';
  }

  async function generateImage() {
    var p = provider();
    var cfg = config();
    var built = buildPrompt();
    if (p.id !== 'custom' && !String(cfg.key || '').trim()) {
      setRunStatus('API 키를 먼저 입력하세요.', 'err');
      var keyInput = $('#cfgKey');
      if (keyInput) keyInput.focus();
      return;
    }
    var request;
    try {
      request = C.providerRequest(p.id, cfg, { prompt: built.prompt, aspect: built.aspect });
    } catch (e) {
      setRunStatus(e.message, 'err');
      return;
    }

    setBusy(true);
    setRunStatus('생성 중… (최대 2분)', 'busy');
    stepList([
      { text: '프롬프트 준비 · ' + built.aspect + ' · ' + p.name },
      { text: '요청 전송 · ' + (p.id === 'custom' ? '내 서버' : '공급자 API') }
    ]);
    abortCtl = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (abortCtl) abortCtl.abort();
    }, 120000);

    try {
      markStep(0, 'done');
      var res = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' ? undefined : JSON.stringify(request.body),
        signal: abortCtl.signal
      });
      var textBody = await res.text();
      if (!res.ok) {
        pushStep('실패 · HTTP ' + res.status, 'err');
        setRunStatus(C.explainHttpError(res.status, textBody, p.id), 'err');
        return;
      }
      var json;
      try { json = JSON.parse(textBody); }
      catch (e) { throw new Error('응답이 JSON이 아닙니다. 커스텀 서버 응답 형식을 확인하세요.'); }
      markStep(1, 'done');
      pushStep('응답 도착 · 이미지 해석 중', '');
      var parsed = C.parseProviderResponse(p.id, json, cfg);
      if (parsed.kind === 'text') {
        markStep(2, 'done');
        setRunStatus('프롬프트를 다듬었습니다. 복사해서 구독 AI에 붙여넣으세요.', 'ok');
        showEnhanced(parsed.text);
        toast('프롬프트 고도화 완료');
        return;
      }
      var src = parsed.dataUrl || parsed.url;
      if (!src) throw new Error('이미지 주소를 찾지 못했습니다.');
      var img = await loadImage(src);
      applyImage(img, { source: 'ai', prompt: built.prompt });
      pushStep('배경 삽입 완료 · ' + img.naturalWidth + '×' + img.naturalHeight, 'done');
      markStep(2, 'done');
      generated.unshift({ src: src, prompt: built.prompt, provider: p.name, at: Date.now() });
      generated = generated.slice(0, 6);
      renderResults();
      setRunStatus('배경에 적용했습니다. 썸네일 화면에서 문구를 다듬으세요.', 'ok');
      toast('AI 배경을 캔버스에 넣었습니다.');
    } catch (err) {
      var msg;
      if (timedOut) msg = '2분 안에 응답이 없어 취소했습니다. 잠시 뒤 다시 시도하세요.';
      else msg = C.explainNetworkError(err, p.id);
      pushStep('오류 · ' + msg, 'err');
      setRunStatus(msg, 'err');
    } finally {
      clearTimeout(timer);
      abortCtl = null;
      setBusy(false);
      saveNow();
    }
  }

  function showEnhanced(text) {
    var strip = $('#resultStrip');
    strip.hidden = false;
    var box = $('#enhancedBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'enhancedBox';
      box.className = 'enhanced-box';
      box.innerHTML = '<div class="prompt-preview-head"><span>Claude가 다듬은 프롬프트</span>' +
        '<span class="row-mini"><button type="button" class="mini-btn" id="enhancedCopy">복사</button>' +
        '<button type="button" class="mini-btn" id="enhancedBridge">브리지로</button></span></div>' +
        '<pre class="prompt-box" id="enhancedText"></pre>';
      strip.parentNode.insertBefore(box, strip);
      $('#enhancedCopy').addEventListener('click', function () {
        copyText($('#enhancedText').textContent, '고도화된 프롬프트를 복사했습니다.');
      });
      $('#enhancedBridge').addEventListener('click', function () {
        switchView('bridge');
        toast('브리지에서 도구별 문장으로 바꿔 복사하세요.');
      });
    }
    box.hidden = false;
    $('#enhancedText').textContent = text;
  }

  function renderResults() {
    var strip = $('#resultStrip');
    if (!generated.length) { strip.hidden = true; return; }
    strip.hidden = false;
    strip.innerHTML = generated.map(function (g, i) {
      return '<button type="button" class="result-thumb" data-idx="' + i + '" title="이 이미지를 배경으로">' +
        '<img src="' + g.src + '" alt="생성된 배경 ' + (i + 1) + '" />' +
        '<span>' + escapeHtml(g.provider) + ' · ' + new Date(g.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + '</span></button>';
    }).join('') + '<button type="button" class="result-thumb result-more" id="resultToMake"><span class="result-big">썸네일로</span><span>문구 얹으러 가기</span></button>';
    strip.querySelectorAll('.result-thumb[data-idx]').forEach(function (b) {
      b.addEventListener('click', function () {
        var g = generated[Number(b.dataset.idx)];
        loadImage(g.src).then(function (img) { applyImage(img, { source: 'ai', prompt: g.prompt }); toast('이 배경을 적용했습니다.'); });
      });
    });
    var more = $('#resultToMake');
    if (more) more.addEventListener('click', function () { switchView('make'); });
  }

  /* ══════════════════════════════════════════════════
     화면 전환
     ══════════════════════════════════════════════════ */
  var views = ['make', 'pro', 'bridge', 'guide'];
  function switchView(name) {
    if (views.indexOf(name) < 0) name = 'make';
    state.view = name;
    views.forEach(function (v) {
      var sec = document.getElementById('view-' + v);
      if (sec) sec.hidden = v !== name;
    });
    $$('.tab').forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    markDirty();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'make') render();
    if (name === 'bridge') updatePromptUI();
  }

  /* ══════════════════════════════════════════════════
     내려받기
     ══════════════════════════════════════════════════ */
  function canvasForExport(scale) {
    var r = currentRatio();
    var c = makeCanvas(r.w * scale, r.h * scale);
    var g = c.getContext('2d');
    g.scale(scale, scale);
    state.bgImage = bgImage;
    compose(g, r.w, r.h, state);
    return c;
  }

  function extension(fmt) { return fmt === 'jpeg' ? 'jpg' : fmt; }

  function downloadCurrent() {
    var fmt = state.format;
    var scale = Number(state.scale) || 1;
    var cv;
    try { cv = canvasForExport(scale); }
    catch (e) { toast('캔버스를 만들지 못했습니다.'); return; }
    var mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    var q = Math.min(1, Math.max(0.3, Number(state.quality) / 100));
    cv.toBlob(function (blob) {
      if (!blob) { toast('저장에 실패했습니다. 다른 형식으로 시도해 보세요.'); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = C.downloadName(state.title, state.ratio, extension(fmt), scale);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast(extension(fmt).toUpperCase() + ' 저장 · ' + cv.width + '×' + cv.height + ' · ' + C.formatBytes(blob.size));
    }, mime, q);
  }

  function copyImage() {
    var cv = canvasForExport(1);
    if (!cv.toBlob || !navigator.clipboard || !window.ClipboardItem) {
      toast('이 브라우저는 이미지 복사를 지원하지 않습니다. PNG로 저장하세요.');
      return;
    }
    cv.toBlob(function (blob) {
      if (!blob) { toast('복사할 이미지를 만들지 못했습니다.'); return; }
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () {
        toast('이미지를 클립보드에 복사했습니다.');
      }).catch(function () {
        toast('브라우저가 복사를 막았습니다. PNG로 저장하세요.');
      });
    }, 'image/png');
  }

  /* ══════════════════════════════════════════════════
     이벤트 연결
     ══════════════════════════════════════════════════ */
  function syncControls() {
    el.title.value = state.title;
    el.sub.value = state.sub;
    el.badge.value = state.badge;
    el.handle.value = state.handle;
    el.titleCount.textContent = state.title.length + '/90';
    el.bgColor.value = state.bgColor;
    el.accentColor.value = state.accentColor;
    el.bgColorVal.textContent = state.bgColor.toUpperCase();
    el.accentColorVal.textContent = state.accentColor.toUpperCase();
    $('#textureRange').value = state.texture;
    $('#grainRange').value = state.grain;
    $('#vignetteRange').value = state.vignette;
    $('#textureVal').textContent = state.texture;
    $('#grainVal').textContent = state.grain;
    $('#vignetteVal').textContent = state.vignette;
    $('#subjectScale').value = state.subject.scale;
    $('#subjectX').value = state.subject.x;
    $('#subjectY').value = state.subject.y;
    $('#shadowRange').value = state.subject.shadow;
    $('#scaleVal').textContent = state.subject.scale;
    $('#posXVal').textContent = state.subject.x;
    $('#posYVal').textContent = state.subject.y;
    $('#shadowVal').textContent = state.subject.shadow;
    $('#algoSelect').value = state.subject.algo;
    $('#strengthRange').value = state.subject.strength;
    $('#toleranceRange').value = state.subject.tolerance;
    $('#featherRange').value = state.subject.feather;
    $('#strengthVal').textContent = state.subject.strength;
    $('#toleranceVal').textContent = state.subject.tolerance;
    $('#featherVal').textContent = state.subject.feather;
    el.cutToggle.checked = state.subject.removed;
    $('#qualityRange').value = state.quality;
    $('#qualityVal').textContent = state.quality;
    $('#scaleSelect').value = String(state.scale);
    $('#safeToggle').checked = state.safe;
    $('#showBadge').checked = state.showBadge;
    $('#showSub').checked = state.showSub;
    $('#showHandle').checked = state.showHandle;
    $('#moodSelect').value = state.prompt.mood;
    $('#lightSelect').value = state.prompt.lighting;
    $('#topicInput').value = state.topic || '';
    $('#extraInput').value = state.prompt.extra || '';
    updateRangeFills();

    $$('.seg-btn[data-format]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.format === state.format); });
    $$('.seg-btn[data-bg]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.bg === state.bgMode); });
    $$('.seg-btn[data-align]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.align === state.align); });
    $$('.seg-btn[data-tool]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.tool === state.bridgeTool); });
    $$('.style-chip').forEach(function (b) { b.classList.toggle('is-active', b.dataset.style === state.prompt.style); });
  }

  function updateRangeFills() {
    $$('input[type="range"]').forEach(function (r) {
      var min = Number(r.min || 0), max = Number(r.max || 100), v = Number(r.value);
      var pct = ((v - min) / (max - min)) * 100;
      r.style.setProperty('--fill', pct + '%');
    });
  }

  function updateMetaUI() {
    var r = currentRatio();
    el.stageRatioName.textContent = r.name;
    el.stageDims.textContent = r.w + ' × ' + r.h;
    el.ratioChip.textContent = r.ratio;
    el.ratioHint.textContent = r.note;
    $('#stageNote').innerHTML = '강조는 <b>**이렇게**</b> 감싸면 포인트색으로 바뀝니다. ' + r.safe + '.';
    $('#downloadLabel').textContent = state.format === 'png' ? 'PNG 저장' : state.format === 'jpeg' ? 'JPG 저장' : 'WebP 저장';
    $('#topDownloadLabel').textContent = state.format.toUpperCase() + ' 저장';
    el.themeName.textContent = C.themeById(state.theme).name;
  }

  function updateScore() {
    var sc = C.quickHeadlineScore(state.title, P);
    el.scoreChip.textContent = sc.total;
    el.scoreChip.dataset.grade = sc.grade;
    el.scoreChip.title = '제목 후킹 점수 ' + sc.total + '점 (' + sc.grade + ')';
    if (sc.tips && sc.tips.length) el.scoreTip.textContent = '보강하면 좋은 트리거: ' + sc.tips.join(' · ');
    else el.scoreTip.textContent = '**강조** 문법으로 핵심 단어만 포인트색으로.';
  }

  function bindEvents() {
    // 탭
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.dataset.tab); });
    });
    document.addEventListener('click', function (e) {
      var a = e.target.closest('[data-action="go-make"]');
      if (a) { e.preventDefault(); switchView('make'); }
      var d = e.target.closest('[data-action="download"]');
      if (d) { e.preventDefault(); downloadCurrent(); }
    });

    // 비율
    el.ratioGrid.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ratio]');
      if (!b) return;
      state.ratio = b.dataset.ratio;
      $$('.ratio-card', el.ratioGrid).forEach(function (x) {
        var on = x.dataset.ratio === state.ratio;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-checked', String(on));
      });
      updateMetaUI();
      render();
      updatePromptUI();
      markDirty();
    });

    // 테마
    el.themeGrid.addEventListener('click', function (e) {
      var b = e.target.closest('[data-theme]');
      if (!b) return;
      state.theme = b.dataset.theme;
      var th = C.themeById(state.theme);
      state.bgColor = th.palette.bg;
      state.accentColor = th.palette.accent;
      $$('.theme-card', el.themeGrid).forEach(function (x) {
        var on = x.dataset.theme === state.theme;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-checked', String(on));
      });
      syncControls();
      updateMetaUI();
      render();
      markDirty();
    });

    // 배경 세그
    $('#bgSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-bg]');
      if (!b) return;
      var mode = b.dataset.bg;
      if (mode === 'image' && !bgImage) {
        toast('먼저 사진을 넣거나 Pro에서 배경을 만드세요.');
        return;
      }
      state.bgMode = mode;
      $$('.seg-btn[data-bg]').forEach(function (x) { x.classList.toggle('is-active', x.dataset.bg === mode); });
      render();
      markDirty();
    });

    el.bgColor.addEventListener('input', function () {
      state.bgColor = el.bgColor.value;
      state.bgMode = 'color';
      el.bgColorVal.textContent = state.bgColor.toUpperCase();
      $$('.seg-btn[data-bg]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.bg === 'color'); });
      render(); markDirty();
    });
    el.accentColor.addEventListener('input', function () {
      state.accentColor = el.accentColor.value;
      el.accentColorVal.textContent = state.accentColor.toUpperCase();
      render(); markDirty();
    });
    $('#paletteReset').addEventListener('click', function () {
      var th = C.themeById(state.theme);
      state.bgColor = th.palette.bg;
      state.accentColor = th.palette.accent;
      state.bgMode = 'theme';
      syncControls();
      $$('.seg-btn[data-bg]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.bg === 'theme'); });
      render(); markDirty();
      toast('테마 기본 색으로 돌렸습니다.');
    });

    // 슬라이더 공통
    function bindRange(id, key, label, after) {
      var node = document.getElementById(id);
      node.addEventListener('input', function () {
        var v = Number(node.value);
        state[key] = v;
        if (label) document.getElementById(label).textContent = v;
        updateRangeFills();
        if (after) after();
        render();
        markDirty();
      });
    }
    bindRange('textureRange', 'texture', 'textureVal');
    bindRange('grainRange', 'grain', 'grainVal');
    bindRange('vignetteRange', 'vignette', 'vignetteVal');
    bindRange('qualityRange', 'quality', 'qualityVal');

    // 사진
    el.dropzone.addEventListener('click', function () { el.photoInput.click(); });
    el.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.photoInput.click(); }
    });
    el.photoInput.addEventListener('change', function () {
      if (el.photoInput.files && el.photoInput.files[0]) loadPhotoFromFile(el.photoInput.files[0]);
      el.photoInput.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      el.dropzone.addEventListener(ev, function (e) { e.preventDefault(); el.dropzone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.dropzone.addEventListener(ev, function (e) { e.preventDefault(); el.dropzone.classList.remove('is-over'); });
    });
    el.dropzone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadPhotoFromFile(f);
    });
    document.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { loadPhotoFromFile(f); toast('붙여넣은 이미지를 넣었습니다.'); }
          return;
        }
      }
    });
    $('#sampleBtn').addEventListener('click', sampleProduct);
    $('#photoClear').addEventListener('click', function () {
      photo.canvas = null; photo.cut = null; photo.stats = null; photo.edge = null; photo.srcName = '';
      bgImageInfo = { source: '', prompt: '' };
      refreshPhotoUI(); render();
      toast('사진을 뺐습니다.');
    });

    el.cutToggle.addEventListener('change', function () {
      state.subject.removed = el.cutToggle.checked;
      render(); markDirty();
    });
    $('#algoSelect').addEventListener('change', function () {
      state.subject.algo = this.value;
      processCut();
      markDirty();
    });
    function bindSubjectRange(id, key, labelId, after) {
      var node = document.getElementById(id);
      node.addEventListener('input', function () {
        var v = Number(node.value);
        state.subject[key] = v;
        if (labelId) document.getElementById(labelId).textContent = v;
        updateRangeFills();
        if (after) after();
        render();
        markDirty();
      });
    }
    bindSubjectRange('strengthRange', 'strength', 'strengthVal', function () { processCut(); });
    bindSubjectRange('toleranceRange', 'tolerance', 'toleranceVal', function () { processCut(); });
    bindSubjectRange('featherRange', 'feather', 'featherVal', function () { processCut(); });
    bindSubjectRange('subjectScale', 'scale', 'scaleVal');
    bindSubjectRange('subjectX', 'x', 'posXVal');
    bindSubjectRange('subjectY', 'y', 'posYVal');
    bindSubjectRange('shadowRange', 'shadow', 'shadowVal');
    $('#cutPreview').addEventListener('click', function () {
      if (!photo.canvas) return;
      previewOriginal = !previewOriginal;
      state.subject.removed = previewOriginal ? false : el.cutToggle.checked;
      this.textContent = previewOriginal ? '누끼로 돌아가기' : '원본/누끼 비교';
      render();
    });
    $('#bgFromPhoto').addEventListener('click', function () {
      if (!photo.canvas) return;
      applyImage(photo.canvas, { source: 'photo' });
      toast('사진을 배경으로 깔았습니다. Pro 배경과 바꿔 보세요.');
      markDirty();
    });

    // 문구
    el.title.addEventListener('input', function () {
      state.title = el.title.value;
      el.titleCount.textContent = state.title.length + '/90';
      updateScore();
      render();
      updatePromptUI();
      markDirty();
    });
    el.sub.addEventListener('input', function () { state.sub = el.sub.value; render(); markDirty(); });
    el.badge.addEventListener('input', function () { state.badge = el.badge.value; render(); markDirty(); });
    el.handle.addEventListener('input', function () { state.handle = el.handle.value; render(); markDirty(); });
    $('#topicInput').addEventListener('input', function () { state.topic = this.value; updatePromptUI(); markDirty(); });
    $('#extraInput').addEventListener('input', function () { state.prompt.extra = this.value; updatePromptUI(); markDirty(); });
    $('#moodSelect').addEventListener('change', function () { state.prompt.mood = this.value; updatePromptUI(); markDirty(); });
    $('#lightSelect').addEventListener('change', function () { state.prompt.lighting = this.value; updatePromptUI(); markDirty(); });

    $('#alignSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-align]');
      if (!b) return;
      state.align = b.dataset.align;
      $$('.seg-btn[data-align]').forEach(function (x) { x.classList.toggle('is-active', x.dataset.align === state.align); });
      render(); markDirty();
    });
    $('#formatSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-format]');
      if (!b) return;
      state.format = b.dataset.format;
      $$('.seg-btn[data-format]').forEach(function (x) { x.classList.toggle('is-active', x.dataset.format === state.format); });
      updateMetaUI(); markDirty();
    });
    $('#scaleSelect').addEventListener('change', function () { state.scale = Number(this.value); markDirty(); });
    $('#safeToggle').addEventListener('change', function () { state.safe = this.checked; render(); markDirty(); });
    $('#showBadge').addEventListener('change', function () { state.showBadge = this.checked; render(); markDirty(); });
    $('#showSub').addEventListener('change', function () { state.showSub = this.checked; render(); markDirty(); });
    $('#showHandle').addEventListener('change', function () { state.showHandle = this.checked; render(); markDirty(); });

    $('#downloadBtn').addEventListener('click', downloadCurrent);
    $('#copyImage').addEventListener('click', copyImage);
    $('#goPro').addEventListener('click', function () { switchView('pro'); });
    $('#goBridge').addEventListener('click', function () { updatePromptUI(); switchView('bridge'); });

    // 다크 모드
    $('#themeToggle').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('oneTapImageStudio.theme', next); } catch (e) { /* noop */ }
    });

    // Pro 제공자
    el.providerGrid.addEventListener('click', function (e) {
      var b = e.target.closest('[data-provider]');
      if (!b) return;
      state.pro.provider = b.dataset.provider;
      $$('.provider-card', el.providerGrid).forEach(function (x) {
        var on = x.dataset.provider === state.pro.provider;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-checked', String(on));
      });
      buildConfigFields();
      updatePromptUI();
      markDirty();
    });

    // Pro 프롬프트
    el.styleChips.addEventListener('click', function (e) {
      var b = e.target.closest('[data-style]');
      if (!b) return;
      state.prompt.style = b.dataset.style;
      $$('.style-chip').forEach(function (x) {
        var on = x.dataset.style === state.prompt.style;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-pressed', String(on));
      });
      updatePromptUI(); markDirty();
    });
    $('#promptCopy').addEventListener('click', function () {
      copyText(buildPrompt().prompt, '이미지 프롬프트를 복사했습니다.');
    });
    $('#generateBtn').addEventListener('click', function () {
      if (provider().id === 'claude') enhancePrompt();
      else generateImage();
    });
    $('#sampleGenerate').addEventListener('click', function () {
      setBusy(true);
      setRunStatus('샘플 배경을 만드는 중…', 'busy');
      stepList([{ text: '오프라인 샘플 생성 · 키/네트워크 사용 안 함' }]);
      setTimeout(function () {
        var cv = makeSampleBackground();
        applyImage(cv, { source: 'ai', prompt: 'offline sample' });
        markStep(0, 'done');
        pushStep('샘플 배경 삽입 완료 · 실제 생성은 키를 붙이면 됩니다', 'done');
        setRunStatus('샘플을 배경에 적용했습니다. 실제 AI 결과는 키를 붙이면 나옵니다.', 'ok');
        setBusy(false);
        toast('샘플 배경을 적용했습니다.');
      }, 320);
    });
    $('#cancelBtn').addEventListener('click', function () {
      if (abortCtl) abortCtl.abort();
      setRunStatus('취소하는 중…', 'busy');
    });
    $('#keyClear').addEventListener('click', function () {
      var cfg = config();
      cfg.key = '';
      var inp = $('#cfgKey');
      if (inp) inp.value = '';
      updateProState(); updateCost(); markDirty();
      toast('키를 지웠습니다.');
    });

    // 브리지
    $('#bridgeToolSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tool]');
      if (!b) return;
      state.bridgeTool = b.dataset.tool;
      $$('.seg-btn[data-tool]').forEach(function (x) { x.classList.toggle('is-active', x.dataset.tool === state.bridgeTool); });
      updatePromptUI(); markDirty();
    });
    $('#bridgeCopy').addEventListener('click', function () {
      var built = buildPrompt();
      var variants = C.promptVariants(built);
      var t = state.bridgeTool === 'negative' ? variants.negative : variants[state.bridgeTool];
      copyText(t, '프롬프트를 복사했습니다. 구독 AI에 붙여넣으세요.');
    });
    $('#bridgeRefresh').addEventListener('click', function () { updatePromptUI(); toast('프롬프트를 다시 만들었습니다.'); });
    var bridgeDrop = $('#bridgeDrop');
    bridgeDrop.addEventListener('click', function () { $('#bridgeInput').click(); });
    bridgeDrop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#bridgeInput').click(); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      bridgeDrop.addEventListener(ev, function (e) { e.preventDefault(); bridgeDrop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      bridgeDrop.addEventListener(ev, function (e) { e.preventDefault(); bridgeDrop.classList.remove('is-over'); });
    });
    bridgeDrop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadBridgeImage(f);
    });
    $('#bridgeInput').addEventListener('change', function () {
      if (this.files && this.files[0]) loadBridgeImage(this.files[0]);
      this.value = '';
    });
    $('#bridgeToMake').addEventListener('click', function () { switchView('make'); });

    // 단축키
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        downloadCurrent();
      }
    });

    // 첫 입력 전 자동 저장
    window.addEventListener('beforeunload', saveNow);
  }

  function loadBridgeImage(file) {
    if (!file || !/^image\//.test(file.type)) { toast('이미지 파일만 넣을 수 있습니다.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      loadImage(String(reader.result)).then(function (img) {
        applyImage(img, { source: 'photo', prompt: '' });
        $('#bridgeStatus').textContent = '가져온 이미지를 배경으로 깔았습니다. 썸네일 화면에서 제목을 확인하세요.';
        toast('배경으로 적용했습니다.');
        markDirty();
      }).catch(function () { toast('이미지를 읽지 못했습니다.'); });
    };
    reader.readAsDataURL(file);
  }

  async function enhancePrompt() {
    var p = provider(), cfg = config();
    if (!String(cfg.key || '').trim()) {
      setRunStatus('API 키를 먼저 입력하세요.', 'err');
      var inp = $('#cfgKey'); if (inp) inp.focus();
      return;
    }
    var built = buildPrompt();
    setBusy(true);
    setRunStatus('프롬프트를 다듬는 중…', 'busy');
    stepList([{ text: 'Claude에 프롬프트 개선 요청 · 이미지 생성 아님' }]);
    abortCtl = new AbortController();
    try {
      var req = C.providerRequest('claude', cfg, { prompt: built.prompt, aspect: built.aspect });
      var res = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal: abortCtl.signal });
      var txt = await res.text();
      if (!res.ok) { setRunStatus(C.explainHttpError(res.status, txt, 'claude'), 'err'); return; }
      var parsed = C.parseProviderResponse('claude', JSON.parse(txt), cfg);
      markStep(0, 'done');
      pushStep('다듬은 프롬프트 도착', 'done');
      showEnhanced(parsed.text);
      setRunStatus('완성했습니다. 복사해서 구독 AI에 붙여넣으세요.', 'ok');
    } catch (err) {
      setRunStatus(C.explainNetworkError(err, 'claude'), 'err');
    } finally {
      abortCtl = null;
      setBusy(false);
      saveNow();
    }
  }

  /* ══════════════════════════════════════════════════
     시작
     ══════════════════════════════════════════════════ */
  function init() {
    cacheEls();
    try {
      var t = localStorage.getItem('oneTapImageStudio.theme');
      if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    } catch (e) { /* noop */ }

    restore();
    state.bgImage = null;
    if (state.bgMode === 'image' && !bgImage) state.bgMode = 'theme';
    // 저장값이 깨졌을 때 기본값 보정
    if (!C.ratioById(state.ratio)) state.ratio = 'yt';
    if (!C.themeById(state.theme)) state.theme = 'editorial';
    if (!state.topic) state.topic = '';

    buildRatioGrid();
    buildThemeGrid();
    buildProviderGrid();
    buildSelects();
    buildConfigFields();
    syncControls();
    updateMetaUI();
    updateScore();
    updatePromptUI();
    bindEvents();

    var hash = (location.hash || '').replace('#', '');
    switchView(views.indexOf(hash) >= 0 ? hash : 'make');

    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    fontsReady.then(function () {
      if (document.fonts && document.fonts.load) {
        return Promise.all([
          document.fonts.load('400 16px PlexKR'),
          document.fonts.load('700 40px PlexKR'),
          document.fonts.load('800 40px PlexKR')
        ]).catch(function () { });
      }
    }).then(function () {
      render();
      refreshPhotoUI();
    });

    // 첫 화면 기본 문구가 그대로면 안내
    if (!sessionStorage.getItem(STORE_KEY)) {
      setTimeout(function () { toast('제목을 바꾸고 사진을 넣어 보세요. 전부 이 브라우저에서 처리됩니다.', 3400); }, 700);
    }

    // 테스트/자동화에서 상태를 읽을 수 있게 (읽기 전용)
    window.__studio = {
      get state() { return state; },
      get photo() { return photo; },
      get bgImage() { return bgImage; },
      render: render,
      applySample: sampleProduct,
      applySampleBg: function () { var c = makeSampleBackground(); applyImage(c, { source: 'ai', prompt: 'offline sample' }); return true; },
      setTitle: function (v) { state.title = v; el.title.value = v; updateScore(); render(); },
      download: downloadCurrent,
      buildPrompt: buildPrompt,
      version: C.VERSION
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
