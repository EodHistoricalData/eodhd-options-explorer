/**
 * Colour tokens.
 *
 * Lifted from the terminal's web palette so a sample app looks like the
 * product it is a sample of. Only the keys the vendored modules
 * actually reach for — the terminal's own object carries more (asset-class
 * fills, asset-page grounds), and the rest would be dead weight in a repository whose appeal is that a stranger can
 * read the whole thing.
 *
 * The generator's test suite (it lives with the generator, not in this
 * repository) reads every vendored module for C3.<key> and fails if one is
 * missing here, if one here is no longer read, or if a value drifts away from
 * the terminal.
 */
window.C3 = {
  // Page grounds, for the views that paint their own full-screen background.
  bgGradientDark: '#15140F',
  bgGradientLight: '#f5f5f9',

  // A solid accent since the terminal's design pass; the key keeps its name.
  logoGradient: '#c2410c',
  glowOrange: '#f97316',

  // Quiet fills and hairlines for chips, segmented controls and dividers.
  fillDark: 'rgba(255,255,255,0.05)',
  fillLight: 'rgba(0,0,0,0.04)',
  lineDark: '#2B2820',
  lineLight: '#e2e4e9',

  textDark: '#E9E6DF',
  textLightTheme: '#1e1b4b',
  textMutedDark: '#A39B89',
  textMutedLight: '#4b5563',

  success: '#21CE99',
  error: '#F23645',
  warning: '#F0B90B',
  // Light-theme gain/loss: the dark-theme pair is 2:1 on white.
  successLight: '#047857',
  errorLight: '#c81e2c',

  // Spread into a style prop by the modules: {...C3.glassDark}.
  // The backdrop filters are deliberately 'none' — the terminal turned them
  // off, and reintroducing frosted glass here would make the sample look
  // unlike the product.
  glassDark: {
    background: '#1C1A14',
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none',
    border: '1px solid #2B2820',
  },
  glassLight: {
    background: '#ffffff',
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none',
    border: '1px solid #e2e4e9',
  },
};

// Where the theme is written here: data-theme on <html> (shell/frame.js), not
// the terminal's body.light-theme. The vendored a11yPalette reads this before
// it builds its rules, so the light/dark palette reaches the sample apps too
// (every accent was still 1.8-3.9:1 here).
window.A11yPaletteScopes = {
  light: 'html[data-theme="light"]',
  dark: 'html:not([data-theme="light"])',
};
