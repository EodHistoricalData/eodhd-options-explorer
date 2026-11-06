/**
 * The key gate.
 *
 * These apps do nothing without an EODHD key. That is the point of them: the
 * developer takes out a subscription, or the free tier, pastes the key, and
 * the thing comes alive. There is no demo mode and no sample data — a
 * degraded view would undercut the only thing the app exists to show.
 *
 * The key lives in .env and is read by the proxy. It is never entered in the
 * browser, never stored in localStorage, and never appears in a URL the client
 * builds. This module therefore has no way to set a key; it only reports
 * whether the proxy has one, and if not, says which file to edit.
 *
 * Boot spends zero upstream requests. The free tier allows twenty a day and
 * none of them should go on questions the developer did not ask.
 */
(function () {
  var STATUS_URL = '/api/_status';

  var NO_KEY =
    'No API key configured. Copy .env.example to .env and set EODHD_API_KEY, ' +
    'then restart the server.';
  var NO_SERVER =
    'The local server is not responding. Run npm start in this directory, ' +
    'then reload.';

  function refusedPlaceholder(value, why) {
    if (why === 'short') {
      return 'EODHD_API_KEY is set to "' + value + '", which is too short to be an ' +
        'EODHD key -- they are twenty-odd characters. Check .env for a value ' +
        'that was cut off, then restart.';
    }
    return 'EODHD_API_KEY is set to "' + value + '", which this app treats as ' +
      'unset. Placeholders and the public "demo" token are refused: these apps ' +
      'run on your own key, and a shared one would only show you somebody ' +
      'else\'s plan. Put a real one in .env and restart.';
  }

  function check() {
    return fetch(STATUS_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (body) {
        // Anything other than an explicit boolean is treated as "not ready".
        // A malformed answer must not read as permission to carry on.
        if (!body || typeof body.hasKey !== 'boolean') {
          return { ready: false, reason: NO_SERVER, hasAI: false };
        }
        // Deliberately does not pass `body` through -- each field is copied
        // across by name. If a future proxy change ever put a key in this
        // response, it would stop here rather than reach anything that renders.
        var hasAI = body.hasAI === true;
        // A hash prefix of the key, used only to name browser-side caches.
        if (typeof body.keyTag === 'string' && /^[0-9a-f]{16}$/.test(body.keyTag)) window.EODHD_KEY_TAG = body.keyTag;
        if (body.hasKey) return { ready: true, reason: null, hasAI: hasAI };
        // The proxy sends this only when the configured value was one of its
        // refused placeholders, so it is never a key. Saying "no API key
        // configured" to somebody who typed "demo" reads as the app not having
        // noticed; the server console has always said the right thing, and
        // this is the surface a person is actually looking at.
        var ignored = typeof body.ignoredKey === 'string' ? body.ignoredKey.trim() : '';
        return {
          ready: false,
          reason: ignored ? refusedPlaceholder(ignored, body.ignoredWhy) : NO_KEY,
          hasAI: hasAI,
        };
      })
      .catch(function () {
        return { ready: false, reason: NO_SERVER, hasAI: false };
      });
  }

  /**
   * The screen shown instead of the app.
   *
   * It said "One step left", the reason and "the free tier is enough to try
   * this out" -- the same page in all seven apps, with no name on it, and the
   * last sentence false for the four that need a paid feed. It now
   * says which app this is, what it does and what its key has to reach, from
   * the app's own meta.json by way of boot.js. It follows the reader's theme,
   * as the app will once it opens.
   */
  function screen(reason) {
    var meta = window.APP_META || {};
    var theme = (window.AppFrame && window.AppFrame.savedTheme) ? window.AppFrame.savedTheme() : 'dark';
    var P = window.ShellPalette ? window.ShellPalette(theme) : { text: '#E9E6DF', muted: '#A39B89' };
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.background = theme === 'light' ? '#F4F3EF' : '#0d0d12';
      document.body.style.color = P.text;
      if (document.documentElement) document.documentElement.setAttribute('data-theme', theme);
    }
    var register = window.EODHDLinks ? window.EODHDLinks.url('/register', 'gate') : 'https://eodhd.com/register';
    var box = {
      maxWidth: 560, margin: '14vh auto 0', padding: '32px 20px',
      fontFamily: "'Sora', system-ui, sans-serif", lineHeight: 1.6,
      color: P.text, boxSizing: 'border-box',
    };
    var muted = { color: P.muted };
    return React.createElement('main', { style: box },
      React.createElement('h1', { style: { fontSize: 22, margin: '0 0 6px' } },
        meta.title || 'EODHD sample app'),
      meta.description
        ? React.createElement('p', { style: Object.assign({ margin: '0 0 24px', fontSize: 15 }, muted) }, meta.description)
        : null,
      React.createElement('h2', { style: { fontSize: 16, margin: '0 0 8px' } }, 'One step left'),
      React.createElement('p', { style: Object.assign({ margin: '0 0 16px' }, muted) }, reason),
      meta.keyNote
        ? React.createElement('p', { style: Object.assign({ margin: '0 0 20px', fontSize: 14 }, muted) }, meta.keyNote)
        : null,
      React.createElement('a', {
        href: register,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: {
          display: 'inline-block', padding: '11px 18px', borderRadius: 4,
          // White on the brand orange is 2.8:1; this step of it is 5.2:1.
          background: (window.EODHDLinks && window.EODHDLinks.CTA_BG) || '#c2410c', color: '#fff',
          textDecoration: 'none', fontWeight: 700,
        },
      }, 'Get an API key'),
      React.createElement('p', { style: Object.assign({ margin: '20px 0 0', fontSize: 13 }, muted) },
        'Your key stays in .env on this machine and is never sent to the browser.')
    );
  }

  // 'free', 'paid' or null on window.EODHD_PLAN. Never throws, never waits
  // more than PLAN_WAIT_MS.
  var PLAN_URL = '/api/_plan';
  var PLAN_WAIT_MS = 6000;
  function askPlan() {
    window.EODHD_PLAN = null;
    var asked = fetch(PLAN_URL)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        var plan = body && body.plan;
        window.EODHD_PLAN = plan === 'free' || plan === 'paid' ? plan : null;
      })
      .catch(function () {});
    var late = new Promise(function (resolve) { setTimeout(resolve, PLAN_WAIT_MS); });
    return Promise.race([asked, late]);
  }

  function guard(mount) {
    return check().then(function (state) {
      // The AI affordances render only when the proxy actually holds a model
      // key, so a developer without one sees no AI buttons rather than buttons
      // that explain themselves away.
      if (window.AIService && window.AIService.setAvailable) {
        window.AIService.setAvailable(state.hasAI);
      }
      if (state.ready) {
        // An app whose first screen depends on the plan (meta.json askPlan)
        // waits for the answer, at most a few seconds; without one it mounts
        // as on the free tier.
        if (!window.EODHD_ASK_PLAN) { mount(); return state; }
        return askPlan().then(function () { mount(); return state; });
      }
      var root = document.getElementById('root');
      if (root && window.ReactDOM && window.React) {
        ReactDOM.createRoot(root).render(screen(state.reason));
      }
      return state;
    });
  }

  window.KeyGate = { check: check, screen: screen, guard: guard, askPlan: askPlan };
})();
