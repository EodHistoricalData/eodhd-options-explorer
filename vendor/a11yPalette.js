// A11yPalette — the palette, per theme, for status colours used as TEXT.
//
// The accents (#f97316 orange, #21ce99 green, #eab308 amber, #f23645 red,
// #3b82f6 blue…) are tuned for the dark shell. Written straight into inline
// styles as text colour, they read 1.9–3.9:1 on the light theme on almost
// every screen — and each round of testing found a new place ("the palette, not the spots"). Fixing call sites one by one
// never ends: there are hundreds.
//
// So the palette is fixed where the theme is: one rule per accent, scoped to
// the theme, that swaps the accent for the nearest shade that clears 4.6:1 —
// darker on the light theme, lighter on the dark one — computed by
// A11yColor.readable, not hand-picked, so it cannot drift from the maths.
// The rule matches the `color` property only: an inline style serialises as
// "color: rgb(…)" first or "; color: rgb(…)" later, while background-color,
// border-color and the like are always preceded by a hyphen. Fills, bars and
// charts keep their colours; only text changes.
//
// New code should ask for the colour directly: C3.ink(hex, isDark).

(function () {
  if (typeof window === 'undefined' || window.A11yPalette) return;

  // Accents and greys found as text colours in the views.
  const ACCENTS = [
    '#21ce99', '#f23645', '#f97316', '#eab308', '#84cc16', '#3b82f6', '#a855f7', '#8b5cf6',
    '#ef4444', '#22c55e', '#10b981', '#f59e0b', '#06b6d4', '#ec4899', '#14b8a6', '#6366f1',
    '#facc15', '#fb923c', '#4ade80', '#f87171', '#60a5fa', '#c084fc', '#2dd4bf', '#fbbf24',
    '#e11d48', '#0ea5e9', '#d946ef', '#a3e635', '#16a34a', '#dc2626', '#ea580c', '#2563eb',
    '#ca8a04', '#f0b90b', '#c2410c', '#9333ea', '#0891b2', '#f7931a', '#627eea',
    '#6b7280', '#64748b', '#84839d', '#94a3b8', '#9ca3af', '#ababad', '#a1a1aa', '#71717a',
    '#8b8b8b', '#999999', '#888888',
  ];

  // The darkest light ground text sits on (a card tint over the page) and the
  // lightest dark ones, including the purple and red tints of badges.
  const LIGHT_GROUND = '#e2e1dc';
  const DARK_GROUNDS = ['#2b2924', '#2b1e32', '#311e19', '#1f2327'];
  const MIN = 4.6;

  function variants(A) {
    const out = [];
    ACCENTS.forEach((c) => {
      const rgb = A.parse(c);
      if (!rgb) return;
      const light = A.readable(c, LIGHT_GROUND, MIN);
      let dark = c;
      DARK_GROUNDS.forEach((g) => { if (A.contrast(dark, g) < MIN) dark = A.readable(dark, g, MIN); });
      out.push({ rgb: rgb.join(', '), light: light !== c ? light : null, dark: dark !== c ? dark : null });
    });
    return out;
  }

  function selectors(scope, rgb) {
    return [
      `${scope} [style^="color: rgb(${rgb})"]`,
      `${scope} [style*="; color: rgb(${rgb})"]`,
      `${scope} [style^="color: rgba(${rgb},"]`,
      `${scope} [style*="; color: rgba(${rgb},"]`,
    ].join(',\n');
  }

  // Muted text written as white (dark theme) or black (light theme) at a low
  // alpha: "rgba(255, 255, 255, 0.45)" on a portfolio card read 4.47:1. The
  // lowest alpha that clears MIN on the worst ground is computed; every
  // two-decimal alpha below it is raised to it.
  function minAlpha(A, base, grounds) {
    for (let a = 0.3; a <= 1.0001; a += 0.01) {
      const ok = grounds.every((g) => A.contrast(A.composite(base, a, g), g) >= MIN);
      if (ok) return Math.ceil(a * 100) / 100;
    }
    return 1;
  }

  function alphaRules(A, scope, base, grounds) {
    const need = minAlpha(A, base, grounds);
    const rgb = A.parse(base).join(', ');
    const sels = [];
    for (let i = 20; i < Math.round(need * 100); i++) {
      const a = String(i / 100).replace(/^0/, '0');
      sels.push(`${scope} [style^="color: rgba(${rgb}, ${a})"]`, `${scope} [style*="; color: rgba(${rgb}, ${a})"]`);
    }
    return sels.length ? `${sels.join(',\n')} { color: rgba(${rgb}, ${need}) !important; }` : '';
  }

  // Where the theme is written. The terminal puts .light-theme on <body>; the
  // open-source apps write data-theme on <html> (shell/frame.js) and set
  // window.A11yPaletteScopes before this file runs (the palette
  // never reached them, so every accent was still 1.8-3.9:1 there).
  function scopes() {
    const s = (typeof window !== 'undefined' && window.A11yPaletteScopes) || {};
    return { light: s.light || 'body.light-theme', dark: s.dark || 'body:not(.light-theme)' };
  }

  function css(A) {
    const S = scopes();
    const rules = [];
    variants(A).forEach((v) => {
      if (v.light) rules.push(`${selectors(S.light, v.rgb)} { color: ${v.light} !important; }`);
      if (v.dark) rules.push(`${selectors(S.dark, v.rgb)} { color: ${v.dark} !important; }`);
    });
    // White text on an accent FILL (badges: SAVE on #21ce99 2.0:1, POPULAR on
    // #3b82f6 3.7:1): the fill darkens until white reads, in
    // either theme. Matches background / background-color, white text only.
    const onFill = (rgb) => {
      const sels = [];
      ['background', 'background-color'].forEach((prop) => {
        ['color: white', 'color: rgb(255, 255, 255)'].forEach((w) => {
          sels.push(`[style^="${prop}: rgb(${rgb})"][style*="${w}"]`, `[style*="; ${prop}: rgb(${rgb})"][style*="${w}"]`);
        });
      });
      return sels;
    };
    const keepWhite = [];
    ACCENTS.forEach((c) => {
      const f = A.fill(c);
      const rgb = A.parse(c).join(', ');
      keepWhite.push(...onFill(rgb), ...onFill(A.parse(f).join(', ')));
      if (f !== c) rules.push(`${onFill(rgb).join(',\n')} { background: ${f} !important; }`);
    });
    // The terminal's stylesheet turns every inline white text dark on the light theme (a
    // Telegram-era fix for white on white). White on a solid accent fill is
    // meant: SAVE / POPULAR / BEST VALUE read #1e1b4b on blue and green,
    // 3.4:1. Two attributes outrank that rule's one.
    rules.push(`${keepWhite.map((s) => S.light + ' ' + s).join(',\n')} { color: #ffffff !important; }`);
    rules.push(alphaRules(A, S.dark, '#ffffff', DARK_GROUNDS));
    rules.push(alphaRules(A, S.light, '#000000', [LIGHT_GROUND]));
    return rules.filter(Boolean).join('\n');
  }

  function install() {
    const A = window.A11yColor;
    if (!A || typeof document === 'undefined' || document.getElementById('a11y-palette')) return;
    const el = document.createElement('style');
    el.id = 'a11y-palette';
    el.textContent = css(A);
    (document.head || document.documentElement).appendChild(el);
  }

  window.A11yPalette = { ACCENTS, variants, css, install, scopes };
  install();
})();
