/**
 * Stand-ins for parts of the terminal that a standalone app either does not
 * have, or must not have.
 *
 * Load order matters: this must run before any vendored module, because they
 * read these at definition time as well as at render time.
 */

// The vendored modules branch on this. There is no Telegram here. Two of them
// (HelpTooltip, PortalDropdown) listened for Telegram's viewport events as
// well; the generator replaces that lookup with null on the way in, so no
// reference to window.Telegram survives into vendor/.
window.APP_PLATFORM = 'WEB';

// On web the terminal's AppLayout is already a pass-through — it exists to
// render the Telegram bottom navigation, and returns children untouched
// otherwise. Reproducing that literally is the whole shim.
window.AppLayout = function (props) {
  return props.children;
};

// Absorb anything. The vendored modules call Haptics on interactions and
// MIAnalytics on navigation; both are meaningless outside the product.
//
// MIAnalytics is not merely disabled — the terminal's implementation pushes
// into Google Tag Manager's dataLayer, and vendoring that would mean every
// developer running a sample on their own machine reports back to us, without
// being asked and without an obvious way to notice. It must not be in the tree
// at all, which is why this file substitutes rather than configures.
function absorbEverything() {
  var noop = function () {};
  return new Proxy({}, {
    get: function () { return noop; },
    // Modules sometimes test for a method before calling it.
    has: function () { return true; },
  });
}

window.Haptics = absorbEverything();
window.MIAnalytics = absorbEverything();

// There is no demo mode. A visitor without a key sees the key screen; they do
// not see a degraded view of somebody else's data. This is the decision that
// the whole project rests on — these apps exist so that a developer takes out
// a subscription, or the free tier, and pastes a key.
window.DEMO_API_KEY = null;

// Server-side in the terminal, and absent here. null rather than undefined
// because the modules guard with `window.TokenManager && ...`, so null is the
// shape they already read as "not available".
window.TokenManager = null;

// Syncs watchlists and settings to our backend. A standalone app has no
// account to sync to, and the modules already treat its absence as "work from
// local state", which is exactly right here.
window.DataSync = null;

// The path prefix our own hosting sits under. Meaningless once the app is on
// somebody else's machine; empty keeps the string concatenations honest.
window.MI_PUBLIC_PREFIX = '';

/**
 * The terminal's paywall, which does not exist here.
 *
 * PaywallGate wraps a feature and shows a purchase prompt when the plan does
 * not cover it. In a repository somebody cloned, there is nothing to purchase
 * from us -- their plan is between them and EODHD -- so it passes its children
 * through. A refusal still shows up, from the 403 that actually happens, in
 * the panel that reads it.
 */
window.PaywallGate = function (props) {
  return props.children || null;
};

/**
 * Minimal markdown, for the AI answers the modules render.
 *
 * The terminal's version lives inside a 44KB aiService.js that also carries
 * our own backend provider. Eighty-two lines of it are worth having; the rest
 * is not, and vendoring the file to reach them would drag our billing into a
 * public repository.
 *
 * Returns React elements, not an HTML string. The call sites are
 *
 *     window.renderMarkdown ? window.renderMarkdown(result) : result
 *
 * placed directly among JSX children, and React renders a string as text --
 * so the first version of this, which built HTML and escaped it carefully,
 * put "<p>AI provider: ..." on the screen, angle brackets and all. That is
 * every AI answer in every app, and no test caught it: they all asserted on
 * the string this used to return. It took clicking the button.
 *
 * Elements are also the safer shape. Escaping stops being something this
 * function has to remember, because React never interprets a text node as
 * markup -- a model that answers in HTML is displayed, not executed.
 *
 * Deliberately small: headings, bold, italic, inline code, bullets.
 */
window.renderMarkdown = function (text) {
  if (!text) return null;

  var key = 0;

  // **bold**, *italic* and `code` inside a single line.
  function inline(line) {
    var parts = [];
    var re = /\*\*(.+?)\*\*|\*([^*]+?)\*|`([^`]+?)`/g;
    var last = 0;
    var m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.substring(last, m.index));
      if (m[1]) parts.push(React.createElement('strong', { key: 'i' + key++ }, m[1]));
      else if (m[2]) parts.push(React.createElement('em', { key: 'i' + key++ }, m[2]));
      else parts.push(React.createElement('code', {
        key: 'i' + key++,
        style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.92em' },
      }, m[3]));
      last = re.lastIndex;
    }
    if (last < line.length) parts.push(line.substring(last));
    return parts.length ? parts : [line];
  }

  var out = [];
  String(text).split('\n').forEach(function (line, index) {
    if (!line.trim()) {
      // A gap, not a <br>. Consecutive blank lines collapse into one.
      if (index > 0) out.push(React.createElement('div', { key: 'b' + key++, style: { height: 8 } }));
      return;
    }

    var heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      out.push(React.createElement('div', {
        key: 'h' + key++,
        style: { fontSize: { 1: 17, 2: 15, 3: 14 }[heading[1].length], fontWeight: 700, margin: '6px 0 2px' },
      }, inline(heading[2])));
      return;
    }

    var bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) {
      out.push(React.createElement('div', {
        key: 'l' + key++,
        style: { display: 'flex', gap: 8, margin: '2px 0' },
      },
        React.createElement('span', { style: { opacity: 0.5 } }, '•'),
        React.createElement('span', null, inline(bullet[1]))));
      return;
    }

    out.push(React.createElement('div', { key: 'p' + key++, style: { margin: '2px 0' } }, inline(line)));
  });

  return out;
};
