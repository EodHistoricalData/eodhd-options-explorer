/**
 * Wraps the app's view and surfaces the upgrade panel when the key turns out
 * not to reach the data.
 *
 * Without this the panel would be written, tested and never rendered: the
 * vendored module does not know it exists, and nothing else was watching. The
 * commercial moment of the whole exercise would have been unreachable.
 *
 * The panel appears *above* the view rather than replacing it. A plan often
 * covers some of what an app shows and not the rest, and blanking the screen
 * over one missing feed would hide the parts that do work.
 *
 * It watches every capability, not one. The first version listened to the
 * single capability an app declared, while api.js attributes endpoints to
 * eleven -- so the calendar refused on economic-events, the heatmap refused on
 * exchange-details and the news app refused on sentiment (its own opening
 * screen) all showed nothing at all. The declared capability now only says
 * which plan text the README carries.
 *
 * It also owns the theme. The vendored views are written for both -- `isDark`
 * is branched on some thirteen hundred times across the seven -- but every app
 * passed theme: 'dark' and offered no switch, so the light half was dead
 * weight nobody could reach. The switch lives here, the
 * choice in localStorage, and the view gets the theme as the prop it always
 * had.
 */
(function () {
  var THEME_KEY = 'eodhd_theme';
  var PAGE_BG = { dark: '#0d0d12', light: '#F4F3EF' };

  /**
   * One hover for everything that can be clicked.
   *
   * The views style their elements inline, and an inline style cannot say
   * :hover -- so across the seven apps the only sign that a chip, a tab, a
   * preset, Refresh, a calendar row or a heatmap tile was live was the cursor
   * changing. A stylesheet can say it, once, for all of them.
   *
   * The treatment is a one-pixel ring in the element's own text colour, drawn
   * as an inset shadow: inside the box, so nothing moves, and never under the
   * text, so its contrast is what it was. The two obvious others were tried
   * in a browser and measured out. A veil over the fill moves the background
   * towards the text: the calendar's "Grid" went from 5.5:1 to 4.5 and the
   * screener's "Guide" from 4.6 to 4.0. A brightness filter lightens the fill
   * under white text: "See EODHD plans" went from 5.2 to 4.3.
   *
   * Left alone: anything disabled, plain text links (the footer's are
   * underlined already, and a headline is a block inside its card: a ring
   * there drew a square box inside the card's rounded one), and anything
   * with a hover of its own -- the "?" help, the index
   * cards, Edit and History set their border, colour or opacity from script
   * when the pointer enters. Those are not listed here, they are noticed: an
   * element whose inline style changes as the pointer comes in is marked, and
   * the rule steps aside for it. The next module to bring its own hover needs
   * no entry in a list that nobody would remember to keep.
   *
   * Written from here rather than in index.html so the rule travels with the
   * frame; the page's policy allows inline styles (React needs them).
   */
  var HOVER_STYLE_ID = 'eodhd-hover';
  var OWN_HOVER = 'data-own-hover';
  var HOVER_TARGET = ':is(button, [role="button"], [role="tab"], a[style*="border-radius"], [style*="cursor: pointer"])'
    + ':not(:disabled, [aria-disabled="true"], [role="option"], [' + OWN_HOVER + '],'
    + ' [style*="cursor: not-allowed"], [style*="cursor: default"])';
  var HOVER_CSS = [
    // 120 ms for the ring. An element with a transition of its own keeps its
    // list of properties and takes the duration: "all 0.2s" would otherwise
    // draw the ring slower than everything else on the page.
    '#root ' + HOVER_TARGET + ' { transition: box-shadow 120ms ease-out; transition-duration: 120ms !important; }',
    // Only where there is a pointer that hovers: on a touch screen :hover
    // sticks to the last thing tapped.
    '@media (hover: hover) {',
    '  #root ' + HOVER_TARGET + ':hover { box-shadow: inset 0 0 0 1px currentColor; box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 55%, transparent); }',
    // An element with a shadow of its own keeps it -- an inline style wins
    // over this sheet -- and so got no ring at all: the options chain's
    // "Later dates" casts one over the chips it sits on. The same line as an
    // outline, drawn inwards so it takes no room either. Not over a keyboard
    // focus ring, which is an outline too and matters more.
    '  #root ' + HOVER_TARGET + '[style*="box-shadow"]:hover:not(:focus-visible) { outline: 1px solid currentColor; outline: 1px solid color-mix(in srgb, currentColor 55%, transparent); outline-offset: -1px; }',
    // A table row that tints itself under the pointer. The tint moves the
    // ground under everything in the row: the portfolio's P&L badge, coloured
    // text on a pale fill of the same colour, went from 4.6:1 to 4.3 in the
    // light theme and from 5.2 to 4.3 in the dark. The row keeps whatever
    // else its own hover does and gets the ring in place of the tint.
    '  #root tr[' + OWN_HOVER + ']:hover { background-color: transparent !important; outline: 1px solid currentColor; outline: 1px solid color-mix(in srgb, currentColor 55%, transparent); outline-offset: -1px; }',
    // A button whose inline style is `all: unset` -- the index's sort
    // headers -- unsets this sheet's shadow along with the browser's own
    // styles, and the inline style wins. The ring is the outline there, the
    // one property such a button is then given only for keyboard focus.
    '  #root ' + HOVER_TARGET + '[style*="all: unset"]:hover:not(:focus-visible) { outline: 1px solid currentColor !important; outline: 1px solid color-mix(in srgb, currentColor 55%, transparent) !important; outline-offset: -1px !important; }',
    // A text link (the footer's) has no box to ring: its underline thickens.
    // The colour is the link's own, so the contrast is too, and an underline
    // takes no room.
    '  #root a[href]:not([style*="border-radius"]):not([style*="display: block"]):hover { text-decoration-thickness: 2px !important; }',
    // A card that is one link -- a news headline with its summary -- is
    // ringed as the card: the link inside it is a plain block, and a ring on
    // that drew a square inside the card\'s rounded corners. The link\'s own
    // text colour, like everywhere else.
    '  #root [style*="border-radius"]:has(> a[href][style*="display: block"]:hover) { outline: 1px solid color-mix(in srgb, currentColor 55%, transparent); outline-offset: -1px; }',
    '}',
    '#root ' + HOVER_TARGET + ':active { box-shadow: inset 0 0 0 1px currentColor; }',
    '@media (prefers-reduced-motion: reduce) {',
    '  #root ' + HOVER_TARGET + ' { transition-duration: 0.01ms !important; }',
    '}',
  ].join('\n');

  function installHoverStyle() {
    if (typeof document === 'undefined' || !document.head || !document.createElement) return;
    if (document.getElementById(HOVER_STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = HOVER_STYLE_ID;
    el.textContent = HOVER_CSS;
    document.head.appendChild(el);

    // Noticing a hover of its own: the inline styles on the way from the
    // element the pointer is entering up to the root, read before the views'
    // handlers run (capture, on the document, which is above React's root)
    // and again two frames later -- one for a handler that writes the style
    // directly, one more for a handler that sets state and lets React write
    // it. Whatever changed in between did so because the pointer came in.
    //
    // On mouseout as well as mouseover, because React runs onMouseEnter from
    // the mouseout of the element being left (the one entered is its
    // relatedTarget); by the time mouseover arrives the style has already
    // changed and there is nothing to compare. Found in a browser: listening
    // to mouseover alone noticed nothing unless the pointer came in from
    // outside the window.
    var frame = function (fn) {
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(fn);
      else setTimeout(fn, 16);
    };
    // A click or a key between the two readings explains a changed style
    // better than the pointer does: the tab just pressed is redrawn as the
    // active one. Nothing is concluded from such a pair.
    var acted = 0;
    var act = function () { acted += 1; };
    document.addEventListener('mousedown', act, true);
    document.addEventListener('keydown', act, true);
    var watch = function (ev) {
      var root = document.getElementById('root');
      var node = ev.type === 'mouseout' ? ev.relatedTarget : ev.target;
      if (!root || !node || node.nodeType !== 1 || !root.contains(node)) return;
      var seen = [];
      for (; node && node !== root; node = node.parentElement) {
        if (!node.hasAttribute(OWN_HOVER)) seen.push({ el: node, style: node.getAttribute('style') });
      }
      if (!seen.length) return;
      var before = acted;
      frame(function () {
        frame(function () {
          if (acted !== before) return;
          seen.forEach(function (s) {
            if (s.el.getAttribute('style') !== s.style) s.el.setAttribute(OWN_HOVER, '');
          });
        });
      });
    };
    document.addEventListener('mouseout', watch, true);
    document.addEventListener('mouseover', watch, true);
  }
  installHoverStyle();

  function palette(theme) {
    return window.ShellPalette ? window.ShellPalette(theme) : {
      panelBg: '#1C1A14', panelBorder: '1px solid #2B2820', text: '#E9E6DF', muted: '#A39B89', code: 'rgba(0,0,0,0.25)',
    };
  }

  /**
   * One line saying the app can do more with a model key.
   *
   * The AI affordances render only when the proxy holds one, which is right --
   * a button that answers a click with an apology is worse than no button. But
   * it left the most interesting half of some of these apps invisible to
   * anybody who had not read the README to the end.
   *
   * So: a sentence, not a control. Nothing to click, nothing that fails, and
   * the keygate's promise -- "no buttons that explain themselves away" -- still
   * holds. Shown only for apps that declare AI features; heatmap has none, and
   * a line promising analysis there would be a lie.
   */
  // The hint can be put away. It sat above the app's own title on every
  // screen, four lines of it on a phone, with no way to dismiss it.
  var AI_HINT_KEY = 'eodhd_ai_hint_dismissed';
  function aiHintDismissed() {
    try { return localStorage.getItem(AI_HINT_KEY) === '1'; } catch (e) { return false; }
  }

  function aiHint(hasAIFeatures, theme, inset, onDismiss) {
    if (!hasAIFeatures) return null;
    if (window.AIService && window.AIService.getSettings().enabled) return null;
    var P = palette(theme);
    return React.createElement('div', {
      key: 'ai-hint',
      style: {
        margin: '0 ' + (inset || 0) + 'px 16px', padding: '6px 6px 6px 14px', borderRadius: 4,
        border: P.panelBorder,
        background: theme === 'light' ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.03)',
        fontSize: 13, lineHeight: 1.5,
        color: P.muted,
        display: 'flex', alignItems: 'center', gap: 8,
      },
    },
      React.createElement('span', { style: { flex: 1, padding: '4px 0' } },
        'This app can also analyse what it shows. Add ',
        React.createElement('code', {
          style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.92em' },
        }, 'OPENAI_API_KEY'),
        ' to .env and restart — any OpenAI-compatible provider works, billed by you.'),
      onDismiss
        ? React.createElement('button', {
          onClick: onDismiss,
          'aria-label': 'Dismiss this note',
          title: 'Dismiss',
          style: {
            flexShrink: 0, width: 36, height: 36, border: 'none', borderRadius: 4, cursor: 'pointer',
            background: 'transparent', color: P.muted, fontSize: 18, lineHeight: 1,
          },
        }, '×')
        : null
    );
  }

  /** A small bar-chart mark, the favicon's, for the header's link home. */
  function mark() {
    return React.createElement('svg', {
      width: 20, height: 20, viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false',
      style: { flexShrink: 0 },
    },
      React.createElement('rect', { width: 32, height: 32, rx: 7, fill: '#c2410c' }),
      React.createElement('rect', { x: 8, y: 17, width: 4, height: 7, rx: 1, fill: '#fff' }),
      React.createElement('rect', { x: 14, y: 12, width: 4, height: 12, rx: 1, fill: '#fff' }),
      React.createElement('rect', { x: 20, y: 8, width: 4, height: 16, rx: 1, fill: '#fff' }));
  }

  function link(path, content) {
    return window.EODHDLinks ? window.EODHDLinks.url(path, content) : 'https://eodhd.com' + path;
  }

  /**
   * The credit line. A running app carried no link anywhere and no word of
   * where its numbers came from, so a screenshot or a deployed fork said
   * nothing about the data or the code.
   */
  function footer(theme, inset) {
    var P = palette(theme);
    var meta = window.APP_META || {};
    var a = { color: P.muted, textDecoration: 'underline', textUnderlineOffset: 2 };
    var sep = React.createElement('span', { 'aria-hidden': 'true', style: { margin: '0 8px' } }, '·');
    return React.createElement('footer', {
      key: 'footer',
      style: {
        margin: '40px ' + inset + 'px 0', paddingTop: 16, borderTop: P.panelBorder,
        fontSize: 12, lineHeight: 1.8, color: P.muted,
      },
    },
      'Market data by ',
      React.createElement('a', { href: link('/', 'footer'), target: '_blank', rel: 'noopener noreferrer', style: a }, 'EODHD'),
      sep,
      React.createElement('a', { href: link('/pricing', 'footer'), target: '_blank', rel: 'noopener noreferrer', style: a }, 'Plans and API keys'),
      meta.repo ? sep : null,
      meta.repo
        ? React.createElement('a', {
          href: 'https://github.com/EodHistoricalData/' + meta.repo,
          target: '_blank', rel: 'noopener noreferrer', style: a,
        }, 'Source code (MIT)')
        : null);
  }

  /**
   * What this app keeps in the browser: the localStorage keys under the
   * prefixes meta.json declares (`storage`). Only those -- the seven apps
   * share an origin when they run on the same port, and one app's reset must
   * not take another's portfolio with it.
   */
  function savedKeys() {
    var prefixes = (window.APP_META && window.APP_META.storage) || [];
    var keys = [];
    if (!prefixes.length) return keys;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        for (var j = 0; j < prefixes.length; j++) {
          if (k && k.indexOf(prefixes[j]) === 0) { keys.push(k); break; }
        }
      }
    } catch (e) { /* storage blocked: nothing saved to reset */ }
    return keys;
  }

  /**
   * Start this app empty, keeping a copy. The way out the error panel had
   * no button for: it said "Reloading the page is the reliable way out", and
   * when the cause was the app's own saved data a reload drew the same panel
   * again, with no way to clear that data from the page. The copy is a download of exactly what is removed, so nothing
   * a person typed in is lost by pressing it.
   */
  // Asked first in the panel itself (ViewBoundary below): a browser confirm
  // box could not be styled, read in the app's words or reached the way the
  // rest of the page is, and the apps ask in the page everywhere else.
  function resetSavedData() {
    var keys = savedKeys();
    if (!keys.length) { window.location.reload(); return; }
    var dump = {};
    keys.forEach(function (k) { try { dump[k] = localStorage.getItem(k); } catch (e) { /* skip */ } });
    try {
      var blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'eodhd-' + ((window.APP_META && window.APP_META.app) || 'app') + '-saved-data-'
        + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      // No copy, no removal: the promise in the question is the condition.
      return;
    }
    keys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* skip */ } });
    // What a module keeps for the tab only (the chat's conversation) goes too.
    try {
      var prefixes = (window.APP_META && window.APP_META.storage) || [];
      for (var i = sessionStorage.length - 1; i >= 0; i--) {
        var sk = sessionStorage.key(i);
        if (prefixes.some(function (pre) { return sk && sk.indexOf(pre) === 0; })) sessionStorage.removeItem(sk);
      }
    } catch (e) { /* skip */ }
    window.location.reload();
  }

  /**
   * Catches a render error in the view and shows it, instead of a blank page.
   *
   * The screener called .toFixed on a field that arrived as the string "NA"
   * -- which EODHD's real-time feed does send -- and React unmounted the whole
   * tree: an empty page and a TypeError in a console nobody had open. There
   * was no error boundary in any of the seven. One bad field should cost one
   * card at most; here it costs the view, with a sentence saying so and a way
   * to try again.
   */
  function ViewBoundary(props) {
    React.Component.call(this, props);
    this.state = { error: null };
  }
  ViewBoundary.prototype = Object.create(React.Component.prototype);
  ViewBoundary.prototype.constructor = ViewBoundary;
  ViewBoundary.getDerivedStateFromError = function (error) {
    return { error: error || new Error('unknown error') };
  };
  ViewBoundary.prototype.componentDidCatch = function (error) {
    if (window.console && console.error) console.error('[view] render error:', error);
  };
  ViewBoundary.prototype.render = function () {
    if (!this.state.error) return this.props.children;
    var P = palette(this.props.theme);
    var self = this;
    var message = String((this.state.error && this.state.error.message) || this.state.error);
    var savedCount = savedKeys().length;
    var hasSaved = savedCount > 0;
    var asking = Boolean(this.state.askReset);
    var cancelReset = function () {
      self.setState({ askReset: false }, function () {
        var back = document.querySelector('[data-reset-saved]');
        if (back) back.focus();
      });
    };
    var btn = function (label, onClick, primary, extra) {
      return React.createElement('button', Object.assign({
        type: 'button', onClick: onClick,
        style: primary
          ? { padding: '9px 16px', borderRadius: 4, border: 'none', cursor: 'pointer', background: (window.EODHDLinks && window.EODHDLinks.CTA_BG) || '#c2410c', color: '#fff', fontWeight: 700, fontSize: 13 }
          : { padding: '9px 16px', borderRadius: 4, cursor: 'pointer', background: 'transparent', border: P.panelBorder, color: P.muted, fontWeight: 600, fontSize: 13 },
      }, extra || {}), label);
    };
    return React.createElement('div', {
      role: 'alert',
      style: {
        margin: '0 ' + (this.props.inset || 0) + 'px 24px', padding: '20px 24px', borderRadius: 6,
        background: P.panelBg, border: P.panelBorder,
        fontFamily: "'Sora', system-ui, sans-serif", color: P.text, lineHeight: 1.6,
      },
    },
      React.createElement('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 8 } },
        'This view stopped drawing'),
      // Honest about both halves: what is left on screen, and that pressing
      // the button again is only worth it if something has changed. It used
      // to blame the API and promise that the rest of the page still worked,
      // over an app that had gone. And it promised a reload would fix it,
      // which it does not when the cause is saved in the browser.
      React.createElement('p', { style: { margin: '0 0 8px', color: P.muted, fontSize: 14 } },
        'Something in the data or the view itself was not what the code expected. '
        + 'What is above this panel still works; this view does not, and trying '
        + 'again or reloading will hit the same error unless the data behind it has changed. '
        + (hasSaved
          ? 'If it comes back after a reload, what this app saved in your browser is the likely '
            + 'cause: Reset saved data downloads a copy of it and starts the app empty.'
          : 'If it comes back after a reload, please open an issue with the message below.')),
      React.createElement('pre', {
        style: {
          margin: '0 0 18px', padding: '8px 10px', borderRadius: 4, overflowX: 'auto',
          background: P.code, fontSize: 12, fontFamily: 'ui-monospace, monospace',
          color: P.muted, whiteSpace: 'pre-wrap',
        },
      }, message),
      React.createElement('div', { style: { display: 'flex', gap: 8 } },
        React.createElement('button', {
          onClick: function () { self.setState({ error: null }); },
          style: {
            padding: '9px 16px', borderRadius: 4, border: 'none', cursor: 'pointer',
            background: 'transparent', border: P.panelBorder, color: P.muted, fontWeight: 600, fontSize: 13,
          },
        }, 'Try again'),
        React.createElement('button', {
          onClick: function () { window.location.reload(); },
          style: {
            padding: '9px 16px', borderRadius: 4, border: 'none', cursor: 'pointer',
            background: (window.EODHDLinks && window.EODHDLinks.CTA_BG) || '#c2410c', color: '#fff', fontWeight: 700, fontSize: 13,
          },
        }, 'Reload the page'),
        hasSaved && !asking
          ? btn('Reset saved data', function () { self.setState({ askReset: true }); }, false, { 'data-reset-saved': 'true' })
          : null),
      // The question, in the panel: what goes, and that a copy comes first.
      // Cancel and Escape take it back, and the focus returns to "Reset saved
      // data", which comes back in its place: it fell to <body>, and Escape did
      // nothing.
      asking && React.createElement('div', {
        role: 'group', 'aria-label': 'Reset saved data',
        onKeyDown: function (e) {
          if (e.key !== 'Escape' || e.defaultPrevented) return;
          e.preventDefault();
          e.stopPropagation();
          cancelReset();
        },
        style: { marginTop: 14, padding: '12px 14px', borderRadius: 4, border: P.panelBorder },
      },
        React.createElement('p', { style: { margin: '0 0 10px', fontSize: 14 } },
          'Remove what this app has saved in this browser (' + savedCount + (savedCount === 1 ? ' item' : ' items')
          + ') and start empty? A copy is downloaded first, so nothing is lost.'),
        React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          btn('Download a copy and reset', resetSavedData, true, { autoFocus: true }),
          btn('Cancel', cancelReset)))
    );
  };

  function snapshot() {
    var E = window.Entitlement;
    if (!E || !E.denied) return { denied: [], problem: null, anyAllowed: false };
    return { denied: E.denied(), problem: E.problem ? E.problem() : null, anyAllowed: E.anyAllowed ? E.anyAllowed() : false };
  }

  /**
   * The reader's theme: their saved choice, or what their system asks for.
   *
   * prefers-color-scheme was ignored, so a machine set to light started every
   * one of the seven in dark.
   */
  function savedTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) { /* private mode; fall through to the system preference */ }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (e) { /* older browser */ }
    return 'dark';
  }
  function saveTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* a preference, not data */ }
  }

  window.AppFrame = function (props) {
    var theme = props.theme === 'light' ? 'light' : 'dark';
    var inset = Number(props.contentInset) || 0;
    var P = palette(theme);
    var state = React.useState(snapshot);
    var current = state[0];
    var setCurrent = state[1];

    React.useEffect(function () {
      if (!window.Entitlement || !window.Entitlement.subscribe) return undefined;
      // Every capability. A refusal on the feed a view happens to open with is
      // as much this app's business as a refusal on the one it was named for.
      var off = window.Entitlement.subscribe(function () { setCurrent(snapshot()); });
      // And read once now. The views' effects run before this one (children
      // first), so an answer that arrived in between was announced to nobody
      // and the panel stayed as it was at the first render.
      setCurrent(snapshot());
      return off;
    }, []);

    // The document behind the column follows the theme: index.html paints the
    // dark ground, and a light view on a dark page would show its seams.
    React.useEffect(function () {
      if (typeof document === 'undefined' || !document.body) return;
      document.body.style.background = PAGE_BG[theme];
      document.body.style.color = P.text;
      // Native controls follow: index.html keys color-scheme off this.
      if (document.documentElement) document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    // The terminal's views sit inside a shell that supplies the page margins;
    // AppLayout is a pass-through on web and gives them none. Without this the
    // headings ran flush against the left edge and the card row spilled off
    // the right. The container belongs here rather than in AppLayout, which
    // should stay a faithful copy of the terminal's.
    var page = {
      maxWidth: 1180,
      margin: '0 auto',
      padding: '24px 20px 48px',
      boxSizing: 'border-box',
      overflowX: 'hidden',
      color: P.text,
    };

    var hintState = React.useState(aiHintDismissed);
    var mainRef = React.useRef(null);
    var dismissHint = function () {
      try { localStorage.setItem(AI_HINT_KEY, '1'); } catch (e) { /* a preference, not data */ }
      hintState[1](true);
      // The note's x is gone with the note, and focus fell to <body>: a
      // keyboard reader started over from the top of the page. It goes to
      // the app's heading, or failing that its first control.
      setTimeout(function () {
        var root = mainRef.current;
        if (!root) return;
        var a = document.activeElement;
        if (a && a !== document.body && root.contains(a)) return;
        var target = root.querySelector('h1, h2');
        if (target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        if (!target) target = root.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (target && target.focus) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } }
      }, 0);
    };

    var children = props.children;
    // The exchanges' status is asked through the client once the modules
    // are loaded (shell/api.js, adoptExchangeStatus).
    if (window.EODHD_API && window.EODHD_API._adoptExchangeStatus) window.EODHD_API._adoptExchangeStatus();
    // The view under the frame is mounted afresh for another address (its
    // key, app.js): the screen it was is left, and a loader's steps still
    // to come are not taken for it (EODHD_API.screen).
    var screenKey = children && children.key != null ? String(children.key) : null;
    React.useEffect(function () {
      return function () {
        var api = window.EODHD_API;
        if (api && api.leaveScreen) api.leaveScreen();
      };
    }, [screenKey]);
    var silent = props.silentRefusals || [];
    // Told to Entitlement before the view renders, so that what the view
    // reads from explained() and what this frame shows are the same list.
    if (window.Entitlement && window.Entitlement.setSilent) window.Entitlement.setSilent(silent);
    var shown = current.denied.filter(function (d) { return silent.indexOf(d.capability) === -1; });
    return React.createElement('main', { style: page, ref: mainRef },
      // One row: a link home on the left -- the EODHD mark, so the app says
      // whose data it is -- and the theme switch on the right.
      React.createElement('div', {
        key: 'bar',
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          margin: '-8px ' + inset + 'px 8px',
        },
      },
        React.createElement('a', {
          href: link('/', 'header'),
          target: '_blank',
          rel: 'noopener noreferrer',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 40,
            // Room for the hover ring, taken back by the margin so the mark
            // stays on the column's left edge.
            padding: '0 10px', margin: '0 -10px', borderRadius: 4,
            color: P.muted, textDecoration: 'none', fontSize: 13, fontWeight: 700, letterSpacing: 0.2,
          },
        }, mark(), 'EODHD'),
        props.onToggleTheme
          ? React.createElement('button', {
            onClick: props.onToggleTheme,
            'aria-label': theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
            title: theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
            style: {
              // 40px tall: it was 30, under what a finger can hit reliably.
              minHeight: 40, padding: '0 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
              fontFamily: "'Sora', system-ui, sans-serif",
              background: 'transparent', border: P.panelBorder, color: P.muted,
            },
          }, theme === 'light' ? 'Dark theme' : 'Light theme')
          : null),
      current.problem && window.StatusPanel
        ? React.createElement(window.StatusPanel, { key: 'status', problem: current.problem, theme: theme, inset: inset })
        : null,
      // Feeds whose refusal costs the app nothing a visitor would miss are not
      // announced (meta.json silentRefusals): the calendar asks the Screener
      // only to sort large companies first, and without it simply doesn't.
      shown.length && window.UpgradePanel
        ? React.createElement(window.UpgradePanel, {
            key: 'upgrade',
            // A refusal can cost an app only part of what it does: the
            // calendar without the Screener still lists every event, just not
            // by market cap. meta.json says so per feed (refusalNotes), and
            // the sentence follows upstream's.
            //
            // A note says what still works, so it is only true while this is
            // the one feed refused and nothing else failed: with every
            // calendar feed refused, "Earnings, splits, IPOs and economic
            // events still load; only dividends are missing" stood next to
            // the refusals of earnings, splits, IPOs and economic events.
            reasons: shown.map(function (d) {
              var alone = shown.length === 1 && (d.capabilities || [d.capability]).length === 1 && !current.problem;
              var note = alone && props.refusalNotes && Object.prototype.hasOwnProperty.call(props.refusalNotes, d.capability)
                ? props.refusalNotes[d.capability] : null;
              return note ? (d.reason || '') + ' ' + note : d.reason;
            }),
            // The sentence is only true once something else has answered 200.
            // On the free tier the calendar's thirty-one requests all came
            // back 403 and the panel still promised that everything else
            // worked, over an otherwise empty screen.
            otherFeaturesWork: Boolean(props.otherFeaturesWork) && current.anyAllowed,
            theme: theme,
            inset: inset,
          })
        : null,
      hintState[0] ? null : aiHint(props.hasAIFeatures, theme, inset, dismissHint),
      // Where the view's own lines are looked for (Entitlement: a failure
      // the screen says itself leaves the panel only while its line is on
      // the page) -- never in the panels above. No box of its own.
      React.createElement('div', { key: 'view', 'data-app-view': 'true', style: { display: 'contents' } },
        React.createElement(ViewBoundary, { theme: theme, inset: inset }, children)),
      footer(theme, inset)
    );
  };
  window.AppFrame.savedTheme = savedTheme;
  window.AppFrame.savedKeys = savedKeys;
  window.AppFrame.resetSavedData = resetSavedData;
  window.AppFrame.saveTheme = saveTheme;
})();
