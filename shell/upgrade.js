/**
 * Shown when the key cannot reach the data the view needs.
 *
 * This is the one commercial moment in an otherwise plain sample app, and the
 * temptation is to make it work hard: a modal over a blurred table, a
 * countdown, a discount. In a repository someone cloned in good faith that
 * reads as bait-and-switch, and it costs more trust than the click is worth.
 *
 * So it is a panel. It repeats upstream's own sentence, which names the exact
 * feed, and offers one link. Nothing is hidden behind it, because nothing was
 * ever fetched -- the request genuinely came back 403.
 *
 * It also avoids the words "error" and "failed". Nothing went wrong and the
 * developer did nothing incorrectly; their plan simply does not include this,
 * and saying so plainly respects them more than an apology would.
 */
(function () {
  // EODHD's own words, ended as a sentence before ours: "API Rate Limit
  // Exceeded" ran straight into "Your plan's…".
  // Upstream's words in quotes, built by the one function that reads them
  // (shell/entitlement.js); a bare quote where it is not loaded (tests).
  function quoted(reason) {
    var E = window.Entitlement;
    return E && E.quote ? E.quote(reason) : '"' + String(reason).trim() + '"';
  }

  function sentence(reason) {
    var r = String(reason || '').trim();
    if (!r) return '';
    return (/[.!?…]$/.test(r) ? r : r + '.') + ' ';
  }

  // Tagged links, from shell/links.js; bare ones when it is absent (tests).
  function links(path, content) {
    return window.EODHDLinks ? window.EODHDLinks.url(path, content) : 'https://eodhd.com' + path;
  }
  function ctaBg() {
    return (window.EODHDLinks && window.EODHDLinks.CTA_BG) || '#c2410c';
  }
  var FALLBACK = 'Your EODHD plan does not include this data.';

  /**
   * The shell's colours for a theme. The vendored views carry both themes
   * already (`isDark` is branched on some thirteen hundred times across the
   * seven); the shell's own panels used to know only the dark one.
   */
  function palette(theme) {
    var C = window.C3 || {};
    if (theme === 'light') {
      return {
        panelBg: '#ffffff',
        panelBorder: '1px solid #e2e4e9',
        text: C.textLightTheme || '#1e1b4b',
        muted: C.textMutedLight || '#4b5563',
        code: 'rgba(0,0,0,0.05)',
      };
    }
    return {
      panelBg: C.glassDark ? C.glassDark.background : '#1C1A14',
      panelBorder: C.glassDark ? C.glassDark.border : '1px solid #2B2820',
      text: C.textDark || '#E9E6DF',
      muted: C.textMutedDark || '#A39B89',
      code: 'rgba(0,0,0,0.25)',
    };
  }
  window.ShellPalette = palette;

  function panelStyle(P, inset) {
    return {
      // Not centred and not narrower than the page: AppFrame supplies the
      // column, and a panel that stops at 560px beside a view that runs the
      // full width read as two documents with two left edges. The inset is
      // the view's own inner padding, so the panel's left edge lines up with
      // the view's heading rather than sitting a step to its left.
      margin: '0 ' + (inset || 0) + 'px 24px', padding: '20px 24px',
      borderRadius: 6,
      background: P.panelBg,
      border: P.panelBorder,
      fontFamily: "'Sora', system-ui, sans-serif",
      color: P.text, lineHeight: 1.6,
    };
  }

  function linkStyle() {
    return {
      display: 'inline-block', padding: '9px 16px', borderRadius: 4,
      // Not the brand gradient: white on #f97316 is 2.8:1.
      background: ctaBg(), color: '#fff',
      textDecoration: 'none', fontWeight: 700, fontSize: 13,
    };
  }

  window.UpgradePanel = function (props) {
    var P = palette(props && props.theme);
    // One feed or several: an app that touches five endpoints can be refused
    // on two of them, and each refusal has its own sentence.
    var reasons = (props && props.reasons && props.reasons.length)
      ? props.reasons
      : [(props && props.reason) || FALLBACK];

    return React.createElement('div', { style: panelStyle(P, props && props.inset), role: 'status' },
      React.createElement('div', {
        style: { fontSize: 15, fontWeight: 700, marginBottom: 8 },
      }, 'Not included in this plan'),

      reasons.map(function (reason, i) {
        return React.createElement('p', {
          key: i,
          style: { margin: i === reasons.length - 1 ? '0 0 18px' : '0 0 8px', color: P.muted, fontSize: 14 },
        }, reason || FALLBACK);
      }),

      React.createElement('a', {
        href: links('/pricing', 'upgrade'),
        target: '_blank',
        rel: 'noopener noreferrer',
        style: linkStyle(),
      }, 'See EODHD plans'),

      // Only where it is true. In an app whose entire subject is the gated
      // feed -- index constituents, say -- nothing else works, and saying
      // otherwise directly above "Access denied" is the kind of small lie that
      // costs a reader's trust in everything around it.
      props.otherFeaturesWork
        ? React.createElement('p', {
          style: { margin: '16px 0 0', fontSize: 12, color: P.muted },
        }, 'Everything else in this app keeps working on your current key.')
        : null
    );
  };

  /**
   * Shown when a request failed for a reason that is not the plan.
   *
   * Three cases, each with the one thing the reader can do about it. The
   * wording says explicitly that the empty view below is not "no data": the
   * request never came back, and a calendar reading "No upcoming events found"
   * over a spent quota was the single most misleading screen these apps had.
   */
  // Marketplace products keep their own allowance, and it is not a calendar
  // day: it runs for 24 hours from that product's first request. "Resets at
  // midnight UTC" was wrong for the options chain and the index constituents.
  var MARKETPLACE = { options: true, marketplace: true };

  // A request that never left the browser. Blaming "a bad minute upstream"
  // for the reader's own dropped Wi-Fi sends them to the wrong place.
  function offline() {
    try { return typeof navigator !== 'undefined' && navigator.onLine === false; } catch (_) { return false; }
  }

  // The client's per-minute wait, the one every Try again counts down
  // (window.RateLimitWait). A hook, so it is called on every render: the
  // module is in every app or in none, never in some renders only.
  var RLW = function () { return window.RateLimitWait && window.RateLimitWait.useWait ? window.RateLimitWait : null; };
  function useLimitWait() {
    var R = RLW();
    return R ? R.useWait() : null;
  }

  window.StatusPanel = function (props) {
    var P = palette(props && props.theme);
    var p = (props && props.problem) || {};
    var title, lines, link;
    var wait = useLimitWait();
    // When the wait it counted is over, a screen reader is told once; the
    // count itself is outside the live region (it changes every second).
    var counted = React.useRef(false);
    var left = wait ? wait.left : 0;
    React.useEffect(function () {
      if (left) { counted.current = true; return; }
      if (counted.current) {
        counted.current = false;
        var R = RLW();
        if (R && R.announce) R.announce(R.OVER);
      }
    }, [left]);
    var waitLine = null;

    if (p.kind === 'key') {
      title = 'EODHD did not accept the key';
      lines = [
        'The server sent the key from .env and eodhd.com answered 401'
          + (p.reason ? ' — ' + quoted(p.reason) : '') + '.',
        'Check EODHD_API_KEY in .env for a typo or an expired key, then restart the server. '
          + 'Nothing below is missing data; the requests were refused before any data was read.',
      ];
      link = { href: links('/cp/settings/api', 'key'), text: 'Your API key at eodhd.com' };
    } else if (p.kind === 'quota' && p.status === 429) {
      // 429 is the per-minute throttle, not the daily allowance -- EODHD
      // answers a spent day with 402. It used to get the daily-limit copy,
      // which sent people away until midnight over a one-minute wait.
      title = 'Too many requests at once';
      // One wait, one number: "Wait a minute and reload" stood over a Try
      // again counting 27 s. The panel names the wait
      // the buttons count, from the same clock, and the button rather than a
      // reload.
      lines = [
        sentence(p.reason)
          + 'EODHD limits how many requests a key may make per minute, as well as per day.',
        'Nothing below is missing data — the requests were not served.',
      ];
      if (wait) {
        waitLine = left
          ? 'Requests resume in ' + left + ' s.'
          : 'The wait is over: use Try again, or reload the page.';
      } else {
        lines[1] += ' Wait a minute and reload.';
      }
      link = null;
    } else if (p.kind === 'quota') {
      title = 'Daily request limit reached';
      lines = [
        // Plan-neutral: the free tier's twenty is one limit among several,
        // and a paying subscriber was being told about it.
        sentence(p.reason)
          // When EODHD's own sentence says "daily", it is the key's day that
          // is spent, whatever the request was for: a free key out of
          // requests is refused on the options chain in those words too, and
          // was told about a 24-hour Marketplace window.
          + (MARKETPLACE[p.capability] && !p.daily
            ? 'This Marketplace product’s allowance is spent. It runs for 24 hours from the product’s first request, so it frees up as that window rolls on.'
            : 'Today’s API request limit for this key is used up; the counter resets at midnight UTC.'),
        'Nothing below is missing data — the requests were not served. Reload after the reset, '
          + 'or move to a plan with a higher limit.',
      ];
      link = { href: links('/pricing', 'quota'), text: 'See EODHD plans' };
    } else if (!p.status && offline()) {
      title = 'You are offline';
      lines = [
        'This browser has no network connection, so the request never reached eodhd.com.',
        'Nothing below is missing data. Reload once you are back online.',
      ];
      link = null;
    } else {
      title = 'EODHD did not answer';
      lines = [
        (p.status ? 'eodhd.com returned HTTP ' + p.status : 'The request to eodhd.com did not complete')
          + (p.reason ? ' — ' + quoted(p.reason) : '') + '.',
        'This is usually a bad minute upstream. Nothing below is missing data; reload in a moment.',
      ];
      link = null;
    }

    // The title and the reason are the live region, read when the panel
    // appears; the count after them changes every second and is not in it.
    return React.createElement('div', { style: panelStyle(P, props && props.inset) },
      React.createElement('div', { role: 'status' },
        React.createElement('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 8 } }, title),
        lines.map(function (line, i) {
          return React.createElement('p', {
            key: i,
            style: { margin: i === lines.length - 1 && !waitLine ? '0 0 18px' : '0 0 8px', color: P.muted, fontSize: 14 },
          }, line);
        })),
      waitLine
        ? React.createElement('p', { 'data-status-wait': left ? String(left) : 'over', style: { margin: '0 0 18px', color: P.muted, fontSize: 14 } }, waitLine)
        : null,
      link
        ? React.createElement('a', {
          href: link.href, target: '_blank', rel: 'noopener noreferrer', style: linkStyle(),
        }, link.text)
        : null
    );
  };
})();
