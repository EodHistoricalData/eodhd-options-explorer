// A11yColor — text colour that stays readable on the ground it sits on.
//
// Status colours (#f59e0b amber, #22c55e green, #f97316 orange…) are tuned
// for the dark shell. On the light theme the same hue as TEXT measured 2.0 to
// 2.6:1 against its own tinted pill or a white card.
// Rather than keep a second hand-picked palette that drifts, `readable()`
// darkens the given colour (or lightens it on a dark ground) just until it
// clears WCAG AA 4.5:1 — the hue stays, so a green badge is still green.
//
// Pure functions, no DOM. `composite()` gives the real ground of a tinted
// pill: rgba(color, 0.12) over the card behind it.

(function () {
  if (typeof window === 'undefined' || window.A11yColor) return;

  function parse(c) {
    if (Array.isArray(c)) return c.slice(0, 3);
    const s = String(c || '').trim();
    let m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }

  function hex(rgb) {
    return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }

  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(fg, bg) {
    const a = parse(fg); const b = parse(bg);
    if (!a || !b) return 1;
    const la = luminance(a); const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // `color` at `alpha` laid over the opaque `bg`.
  function composite(color, alpha, bg) {
    const c = parse(color); const b = parse(bg);
    if (!c || !b) return bg;
    return hex(c.map((v, i) => v * alpha + b[i] * (1 - alpha)));
  }

  const cache = new Map();

  // The colour nearest to `fg` that reaches `min` against `bg`: mixed toward
  // black on a light ground, toward white on a dark one. Unparseable input is
  // returned as is.
  function readable(fg, bg, min) {
    const target = min || 4.5;
    const key = fg + '|' + bg + '|' + target;
    if (cache.has(key)) return cache.get(key);
    const f = parse(fg); const b = parse(bg);
    let out = fg;
    if (f && b && contrast(f, b) < target) {
      const toward = luminance(b) > 0.18 ? [0, 0, 0] : [255, 255, 255];
      out = hex(toward);
      for (let t = 0.02; t <= 1; t += 0.02) {
        const mix = hex(f.map((v, i) => v * (1 - t) + toward[i] * t));
        if (contrast(mix, b) >= target) { out = mix; break; }   // judged as rounded
      }
    }
    cache.set(key, out);
    return out;
  }

  // The grounds status text actually sits on: a card tint over the page,
  // taken a shade darker (light) / lighter (dark) than the plain surface so a
  // colour that passes here passes on every card (options tabs
  // other than Chain still printed #22c55e on light grey at 1.9:1).
  const GROUND_LIGHT = '#e2e1dc';
  const GROUND_DARK = '#2b2924';

  // A status colour used as TEXT, for the theme it is shown in. `tint`: the
  // text sits on a pill of its own colour at that alpha (BUY on 15% green).
  function text(color, isDark, tint) {
    if (!parse(color)) return color;
    const base = isDark ? GROUND_DARK : GROUND_LIGHT;
    const ground = tint ? composite(color, tint, base) : base;
    return readable(color, ground, 4.6);
  }

  // A status colour used as the FILL under white text (badges, "+ Buy Call"):
  // darkened until white on it reads, in either theme.
  function fill(color) {
    if (!parse(color)) return color;
    return readable(color, '#ffffff', 4.6);
  }

  // The colour actually painted behind `el`: its own and its ancestors'
  // backgrounds, translucent ones laid over what is under them, down to the
  // first opaque one (or `fallback`). A chart label's halo has to be this
  // colour; a fixed #fff or #1a1a2e drew a visible box on the tinted card.
  function groundOf(el, fallback) {
    const layers = [];
    let base = fallback || '#ffffff';
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      let bg = '';
      try { bg = getComputedStyle(n).backgroundColor || ''; } catch (_) { bg = ''; }
      const m = bg.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?/i);
      if (!m) continue;
      const a = m[4] == null ? 1 : parseFloat(m[4]);
      if (!(a > 0)) continue;
      const rgb = [+m[1], +m[2], +m[3]];
      if (a >= 1) { base = hex(rgb); break; }
      layers.push([rgb, a]);
    }
    for (let i = layers.length - 1; i >= 0; i--) base = composite(layers[i][0], layers[i][1], base);
    return base;
  }

  window.A11yColor = { contrast, composite, readable, parse, text, fill, groundOf };
})();
