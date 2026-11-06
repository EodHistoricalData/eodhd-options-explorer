// ToggleStyle — the on state of a toggle, in the one accent.
//
// Anything the user switches on or picks reads as on, in the accent of the
// theme: #f97316 on the dark one, #c2410c on the light one (C3.glowOrange /
// C3.logoGradient). Two shapes:
// - a switch (a track with a knob): the track is the solid accent, the knob
//   stays white. `track(isDark)`.
// - a value toggle (a pressed button, the picked option of a small group):
//   accent ink, a 1 px accent line and a light accent fill.
//   `...value(on, isDark)` goes after the control's own neutral colours; off,
//   it adds only the transition, so the colours fade both ways (150 ms;
//   styles.css ends it at once under prefers-reduced-motion).
// The line is an inset shadow, so a control drawn without a border keeps its
// size; one with a 1 px border of its own passes { bordered: true } and the
// border takes the accent.
// Not for tab bars (the terminal's stylesheet .mi-tab), navigation or primary actions.

(function () {
  if (typeof window === 'undefined' || window.ToggleStyle) return;

  // The fill: the accent at this strength over whatever the control sits on.
  const FILL = { dark: 0.14, light: 0.08 };
  const TRANSITION = 'background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease';

  function accent(isDark) {
    const C3 = window.C3 || {};
    const c = isDark ? C3.glowOrange : C3.logoGradient;
    // Tests stub C3 with other values; the accent stays the accent.
    return /^#[0-9a-f]{6}$/i.test(c || '') ? c : (isDark ? '#f97316' : '#c2410c');
  }

  function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // The ink clears 4.6:1 on its own fill over the lightest ground a toggle
  // sits on. Dark: a segmented group (white at 10%) on a card (C3.glassDark),
  // where the bare accent read 4.4:1 and the palette's ink 4.49:1 (Calendar,
  // Feed/Grid). Light: the palette's ground (A11yColor.text), 4.1:1 bare.
  // Without A11yColor (a standalone build), the measured ink of the two
  // theme accents: 4.9:1 and 5.0:1 at the lowest grounds above.
  const INK = { dark: '#fa8f45', light: '#a3370a' };
  function ink(a, isDark, tint) {
    const A = window.A11yColor;
    if (!A) return isDark ? INK.dark : INK.light;
    if (!isDark) return A.text(a, false, tint);
    const card = ((window.C3 || {}).glassDark || {}).background;
    const base = A.composite('#ffffff', 0.1, /^#[0-9a-f]{6}$/i.test(card || '') ? card : '#1C1A14');
    return A.readable(a, A.composite(a, tint, base), 4.6);
  }

  function value(on, isDark, opts) {
    const style = { transition: TRANSITION };
    if (!on) return style;
    const a = accent(isDark);
    const tint = isDark ? FILL.dark : FILL.light;
    style.color = ink(a, !!isDark, tint);
    style.background = rgba(a, tint);
    if (opts && opts.bordered) style.border = `1px solid ${a}`;
    else style.boxShadow = `inset 0 0 0 1px ${a}`;
    return style;
  }

  window.ToggleStyle = { accent, track: accent, value, FILL, TRANSITION };
})();
