/* ============================================================
   원탭 이미지·썸네일 스튜디오 · core.js
   DOM에 닿지 않는 순수 로직만 담는다. node에서는 require, 브라우저에서는 window.ImageStudioCore.
     · 캔버스 비율 프리셋 5종 / 테마 20종(카테고리 6종)
     · 레퍼런스 벤치마킹 엔진(유튜브 URL · 픽셀 팔레트/톤/구조 분석 · 프리셋)
     · 배경 투명화(가장자리 색 샘플링 · 연결 영역 · 밝은 배경) + 페더링
     · 한국어 줄바꿈·자동 크기 피팅
     · 이미지 프롬프트 빌더(구독 AI 브리지)
     · Pro API 요청/응답 빌더(OpenAI · Gemini · Claude · 커스텀 서버)
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImageStudioCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 작은 유틸 ─────────────────────────────────────── */
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
  function round(n, d) { var p = Math.pow(10, d || 0); return Math.round(n * p) / p; }
  function isHex(v) { return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim()); }
  function hexToRgb(hex) {
    var h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgbToHex(r, g, b) {
    function x(v) { var s = clamp(Math.round(v), 0, 255).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + x(r) + x(g) + x(b);
  }
  function mixHex(a, b, t) {
    var A = hexToRgb(a), B = hexToRgb(b), k = clamp(t, 0, 1);
    return rgbToHex(A.r + (B.r - A.r) * k, A.g + (B.g - A.g) * k, A.b + (B.b - A.b) * k);
  }
  function relativeLuminance(hex) {
    var c = hexToRgb(hex);
    var ch = [c.r, c.g, c.b].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrastRatio(a, b) {
    var l1 = relativeLuminance(a), l2 = relativeLuminance(b);
    var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  function readableInk(bg, candidates) {
    var list = candidates && candidates.length ? candidates : ['#111111', '#FFFFFF'];
    var best = list[0], bestRatio = 0;
    list.forEach(function (c) {
      var r = contrastRatio(bg, c);
      if (r > bestRatio) { bestRatio = r; best = c; }
    });
    return { hex: best, ratio: round(bestRatio, 2) };
  }
  function slugify(s, fallback) {
    var t = String(s == null ? '' : s).trim()
      .replace(/[\\/:*?"<>|#%&{}$!'@+`,]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    if (t.length > 60) t = t.slice(0, 60).replace(/-+$/, '');
    return t || (fallback || 'thumbnail');
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return round(n / 1024, 1) + ' KB';
    return round(n / 1024 / 1024, 2) + ' MB';
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ── 비율 프리셋 5종 ──────────────────────────────── */
  var RATIOS = [
    {
      id: 'yt', name: '유튜브 썸네일', short: '유튜브', ratio: '16:9', w: 1280, h: 720,
      platform: 'YouTube', purpose: 'video',
      note: '1280×720 · 썸네일에 꼭 맞는 가로형', safe: '오른쪽 아래 재생 시간 배지는 피하세요'
    },
    {
      id: 'ig45', name: '인스타·스레드 세로', short: '4:5', ratio: '4:5', w: 1080, h: 1350,
      platform: 'Instagram / Threads', purpose: 'feed',
      note: '1080×1350 · 피드에서 가장 크게 보이는 세로형', safe: '위 12%는 프로필 UI에 가려집니다'
    },
    {
      id: 'sq', name: '정사각 피드', short: '1:1', ratio: '1:1', w: 1080, h: 1080,
      platform: 'Instagram / Threads', purpose: 'feed',
      note: '1080×1080 · 어떤 채널에나 안전한 정사각', safe: '가장자리 6%는 잘릴 수 있습니다'
    },
    {
      id: 'store', name: '스마트스토어 대표', short: '스토어', ratio: '1:1', w: 1000, h: 1000,
      platform: '스마트스토어 / 쿠팡', purpose: 'commerce',
      note: '1000×1000 · 대표 이미지·상세 첫 컷 규격', safe: '상품은 가운데 70% 안에 두세요'
    },
    {
      id: 'blog', name: '블로그 대표 컷', short: '블로그', ratio: '3:2', w: 1200, h: 800,
      platform: '네이버 블로그 / 티스토리', purpose: 'article',
      note: '1200×800 · 본문 상단 대표 이미지', safe: '제목이 들어갈 왼쪽 절반을 비워두세요'
    }
  ];
  function ratioById(id) {
    for (var i = 0; i < RATIOS.length; i++) if (RATIOS[i].id === id) return RATIOS[i];
    return RATIOS[0];
  }

  /* ── 테마 20종 ─────────────────────────────────────
     cat      에디토리얼 · 미디어 · 그래픽 · 레트로 · 럭스 · 커머스
     texture  배경 질감 페인터 키 (app.js의 TEXTURES)
     frame    피사체를 받치는 매트 — none/photo/panel/polaroid/film/hairline/glass/offset
     deco     정규화 좌표(0~1) 장식 레이어. fg:true면 문구 위에 다시 그린다.
     preview  테마 칩 미리보기 — 칩 안에서 배경·타입·포인트를 흉내 낸다.
  */
  var THEME_CATEGORIES = [
    { id: 'all', name: '전체' },
    { id: 'editorial', name: '에디토리얼' },
    { id: 'media', name: '미디어' },
    { id: 'graphic', name: '그래픽' },
    { id: 'retro', name: '레트로' },
    { id: 'luxe', name: '럭스' },
    { id: 'commerce', name: '커머스' }
  ];

  var THEMES = [
    {
      id: 'editorial', name: '크림 에디토리얼', short: '에디토리얼', tag: '종이 질감 · 세리프',
      cat: 'editorial',
      ref: 'cream-editorial', dark: false, texture: 'paper',
      palette: { bg: '#F3EADD', surface: '#FFFCF6', ink: '#33281E', sub: '#6A5B4A', line: '#E0D2BE', accent: '#A8431F', accentSoft: '#F6E3D6' },
      layout: { align: 'left', text: { x: .07, y: .54, w: .52, h: .38 }, subject: { x: .55, y: .13, w: .38, h: .76 }, badge: 'tab' },
      titleWeight: 700, titleTracking: -0.015, lineHeight: 1.16, kicker: 'EYE EDITORIAL',
      kickerStyle: 'rule',
      frame: { kind: 'photo', pad: .02, border: .011, shadow: .3, rotate: -0.012 },
      deco: [
        { kind: 'edgebar', side: 'left', thick: .012, color: 'accent' },
        { kind: 'label', text: 'EYE EDITORIAL', x: .07, y: .462, size: .0122, color: 'sub', tracking: .2 },
        { kind: 'rule', x: .07, y: .498, w: .16, h: .0022, color: 'line' }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'left' }
    },
    {
      id: 'magazine', name: '스위스 매거진', short: '매거진', tag: '격자 · 큰 숫자',
      cat: 'editorial',
      ref: 'swiss-magazine', dark: false, texture: 'grid',
      palette: { bg: '#F2F2EF', surface: '#FFFFFF', ink: '#111111', sub: '#5C5C58', line: '#D8D8D2', accent: '#D33A1E', accentSoft: '#F6DDD6' },
      layout: { align: 'left', text: { x: .07, y: .1, w: .44, h: .38 }, subject: { x: .5, y: .12, w: .46, h: .76 }, badge: 'bar' },
      titleWeight: 800, titleTracking: -0.035, lineHeight: 1.05, kicker: 'ISSUE 04',
      kickerStyle: 'mono',
      frame: { kind: 'photo', pad: .012, border: .007, shadow: .22, rotate: 0 },
      deco: [
        { kind: 'bar', x: .8, y: 0, w: .2, h: .052, color: 'accent' },
        { kind: 'label', text: 'THUMBNAIL / GRID', x: .07, y: .058, size: .0118, color: 'sub', tracking: .16 },
        { kind: 'rule', x: .07, y: .93, w: .86, h: .0014, color: 'line' },
        { kind: 'number', text: '04', x: .07, y: .72, size: .16, color: 'ink', alpha: .14, align: 'left' }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'top' }
    },
    {
      id: 'typeposter', name: '빅타입 포스터', short: '빅타입', tag: '타이포 · 여백',
      cat: 'editorial',
      dark: false, texture: 'poster',
      palette: { bg: '#F7F4EE', surface: '#FFFFFF', ink: '#0F0E0C', sub: '#57534B', line: '#DAD4C8', accent: '#E03A16', accentSoft: '#FBE0D8' },
      layout: { align: 'left', text: { x: .06, y: .44, w: .56, h: .52 }, subject: { x: .64, y: .07, w: .34, h: .44 }, badge: 'box' },
      titleWeight: 900, titleTracking: -0.045, lineHeight: 0.94, kicker: 'TYPE POSTER',
      kickerStyle: 'mono',
      frame: { kind: 'none' },
      deco: [
        { kind: 'number', text: '01', x: .97, y: .34, size: .38, color: 'line', alpha: .5, align: 'right' },
        { kind: 'label', text: 'TYPE POSTER / 2026', x: .06, y: .05, size: .0118, color: 'sub', tracking: .3 },
        { kind: 'rule', x: .06, y: .4, w: .26, h: .005, color: 'accent' },
        { kind: 'rule', x: .06, y: .965, w: .88, h: .0014, color: 'line' }
      ],
      scrim: 'strong',
      preview: { shape: 'left', accentBar: 'top' }
    },
    {
      id: 'monochrome', name: '모노크롬', short: '모노', tag: '흑백 · 하이라인',
      cat: 'editorial',
      dark: false, texture: 'mono',
      palette: { bg: '#EDEDEA', surface: '#FFFFFF', ink: '#0D0D0D', sub: '#4F4F4F', line: '#CFCFC9', accent: '#262626', accentSoft: '#DEDED8' },
      layout: { align: 'left', text: { x: .08, y: .5, w: .44, h: .42 }, subject: { x: .55, y: .1, w: .4, h: .8 }, badge: 'line' },
      titleWeight: 600, titleTracking: 0.005, lineHeight: 1.1, kicker: 'MONO / 002',
      kickerStyle: 'mono',
      frame: { kind: 'hairline', pad: .018, lineW: .0014, color: 'ink', alpha: .35 },
      deco: [
        { kind: 'frame', inset: .038, lineW: .0012, color: 'line' },
        { kind: 'label', text: 'MONO / 002', x: .08, y: .07, size: .0118, color: 'sub', tracking: .24 },
        { kind: 'rule', x: .08, y: .475, w: .2, h: .0016, color: 'ink', alpha: .55 }
      ],
      scrim: 'strong',
      preview: { shape: 'left', accentBar: 'bottom' }
    },
    {
      id: 'hanji', name: '한지 크래프트', short: '한지', tag: '한지 · 수묵 · 낙관',
      cat: 'editorial',
      dark: false, texture: 'hanji',
      palette: { bg: '#EFE6D2', surface: '#FBF6E9', ink: '#2A2117', sub: '#6B5B45', line: '#D8C9AE', accent: '#A8201A', accentSoft: '#F3DCD3' },
      layout: { align: 'left', text: { x: .08, y: .52, w: .44, h: .4 }, subject: { x: .54, y: .1, w: .4, h: .78 }, badge: 'seal' },
      titleWeight: 700, titleTracking: -0.012, lineHeight: 1.18, kicker: 'HANJI EDITION',
      kickerStyle: 'rule',
      frame: { kind: 'panel', pad: .022, fill: '#FBF6E9', radius: .008, border: .0018, shadow: .16 },
      deco: [
        { kind: 'brush', x: .08, y: .452, w: .22, h: .014, color: 'ink', alpha: .55 },
        { kind: 'stamp', text: '印', cx: .9, cy: .88, r: .048, color: 'accent', textColor: '#FBF6E9', rotate: -0.06 },
        { kind: 'label', text: '한지 · 수묵 에디션', x: .08, y: .06, size: .0122, color: 'sub', tracking: .08 }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'none', seal: true }
    },
    {
      id: 'neon', name: '다크 네온', short: '네온', tag: '글로우 · 임팩트',
      cat: 'media',
      ref: 'dark-neon', dark: true, texture: 'glow',
      palette: { bg: '#0B0D14', surface: '#12151F', ink: '#F5F7FF', sub: '#A9B1C6', line: '#2A3040', accent: '#39E6FF', accentSoft: '#123642' },
      layout: { align: 'left', text: { x: .07, y: .5, w: .6, h: .4 }, subject: { x: .5, y: .07, w: .46, h: .86 }, badge: 'pill' },
      titleWeight: 800, titleTracking: -0.03, lineHeight: 0.99, kicker: 'NIGHT SIGNAL',
      kickerStyle: 'plain',
      frame: { kind: 'none' },
      deco: [
        { kind: 'rule', x: .07, y: .44, w: .4, h: .0028, color: 'accent', glow: true },
        { kind: 'brackets', inset: .05, len: .03, lineW: .0016, color: 'ink', alpha: .35 },
        { kind: 'label', text: 'NIGHT SIGNAL', x: .07, y: .4, size: .0118, color: 'accent', tracking: .26 }
      ],
      scrim: 'strong',
      preview: { shape: 'left', accentBar: 'bottom', dark: true }
    },
    {
      id: 'cyber', name: '사이버 HUD', short: '사이버', tag: '스캔 · 모 노 · 브래킷',
      cat: 'media',
      dark: true, texture: 'scan',
      palette: { bg: '#050A12', surface: '#0B1520', ink: '#E6F7FF', sub: '#8FA9BF', line: '#1B3346', accent: '#38F2C0', accentSoft: '#0C2A28' },
      layout: { align: 'left', text: { x: .07, y: .46, w: .58, h: .44 }, subject: { x: .55, y: .08, w: .4, h: .84 }, badge: 'box' },
      titleWeight: 800, titleTracking: -0.02, lineHeight: 1.0, kicker: 'SYS // 04',
      kickerStyle: 'mono',
      frame: { kind: 'hairline', pad: .012, lineW: .0018, color: 'accent', alpha: .45 },
      deco: [
        { kind: 'brackets', inset: .045, len: .045, lineW: .002, color: 'accent', alpha: .8 },
        { kind: 'ticks', inset: .03, len: .012, lineW: .0012, color: 'ink', alpha: .3 },
        { kind: 'label', text: 'SYS // 04  ·  SCAN OK', x: .07, y: .07, size: .0112, color: 'accent', tracking: .22 },
        { kind: 'rule', x: .07, y: .41, w: .3, h: .0018, color: 'accent', alpha: .7 }
      ],
      scrim: 'strong',
      preview: { shape: 'left', accentBar: 'top', dark: true }
    },
    {
      id: 'newsflash', name: '뉴스 속보', short: '뉴스', tag: '속보 · 괘선 · 띠',
      cat: 'media',
      dark: false, texture: 'news',
      palette: { bg: '#FFFFFF', surface: '#F4F4F2', ink: '#0A0A0A', sub: '#4A4A4A', line: '#D6D6D6', accent: '#D0021B', accentSoft: '#FBE3E3' },
      layout: { align: 'left', text: { x: .06, y: .2, w: .5, h: .4 }, subject: { x: .52, y: .3, w: .44, h: .64 }, badge: 'bar' },
      titleWeight: 800, titleTracking: -0.03, lineHeight: 1.06, kicker: 'BREAKING',
      kickerStyle: 'box',
      frame: { kind: 'none' },
      deco: [
        { kind: 'bar', x: 0, y: 0, w: 1, h: .07, color: 'ink' },
        { kind: 'label', text: 'BREAKING NEWS', x: .06, y: .021, size: .0135, color: 'surface', tracking: .18, weight: 800 },
        { kind: 'bar', x: .06, y: .185, w: .12, h: .012, color: 'accent' },
        { kind: 'rule', x: .06, y: .93, w: .88, h: .002, color: 'ink' },
        { kind: 'rule', x: .06, y: .955, w: .88, h: .001, color: 'line' }
      ],
      scrim: 'strong',
      preview: { shape: 'left', accentBar: 'top', news: true }
    },
    {
      id: 'filmnoir', name: '필름 누아르', short: '누아르', tag: '레터박스 · 그레인',
      cat: 'retro',
      dark: true, texture: 'film',
      palette: { bg: '#14100C', surface: '#241D16', ink: '#F3E9DA', sub: '#B9A88F', line: '#3A2F24', accent: '#E8B45C', accentSoft: '#3A2C18' },
      layout: { align: 'left', text: { x: .09, y: .5, w: .44, h: .34 }, subject: { x: .54, y: .09, w: .38, h: .74 }, badge: 'line' },
      titleWeight: 600, titleTracking: 0.002, lineHeight: 1.14, kicker: '35MM / 1.85:1',
      kickerStyle: 'mono',
      frame: { kind: 'film', pad: .022, border: .009, fill: '#F3E9DA' },
      deco: [
        { kind: 'bar', x: 0, y: 0, w: 1, h: .062, color: '#080604' },
        { kind: 'bar', x: 0, y: .938, w: 1, h: .062, color: '#080604' },
        { kind: 'label', text: '35MM · 1.85:1', x: .09, y: .022, size: .0108, color: 'sub', tracking: .22 },
        { kind: 'label', text: 'TAKE 07 / SCENE 2', x: .91, y: .022, size: .0108, color: 'sub', tracking: .18, align: 'right' },
        { kind: 'rule', x: .09, y: .455, w: .2, h: .0016, color: 'accent', alpha: .8 }
      ],
      scrim: 'strong',
      preview: { shape: 'left', accentBar: 'none', dark: true, film: true }
    },
    {
      id: 'retroprint', name: '레트로 인쇄', short: '레트로', tag: '할프톤 · 리소',
      cat: 'retro',
      dark: false, texture: 'halftone',
      palette: { bg: '#F1E4C8', surface: '#FBF2DF', ink: '#1F2B29', sub: '#5A6862', line: '#D9C7A2', accent: '#D2543A', accentSoft: '#F6DDD2' },
      layout: { align: 'left', text: { x: .07, y: .12, w: .48, h: .34 }, subject: { x: .5, y: .4, w: .46, h: .56 }, badge: 'sticker' },
      titleWeight: 800, titleTracking: -0.03, lineHeight: 1.04, kicker: 'RISO 02',
      kickerStyle: 'mono',
      frame: { kind: 'panel', pad: .014, fill: '#FBF2DF', radius: .006, border: .0022, shadow: .18 },
      deco: [
        { kind: 'dots', x: .74, y: .04, w: .22, h: .18, gap: .018, r: .0042, color: 'accent', alpha: .5 },
        { kind: 'circle', cx: .12, cy: .86, r: .07, color: '#1F6E6A', alpha: .22, fill: true },
        { kind: 'label', text: 'RISO 02 / SPOT', x: .07, y: .06, size: .0115, color: 'sub', tracking: .2 },
        { kind: 'rule', x: .07, y: .965, w: .86, h: .0016, color: 'accent', alpha: .55 }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'top', dots: true }
    },
    {
      id: 'vivid', name: '비비드 팝', short: '비비드', tag: '색 블록 · 스티커',
      cat: 'graphic',
      ref: 'vivid-pop', dark: false, texture: 'blocks',
      palette: { bg: '#FFE24B', surface: '#FFFFFF', ink: '#16130B', sub: '#5A4E16', line: '#E8C837', accent: '#1F4BFF', accentSoft: '#DCE3FF' },
      layout: { align: 'left', text: { x: .07, y: .08, w: .42, h: .28 }, subject: { x: .43, y: .34, w: .53, h: .6 }, badge: 'sticker' },
      titleWeight: 800, titleTracking: -0.04, lineHeight: 1.02, kicker: 'POP PICK',
      kickerStyle: 'plain',
      frame: { kind: 'offset', pad: .02, border: .005, offset: .01, fill: '#FFFFFF' },
      deco: [
        { kind: 'number', text: 'NEW', x: .88, y: .06, size: .045, color: 'ink', alpha: .9, align: 'center', rotate: -0.14, box: true },
        { kind: 'dots', x: .04, y: .74, w: .18, h: .18, gap: .016, r: .004, color: 'ink', alpha: .3 },
        { kind: 'bar', x: 0, y: .93, w: 1, h: .07, color: 'ink' }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'bottom', pop: true }
    },
    {
      id: 'brutal', name: '네오 브루탈', short: '브루탈', tag: '하드 섀도 · 형광',
      cat: 'graphic',
      ref: 'neo-brutalism', dark: false, texture: 'brutal',
      palette: { bg: '#FFFDF2', surface: '#FFFFFF', ink: '#000000', sub: '#474747', line: '#000000', accent: '#C6F432', accentSoft: '#EEFBC0' },
      layout: { align: 'left', text: { x: .06, y: .55, w: .7, h: .38 }, subject: { x: .29, y: .05, w: .44, h: .42 }, badge: 'sticker' },
      titleWeight: 900, titleTracking: -0.04, lineHeight: 0.98, kicker: 'NO.01',
      kickerStyle: 'box',
      frame: { kind: 'offset', pad: .018, border: .0045, offset: .012, fill: '#FFFFFF' },
      deco: [
        { kind: 'frame', inset: .028, lineW: .004, color: 'ink' },
        { kind: 'bar', x: .06, y: .49, w: .22, h: .02, color: 'accent' },
        { kind: 'label', text: 'NO.01 / RAW', x: .06, y: .045, size: .0118, color: 'ink', tracking: .18, weight: 800 }
      ],
      scrim: 'strong',
      preview: { shape: 'left', accentBar: 'top', brutal: true }
    },
    {
      id: 'collage', name: '콜라주 컷', short: '콜라주', tag: '찢은 종이 · 테이프',
      cat: 'graphic',
      dark: false, texture: 'collage',
      palette: { bg: '#F0EBE1', surface: '#FFFDF8', ink: '#1C1A16', sub: '#5C564B', line: '#D5CEC0', accent: '#E4572E', accentSoft: '#FADFD6' },
      layout: { align: 'left', text: { x: .06, y: .52, w: .43, h: .42 }, subject: { x: .56, y: .08, w: .4, h: .76 }, badge: 'sticker' },
      titleWeight: 800, titleTracking: -0.025, lineHeight: 1.04, kicker: 'CUT & PASTE',
      kickerStyle: 'mono',
      frame: { kind: 'polaroid', pad: .028, fill: '#FFFDF8', shadow: .3, rotate: -0.028 },
      deco: [
        { kind: 'tape', x: .54, y: .05, w: .12, h: .04, angle: -0.16, color: '#E8D9B8', alpha: .9 },
        { kind: 'tape', x: .82, y: .8, w: .1, h: .034, angle: 0.22, color: '#E8D9B8', alpha: .8 },
        { kind: 'label', text: 'CUT & PASTE / 03', x: .06, y: .06, size: .0118, color: 'sub', tracking: .2 },
        { kind: 'brush', x: .06, y: .48, w: .26, h: .016, color: 'accent', alpha: .8 }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'none', collage: true }
    },
    {
      id: 'bento', name: '벤토 그리드', short: '벤토', tag: '카드 · 라운딩',
      cat: 'graphic',
      ref: 'bento-saas', dark: false, texture: 'bento',
      palette: { bg: '#EFF1F6', surface: '#FFFFFF', ink: '#0B1020', sub: '#4E5568', line: '#DDE2EA', accent: '#4338CA', accentSoft: '#EDECFB' },
      layout: { align: 'left', text: { x: .06, y: .06, w: .42, h: .3 }, subject: { x: .51, y: .3, w: .45, h: .64 }, badge: 'pill' },
      titleWeight: 800, titleTracking: -0.035, lineHeight: 1.06, kicker: 'BENTO / 01',
      kickerStyle: 'plain',
      frame: { kind: 'panel', pad: .016, fill: '#FFFFFF', radius: .024, border: .0012, shadow: .18 },
      deco: [
        { kind: 'panel', x: .06, y: .4, w: .4, h: .13, radius: .018, color: 'surface', alpha: .9, border: true },
        { kind: 'panel', x: .06, y: .56, w: .4, h: .13, radius: .018, color: 'surface', alpha: .9, border: true },
        { kind: 'label', text: 'BENTO / 01', x: .06, y: .42, size: .0105, color: 'sub', tracking: .16 },
        { kind: 'label', text: '▦  4 CARDS', x: .06, y: .58, size: .0105, color: 'accent', tracking: .1 },
        { kind: 'label', text: '24px GUTTER', x: .06, y: .74, size: .0098, color: 'sub', tracking: .12 }
      ],
      scrim: 'soft',
      preview: { shape: 'card', accentBar: 'none', bento: true }
    },
    {
      id: 'minimal', name: '미니멀 럭셔리', short: '미니멀', tag: '여백 · 얇은 선',
      cat: 'luxe',
      ref: 'minimal-luxury', dark: false, texture: 'none',
      palette: { bg: '#F6F3EC', surface: '#FFFFFF', ink: '#1E1B16', sub: '#6E675C', line: '#D9D2C4', accent: '#8A6B3F', accentSoft: '#EDE5D6' },
      layout: { align: 'center', text: { x: .12, y: .62, w: .76, h: .28 }, subject: { x: .24, y: .12, w: .52, h: .45 }, badge: 'line' },
      titleWeight: 600, titleTracking: 0.02, lineHeight: 1.3, kicker: 'LESS, BUT BETTER',
      kickerStyle: 'rule',
      frame: { kind: 'none' },
      deco: [
        { kind: 'frame', inset: .045, lineW: .0009, color: 'line' },
        { kind: 'circle', cx: .78, cy: .36, r: .265, color: 'surface', alpha: .55, fill: true },
        { kind: 'circle', cx: .78, cy: .36, r: .265, color: 'line', alpha: .5, fill: false, lineW: .0008 },
        { kind: 'circle', cx: .5, cy: .585, r: .0035, color: 'accent', alpha: .9, fill: true }
      ],
      scrim: 'soft',
      preview: { shape: 'center', accentBar: 'none' }
    },
    {
      id: 'darkluxe', name: '블랙 골드', short: '블랙골드', tag: '골드 헤어라인',
      cat: 'luxe',
      dark: true, texture: 'darkgold',
      palette: { bg: '#0C0B09', surface: '#15130F', ink: '#F7F1E3', sub: '#B5A88F', line: '#2B2620', accent: '#D8B26A', accentSoft: '#2A2318' },
      layout: { align: 'left', text: { x: .09, y: .55, w: .52, h: .34 }, subject: { x: .52, y: .1, w: .4, h: .78 }, badge: 'line' },
      titleWeight: 600, titleTracking: 0.01, lineHeight: 1.22, kicker: 'PRIVATE EDITION',
      kickerStyle: 'rule',
      frame: { kind: 'hairline', pad: .022, lineW: .001, color: 'accent', alpha: .45 },
      deco: [
        { kind: 'frame', inset: .05, lineW: .0009, color: 'accent', alpha: .35 },
        { kind: 'label', text: 'PRIVATE EDITION', x: .09, y: .075, size: .0108, color: 'accent', tracking: .3 },
        { kind: 'rule', x: .09, y: .505, w: .18, h: .0014, color: 'accent', alpha: .8 }
      ],
      scrim: 'strong',
      preview: { shape: 'left', accentBar: 'none', dark: true, gold: true }
    },
    {
      id: 'glass', name: '글래스 모피즘', short: '글래스', tag: '메시 · 프로스트',
      cat: 'graphic',
      dark: false, texture: 'mesh',
      palette: { bg: '#E8ECFF', surface: '#FFFFFF', ink: '#14162B', sub: '#4C5170', line: '#C9D0E8', accent: '#5B4BFF', accentSoft: '#E4E1FF' },
      layout: { align: 'left', text: { x: .07, y: .52, w: .45, h: .4 }, subject: { x: .55, y: .12, w: .39, h: .76 }, badge: 'pill' },
      titleWeight: 800, titleTracking: -0.03, lineHeight: 1.06, kicker: 'GLASS / UI',
      kickerStyle: 'plain',
      frame: { kind: 'glass', pad: .02, radius: .024 },
      deco: [
        { kind: 'glasspanel', x: .055, y: .46, w: .56, h: .47, radius: .03, alpha: .42 },
        { kind: 'blob', cx: .82, cy: .2, r: .3, color: '#9B8CFF', alpha: .35 },
        { kind: 'blob', cx: .12, cy: .88, r: .26, color: '#7ED8FF', alpha: .3 },
        { kind: 'label', text: 'GLASS / UI', x: .07, y: .075, size: .0112, color: 'sub', tracking: .24 }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'none', glass: true }
    },
    {
      id: 'pastel', name: '파스텔 클린', short: '파스텔', tag: '소프트 블롭',
      cat: 'graphic',
      dark: false, texture: 'blob',
      palette: { bg: '#FDF1F4', surface: '#FFFFFF', ink: '#2A2230', sub: '#6A5F72', line: '#EBD9E2', accent: '#C4407A', accentSoft: '#FBE3ED' },
      layout: { align: 'left', text: { x: .08, y: .5, w: .46, h: .42 }, subject: { x: .56, y: .1, w: .38, h: .8 }, badge: 'pill' },
      titleWeight: 700, titleTracking: -0.02, lineHeight: 1.16, kicker: 'SOFT MODE',
      kickerStyle: 'plain',
      frame: { kind: 'panel', pad: .014, fill: '#FFFFFF', radius: .03, border: .0012, shadow: .12 },
      deco: [
        { kind: 'blob', cx: .18, cy: .16, r: .3, color: '#FFC9DE', alpha: .55 },
        { kind: 'blob', cx: .86, cy: .82, r: .3, color: '#C9D8FF', alpha: .45 },
        { kind: 'label', text: 'SOFT MODE', x: .08, y: .06, size: .0112, color: 'sub', tracking: .22 }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'none', pastel: true }
    },
    {
      id: 'retail', name: '커머스 클린', short: '커머스', tag: '제품 중심 · 혜택 칩',
      cat: 'commerce',
      ref: 'commerce-clean', dark: false, texture: 'soft',
      palette: { bg: '#F7F8FA', surface: '#FFFFFF', ink: '#101418', sub: '#5A6373', line: '#E2E6EC', accent: '#E0322B', accentSoft: '#FDECEA' },
      layout: { align: 'center', text: { x: .06, y: .05, w: .88, h: .27 }, subject: { x: .24, y: .34, w: .52, h: .52 }, badge: 'pill' },
      titleWeight: 800, titleTracking: -0.03, lineHeight: 1.1, kicker: '오늘의 특가',
      kickerStyle: 'plain',
      frame: { kind: 'none' },
      deco: [
        { kind: 'circle', cx: .5, cy: .58, r: .3, color: 'accent', alpha: .06, fill: true },
        { kind: 'bar', x: .44, y: .255, w: .12, h: .006, color: 'accent' },
        { kind: 'panel', x: .06, y: .9, w: .88, h: .075, radius: .012, color: 'surface', alpha: .85, border: true },
        { kind: 'label', text: '무료배송 · 오늘 출발', x: .5, y: .928, size: .0135, color: 'ink', tracking: .02, align: 'center' }
      ],
      scrim: 'soft',
      preview: { shape: 'center', accentBar: 'none', retail: true }
    },
    {
      id: 'sale', name: '세일 임팩트', short: '세일', tag: '그라데이션 · 가격',
      cat: 'commerce',
      dark: false, texture: 'gradient',
      palette: { bg: '#FFF3EC', surface: '#FFFFFF', ink: '#1B0E08', sub: '#5C4033', line: '#F0D6C6', accent: '#E8340C', accentSoft: '#FFE1D6' },
      layout: { align: 'left', text: { x: .06, y: .14, w: .5, h: .42 }, subject: { x: .56, y: .34, w: .42, h: .6 }, badge: 'sticker' },
      titleWeight: 900, titleTracking: -0.04, lineHeight: 0.98, kicker: 'LIMITED',
      kickerStyle: 'box',
      frame: { kind: 'none' },
      deco: [
        { kind: 'gradient', x: .62, y: 0, w: .38, h: 1, from: 'accent', to: '#FF8A00', alpha: .92, angle: -0.35 },
        { kind: 'circle', cx: .855, cy: .15, r: .075, color: '#FFFFFF', alpha: .95, fill: true },
        { kind: 'label', text: 'SALE', x: .855, y: .141, size: .023, color: 'accent', tracking: .02, align: 'center', weight: 900 },
        { kind: 'label', text: 'LIMITED / TODAY', x: .06, y: .07, size: .0118, color: 'sub', tracking: .24 }
      ],
      scrim: 'soft',
      preview: { shape: 'left', accentBar: 'bottom', sale: true }
    }
  ];
  function themeById(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return THEMES[0];
  }
  function themesByCategory(cat) {
    if (!cat || cat === 'all') return THEMES.slice();
    var found = false;
    for (var i = 0; i < THEME_CATEGORIES.length; i++) if (THEME_CATEGORIES[i].id === cat) found = true;
    if (!found) return THEMES.slice();
    return THEMES.filter(function (t) { return t.cat === cat; });
  }
  function themeCategoryName(id) {
    for (var i = 0; i < THEME_CATEGORIES.length; i++) if (THEME_CATEGORIES[i].id === id) return THEME_CATEGORIES[i].name;
    return '전체';
  }

  /* ══════════════════════════════════════════════════════
     레퍼런스 벤치마킹 엔진
     · 유튜브 URL → 영상 ID → 공식 썸네일 목록
     · 레퍼런스 픽셀 → 팔레트 · 톤 · 구조(레이아웃) 분석
     · 분석값 → 테마 매칭 · 브랜드 프리셋 · 프롬프트 힌트
     DOM에 닿지 않는 순수 함수만 둔다(node 테스트 가능).
     ══════════════════════════════════════════════════════ */

  function lumaOf(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
  function lumaOfHex(hex) { var c = hexToRgb(hex); return lumaOf(c.r, c.g, c.b); }
  function hsvOf(r, g, b) {
    var rr = r / 255, gg = g / 255, bb = b / 255;
    var max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
    var d = max - min, h = 0;
    if (d > 0.00001) {
      if (max === rr) h = ((gg - bb) / d) % 6;
      else if (max === gg) h = (bb - rr) / d + 2;
      else h = (rr - gg) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: round(h, 1), s: round(max === 0 ? 0 : d / max, 4), v: round(max, 4) };
  }
  function hsvOfHex(hex) { var c = hexToRgb(hex); return hsvOf(c.r, c.g, c.b); }
  function hueDistance(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* ── 유튜브 링크 → 영상 ID ────────────────────────── */
  function parseYouTubeUrl(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return { ok: false, reason: '링크를 입력하세요.' };
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
      return { ok: true, id: raw, kind: 'id', normalized: 'https://www.youtube.com/watch?v=' + raw };
    }
    var url;
    try {
      url = new URL(raw.indexOf('//') < 0 ? 'https://' + raw : raw);
    } catch (e) {
      return { ok: false, reason: '주소 형식을 읽지 못했습니다. youtube.com/watch?v=… 형태로 넣어 주세요.' };
    }
    var host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '').replace(/^music\./, '');
    var id = '', kind = 'watch';
    if (host === 'youtu.be') {
      id = (url.pathname.split('/').filter(Boolean)[0] || '');
      kind = 'short';
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      var parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'watch') { id = url.searchParams.get('v') || ''; kind = 'watch'; }
      else if (parts[0] === 'shorts') { id = parts[1] || ''; kind = 'shorts'; }
      else if (parts[0] === 'embed') { id = parts[1] || ''; kind = 'embed'; }
      else if (parts[0] === 'live') { id = parts[1] || ''; kind = 'live'; }
      else if (parts[0] === 'v') { id = parts[1] || ''; kind = 'v'; }
      else if (parts[0] === 'playlist') {
        return { ok: false, reason: '재생목록 주소는 썸네일을 하나로 고를 수 없습니다. 영상 주소를 넣어 주세요.' };
      }
    } else {
      return { ok: false, reason: '유튜브 주소가 아닙니다. (youtube.com · youtu.be)' };
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
      return { ok: false, reason: '영상 ID(11자리)를 찾지 못했습니다. 링크를 다시 확인하세요.' };
    }
    return {
      ok: true, id: id, kind: kind,
      normalized: 'https://www.youtube.com/watch?v=' + id,
      embed: 'https://www.youtube.com/embed/' + id
    };
  }

  /** 공식 썸네일 후보 — 화질 높은 순. maxres가 없으면 hq로 떨어진다. */
  function youtubeThumbs(id) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ''))) return [];
    return [
      { name: 'maxres', label: '고화질 1280×720', w: 1280, h: 720, url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' },
      { name: 'sd', label: '표준 640×480', w: 640, h: 480, url: 'https://i.ytimg.com/vi/' + id + '/sddefault.jpg' },
      { name: 'hq', label: '기본 480×360', w: 480, h: 360, url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' },
      { name: 'mq', label: '저화질 320×180', w: 320, h: 180, url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' }
    ];
  }
  function youtubeThumbUrl(id, name) {
    var list = youtubeThumbs(id);
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i].url;
    return list.length ? list[0].url : '';
  }

  /* ── 색 양자화 ───────────────────────────────────── */
  /** 5비트 버킷 → 비슷한 색 병합. 픽셀을 고르게 샘플링하므로 큰 이미지도 빠르다. */
  function quantizeColors(rgba, w, h, opts) {
    var o = opts || {};
    var limit = o.limit || 14;
    var step = Math.max(1, Math.round(Math.sqrt((w * h) / 26000)));
    var map = Object.create(null);
    var total = 0, x, y;
    for (y = 0; y < h; y += step) {
      for (x = 0; x < w; x += step) {
        var i = (y * w + x) * 4;
        if (rgba[i + 3] < 40) continue;
        var r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        var e = map[key];
        if (!e) { e = map[key] = { sr: 0, sg: 0, sb: 0, n: 0 }; }
        e.sr += r; e.sg += g; e.sb += b; e.n++;
        total++;
      }
    }
    var list = Object.keys(map).map(function (k) {
      var e = map[k];
      return { r: e.sr / e.n, g: e.sg / e.n, b: e.sb / e.n, n: e.n };
    });
    list.sort(function (a, b) { return b.n - a.n; });

    var merged = [];
    list.forEach(function (e) {
      for (var i = 0; i < merged.length; i++) {
        var m = merged[i];
        if (distRgb(e, m) < 20) {
          var n = m.n + e.n;
          m.r = (m.r * m.n + e.r * e.n) / n;
          m.g = (m.g * m.n + e.g * e.n) / n;
          m.b = (m.b * m.n + e.b * e.n) / n;
          m.n = n;
          return;
        }
      }
      merged.push({ r: e.r, g: e.g, b: e.b, n: e.n });
    });
    merged.sort(function (a, b) { return b.n - a.n; });

    return merged.slice(0, limit).map(function (m) {
      return {
        hex: rgbToHex(m.r, m.g, m.b).toUpperCase(),
        r: round(m.r, 1), g: round(m.g, 1), b: round(m.b, 1),
        share: round(m.n / Math.max(1, total), 4),
        luma: round(lumaOf(m.r, m.g, m.b), 4),
        hsv: hsvOf(m.r, m.g, m.b)
      };
    });
  }

  /* ── 명암 지도 / 구조 판독 ───────────────────────── */
  function lumaGrid(rgba, w, h, GW, GH) {
    var grid = new Float32Array(GW * GH);
    var counts = new Float32Array(GW * GH);
    var step = Math.max(1, Math.round(Math.sqrt((w * h) / 32000)));
    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        var i = (y * w + x) * 4;
        if (rgba[i + 3] < 40) continue;
        var gx = Math.min(GW - 1, Math.floor(x / w * GW));
        var gy = Math.min(GH - 1, Math.floor(y / h * GH));
        grid[gy * GW + gx] += lumaOf(rgba[i], rgba[i + 1], rgba[i + 2]);
        counts[gy * GW + gx]++;
      }
    }
    for (var k = 0; k < grid.length; k++) if (counts[k]) grid[k] /= counts[k];
    return grid;
  }

  /** 이웃 밝기 차 = 디테일 에너지. 글자·피사체 경계가 많은 곳이 높다. */
  function energyGrid(grid, GW, GH) {
    var e = new Float32Array(GW * GH);
    for (var y = 1; y < GH - 1; y++) {
      for (var x = 1; x < GW - 1; x++) {
        var i = y * GW + x;
        var dx = Math.abs(grid[i + 1] - grid[i - 1]);
        var dy = Math.abs(grid[i + GW] - grid[i - GW]);
        e[i] = dx + dy;
      }
    }
    return e;
  }

  function boxMean(grid, GW, GH, x0, x1, y0, y1) {
    var sum = 0, n = 0;
    var ax = Math.max(0, Math.floor(x0 * GW)), bx = Math.min(GW, Math.ceil(x1 * GW));
    var ay = Math.max(0, Math.floor(y0 * GH)), by = Math.min(GH, Math.ceil(y1 * GH));
    for (var y = ay; y < by; y++) {
      for (var x = ax; x < bx; x++) { sum += grid[y * GW + x]; n++; }
    }
    return n ? sum / n : 0;
  }

  var STRUCTURES = {
    left: { label: '좌측 텍스트 · 우측 피사체', align: 'left', text: { x: .06, y: .5, w: .52, h: .42 }, subject: { x: .54, y: .1, w: .4, h: .8 } },
    right: { label: '우측 텍스트 · 좌측 피사체', align: 'left', text: { x: .44, y: .5, w: .5, h: .42 }, subject: { x: .06, y: .1, w: .4, h: .8 } },
    center: { label: '중앙 집중형', align: 'center', text: { x: .1, y: .58, w: .8, h: .34 }, subject: { x: .22, y: .06, w: .56, h: .5 } },
    'bottom-bar': { label: '하단 바 · 상단 이미지', align: 'left', text: { x: .06, y: .7, w: .88, h: .24 }, subject: { x: .2, y: .05, w: .6, h: .62 } },
    split: { label: '상하 분할', align: 'left', text: { x: .07, y: .08, w: .86, h: .34 }, subject: { x: .22, y: .44, w: .56, h: .5 } },
    grid: { label: '그리드 분산', align: 'left', text: { x: .07, y: .62, w: .46, h: .3 }, subject: { x: .55, y: .1, w: .38, h: .5 } }
  };

  /** 레이아웃 구조 판독 — 텍스트가 몰린 쪽(디테일 많은 쪽)을 찾는다. */
  function referenceStructure(rgba, w, h) {
    var GW = 48, GH = 48;
    var g = lumaGrid(rgba, w, h, GW, GH);
    var e = energyGrid(g, GW, GH);
    var eL = boxMean(e, GW, GH, .03, .37, .08, .92);
    var eM = boxMean(e, GW, GH, .35, .65, .08, .92);
    var eR = boxMean(e, GW, GH, .63, .97, .08, .92);
    var eBottom = boxMean(e, GW, GH, .04, .96, .79, .97);
    var eUpper = boxMean(e, GW, GH, .04, .96, .1, .72);
    var eMid = boxMean(e, GW, GH, .04, .96, .3, .7);
    var eTop = boxMean(e, GW, GH, .04, .96, .03, .34);
    var eLower = boxMean(e, GW, GH, .04, .96, .44, .8);
    // 하단 띠가 화면 폭 전체에 걸쳐 있는지 — 한쪽에 몰린 글자는 띠가 아니다.
    var bandThirds = [
      boxMean(e, GW, GH, .04, .36, .79, .97),
      boxMean(e, GW, GH, .36, .64, .79, .97),
      boxMean(e, GW, GH, .64, .96, .79, .97)
    ];
    var bandCoverage = bandThirds.filter(function (v) { return v > eMid * 1.25; }).length;
    var lBottom = boxMean(g, GW, GH, .04, .96, .79, .97);
    var lUpper = boxMean(g, GW, GH, .04, .96, .1, .72);
    var lTop = boxMean(g, GW, GH, .04, .96, .03, .34);
    var lLower = boxMean(g, GW, GH, .04, .96, .44, .8);

    var maxH = Math.max(eL, eM, eR, 1e-6);
    var type = 'grid', conf = 0.42, why = '';

    var bottomBar = (eBottom > eUpper * 1.2 && eBottom > eMid * 1.18) &&
      ((Math.abs(lBottom - lUpper) > 0.06 && bandCoverage >= 2) || (bandCoverage >= 2 && eBottom > eMid * 1.6));
    var split = (eTop > eLower * 1.22 && Math.abs(lTop - lLower) > 0.075) || eTop > eLower * 1.85;

    if (bottomBar) {
      type = 'bottom-bar';
      conf = clamp(0.55 + (eBottom / (eUpper + 1e-6) - 1.2) * 0.35, 0.5, 0.96);
      why = '하단 띠의 디테일·명암이 위쪽과 뚜렷하게 다릅니다';
    } else if (split && eTop > eLower * 1.18) {
      type = 'split';
      conf = clamp(0.52 + (eTop / (eLower + 1e-6) - 1.2) * 0.35, 0.5, 0.95);
      why = '위/아래 절반의 구성이 분리되어 있습니다';
    } else if (eM > Math.max(eL, eR) * 1.22) {
      type = 'center';
      conf = clamp(0.5 + (eM / (Math.max(eL, eR) + 1e-6) - 1.2) * 0.4, 0.45, 0.95);
      why = '가운데에 요소가 몰려 있습니다';
    } else if (eL > eR * 1.18 || eR > eL * 1.18) {
      type = eL > eR ? 'left' : 'right';
      conf = clamp(0.5 + Math.abs(eL - eR) / (maxH + 1e-6) * 0.9, 0.45, 0.95);
      why = (type === 'left' ? '왼쪽' : '오른쪽') + '에 텍스트·요소가 몰려 있습니다';
    } else {
      type = 'grid';
      conf = 0.4;
      why = '요소가 고르게 퍼져 있어 격자형으로 읽었습니다';
    }
    var s = STRUCTURES[type];
    return {
      type: type, label: s.label, align: s.align, why: why,
      confidence: round(conf, 2),
      text: s.text, subject: s.subject,
      regions: {
        left: round(eL, 3), center: round(eM, 3), right: round(eR, 3),
        top: round(eTop, 3), bottom: round(eBottom, 3),
        lumaTop: round(lTop, 3), lumaBottom: round(lBottom, 3)
      }
    };
  }

  /** 레퍼런스 이미지 픽셀 전체 분석. */
  function analyzeReference(rgba, w, h, opts) {
    var o = opts || {};
    if (!rgba || !w || !h) throw new Error('분석할 이미지가 없습니다.');
    var valid = validateReferenceImage(w, h);
    if (!valid.ok) throw new Error(valid.reason);
    var colors = quantizeColors(rgba, w, h, { limit: 14 });
    if (!colors.length) throw new Error('이미지에서 색을 읽지 못했습니다.');

    var edge = sampleEdgeColors(rgba, w, h);
    var bg = edge.dominant || '#FFFFFF';
    // 큰 어두운 면(다크 배경 + 밝은 피사체 블록)이 있으면 그쪽을 배경으로 본다.
    var topColor = colors[0];
    if (topColor && topColor.luma > 0.5) {
      var darkMass = null;
      colors.forEach(function (c) {
        if (c.luma < 0.24 && c.share >= 0.28 && (!darkMass || c.share > darkMass.share)) darkMass = c;
      });
      if (darkMass) bg = darkMass.hex;
    }
    var bgLuma = lumaOfHex(bg);

    var darkest = colors[0], lightest = colors[0];
    colors.forEach(function (c) {
      if (c.luma < darkest.luma) darkest = c;
      if (c.luma > lightest.luma) lightest = c;
    });
    var ink = contrastRatio(bg, darkest.hex) >= contrastRatio(bg, lightest.hex) ? darkest.hex : lightest.hex;
    if (contrastRatio(bg, ink) < 4.5) ink = bgLuma > 0.5 ? '#111111' : '#FFFFFF';

    // 포인트색 — 배경·글자와 충분히 떨어진, 채도와 점유율이 높은 색
    var accent = null, bestScore = 0;
    colors.forEach(function (c) {
      if (c.hsv.s < 0.16 || c.share < 0.002) return;
      if (distRgb({ r: c.r, g: c.g, b: c.b }, hexToRgb(bg)) < 32) return;
      if (distRgb({ r: c.r, g: c.g, b: c.b }, hexToRgb(ink)) < 42) return;
      var score = Math.pow(c.hsv.s, 1.1) * (0.4 + Math.sqrt(c.share)) * (0.55 + c.hsv.v * 0.7);
      if (score > bestScore) { bestScore = score; accent = c; }
    });
    var accentHex = accent ? accent.hex : ink;

    var surface = bgLuma > 0.5 ? mixHex(bg, '#FFFFFF', 0.66) : mixHex(bg, '#FFFFFF', 0.1);
    var sub = mixHex(ink, bg, contrastRatio(bg, mixHex(ink, bg, 0.18)) >= 2.8 ? 0.36 : 0.16);
    if (contrastRatio(bg, sub) < 2.8) sub = mixHex(ink, bg, 0.12);
    var line = mixHex(bg, ink, 0.22);
    var palette = {
      bg: bg, surface: surface, ink: ink, sub: sub, line: line,
      accent: accentHex, accentSoft: mixHex(bg, accentHex, 0.16)
    };

    // 톤 — 밝기·대비·채도·색온도
    var sumL = 0, sumS = 0, sumN = 0, cosH = 0, sinH = 0, maxS = 0;
    colors.forEach(function (c) {
      sumL += c.luma * c.share;
      sumS += c.hsv.s * c.share;
      sumN += c.share;
      maxS = Math.max(maxS, c.hsv.s);
      if (c.hsv.s > 0.12) {
        cosH += Math.cos(c.hsv.h * Math.PI / 180) * c.hsv.s * c.share;
        sinH += Math.sin(c.hsv.h * Math.PI / 180) * c.hsv.s * c.share;
      }
    });
    var meanLuma = sumN ? sumL / sumN : bgLuma;
    var meanSat = sumN ? sumS / sumN : 0;
    var hue = (Math.atan2(sinH, cosH) * 180 / Math.PI + 360) % 360;
    var lumas = colors.map(function (c) { return c.luma; }).sort(function (a, b) { return a - b; });
    var p05 = lumas[Math.floor((lumas.length - 1) * 0.05)];
    var p95 = lumas[Math.ceil((lumas.length - 1) * 0.95)];
    var contrastSpan = Math.abs((p95 == null ? meanLuma : p95) - (p05 == null ? meanLuma : p05));
    var scheme = bgLuma < 0.42 ? 'dark' : 'light';
    var accentHsv = hsvOfHex(accentHex);
    var mood;
    if (maxS < 0.14) mood = 'mono';
    else if (meanSat > 0.45 && maxS > 0.62) mood = 'vivid';
    else if (meanLuma < 0.32) mood = 'dark';
    else if (meanLuma > 0.72 && meanSat < 0.24) mood = 'clean';
    else mood = 'balanced';
    var temperature = 'neutral';
    if (meanSat > 0.08) temperature = (hue < 70 || hue > 320) ? 'warm' : (hue > 150 && hue < 290 ? 'cool' : 'warm');
    var toneLabel = { mono: '모노', vivid: '비비드', dark: '다크', clean: '클린', balanced: '밸런스' }[mood] +
      ' · ' + (scheme === 'dark' ? '어두운' : '밝은') + ' 톤';

    var structure = referenceStructure(rgba, w, h);

    var matched = referenceToTheme({ palette: palette, tone: { scheme: scheme, mood: mood, saturation: meanSat, luma: meanLuma, hue: hue }, structure: structure });

    return {
      size: { w: w, h: h, ratio: round(w / h, 3) },
      palette: palette,
      colors: colors.slice(0, 6),
      tone: {
        luma: round(bgLuma, 3), meanLuma: round(meanLuma, 3), contrast: round(contrastSpan, 3),
        saturation: round(meanSat, 3), maxSaturation: round(maxS, 3),
        hue: round(hue, 1), accentHue: accentHsv.h, accentSaturation: accentHsv.s,
        temperature: temperature, scheme: scheme, mood: mood, label: toneLabel
      },
      structure: structure,
      theme: matched.theme,
      matchScore: matched.score,
      source: o.source || { type: 'image' }
    };
  }

  /** 분석값에 가장 가까운 테마 — 다크/라이트·채도·색상·정렬을 가중 합산. */
  function referenceToTheme(a) {
    var tone = a.tone || {}, st = a.structure || STRUCTURES.left;
    var hueRef = tone.accentHue == null ? (tone.hue || 0) : tone.accentHue;
    var satRef = tone.accentSaturation == null ? (tone.saturation || 0) : tone.accentSaturation;
    var bgHsvRef = hsvOfHex((a.palette && a.palette.bg) || '#FFFFFF');
    var bgSatRef = bgHsvRef.s, bgHueRef = bgHsvRef.h;
    var lists = [];
    THEMES.forEach(function (t) {
      var tLuma = lumaOfHex(t.palette.bg);
      var accentHsv = hsvOfHex(t.palette.accent);
      var bgHsv = hsvOfHex(t.palette.bg);
      var score = 0;
      score += (!!t.dark === (tone.scheme === 'dark')) ? 2.4 : 0;
      score += 1.7 * (1 - Math.min(1, Math.abs(tLuma - (tone.luma == null ? 0.5 : tone.luma)) * 1.6));
      score += 1.6 * (1 - Math.min(1, Math.abs(accentHsv.s - satRef) * 1.3));
      if (satRef > 0.14 && accentHsv.s > 0.12) {
        score += 2.2 * (1 - hueDistance(accentHsv.h, hueRef) / 180);
      }
      score += 1.8 * (1 - Math.min(1, Math.abs(bgHsv.s - bgSatRef) * 1.6));
      if (bgSatRef > 0.12) {
        score += 1.2 * (1 - hueDistance(bgHsv.h, bgHueRef) / 180);
      }
      if (tone.mood === 'mono' && accentHsv.s < 0.18) score += 1.4;
      if (tone.mood === 'vivid' && accentHsv.s > 0.55) score += 1.2;
      if (t.layout.align === st.align) score += 1.0;
      lists.push({ theme: t, score: score });
    });
    lists.sort(function (x, y) { return y.score - x.score; });
    var top = lists[0];
    return { theme: top.theme, score: clamp(Math.round(top.score / 10.4 * 100), 1, 99), runners: lists.slice(1, 4).map(function (r) { return r.theme.id; }) };
  }

  /** 프롬프트에 넣을 영어 아트디렉션 힌트. */
  function referenceHints(a) {
    if (!a || !a.palette) return '';
    var pal = a.palette, tone = a.tone || {}, st = a.structure || {};
    var comp = {
      left: 'subject weighted to the right, calm negative space on the left for the headline',
      right: 'subject weighted to the left, calm negative space on the right for the headline',
      center: 'centered subject with symmetrical calm margins for a centered headline',
      'bottom-bar': 'subject in the upper area, a calm horizontal band along the bottom for the headline',
      split: 'a clean horizontal split — visual weight on the bottom, headline band on top',
      grid: 'a modular composition with even calm blocks for text'
    }[st.type] || 'clean composition with clear negative space';
    var treat = (tone.saturation || 0) > 0.4 ? 'saturated, high-energy color' : ((tone.mood === 'mono') ? 'near-monochrome, tonal' : 'muted, low-saturation color');
    return (tone.scheme === 'dark' ? 'dark' : 'light') + ' ' + treat + ' palette built on ' + pal.bg +
      ' with ' + pal.accent + ' accent and ' + pal.ink + ' type; ' + comp + '; echo the reference grain and contrast, ' +
      'but keep the plate free of any text or logos.';
  }

  function referenceSummary(a) {
    if (!a) return '';
    var st = a.structure || {};
    return (a.tone ? a.tone.label : '톤 미상') + ' · ' + (st.label || '구조 미상') +
      ' · 신뢰도 ' + Math.round((st.confidence || 0) * 100) + '% · 테마 ' + (a.theme ? a.theme.short : '-');
  }

  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  var BRAND_PRESET_LIMIT = 8;

  /** 분석값 → 저장 가능한 "내 브랜드 프리셋". */
  function buildBrandPreset(a, meta) {
    var m = meta || {};
    if (!a || !a.palette) throw new Error('분석 결과가 필요합니다.');
    var name = String(m.name || '').trim() || ('레퍼런스 ' + (a.theme ? a.theme.short : '스타일'));
    var hints = referenceHints(a);
    var preset = {
      v: 1,
      id: 'ref-' + hashString(name + a.palette.bg + a.palette.accent + hints),
      name: name,
      at: m.at || Date.now(),
      source: a.source || { type: 'image' },
      theme: a.theme ? a.theme.id : 'editorial',
      palette: {
        bg: a.palette.bg, surface: a.palette.surface, ink: a.palette.ink,
        sub: a.palette.sub, line: a.palette.line, accent: a.palette.accent, accentSoft: a.palette.accentSoft
      },
      tone: a.tone,
      structure: {
        type: a.structure.type, label: a.structure.label, align: a.structure.align,
        confidence: a.structure.confidence, text: a.structure.text, subject: a.structure.subject
      },
      hints: hints,
      thumb: m.thumb || ''
    };
    return preset;
  }

  /** 프리셋을 현재 캔버스에 적용할 상태 조각. */
  function presetToState(preset) {
    if (!preset || !preset.palette) return null;
    return {
      theme: preset.theme,
      bgColor: preset.palette.bg,
      accentColor: preset.palette.accent,
      refPalette: {
        bg: preset.palette.bg, surface: preset.palette.surface, ink: preset.palette.ink,
        sub: preset.palette.sub, line: preset.palette.line,
        accent: preset.palette.accent, accentSoft: preset.palette.accentSoft
      },
      align: preset.structure ? preset.structure.align : 'left',
      refLayout: preset.structure ? {
        on: true,
        type: preset.structure.type,
        align: preset.structure.align,
        text: preset.structure.text,
        subject: preset.structure.subject
      } : null,
      refHints: preset.hints || ''
    };
  }

  function validateReferenceImage(w, h) {
    if (!w || !h) return { ok: false, reason: '이미지 크기를 읽지 못했습니다.' };
    if (w < 80 || h < 60) return { ok: false, reason: '이미지가 너무 작습니다(최소 80×60). 캡처를 다시 해 주세요.' };
    if (w * h > 24e6) return { ok: false, reason: '이미지가 너무 큽니다(2400만 픽셀 이하). 캡처를 줄여 주세요.' };
    return { ok: true };
  }

  /** 레퍼런스 팔레트를 테마 팔레트에 덮어쓴 사본 — 분석 없이 색만 옮길 때. */
  function paletteWithReference(theme, referencePalette) {
    var out = clone(theme);
    if (!referencePalette) return out;
    ['bg', 'surface', 'ink', 'sub', 'line', 'accent', 'accentSoft'].forEach(function (k) {
      if (referencePalette[k]) out.palette[k] = String(referencePalette[k]).toUpperCase();
    });
    return out;
  }

  /* ── 배경 투명화 ───────────────────────────────────── */
  /** 테두리 고리 픽셀을 12단계로 양자화해 dominant 색을 뽑는다. */
  function sampleEdgeColors(rgba, w, h, opts) {
    var o = opts || {};
    var thickness = o.thickness || Math.max(2, Math.round(Math.min(w, h) * 0.025));
    var step = o.step || Math.max(1, Math.round((w + h) / 900));
    var buckets = Object.create(null);

    function add(x, y) {
      var i = (y * w + x) * 4;
      if (rgba[i + 3] < 24) return;
      var r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      var key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      var e = buckets[key];
      if (!e) { e = buckets[key] = { sr: 0, sg: 0, sb: 0, n: 0 }; }
      e.sr += r; e.sg += g; e.sb += b; e.n++;
    }
    var x, y;
    var th = Math.min(thickness, Math.floor(Math.min(w, h) / 2));
    for (y = 0; y < h; y += step) {
      for (x = 0; x < th; x += step) { add(x, y); add(w - 1 - x, y); }
    }
    for (x = 0; x < w; x += step) {
      for (y = 0; y < th; y += step) { add(x, y); add(x, h - 1 - y); }
    }

    var list = [];
    Object.keys(buckets).forEach(function (k) {
      var e = buckets[k];
      e.r = e.sr / e.n; e.g = e.sg / e.n; e.b = e.sb / e.n;
      list.push(e);
    });
    list.sort(function (a, b) { return b.n - a.n; });

    var total = 0;
    list.forEach(function (e) { total += e.n; });

    // 비슷한 색 병합 (거리 26 이내)
    var merged = [];
    list.forEach(function (e) {
      for (var i = 0; i < merged.length; i++) {
        var m = merged[i];
        if (distRgb(e, m) < 26) {
          var n = m.n + e.n;
          m.r = (m.r * m.n + e.r * e.n) / n;
          m.g = (m.g * m.n + e.g * e.n) / n;
          m.b = (m.b * m.n + e.b * e.n) / n;
          m.n = n;
          return;
        }
      }
      merged.push({ r: e.r, g: e.g, b: e.b, n: e.n });
    });
    merged.sort(function (a, b) { return b.n - a.n; });

    var colors = merged.slice(0, 5).map(function (m) {
      return {
        hex: rgbToHex(m.r, m.g, m.b).toUpperCase(),
        r: round(m.r, 1), g: round(m.g, 1), b: round(m.b, 1),
        share: round(m.n / Math.max(1, total), 3)
      };
    });
    return {
      colors: colors,
      uniform: colors.length ? colors[0].share : 0,
      dominant: colors.length ? colors[0].hex : '#FFFFFF'
    };
  }

  function distRgb(a, b) {
    var dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return Math.sqrt((2 * dr * dr + 4 * dg * dg + 3 * db * db) / 9);
  }
  function distToAny(r, g, b, targets) {
    var best = 1e9;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var d = distRgb({ r: r, g: g, b: b }, t);
      if (d < best) best = d;
    }
    return best;
  }

  /** 알파 마스크를 박스 블러로 부드럽게 (분리형, 경계 클램프). */
  function blurAlpha(src, w, h, radius) {
    var r = Math.round(radius || 0);
    if (r <= 0) return src;
    var tmp = new Float32Array(w * h);
    var out = new Float32Array(w * h);
    var i, x, y, sum, count;
    var win = r * 2 + 1;
    for (y = 0; y < h; y++) {
      var row = y * w;
      sum = 0;
      for (x = -r; x <= r; x++) sum += src[row + clamp(x, 0, w - 1)];
      for (x = 0; x < w; x++) {
        tmp[row + x] = sum / win;
        sum -= src[row + clamp(x - r, 0, w - 1)];
        sum += src[row + clamp(x + r + 1, 0, w - 1)];
      }
    }
    for (x = 0; x < w; x++) {
      sum = 0;
      for (y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
      for (y = 0; y < h; y++) {
        out[y * w + x] = sum / win;
        sum -= tmp[clamp(y - r, 0, h - 1) * w + x];
        sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x];
      }
    }
    void count;
    return out;
  }

  /**
   * 배경 투명화.
   * @param {Uint8ClampedArray|Uint8Array} rgba  RGBA 픽셀
   * @param {number} w @param {number} h
   * @param {object} opts {algorithm:'auto'|'flood'|'light', tolerance, strength, feather, edge}
   * @returns {{data:Uint8ClampedArray, alpha:Float32Array, edge:object, stats:object}}
   */
  function removeBackground(rgba, w, h, opts) {
    var p = opts || {};
    var algorithm = p.algorithm || 'auto';
    var tol = clamp(p.tolerance == null ? 38 : Number(p.tolerance), 2, 120);
    var strength = clamp(p.strength == null ? 45 : Number(p.strength), 0, 100);
    var feather = clamp(p.feather == null ? 3 : Number(p.feather), 0, 14);
    var edge = p.edge || sampleEdgeColors(rgba, w, h);
    var n = w * h;
    var out = new Uint8ClampedArray(rgba);
    var alpha = new Float32Array(n);
    alpha.fill(1);

    var targets = edge.colors.slice(0, 3).map(function (c) { return { r: c.r, g: c.g, b: c.b }; });
    if (algorithm === 'light') {
      targets = [{ r: 255, g: 255, b: 255 }, { r: 250, g: 250, b: 248 }, { r: 244, g: 244, b: 240 }].concat(targets);
    }
    if (!targets.length) targets = [{ r: 255, g: 255, b: 255 }];

    var eff = tol * (0.55 + strength / 100);       // 38 · 45 → 38
    if (algorithm === 'light') eff = tol * (0.45 + strength / 300);  // 밝은 배경은 더 보수적으로
    var t0 = eff * 0.55;
    var t1 = eff * 1.25;
    if (t1 - t0 < 4) t1 = t0 + 4;

    function ramp(d) {
      if (d <= t0) return 0;
      if (d >= t1) return 1;
      var t = (d - t0) / (t1 - t0);
      return t * t * (3 - 2 * t);                   // smoothstep
    }

    var i, x, y;
    if (algorithm === 'flood' || algorithm === 'light') {
      var seen = new Uint8Array(n);
      var stack = new Int32Array(n);
      var sp = 0;
      function push(idx) {
        if (seen[idx]) return;
        var j = idx * 4;
        if (algorithm === 'light' && Math.min(rgba[j], rgba[j + 1], rgba[j + 2]) < 185) return;
        var d = distToAny(rgba[j], rgba[j + 1], rgba[j + 2], targets);
        if (d >= t1) return;
        seen[idx] = 1;
        alpha[idx] = ramp(d);
        stack[sp++] = idx;
      }
      for (x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
      for (y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
      while (sp > 0) {
        var idx2 = stack[--sp];
        var px = idx2 % w, py = (idx2 - px) / w;
        if (px > 0) push(idx2 - 1);
        if (px < w - 1) push(idx2 + 1);
        if (py > 0) push(idx2 - w);
        if (py < h - 1) push(idx2 + w);
      }
    } else {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          var k = i * 4;
          if (rgba[k + 3] === 0) { alpha[i] = 0; continue; }
          var dd = distToAny(rgba[k], rgba[k + 1], rgba[k + 2], targets);
          alpha[i] = ramp(dd);
          if (algorithm === 'light') {
            // 밝은 배경 모드에서도 '색이 있는 피사체'는 지우지 않는다.
            // (베이지 배경 위 연두색 제품처럼 거리만으로는 경계가 애매한 경우 보호)
            var mn = Math.min(rgba[k], rgba[k + 1], rgba[k + 2]);
            if (mn < 185) alpha[i] = 1;
          }
        }
      }
    }

    if (feather > 0) alpha = blurAlpha(alpha, w, h, feather);

    var transparent = 0, soft = 0, kept = 0;
    for (i = 0; i < n; i++) {
      var a = alpha[i];
      if (a < 0.04) { alpha[i] = 0; transparent++; }
      else if (a > 0.96) { alpha[i] = 1; kept++; }
      else soft++;
      out[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * alpha[i]);
    }
    return {
      data: out,
      alpha: alpha,
      edge: edge,
      stats: {
        total: n, transparent: transparent, soft: soft, kept: kept,
        transparentRatio: round(transparent / Math.max(1, n), 4),
        softRatio: round(soft / Math.max(1, n), 4)
      }
    };
  }

  /* ── 텍스트: 리치 파싱 · 줄바꿈 · 자동 크기 ─────────── */
  /** **강조** 문법을 토큰으로. */
  function parseRich(text) {
    var src = String(text == null ? '' : text);
    var out = [];
    var re = /\*\*([^*]+)\*\*/g;
    var last = 0, m;
    while ((m = re.exec(src))) {
      if (m.index > last) out.push({ t: src.slice(last, m.index), em: false });
      out.push({ t: m[1], em: true });
      last = re.lastIndex;
    }
    if (last < src.length) out.push({ t: src.slice(last), em: false });
    return out.length ? out : [{ t: '', em: false }];
  }

  /** 한글은 글자 단위, 영문·숫자는 단어 단위로 끊는 세그먼트. */
  function toSegments(tokens) {
    // 숫자+한글 단위(3만원대, 12개, 2주)와 영문 단어는 한 덩어리로 끊는다.
    // '3만원대'가 '3만' / '원대'로 갈라지면 썸네일에서 읽기 나빠진다.
    var segs = [];
    tokens.forEach(function (tok) {
      var s = tok.t, i = 0;
      while (i < s.length) {
        var ch = s[i];
        if (ch === ' ') { segs.push({ t: ' ', em: tok.em }); i++; continue; }
        if (/[0-9]/.test(ch)) {
          var st = i;
          while (i < s.length && /[0-9.,]/.test(s[i])) i++;
          while (i < s.length && /[가-힣A-Za-z%]/.test(s[i])) i++;
          segs.push({ t: s.slice(st, i), em: tok.em });
          continue;
        }
        if (/[A-Za-z@#%&+\-_.·:/\u00C0-\u024F]/.test(ch)) {
          var st2 = i;
          while (i < s.length && /[A-Za-z0-9@#%&+\-_.·:/\u00C0-\u024F]/.test(s[i])) i++;
          segs.push({ t: s.slice(st2, i), em: tok.em });
          continue;
        }
        segs.push({ t: ch, em: tok.em });
        i++;
      }
    });
    return segs;
  }

  /**
   * 폭에 맞춰 줄을 나눈다. ctx.measureText를 쓴다(폰트는 호출 전에 설정).
   * @returns {Array<Array<{t,em,w}>>}
   */
  function wrapRich(ctx, tokens, maxW) {
    var lines = [[]];
    var segs = toSegments(tokens);
    var cur = 0;
    function newLine() { lines.push([]); cur = 0; }
    segs.forEach(function (seg) {
      var w = ctx.measureText(seg.t).width;
      if (seg.t === ' ' && cur === 0) return;
      if (cur + w > maxW && cur > 0) {
        // 공백이면 버리고 줄바꿈
        if (seg.t === ' ') { newLine(); return; }
        newLine();
      }
      if (w > maxW) {
        // 한 세그먼트가 폭보다 김 → 글자 단위로
        var chunk = '';
        for (var i = 0; i < seg.t.length; i++) {
          var test = chunk + seg.t[i];
          if (ctx.measureText(test).width > maxW && chunk) {
            lines[lines.length - 1].push({ t: chunk, em: seg.em, w: ctx.measureText(chunk).width });
            newLine();
            chunk = seg.t[i];
          } else chunk = test;
        }
        if (chunk) {
          var cw = ctx.measureText(chunk).width;
          lines[lines.length - 1].push({ t: chunk, em: seg.em, w: cw });
          cur += cw;
        }
        return;
      }
      lines[lines.length - 1].push({ t: seg.t, em: seg.em, w: w });
      cur += w;
    });
    // 빈 줄 정리
    return lines.filter(function (l) { return l.length > 0; });
  }

  function fontString(size, weight, family) {
    return (weight || 700) + ' ' + size + 'px ' + (family || '"PlexKR", "Apple SD Gothic Neo", sans-serif');
  }

  /**
   * 제목을 박스에 맞추는 최대 폰트 크기 탐색.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text  **강조** 포함
   * @param {object} o {maxW,maxH,maxSize,minSize,weight,lineHeight,family,maxLines}
   */
  function fitTitle(ctx, text, o) {
    var opt = o || {};
    var maxW = Math.max(10, opt.maxW || 400);
    var maxH = Math.max(10, opt.maxH || 200);
    var maxSize = Math.max(8, opt.maxSize || 96);
    var minSize = Math.max(8, opt.minSize || 22);
    var lh = opt.lineHeight || 1.15;
    var maxLines = opt.maxLines || 4;
    var weight = opt.weight || 800;
    var family = opt.family;
    var tokens = parseRich(text);
    var best = null;

    for (var size = Math.round(maxSize); size >= minSize; size -= 1) {
      ctx.font = fontString(size, weight, family);
      if (opt.tracking != null && 'letterSpacing' in ctx) {
        try { ctx.letterSpacing = (opt.tracking * size).toFixed(2) + 'px'; } catch (e) { /* noop */ }
      }
      var lines = wrapRich(ctx, tokens, maxW);
      var textH = lines.length * size * lh * 0.98;
      var widest = 0;
      lines.forEach(function (l) {
        var w = 0; l.forEach(function (s) { w += s.w; });
        if (w > widest) widest = w;
      });
      best = { size: size, lines: lines, height: textH, width: widest, lineHeight: size * lh };
      if (lines.length <= maxLines && textH <= maxH && widest <= maxW + 0.5) break;
      if (size === minSize) {
        // 최소 크기에서도 넘치면 줄 수를 잘라 … 처리
        if (lines.length > maxLines) {
          lines = lines.slice(0, maxLines);
          var last = lines[lines.length - 1];
          if (last.length) last[last.length - 1] = { t: last[last.length - 1].t + '…', em: last[last.length - 1].em, w: last[last.length - 1].w + size * 0.6 };
          best.lines = lines;
          best.height = lines.length * size * lh * 0.98;
        }
      }
    }
    return best;
  }

  /** 제목 후킹 진단(카피심리 엔진이 있으면 실제 점수, 없으면 길이 기반 근사). */
  function quickHeadlineScore(text, CopyPsych) {
    var t = String(text || '').replace(/\*\*/g, '').trim();
    if (!t) return { total: 0, grade: '-', tips: ['제목을 입력하면 후킹 점수를 계산합니다.'] };
    if (CopyPsych && typeof CopyPsych.diagnose === 'function') {
      try {
        var d = CopyPsych.diagnose(t);
        var tips = (d.gaps || []).slice(0, 2).map(function (g) { return g.name + ' 보강'; });
        // 총점은 8개 트리거 가중 평균이라 한두 개만 강해도 낮게 나온다.
        // 썸네일 제목은 '가장 강한 트리거'가 중요하므로 최고 트리거를 함께 반영한다.
        var best = 0;
        (d.triggers || []).forEach(function (tr) { if (tr.score > best) best = tr.score; });
        var score = Math.max(d.total, Math.round(best * 0.9));
        if (t.length >= 12 && t.length <= 38) score += 8;
        if (/\d/.test(t)) score += 6;
        if (/[?？!]/.test(t)) score += 4;
        var total = clamp(score, 0, 100);
        return {
          total: total,
          grade: total >= 85 ? 'S' : total >= 70 ? 'A' : total >= 55 ? 'B' : total >= 40 ? 'C' : 'D',
          tips: tips, best: best
        };
      } catch (e) { /* fallthrough */ }
    }
    var score = 30;
    if (/\d/.test(t)) score += 18;
    if (/[?!]/.test(t)) score += 8;
    if (t.length >= 12 && t.length <= 34) score += 14;
    if (/(하는|한|법|이유|차이|비교|후기|정리|총정리)/.test(t)) score += 10;
    if (/^(안녕|오늘|저는)/.test(t)) score -= 12;
    return { total: clamp(score, 0, 100), grade: score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 55 ? 'B' : 'C', tips: [] };
  }

  /* ── 이미지 프롬프트 ───────────────────────────────── */
  var STYLES = [
    { id: 'photo', name: '실사 사진', en: 'photorealistic editorial photograph',
      hints: 'shot on a 50mm lens at f/2.0, natural directional light, shallow depth of field, true-to-life color, subtle film grain' },
    { id: 'product', name: '제품 스튜디오 컷', en: 'premium studio product photograph',
      hints: 'seamless paper backdrop, large softbox from the top left, crisp rim light, soft contact shadow, ultra sharp, commercial catalog quality' },
    { id: 'render3d', name: '3D 일러스트', en: 'soft 3D clay render illustration',
      hints: 'matte clay materials, pastel palette, soft ambient occlusion, gentle studio lighting, premium and playful' },
    { id: 'flat', name: '플랫 벡터', en: 'flat vector illustration',
      hints: 'limited five-color palette, clean geometric shapes, no gradients, generous negative space, editorial poster feel' },
    { id: 'cinematic', name: '시네마틱', en: 'cinematic film still',
      hints: 'volumetric light, atmospheric haze, teal and amber grade, anamorphic bokeh, wide cinematic composition' },
    { id: 'collage', name: '그래픽 콜라주', en: 'graphic collage artwork',
      hints: 'torn paper edges, halftone dots, bold cutout shapes, risograph texture, layered depth' }
  ];
  var MOODS = [
    { id: 'warm', name: '따뜻한', en: 'warm, cozy and inviting' },
    { id: 'cool', name: '차가운', en: 'cool, clean and technical' },
    { id: 'premium', name: '고급스러운', en: 'quiet luxury, refined and understated' },
    { id: 'energetic', name: '활기찬', en: 'energetic, bold and high contrast' },
    { id: 'calm', name: '차분한', en: 'calm, airy and minimal' },
    { id: 'futuristic', name: '미래적인', en: 'futuristic, luminous and precise' }
  ];
  var LIGHTS = [
    { id: 'natural', name: '자연광', en: 'soft natural window light' },
    { id: 'studio', name: '스튜디오', en: 'controlled studio softbox lighting' },
    { id: 'golden', name: '골든아워', en: 'golden hour sunlight with long shadows' },
    { id: 'neon', name: '네온', en: 'neon practical lights with colored rim light' },
    { id: 'overcast', name: '흐린 날', en: 'flat overcast daylight, no hard shadows' }
  ];
  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }

  var NEGATIVE_BASE = 'no text, no letters, no Korean typography, no watermark, no logo, no signature, no UI screenshot, no deformed hands, no extra fingers, no duplicated objects, no low contrast, no cluttered background';

  /**
   * 썸네일 배경용 이미지 프롬프트(영어) 생성.
   * @param {object} input {title, topic, style, mood, lighting, extra, ratio/width+height, position}
   */
  function buildImagePrompt(input) {
    var p = input || {};
    var style = byId(STYLES, p.style || 'photo');
    var mood = byId(MOODS, p.mood || 'warm');
    var light = byId(LIGHTS, p.lighting || 'natural');
    var topic = String(p.topic || p.title || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (!topic) topic = 'a seasonal lifestyle product story';
    var ratio = p.ratio || aspectFromSize(p.width, p.height);
    var side = p.textSide === 'right' ? 'right' : (p.textSide === 'center' ? 'center' : 'left');
    var space = side === 'center'
      ? 'Keep the central lower third calm and uncluttered for a Korean headline overlay.'
      : 'Leave the ' + side + ' third of the frame as calm negative space for a Korean headline overlay.';
    var extra = String(p.extra || '').trim();
    var refHints = '';
    if (p.reference) {
      refHints = typeof p.reference === 'string' ? p.reference : referenceHints(p.reference);
      refHints = String(refHints || '').trim();
    }

    var prompt = style.en + ' for a ' + (p.platform || 'social media') + ' thumbnail about "' + topic + '". ' +
      'Scene: a single clear subject that instantly reads at small size, ' + mood.en + ' atmosphere, ' + light.en + ', ' + style.hints + '. ' +
      space + ' Strong figure-ground separation, uncluttered composition, high detail, professional art direction, ' +
      ratio + ' aspect ratio.' + (extra ? ' Extra direction: ' + extra.replace(/\s+/g, ' ').trim() + '.' : '') +
      (refHints ? ' Benchmarked from the user reference: ' + refHints : '') +
      ' The image is a background plate only — absolutely no text, letters, numbers, logos or watermarks anywhere.';

    return {
      prompt: prompt.replace(/\s{2,}/g, ' ').trim(),
      negative: NEGATIVE_BASE + (p.negative ? ', ' + p.negative : ''),
      aspect: ratio,
      style: style.id, mood: mood.id, lighting: light.id,
      reference: refHints,
      ko: style.name + ' · ' + mood.name + ' · ' + light.name + ' / ' + ratio
        + (refHints ? ' · 레퍼런스 반영' : '')
    };
  }

  function aspectFromSize(w, h) {
    if (!w || !h) return '16:9';
    var r = w / h;
    var table = [
      { a: '1:1', v: 1 }, { a: '4:5', v: 0.8 }, { a: '16:9', v: 16 / 9 },
      { a: '3:2', v: 1.5 }, { a: '9:16', v: 0.5625 }, { a: '2:3', v: 2 / 3 }
    ];
    var best = table[0], bd = 99;
    table.forEach(function (t) {
      var d = Math.abs(t.v - r);
      if (d < bd) { bd = d; best = t; }
    });
    return best.a;
  }

  /** 구독 AI별 복붙용 변형. */
  function promptVariants(built, opts) {
    var o = opts || {};
    var base = built.prompt;
    var neg = built.negative;
    var ar = built.aspect;
    return {
      chatgpt: base + '\n\nAvoid: ' + neg + '.',
      gemini: base + '\n\nAspect ratio: ' + ar + '. Avoid: ' + neg + '.',
      midjourney: base.replace(/\s+/g, ' ') + ' --ar ' + ar.replace(':', ':') + ' --style raw --no ' + 'text, letters, watermark, logo' + (o.mjVersion ? ' --v ' + o.mjVersion : ''),
      negative: neg
    };
  }

  /** Claude(텍스트 전용)로 프롬프트를 고도화할 때 보내는 지시문. */
  function buildPromptEnhanceRequest(input) {
    var p = input || {};
    var base = p.built && p.built.prompt ? p.built.prompt : buildImagePrompt(p).prompt;
    var art = p.artDirection || '';
    var text = 'You are an art director for Korean social media thumbnails.\n' +
      'Improve the image-generation prompt below so it produces a cleaner, more premium background plate with clear empty space for a Korean headline.\n' +
      'Rules:\n' +
      '- Output one English prompt (max 110 words), then a line "Negative:" and a short negative list.\n' +
      '- Never include text, letters, logos, watermarks, UI, or people holding signs in the image.\n' +
      '- Keep it photographic/commercial, not fantasy art. Do not add brand names.\n' +
      (art ? '- Art direction to respect: ' + art + '\n' : '') +
      '\nOriginal prompt:\n' + base + '\n';
    return {
      system: 'You are a precise art director. Reply with the prompt only, in the requested two-part format.',
      prompt: text
    };
  }

  /* ── Pro API 제공자 ────────────────────────────────── */
  var PROVIDERS = [
    {
      id: 'openai', rank: 1, name: 'OpenAI', vendor: 'OpenAI',
      kinds: ['image'], badge: '가장 무난한 실사',
      product: 'gpt-image-1 · DALL·E 3',
      models: [
        { id: 'gpt-image-1', name: 'gpt-image-1 (권장)', sizes: ['1024x1024', '1536x1024', '1024x1536'], cost: '약 $0.02~0.08/장' },
        { id: 'dall-e-3', name: 'DALL·E 3', sizes: ['1024x1024', '1792x1024', '1024x1792'], cost: '약 $0.04~0.08/장' }
      ],
      note: '키는 브라우저에서 OpenAI로만 전송됩니다. 결제 계정에 이미지 생성 권한이 있어야 합니다.',
      docs: 'https://platform.openai.com/api-keys'
    },
    {
      id: 'gemini', rank: 2, name: 'Google Gemini', vendor: 'Google',
      kinds: ['image'], badge: 'Imagen · 빠른 생성',
      product: 'Imagen 3 · Gemini 2.5 Flash Image',
      models: [
        { id: 'imagen-3.0-generate-002', name: 'Imagen 3 (실사)', sizes: ['1:1', '3:4', '4:3', '9:16', '16:9'], cost: '약 $0.03~0.04/장' },
        { id: 'gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image', sizes: ['1:1', '4:5', '16:9', '3:2'], cost: '약 $0.03/장' }
      ],
      note: 'Google AI Studio에서 발급한 API 키를 씁니다. Imagen은 인물 생성 정책이 별도로 있습니다.',
      docs: 'https://aistudio.google.com/app/apikey'
    },
    {
      id: 'claude', rank: 3, name: 'Anthropic Claude', vendor: 'Anthropic',
      kinds: ['text'], badge: '이미지 생성 미지원',
      product: 'Claude Sonnet 4.5 · Haiku 4.5',
      models: [
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (권장)', sizes: [], cost: '약 $0.01/회' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', sizes: [], cost: '약 $0.003/회' }
      ],
      note: 'Claude는 이미지를 그리지 않습니다. 대신 썸네일용 프롬프트를 다듬어 무료 모드나 구독 AI(ChatGPT·Gemini·Midjourney)로 이어 줍니다.',
      docs: 'https://console.anthropic.com/settings/keys'
    },
    {
      id: 'custom', rank: 4, name: '자체 API 서버', vendor: 'Custom',
      kinds: ['image', 'text'], badge: '프록시 · 사내 서버',
      product: '커스텀 프록시 / 사내 이미지 서버',
      models: [{ id: 'custom', name: '내 서버 모델', sizes: [], cost: '서버 정책에 따름' }],
      note: 'OpenAI·Gemini의 브라우저 직접 호출이 막히는 환경(CORS)에서 프록시 서버를 두고 여기에 연결합니다.',
      docs: ''
    }
  ];
  function providerById(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return PROVIDERS[0];
  }

  function openaiSize(model, aspect) {
    if (model === 'dall-e-3') {
      if (aspect === '16:9' || aspect === '3:2') return '1792x1024';
      if (aspect === '4:5' || aspect === '9:16' || aspect === '2:3') return '1024x1792';
      return '1024x1024';
    }
    if (aspect === '16:9' || aspect === '3:2') return '1536x1024';
    if (aspect === '4:5' || aspect === '9:16' || aspect === '2:3') return '1024x1536';
    return '1024x1024';
  }

  /** 공급자별 fetch 요청을 만든다. 키는 호출 시점의 cfg에서만 읽는다. */
  function providerRequest(providerId, cfg, req) {
    var c = cfg || {};
    var r = req || {};
    var prompt = r.prompt || '';
    var aspect = r.aspect || '16:9';
    var apiKey = String(c.apiKey || c.key || '').trim();
    if (!apiKey && providerId !== 'custom') throw new Error('API 키를 먼저 입력하세요.');
    var model = c.model || '';

    if (providerId === 'openai') {
      if (!model) model = 'gpt-image-1';
      var body = { model: model, prompt: prompt, size: openaiSize(model, aspect), n: 1 };
      if (model === 'dall-e-3') {
        body.quality = (c.quality === 'high' || c.quality === 'hd') ? 'hd' : 'standard';
        body.response_format = 'b64_json';
      } else {
        body.quality = c.quality === 'standard' ? 'medium' : (c.quality || 'medium');
        body.output_format = 'png';
      }
      return {
        url: 'https://api.openai.com/v1/images/generations',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: body
      };
    }

    if (providerId === 'gemini') {
      if (!model) model = 'imagen-3.0-generate-002';
      var base = 'https://generativelanguage.googleapis.com/v1beta/models/';
      if (model.indexOf('imagen') === 0) {
        return {
          url: base + model + ':predict?key=' + encodeURIComponent(apiKey),
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            instances: [{ prompt: prompt }],
            parameters: { sampleCount: 1, aspectRatio: aspect, personGeneration: 'allow_adult' }
          }
        };
      }
      return {
        url: base + model + ':generateContent?key=' + encodeURIComponent(apiKey),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        }
      };
    }

    if (providerId === 'claude') {
      if (!model) model = 'claude-sonnet-4-5';
      var enh = buildPromptEnhanceRequest({ built: { prompt: prompt } });
      return {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: {
          model: model, max_tokens: 900,
          system: enh.system,
          messages: [{ role: 'user', content: enh.prompt }]
        }
      };
    }

    // custom: {{prompt}} 는 JSON 안전 이스케이프, {{promptJson}} 은 따옴표 포함
    var headers = {};
    if (c.headers) {
      if (typeof c.headers === 'string') {
        try { headers = JSON.parse(c.headers || '{}'); }
        catch (e) { throw new Error('헤더 JSON 형식이 올바르지 않습니다.'); }
      } else headers = c.headers;
    }
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    var tpl = c.bodyTemplate || '{"prompt": {{promptJson}}, "size": "{{size}}", "aspect": "{{aspect}}"}';
    var size = aspect === '1:1' ? '1024x1024' : (aspect === '4:5' || aspect === '9:16' || aspect === '2:3' ? '1024x1536' : '1536x1024');
    var esc = JSON.stringify(prompt).slice(1, -1);
    var out = String(tpl)
      .replace(/\{\{promptJson\}\}/g, JSON.stringify(prompt))
      .replace(/\{\{prompt\}\}/g, esc)
      .replace(/\{\{negative\}\}/g, JSON.stringify(String(c.negative || '')))
      .replace(/\{\{size\}\}/g, size)
      .replace(/\{\{aspect\}\}/g, aspect)
      .replace(/\{\{model\}\}/g, String(c.model || ''));
    if (!String(c.url || '').trim()) throw new Error('커스텀 서버 URL을 입력하세요.');
    return {
      url: String(c.url).trim(),
      method: (c.method || 'POST').toUpperCase(),
      headers: headers,
      body: JSON.parse(out)
    };
  }

  /** 'data.0.b64_json', 'images[0].url' 같은 경로 조회. */
  function lookupPath(obj, path) {
    if (!path) return undefined;
    var parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(function (s) { return s !== ''; });
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /**
   * 공급자 응답 → {kind:'image'|'text', dataUrl?, url?, text?}
   */
  function parseProviderResponse(providerId, json, cfg) {
    var c = cfg || {};
    if (providerId === 'openai') {
      var d = json && json.data && json.data[0];
      if (!d) throw new Error('OpenAI 응답에 이미지가 없습니다.');
      if (d.b64_json) return { kind: 'image', dataUrl: 'data:image/png;base64,' + d.b64_json, revisedPrompt: d.revised_prompt || '' };
      if (d.url) return { kind: 'image', url: d.url, revisedPrompt: d.revised_prompt || '' };
      throw new Error('OpenAI 응답 형식을 읽을 수 없습니다.');
    }
    if (providerId === 'gemini') {
      var pred = json && json.predictions && json.predictions[0];
      if (pred) {
        var b64 = pred.bytesBase64Encoded || pred.image && pred.image.imageBytes;
        if (b64) {
          var mime = (pred.mimeType || 'image/png').toLowerCase();
          return { kind: 'image', dataUrl: 'data:' + mime + ';base64,' + b64 };
        }
      }
      var cand = json && json.candidates && json.candidates[0];
      if (cand && cand.content && cand.content.parts) {
        for (var i = 0; i < cand.content.parts.length; i++) {
          var part = cand.content.parts[i];
          if (part.inlineData && part.inlineData.data) {
            return { kind: 'image', dataUrl: 'data:' + (part.inlineData.mimeType || 'image/png') + ';base64,' + part.inlineData.data };
          }
          if (part.inline_data && part.inline_data.data) {
            return { kind: 'image', dataUrl: 'data:' + (part.inline_data.mime_type || 'image/png') + ';base64,' + part.inline_data.data };
          }
        }
      }
      var blocked = json && json.promptFeedback && json.promptFeedback.blockReason;
      if (blocked) throw new Error('Gemini가 요청을 차단했습니다: ' + blocked);
      throw new Error('Gemini 응답에 이미지가 없습니다.');
    }
    if (providerId === 'claude') {
      var content = json && json.content;
      if (!content || !content.length) throw new Error('Claude 응답이 비어 있습니다.');
      var text = content.map(function (p) { return p.text || ''; }).join('\n').trim();
      if (!text) throw new Error('Claude 응답에 텍스트가 없습니다.');
      return { kind: 'text', text: text };
    }
    // custom
    var val = lookupPath(json, c.responsePath || '');
    var type = c.responseType || 'auto';
    if (val == null) throw new Error('응답에서 ' + (c.responsePath || '이미지') + ' 값을 찾지 못했습니다.');
    if (typeof val === 'string') {
      if (/^data:image\//.test(val)) return { kind: 'image', dataUrl: val };
      if (/^https?:\/\//.test(val)) return { kind: 'image', url: val };
      if (type === 'text') return { kind: 'text', text: val };
      return { kind: 'image', dataUrl: 'data:image/png;base64,' + val };
    }
    if (val && typeof val === 'object') {
      var b = val.b64_json || val.base64 || val.data || val.image;
      if (b && typeof b === 'string') return { kind: 'image', dataUrl: /^data:/.test(b) ? b : 'data:image/png;base64,' + b };
      if (val.url) return { kind: 'image', url: val.url };
      if (val.text) return { kind: 'text', text: val.text };
    }
    throw new Error('커스텀 응답 형식을 읽을 수 없습니다.');
  }

  /** HTTP 상태별로 사용자가 바로 고칠 수 있는 문장. */
  function explainHttpError(status, bodyText, providerId) {
    var detail = String(bodyText || '').slice(0, 300);
    try {
      var j = JSON.parse(bodyText);
      if (j && j.error) detail = j.error.message || j.error.status || detail;
    } catch (e) { /* keep */ }
    if (status === 401 || status === 403) return '키가 올바르지 않거나 권한이 없습니다(HTTP ' + status + '). 키를 다시 확인하세요.';
    if (status === 429) return '요청 한도·결제 한도에 걸렸습니다(HTTP 429). 잠시 뒤 다시 시도하거나 결제 설정을 확인하세요.';
    if (status === 400) return '요청이 거부되었습니다(HTTP 400). ' + detail;
    if (status === 404) return '모델 이름이나 주소가 맞지 않습니다(HTTP 404). 모델을 다시 고르세요.';
    if (status >= 500) return '공급자 서버 오류입니다(HTTP ' + status + '). 잠시 뒤 다시 시도하세요.';
    return '요청 실패(HTTP ' + status + '). ' + detail;
  }

  function isAbort(err) { return err && (err.name === 'AbortError' || err.code === 20); }
  function explainNetworkError(err, providerId) {
    if (isAbort(err)) return '요청을 취소했습니다.';
    var msg = err && err.message ? err.message : String(err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return '브라우저가 ' + (providerId === 'custom' ? '서버' : '공급자 API') + '에 직접 연결하지 못했습니다(CORS/네트워크). ' +
        (providerId === 'custom' ? '서버의 CORS 허용과 HTTPS를 확인하세요.' : '4번 자체 API 서버(프록시)를 중간에 두면 해결됩니다.');
    }
    return msg;
  }

  /* ── 다운로드 파일명 ──────────────────────────────── */
  function downloadName(title, ratioId, ext, scale) {
    var r = ratioById(ratioId);
    return slugify(title, 'thumbnail') + '-' + r.short.replace(/[^\w가-힣]/g, '') + (scale > 1 ? '@' + scale + 'x' : '') + '.' + (ext || 'png');
  }

  return {
    VERSION: '2.0.0',
    RATIOS: RATIOS, THEMES: THEMES, THEME_CATEGORIES: THEME_CATEGORIES,
    STYLES: STYLES, MOODS: MOODS, LIGHTS: LIGHTS, PROVIDERS: PROVIDERS,
    ratioById: ratioById, themeById: themeById, themesByCategory: themesByCategory,
    themeCategoryName: themeCategoryName, providerById: providerById,
    parseYouTubeUrl: parseYouTubeUrl, youtubeThumbs: youtubeThumbs, youtubeThumbUrl: youtubeThumbUrl,
    quantizeColors: quantizeColors, lumaOf: lumaOf, lumaOfHex: lumaOfHex, hsvOf: hsvOf, hsvOfHex: hsvOfHex,
    analyzeReference: analyzeReference, referenceStructure: referenceStructure, referenceToTheme: referenceToTheme,
    referenceHints: referenceHints, referenceSummary: referenceSummary,
    buildBrandPreset: buildBrandPreset, presetToState: presetToState,
    validateReferenceImage: validateReferenceImage, paletteWithReference: paletteWithReference,
    STRUCTURES: STRUCTURES, BRAND_PRESET_LIMIT: BRAND_PRESET_LIMIT,
    clamp: clamp, round: round, isHex: isHex, hexToRgb: hexToRgb, rgbToHex: rgbToHex, mixHex: mixHex,
    relativeLuminance: relativeLuminance, contrastRatio: contrastRatio, readableInk: readableInk,
    slugify: slugify, formatBytes: formatBytes, clone: clone,
    sampleEdgeColors: sampleEdgeColors, removeBackground: removeBackground, blurAlpha: blurAlpha,
    parseRich: parseRich, toSegments: toSegments, wrapRich: wrapRich, fitTitle: fitTitle, fontString: fontString,
    quickHeadlineScore: quickHeadlineScore,
    buildImagePrompt: buildImagePrompt, promptVariants: promptVariants, buildPromptEnhanceRequest: buildPromptEnhanceRequest,
    aspectFromSize: aspectFromSize, NEGATIVE_BASE: NEGATIVE_BASE,
    openaiSize: openaiSize, providerRequest: providerRequest, parseProviderResponse: parseProviderResponse,
    lookupPath: lookupPath, explainHttpError: explainHttpError, explainNetworkError: explainNetworkError,
    downloadName: downloadName
  };
});
