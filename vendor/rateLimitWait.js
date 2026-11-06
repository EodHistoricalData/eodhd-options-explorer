// RATE-LIMIT-WAIT: the one 429 wait, its note and its countdown, for every
// screen. It used to live inside calendar.js and heatmap.js; the
// terminal shares one bundle, so the other screens found it, but an open app
// built without one of those two had no window.RateLimitWait and its
// countdown never moved. Now its own file, loaded before
// every view that reads it.
//
// Until when a Try again should wait after a 429, as epoch ms; 0 when it
// need not. The client keeps the wait: the terminal's EODHD_API back-off
// and the open apps' shell (rateLimitedUntil), both from Retry-After when
// the answer gives one. Only a client without rateLimitedUntil falls back to
// the refusal its Entitlement recorded, and waits a minute from when a view
// first sees it.
window.RateLimitWait = (function () {
  var MINUTE = 60000;
  var seen = { seq: null, at: 0 };

  // Retry-After in ms: seconds ("20") or an HTTP date (RFC 9110). Missing
  // or unreadable is null: the caller keeps its own default. So is a wait
  // of 0 or less ("0", a date already past, a clock ahead of the server's):
  // read as "no wait", every Try again went straight into the same 429.
  function parseRetryAfter(value, now) {
    var v = value == null ? '' : String(value).trim();
    if (!v) return null;
    var ms = null;
    if (/^\d+$/.test(v)) ms = Number(v) * 1000;
    // Every HTTP date form starts with the day's name; "-5" or "1.5" would
    // otherwise parse as some date long past.
    else if (/^[A-Za-z]{3}/.test(v)) {
      var at = Date.parse(v);
      if (Number.isFinite(at)) ms = at - (now == null ? Date.now() : now);
    }
    return ms != null && ms > 0 ? ms : null;
  }

  function until() {
    var now = Date.now();
    var A = window.EODHD_API;
    if (A && typeof A.rateLimitedUntil === 'function') {
      // The client's own wait is the answer: it read Retry-After, and a
      // fixed minute on top of it kept Retry-After: 20 waiting 60 s.
      var t = 0;
      try { t = Number(A.rateLimitedUntil()) || 0; } catch (_) { t = 0; }
      return t > now ? t : 0;
    }
    var E = window.Entitlement;
    var p = null;
    try { p = E && typeof E.problem === 'function' ? E.problem() : null; } catch (_) { p = null; }
    var u = 0;
    if (p && p.status === 429) {
      if (seen.seq !== p.seq || !seen.at) seen = { seq: p.seq, at: now };
      u = seen.at + MINUTE;
    } else if (seen.at && seen.at + MINUTE > now) {
      // Another feed's 500 or a dropped connection, recorded after the 429,
      // does not end the minute.
      u = seen.at + MINUTE;
    } else {
      seen = { seq: null, at: 0 };
    }
    return u > now ? u : 0;
  }

  // Seconds left of the wait (at least 1 while it runs), 0 when none.
  function secondsLeft() {
    var u = until();
    return u ? Math.max(1, Math.ceil((u - Date.now()) / 1000)) : 0;
  }

  // What a press inside the wait says, the same on every screen.
  var HELD = "Not sent: EODHD's per-minute request limit is still in force.";
  function note(left) {
    var s = left == null ? secondsLeft() : left;
    return s ? HELD + ' Try again in ' + s + ' s.' : null;
  }
  // What a screen reader hears when a wait it was told about is over.
  var OVER = 'The wait is over: requests are sent again.';

  // ── Said once, not every second ───────────────────────────────────────
  // A count that changes every second inside role=status was read out
  // every second, "Not sent … Try again in 14 s." over and over.
  // The counts stay on screen, outside any live region; what
  // a screen reader is told goes through this one region, twice per wait:
  // when it starts (with the seconds of that moment) and when it is over.
  // One region for the page, there before anything is put in it: a region
  // added together with its words is not read by every reader. Repeated
  // words within a moment are said once (two views, one press).
  var live = { el: null, said: '', at: 0, clear: null, put: null };
  function liveRegion() {
    if (typeof document === 'undefined' || !document.body) return null;
    if (live.el && document.body.contains(live.el)) return live.el;
    var el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('data-rl-live', 'true');
    // Visually hidden, not display:none: hidden that way it is not read.
    el.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;';
    document.body.appendChild(el);
    live.el = el;
    return el;
  }
  function announce(text) {
    var t = String(text || '').trim();
    if (!t) return;
    var now = Date.now();
    if (t === live.said && now - live.at < 2000) return;
    live.said = t; live.at = now;
    var el = liveRegion();
    if (!el) return;
    if (live.put) clearTimeout(live.put);
    if (live.clear) clearTimeout(live.clear);
    // Emptied first and filled a moment later: the same sentence twice in a
    // row is then a change, and a region just added is in place before it.
    el.textContent = '';
    live.put = setTimeout(function () { live.put = null; el.textContent = t; }, 60);
    // Not left behind for a reader browsing the page later.
    live.clear = setTimeout(function () { live.clear = null; if (el.textContent === t) el.textContent = ''; }, 7000);
  }

  // The words for a request the limit refused, on every screen.
  var REACHED = "EODHD's per-minute request limit was reached.";
  // The words for an answer that came back and could not be read.
  var UNREADABLE = 'EODHD sent a response the app could not read.';

  // A retry button's words: "Try again in 12 s" while the wait runs.
  function label(base, left) {
    var b = base || 'Try again';
    return left ? b + ' in ' + left + ' s' : b;
  }

  // The wait for a React view: `left` counts down once a second while it
  // runs; hold() is for a Try again / Refresh press -- true (and the note
  // shows) when the press must send nothing; `note` is the line to show,
  // null when nothing was held or the wait is over.
  // A wait started by any request (a background quote, another tab) is
  // followed: the client says so with "api:rate-limited", and a Try again
  // already on screen starts counting at once. It read the wait only when
  // something else drew it, and said a plain "Try again" under a bar
  // counting 20 s.
  function useWait() {
    var R = window.React;
    var asked = R.useState(false);
    var tick = R.useState(0);
    var u = until();
    var left = u ? Math.max(1, Math.ceil((u - Date.now()) / 1000)) : 0;
    R.useEffect(function () {
      var bump = function () { tick[1](function (n) { return n + 1; }); };
      window.addEventListener('api:rate-limited', bump);
      window.addEventListener('api:rate-limit-cleared', bump);
      return function () {
        window.removeEventListener('api:rate-limited', bump);
        window.removeEventListener('api:rate-limit-cleared', bump);
      };
    }, []);
    // Re-drawn on the second the count changes, as the global notice is:
    // a steady 1 s interval left the two a second apart.
    R.useEffect(function () {
      if (!u) return undefined;
      var ms = u - Date.now();
      var t = setTimeout(function () { tick[1](function (n) { return n + 1; }); }, (ms > 0 ? (ms % 1000 || 1000) : 0) + 5);
      return function () { clearTimeout(t); };
    }, [u, tick[0]]);
    // A press that was held is told when the wait it was held by is over
    // (the note goes; the count it showed is not read out).
    R.useEffect(function () { if (!left && asked[0]) { asked[1](false); announce(OVER); } }, [left, asked[0]]);
    return {
      until: u,
      left: left,
      note: asked[0] && left ? note(left) : null,
      hold: function () {
        var u2 = until();
        if (!u2) { asked[1](false); return false; }
        // Said once, when the press is held; the note on screen counts on
        // without being read again.
        if (!asked[0]) announce(note(Math.max(1, Math.ceil((u2 - Date.now()) / 1000))));
        asked[1](true);
        tick[1](function (n) { return n + 1; });
        return true;
      },
    };
  }

  // Whether a screen's failure was the limit: true while the wait runs, if
  // it was already running when `failure` (the screen's error, a new value
  // for each failed load) appeared. A 500 that came before another
  // request's 429 stays "did not answer"; only the button says when it can
  // be pressed.
  function useCause(failure) {
    var R = window.React;
    var seen = R.useRef({ failure: null, limited: false });
    var u = until();
    if (!failure) seen.current = { failure: null, limited: false };
    else if (seen.current.failure !== failure) seen.current = { failure: failure, limited: !!u };
    return !!(seen.current.limited && u);
  }

  // Work a Try again cannot add to, while it runs, by name: "prices" is the
  // portfolio's quotes, asked by Try again ('retry') or by anything else
  // ('load'). Every RetryButton with that `busyKey`, on whichever panel,
  // reads "Loading…" with aria-busy and sends nothing more when pressed; it
  // stays where it is, and the focus with it. A press during the reload did
  // nothing and said nothing on Monte Carlo, Rebalance, Macro, Allocation
  // and Health, which kept "none came back" up until it ended.
  var busy = {};
  var busyWatchers = [];
  function tellBusy() {
    busyWatchers.slice().forEach(function (f) { try { f(); } catch (_) { /* one view's trouble */ } });
  }
  // Returns the run's token, for endBusy: a run that ends after a newer one
  // began (another portfolio, a page left and opened again) ends only its own.
  function setBusy(key, kind) {
    if (!key || (!busy[key] && !kind)) return null;
    busy[key] = kind ? { kind: kind } : null;
    tellBusy();
    return busy[key];
  }
  function endBusy(key, token) {
    if (!key || !token || busy[key] !== token) return;
    busy[key] = null;
    tellBusy();
  }
  // false, or what is running: 'retry' / 'load'.
  function busyOf(key) { return (key && busy[key] && busy[key].kind) || false; }
  // For a React view: redrawn when it starts or ends. A plain state asks for
  // the redraw, so it lands in the same batch as the updates the load makes
  // when it ends (the prices, the end of "loading").
  function useBusy(key) {
    var R = window.React;
    var now = !!busyOf(key);
    var s = R.useState(now);
    R.useEffect(function () {
      if (!key) return undefined;
      var sync = function () { s[1](!!busyOf(key)); };
      busyWatchers.push(sync);
      sync();
      return function () { var i = busyWatchers.indexOf(sync); if (i !== -1) busyWatchers.splice(i, 1); };
    }, [key]);
    return now;
  }

  // How a retry button looks while the wait runs: outlined and muted, as
  // the calendar's and the heatmap's do. aria-disabled, not disabled, so it
  // keeps the focus and a press can say why nothing was sent.
  // In the Mini App there is no cursor to turn into "not allowed", the one
  // sign of it on the web: the button is dimmed there as well, and a tap
  // does not flash.
  function waitLook(isDark) {
    var C3 = window.C3 || {};
    var look = {
      background: 'transparent',
      border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'),
      color: isDark ? (C3.textMutedDark || 'rgba(255,255,255,0.7)') : (C3.textMutedLight || 'rgba(0,0,0,0.7)'),
      cursor: 'not-allowed',
    };
    if (window.APP_PLATFORM === 'TELEGRAM') {
      look.opacity = 0.6;
      look.WebkitTapHighlightColor = 'transparent';
    }
    return look;
  }

  // ── A failed load, said the same way on every screen ──────────────────
  // What a load that failed was, kept from the moment it failed: the wait
  // that is running now says nothing about a failure once it is over, and
  // "limit" must not turn into "did not answer" on the second the button
  // clears. `err`: what the client threw (status, statusCode, upstreamStatus,
  // rateLimited), or nothing when it answered null -- most of EODHD_API
  // does -- and then the wait decides: inside it nothing is sent at all.
  // `unreadable`: an answer came back that could not be read -- an HTML page
  // with 200, JSON of another shape. It is its own failure: with no status
  // it read "EODHD did not answer, or the connection dropped",
  // which sent people to check a connection that was fine.
  function failure(err) {
    var o = err && typeof err === 'object' ? err : null;
    var st = o ? (Number(o.upstreamStatus) || Number(o.status) || Number(o.statusCode) || 0) : 0;
    var unreadable = Boolean(o && o.unreadable);
    var limited = o
      ? Boolean(o.rateLimited || st === 429 || o.name === 'EODHDRateLimitError' || (!st && !unreadable && until()))
      : Boolean(until());
    var f = { limited: limited, status: limited ? 429 : st, at: Date.now() };
    if (unreadable && !limited) f.unreadable = true;
    return f;
  }
  // An answer that came back and could not be read, for a client to throw:
  // failure() reads it as its own kind. `status`: the answer's (200 for a
  // page of HTML served as data).
  // A 200 whose body is a message and nothing else -- {"message":
  // "temporarily unavailable"} -- is no data: an answer that could not be
  // read, never "nothing" and never kept (the terminal's cache
  // kept such bodies for 30 s to a day, Macro read them as "No data"). A
  // body with `errors` is not one of them: the screener reads EODHD's
  // {"errors": {"offset": ...}} as its page limit.
  var MESSAGE_KEYS = { message: 1, status: 1, statusCode: 1, success: 1, detail: 1 };
  function notData(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (body.unreadable === true) return true;
    if (typeof body.message !== 'string') return false;
    return Object.keys(body).every(function (k) { return MESSAGE_KEYS[k] === 1; });
  }
  function unreadableError(message, status) {
    var e = new Error(message || 'Invalid response from API');
    e.unreadable = true;
    if (status) e.status = status;
    return e;
  }

  // The sentence for a failure, `what` first ("The price history"): the
  // limit, a refusal, EODHD's own error, or no answer -- never "no data".
  function failText(what, f) {
    var w = what || 'The data';
    if (f && (f.status === 402 || f.status === 403) && !f.limited && !f.unreadable) return w + ' is not included in this plan (' + f.status + ').';
    return w + ' did not load' + (f ? ': ' + failReason(f) : '.');
  }
  // The reason alone, for a screen with words of its own before it.
  function failReason(f) {
    if (!f) return 'EODHD did not answer, or the connection dropped.';
    if (f.limited) return REACHED;
    if (f.unreadable) return UNREADABLE;
    if (f.status === 401) return 'EODHD did not accept the API key (401).';
    if (f.status === 402 || f.status === 403) return 'it is not included in this plan (' + f.status + ').';
    if (f.status >= 500) return 'EODHD answered with an error (' + f.status + ').';
    if (f.status) return 'EODHD answered ' + f.status + '.';
    return 'EODHD did not answer, or the connection dropped.';
  }
  // A load that failed rather than answered (the limit, EODHD's error, a
  // dropped connection, an answer that could not be read): its failure(),
  // else null. A 404, a 400 or a plan's refusal is an answer -- the screen
  // keeps its words for "nothing" there. `err`: what the client threw, or a
  // list of what several requests threw (the first failure among them).
  function outage(err) {
    var list = Array.isArray(err) ? err : [err];
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      var f = failure(list[i]);
      if (f.limited || f.unreadable || !f.status || f.status >= 500) return f;
    }
    return null;
  }

  // A panel the limit stopped loads again by itself once the wait is over:
  // with no button on it, Macro said N/A until the tab was left and opened
  // again, and the price chart stayed "No data
  // available". `failed`: the panel's failure() while it stands
  // (a new one re-arms), null when there is none or it was not the limit.
  // The wait is looked at once a second, not timed to its end: another 429
  // can lengthen it, and the clock can move.
  // The automatic reload is paced per panel, so a server that keeps
  // answering 429 with Retry-After: 1 does not make a panel ask once a
  // second for ever: at least RELOAD_FLOOR after the failure,
  // doubled for each limited failure that answered the panel's own
  // automatic reload (no success in between), up to RELOAD_MAX. A failure
  // that did not follow its reload (a success came between, or a press long
  // after) starts again at the floor. The client's wait -- what the buttons
  // count down, Retry-After -- is not changed:
  // a press is never held longer than it.
  var RELOAD_FLOOR = 5000;
  var RELOAD_MAX = 120000;
  // The reload's own answer comes within the request's deadline (25 s).
  var CHAIN_MS = 30000;
  var streaks = {};
  function streakOf(key, f) {
    var s = streaks[key];
    if (s && s.f === f) return s.n;
    var chained = Boolean(s && s.reloadedAt && f.at >= s.reloadedAt && f.at - s.reloadedAt <= CHAIN_MS);
    var n = chained ? Math.min(s.n + 1, 30) : 1;
    streaks[key] = { f: f, n: n, reloadedAt: 0 };
    return n;
  }
  function reloadDelay(n) {
    return Math.min(RELOAD_MAX, RELOAD_FLOOR * Math.pow(2, Math.max(0, (n || 1) - 1)));
  }
  // When a panel's automatic reload is due after failure `f` (epoch ms):
  // the end of the client's wait, and never before the panel's own pace.
  function reloadAt(f, key) {
    var n = streakOf(key || 'panel', f);
    return Math.max(until(), (f.at || Date.now()) + reloadDelay(n));
  }

  // Whether the focus is on a failed panel's Try again (or inside its
  // line) right now. The reload after the wait is a Try again pressed for
  // the person: when the focus was there it is put back as after a press
  // from the keyboard (the Try again again on another failure, else the
  // heading); when it was elsewhere the reload leaves it alone. The index
  // list's reload skipped that and the focus fell to <body>.
  function focusOnRetry(scope) {
    if (typeof document === 'undefined') return false;
    var a = document.activeElement;
    if (!a || a === document.body || !a.closest) return false;
    if (scope && scope.contains && !scope.contains(a)) return false;
    return Boolean(a.closest('[data-retry-focus], [data-rl-fail]'));
  }

  function useReloadAfterWait(failed, reload, key) {
    var R = window.React;
    var ref = R.useRef(reload);
    ref.current = reload;
    var k = key || 'panel';
    R.useEffect(function () {
      if (!failed || !failed.limited) return undefined;
      var off = false;
      var t = null;
      var due = reloadAt(failed, k);
      var check = function () {
        if (off) return;
        // Another 429 can lengthen the client's wait meanwhile.
        due = Math.max(due, until());
        var left = due - Date.now();
        if (left > 0) { t = setTimeout(check, Math.min(1000, left + 20)); return; }
        off = true;
        if (streaks[k]) streaks[k].reloadedAt = Date.now();
        if (typeof ref.current === 'function') ref.current();
      };
      check();
      return function () { off = true; if (t) clearTimeout(t); };
    }, [failed, k]);
  }

  // A second press of a button whose paid request is still on its way joins
  // it rather than paying again -- while that request is young. One that
  // hangs longer is replaced by the next press. The same window as the open
  // apps' shell joins identical requests in (shell/api.js JOIN_WINDOW_MS).
  var JOIN_MS = 3000;
  function joins(startedAt, now) {
    return Boolean(startedAt) && (now == null ? Date.now() : now) - startedAt < JOIN_MS;
  }

  // A press inside the wait, on the Mini App: Telegram's own "refused"
  // feedback, so the tap is not felt as one that went through.
  function felt() {
    if (window.APP_PLATFORM !== 'TELEGRAM') return;
    try { if (window.Haptics && window.Haptics.warning) window.Haptics.warning(); } catch (_) { /* a courtesy */ }
  }

  // A Try again that waits out the limit: "Try again in N s", muted and
  // aria-disabled while the wait runs, and a press inside it sends nothing.
  // `wait`: the view's own useWait(), so its note shows on a held press;
  // without it the button keeps its own.
  // A press inside the wait says why nothing was sent, next to the button
  // that was pressed. A button with no `wait` of its view showed the note
  // nowhere -- Portfolio's Health, Analytics and Macro panels -- and on a
  // phone a press "did nothing". `noteHere`: true to
  // show it here even with a `wait` (the view's own note is out of sight).
  // `busyKey`: the work it retries (setBusy); while that runs the button
  // reads "Loading…", is aria-busy, and a press sends nothing more.
  function RetryButton(props) {
    var R = window.React;
    var own = useWait();
    var w = props.wait || own;
    var working = useBusy(props.busyKey);
    var rest = {};
    Object.keys(props).forEach(function (k) {
      if (['wait', 'isDark', 'label', 'onClick', 'style', 'children', 'noteHere', 'onHeld', 'busyKey'].indexOf(k) === -1) rest[k] = props[k];
    });
    var base = props.label || props.children || 'Try again';
    // This button's own press was held (its note shows) until the wait ends.
    var mine = R.useState(false);
    R.useEffect(function () { if (mine[0] && !w.left) mine[1](false); }, [mine[0], w.left]);
    var button = R.createElement('button', Object.assign({ type: 'button' }, rest, {
      'aria-disabled': !working && w.left ? 'true' : rest['aria-disabled'],
      'aria-busy': working ? 'true' : rest['aria-busy'],
      'data-rl-wait': !working && w.left ? String(w.left) : undefined,
      onClick: function (e) {
        if (busyOf(props.busyKey)) return;
        if (w.hold()) {
          mine[1](true);
          felt();
          if (props.onHeld) props.onHeld(e);
          return;
        }
        if (props.onClick) props.onClick(e);
      },
      style: Object.assign({}, props.style, working ? { cursor: 'progress' } : w.left ? waitLook(props.isDark) : null),
    }), working ? 'Loading…' : label(base, w.left));
    var here = props.noteHere != null ? props.noteHere : !props.wait;
    if (!here || !mine[0] || !w.left) return button;
    var C3 = window.C3 || {};
    // Not a live region: its count changes every second. The press was
    // announced once by hold(), and the end of the wait will be.
    return R.createElement(R.Fragment, null, button,
      R.createElement('span', {
        'data-rl-note': 'true',
        style: { display: 'block', marginTop: 6, fontSize: 12, fontWeight: 400, lineHeight: 1.4,
          color: props.isDark ? (C3.textDark || '#E0E3EB') : (C3.textLightTheme || '#1e1b4b') },
      }, note(w.left)));
  }

  // A failed panel's line: what failed and why, its Try again (counting the
  // wait down), and -- when the limit was why -- a reload of its own once
  // the wait is over. The words are a live region; the button stays outside
  // it.
  // props: what ("The price history"), failure (failure()), onRetry,
  // isDark, text (instead of failText), label, style, buttonStyle, autoRetry
  // (false: the button only), extra (a sentence after the reason),
  // ownFocus (true: the view puts the focus back itself after a retry).
  //
  // The focus after a retry -- pressed, or the reload after the wait -- when
  // it was on this line: the line leaves while the panel loads, and the
  // focus fell to <body> (Macro's tabs, Portfolio's analytics, the
  // dashboard). It goes to the
  // heading before the line while the panel loads, and to the line's Try
  // again when the same panel fails again; focus the person moved elsewhere
  // is left alone. A view with its own rule says ownFocus.
  var refocus = null;
  var HEADINGS = 'h1, h2, h3';
  function headingsBefore(box) {
    if (typeof document === 'undefined' || !box) return [];
    return Array.prototype.slice.call(document.querySelectorAll(HEADINGS)).filter(function (h) {
      return !box.contains(h) && Boolean(h.compareDocumentPosition(box) & 4);
    }).reverse();
  }
  function useRetryFocus(boxRef, panel, own) {
    var R = window.React;
    var mine = R.useRef({ panel: panel, own: own });
    mine.current = { panel: panel, own: own };
    (R.useLayoutEffect || R.useEffect)(function () {
      var r = refocus;
      if (r && r.panel === panel && Date.now() - r.at < 60000) {
        refocus = null;
        var a = document.activeElement;
        var b = boxRef.current && boxRef.current.querySelector('button');
        if (b && (!a || a === document.body || a === r.home)) b.focus();
      }
      return function () {
        var box = boxRef.current;
        var m = mine.current;
        if (m.own || !box || typeof document === 'undefined') return;
        var a = document.activeElement;
        if (!a || a === document.body || !box.contains(a)) return;
        // Still on the page here; the line goes when this returns.
        var homes = headingsBefore(box);
        var at = { panel: m.panel, at: Date.now(), home: null };
        refocus = at;
        setTimeout(function () {
          var now = document.activeElement;
          if (refocus !== at || (now && now !== document.body && document.contains(now))) return;
          var home = homes.filter(function (h) { return document.contains(h); })[0];
          if (!home) return;
          if (!home.hasAttribute('tabindex')) home.setAttribute('tabindex', '-1');
          at.home = home;
          home.focus();
        }, 0);
      };
    }, []);
  }

  function FailNote(props) {
    var R = window.React;
    var f = props.failure;
    var w = useWait();
    var panel = props.panel || props.what || props.text;
    // `panel`: the name its automatic reloads are paced by (useReloadAfterWait).
    useReloadAfterWait(props.autoRetry === false || !props.onRetry ? null : f, props.onRetry, panel);
    var boxRef = R.useRef(null);
    useRetryFocus(boxRef, panel, Boolean(props.ownFocus));
    var C3 = window.C3 || {};
    // The reason is a live region and is read when it appears; the held
    // press's note after it counts down every second, so it is outside
    // and said once by the wait itself.
    var words = (props.text || failText(props.what, f)) + (props.extra ? ' ' + props.extra : '');
    return R.createElement('div', {
      ref: boxRef,
      'data-rl-fail': f && f.limited ? 'limit' : 'other',
      style: Object.assign({ fontSize: 13, lineHeight: 1.5, color: props.isDark ? (C3.textDark || '#E0E3EB') : (C3.textLightTheme || '#1e1b4b') }, props.style),
    },
      R.createElement('span', { role: 'status' }, words),
      w.note ? R.createElement('span', { 'data-rl-count': 'true' }, ' ' + w.note) : null,
      props.onRetry ? R.createElement(RetryButton, {
        wait: w, isDark: props.isDark, label: props.label, onClick: props.onRetry, 'data-retry-focus': props['data-retry-focus'],
        style: Object.assign({ marginLeft: 8, padding: '4px 12px', minHeight: 32, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
          background: 'none', border: '1px solid ' + (props.isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'),
          color: props.isDark ? (C3.textDark || '#E0E3EB') : (C3.textLightTheme || '#1e1b4b') }, props.buttonStyle),
      }) : null);
  }

  return {
    until: until, secondsLeft: secondsLeft, note: note, useWait: useWait, useCause: useCause,
    parseRetryAfter: parseRetryAfter, REACHED: REACHED, UNREADABLE: UNREADABLE, HELD: HELD, OVER: OVER,
    announce: announce, unreadableError: unreadableError, notData: notData, label: label, waitLook: waitLook,
    RetryButton: RetryButton, failure: failure, failText: failText, failReason: failReason, outage: outage,
    setBusy: setBusy, endBusy: endBusy, busyOf: busyOf, useBusy: useBusy,
    useReloadAfterWait: useReloadAfterWait, FailNote: FailNote, JOIN_MS: JOIN_MS, joins: joins, focusOnRetry: focusOnRetry,
    // The nearest heading before an element that is still on the page, for
    // a view that puts the focus back itself after a retry.
    headingBefore: function (el) { return headingsBefore(el).filter(function (h) { return document.contains(h); })[0] || null; },
    reloadAt: reloadAt, reloadDelay: reloadDelay, RELOAD_FLOOR: RELOAD_FLOOR, RELOAD_MAX: RELOAD_MAX,
    _resetPacing: function () { streaks = {}; },
    _resetLive: function () { live.said = ''; live.at = 0; },
  };
})();
// /RATE-LIMIT-WAIT
