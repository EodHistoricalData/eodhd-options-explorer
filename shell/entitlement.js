/**
 * What this key can reach — learned from failure, never asked for.
 *
 * The terminal probes: a small request per feed, up front, to discover what a
 * key can do. That suits a product with a signed-in paying customer. It is the
 * wrong trade here, where the visitor may well be on the free tier and its
 * twenty requests a day. Spending eight of them on questions nobody asked,
 * before a single screen has rendered, is a poor introduction.
 *
 * So there is no probe, and deliberately no entry point that could become one.
 * The request the app was going to make anyway either succeeds or returns 403,
 * and EODHD's 403 carries the answer in its body:
 *
 *     403  "Forbidden. You have no access to Options Data Feed."
 *
 * That sentence is passed through untouched. Upstream names the exact feed;
 * any paraphrase of ours would drift the first time they rename a product.
 *
 * Two kinds of answer are kept apart. A 403, or a 402 that is not about a
 * limit, is a verdict about the plan: this key will not reach that feed today
 * or tomorrow. A 402 "API Rate Limit Exceeded" (the spent daily quota), a 429, a 401, a
 * 500 or a dropped connection is a problem with the request: the quota is
 * spent, the key was refused, upstream is down. Everything except 200 and 403
 * used to fall into one "learned nothing" branch, and the views then said
 * "No upcoming events found" over a request that never came back -- for a
 * showcase of paid data, "the data does not exist" is the worst possible thing
 * to print.
 */
(function () {
  var state = {};     // capability -> { allowed, reason, whats }    (plan verdicts)
  // Request problems, one per feed and kind of request ("<capability>
  // <what>"): { kind, status, reason, capability, what, seq, ... }. Kept
  // per capability alone, a 500 of the portfolio's fundamentals and one of
  // its economic data were one problem, and whichever came last spoke for
  // both.
  //
  // `what` is the kind of request, in the words a line of the screen's says
  // it names: data-own-fail="quotes", "history", "exchange-hours" (api.js,
  // whatOf). Whether the panel or the screen says a failure is decided by
  // that, on the page (said()): the panel speaks for a failure only while
  // no line of the screen's names it. Lists of a line's words per app said
  // it before, and every line not in them -- the portfolio's Allocation,
  // Dividends, Benchmark, Monte Carlo, Correlation, Backtest and What-If --
  // had the panel over it.
  var problems = {};
  // The kinds of request served on this page (keyOf), and where the count
  // stood when they were: a failure of one asked after that leaves part of
  // its set below.
  var servedKinds = {};
  var listeners = [];
  // A count of what has happened, in order: every request sent and every
  // problem recorded takes the next number. It is how a success is known to
  // have been asked for after a problem, rather than merely to have arrived
  // after it.
  var seq = 0;

  // Marketplace products keep their own allowance; a spent one says nothing
  // about the key's day, and the key's day says nothing about it.
  var MARKETPLACE = { options: true, marketplace: true };

  var FALLBACK = 'Your EODHD plan does not include this data.';

  // What each capability is, in words a visitor knows. Used only when
  // upstream's own sentence does not name anything: the marketplace refuses
  // with "Access denied", thirteen bytes, and a panel that repeats that and
  // nothing else leaves the reader guessing which product they lack
  var FEEDS = {
    options: 'the Options Data Feed',
    realtime: 'real-time and delayed quotes',
    core: 'the core API',
    marketplace: 'the S&P index constituents add-on (Marketplace)',
    news: 'the Financial News feed',
    sentiment: 'the Sentiment feed',
    screener: 'the Stock Screener',
    calendar: 'the earnings, splits and IPO calendars',
    // Its own entry: the calendar's earnings could load while its dividends
    // were refused, and the panel then blamed "the earnings, dividends,
    // splits and IPO calendars" without saying which.
    dividends: 'dividend data',
    macro: 'the Economic Events calendar',
    eod: 'end-of-day prices',
    fundamentals: 'the Fundamentals feed',
    exchanges: 'the exchanges’ trading hours and holidays',
  };

  /**
   * Upstream's sentence, when upstream sent a sentence.
   *
   * Most feeds refuse in one line -- "Forbidden. You have no access to Options
   * Data Feed." -- and that line is better than anything we could write,
   * because it names the product. The options feed does not: it answers with a
   * Laravel error page, and the panel printed several kilobytes of markup and
   * inlined CSS at the visitor.
   *
   * So the body is used when it reads like a sentence and dropped when it does
   * not. A page still yields its message if there is one in the markup --
   * "This action is unauthorized." is worth keeping -- and anything longer than
   * a couple of lines is not a refusal message, whatever it is.
   */
  /**
   * The words a body carries, read the one way for every panel. A JSON body
   * is read for its message: the plan panel printed 'Not included in this
   * plan {"message":"Payment required"}', the calendar 'EODHD said:
   * "{"message":"fail"}"', and an array -- ["Forbidden"] -- came through as
   * typed. Objects, arrays, a JSON string and nested { error: { message } }
   * are all read; a JSON body with no words in it says nothing, never its
   * braces. Anything that is not JSON is returned trimmed, as it came.
   */
  function messageOf(body) {
    var text = String(body == null ? '' : body).trim();
    var first = text.charAt(0);
    if (first !== '{' && first !== '[' && first !== '"') return text;
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { return first === '"' ? text : ''; }
    var pick = function (v, depth) {
      if (depth > 3 || v == null) return '';
      if (typeof v === 'string') return v.trim();
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) { var a = pick(v[i], depth + 1); if (a) return a; }
        return '';
      }
      if (typeof v === 'object') {
        var keys = ['message', 'error', 'detail', 'errors', 'reason'];
        for (var k = 0; k < keys.length; k++) { var b = pick(v[keys[k]], depth + 1); if (b) return b; }
      }
      return '';
    };
    return pick(parsed, 0);
  }

  /**
   * Upstream's words in quotes, for a sentence that ends after them. A
   * closing full stop is dropped so the sentence has one, not two: a 500
   * with {"message":"fail"} read 'HTTP 500 — "fail.".'. A question or an
   * exclamation is part of what was said and stays: "Is the key valid?"
   * was quoted as "Is the key valid".
   */
  function quote(words) {
    return '"' + String(words == null ? '' : words).trim().replace(/[\s.]+$/, '') + '"';
  }

  function readableReason(body, capability) {
    var text = messageOf(body);

    if (text.charAt(0) === '<' || /<html|<!doctype/i.test(text)) {
      // One sentence out of the page, not the page flattened. Stripping tags
      // and joining what was left glued the title, the status code and the
      // message into "Forbidden 403 This action is unauthorized." The <title>
      // and any headings go first; then the longest remaining sentence, which
      // is the one a framework's error page puts the explanation in.
      var stripped = text
        .replace(/<(script|style|title|h1|h2)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim();
      var sentences = stripped.split(/(?<=[.!?])\s+/)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 12 && /[a-z]/.test(s) && !/^\d+$/.test(s); });
      text = sentences.length
        ? sentences.reduce(function (a, b) { return b.length > a.length ? b : a; })
        : '';
    }

    if (text.length < 3 || text.length > 200) text = '';

    // A refusal that names nothing gets the feed named for it, with upstream's
    // own words kept in brackets so nobody has to trust our paraphrase.
    // "This action is unauthorized." is Laravel's stock 403 and names no
    // feed either; the calendar printed it alone, for its Screener and its
    // dividends refusals alike.
    var generic = !text || /^(access denied|forbidden|unauthorized|not allowed)\.?$/i.test(text)
      || /^this action is unauthorized\.?$/i.test(text) || text.length < 20;
    if (generic && capability && FEEDS[capability]) {
      return 'Your plan does not include ' + FEEDS[capability] + '.'
        + (text ? ' EODHD said: ' + quote(text) + '.' : '');
    }
    return text || FALLBACK;
  }

  // A 402 whose body is about a limit, in any of the ways EODHD words it:
  // "API Rate Limit Exceeded", and "You exceeded your daily API requests
  // limit" -- which the first pattern here did not match ("daily API
  // requests limit" is neither "daily limit" nor "limit exceeded"), so the
  // news, options and portfolio apps told a free key with a spent day that
  // its plan lacked the feed. The limit word and the verb may
  // come in either order, with a few words between; "limited" is not a limit.
  function isRateLimitBody(body) {
    return /rate limit|too many requests|\bquota\b|\blimits?\b[^.!?]{0,40}\b(?:exceeded|reached|spent|used up)|\b(?:exceed(?:ed|s)?|reached|over)\b[^.!?]{0,60}\blimits?\b|\bdaily\b[^.!?]{0,30}\blimits?\b/i
      .test(String(body == null ? '' : body));
  }

  // Whether the sentence is about the calendar day's counter, whichever
  // product the request was for.
  function isDailyBody(body) {
    return /\bdaily\b|\bper day\b|\btoday\b/i.test(String(body == null ? '' : body));
  }

  function notify(capability) {
    for (var i = 0; i < listeners.length; i++) listeners[i](capability);
    // What the panel has now been drawn from: a line that comes or goes
    // after this is a change to tell it of (look).
    lastLook = sign();
  }

  function fromResponse(res, capability) {
    var verdict = record(res, capability);
    settle(res && res.sent);
    return verdict;
  }

  /** Where we are in the count, without taking a number for a request. */
  function now() { return seq; }

  // Where a request problem is kept: its feed and its kind of request.
  function keyOf(capability, what) { return capability + ' ' + (what || ''); }
  function has(map, k) { return Object.prototype.hasOwnProperty.call(map, k); }

  function record(res, capability) {
    var status = res && res.status;
    var what = (res && res.what) || '';
    var verdict;

    if (status === 200) {
      verdict = { allowed: true, reason: null };
      if (capability) {
        state[capability] = verdict;
        // A success settles an earlier problem of the same kind of request
        // on the same feed: the quota reset, the network came back, the
        // feed answers again. Earlier means asked for earlier: with two
        // requests to one feed in flight, the second can be refused before
        // the first comes back served, and the first must not take the
        // second's refusal off the screen. A caller that does not say when
        // it asked is taken at its word, as before.
        //
        // Only its own kind. Any answer at all used to settle a request
        // that never came back, as proof the network was back: the
        // calendar's feeds all dropped, the screener it asks for market caps
        // answered, and the panel went after a second while the line under
        // the tabs still said "See the panel above".
        var sent = res ? res.sent : null;
        var slot = keyOf(capability, what);
        if (!has(servedKinds, slot)) servedKinds[slot] = seq;
        [slot, slot + BESIDE].forEach(function (k) {
          var mine = problems[k];
          if (!mine || !(sent == null || mine.seq <= sent)) return;
          // A refused key or a spent day that a line of the screen's has
          // pointed at ("… did not load. See the panel above.") stays,
          // served since, while a line points at it or the screen is still
          // drawing one: the portfolio's economic data, served, took the
          // panel off six lines about the refused quotes of the positions,
          // and Macro's own line pointed at nothing. It goes once none does
          // (said(), look()). One no line has pointed at goes as before.
          if (mine.pinned && mine.pointed) { if (!mine.settled) mine.settled = Date.now(); return; }
          settled(k);
        });
        clearKeyWide(capability, sent);
        if (sent != null && sent > served) served = sent;
        notify(capability);
      }
      return verdict;
    }

    // A 402 is two different answers. EODHD refuses a spent daily quota with
    // "402 API Rate Limit Exceeded" (their API-limits page says so), and a
    // free user who hit twenty requests was told "Not included in this plan"
    // under a link to the pricing page -- the wrong fact, for the one reader
    // most likely to see it. The body says which: a limit or a
    // rate is the quota, anything else is still the plan.
    if (status === 402 && isRateLimitBody(res && res.body)) {
      if (capability) {
        keep(capability, { kind: 'quota', status: 402, reason: bodySentence(res.body) || null, daily: isDailyBody(res.body), seq: ++seq }, res);
      }
      return { allowed: null, reason: null, problem: 'quota' };
    }

    if (status === 403 || status === 402) {
      // 402 Payment Required is the plan too -- a feed this key has not paid
      // for -- and used to be printed as a red "Payment required" with no link
      // to the page where one pays.
      verdict = { allowed: false, reason: readableReason(res.body, capability) };
      if (capability) {
        // Which kinds of request the feed refused, for the lines that name
        // them: a 403 is the screen's while a line of its says "not
        // included in this plan" (the exchange's hours in their own line),
        // the panel's while none does (said()).
        var before = state[capability] && state[capability].allowed === false ? state[capability] : null;
        // Said again from memory, and still standing: nothing new.
        if (res.kept && before && (before.whats || []).indexOf(what) !== -1) return verdict;
        var kept = Object.assign({ status: status, capability: capability, whats: [what] }, verdict);
        if (before) (before.whats || []).forEach(function (w) { if (kept.whats.indexOf(w) === -1) kept.whats.push(w); });
        state[capability] = carry(before, kept, res);
        watch();
        notify(capability);
      }
      return verdict;
    }

    // Everything else is a problem with the request, not a fact about the
    // plan. The verdict stays unknown -- telling a paying subscriber they lack
    // a feed because upstream had a bad minute is worse than saying nothing --
    // but the problem itself is recorded, because the page has to say
    // something other than "no data".
    var kind = null;
    if (status === 429) kind = 'quota';
    else if (status === 401) kind = 'key';
    else if (!status || status >= 500) kind = 'upstream';

    if (kind && capability) {
      var text = bodySentence(res && res.body);
      keep(capability, { kind: kind, status: status || 0, reason: text || null, seq: ++seq }, res);
    }
    return { allowed: null, reason: null, problem: kind };
  }

  /**
   * Where a request's problem is kept, and who is told.
   *
   * `res.what`: the kind of request (api.js, whatOf) -- what a line of the
   * screen's names in its data-own-fail. `res.wait`: a line of the screen's
   * may come for it (the app's screens name that kind themselves, or the
   * caller said it does): true, or a function asked when the panel is
   * drawn, for a caller that knows only later -- a later page of the
   * options chain is the chain's once its first page came with contracts.
   * The panel then waits a moment for the line rather than come up and go.
   * `res.part`: data of the same set came, so something below is partial
   * (the options chain's first page, before its later pages failed).
   * `res.held`: a request the client did not send, inside the per-minute
   * wait. `res.idle`: a function that says no screen uses the request now.
   * `res.kept`: a refusal the client answered again from what it was told
   * before, unsent -- no news about the key.
   */
  function keep(capability, p, res) {
    p.capability = capability;
    p.what = (res && res.what) || '';
    // A refused key and a spent day are the panel's from the first refusal,
    // and stay until a request of the same kind is served with the key.
    // They were kept only once asked a second time, and settled by any
    // other feed's answer: the heatmap's hours refused for the key had the
    // panel for a moment, then a line under the map once the quotes came,
    // and the page moved each time.
    if (p.status === 401 || p.status === 402) p.pinned = true;
    if (res && res.held) p.held = true;
    if (res && res.kept) p.kept = true;
    // When it was asked (or, held or answered from memory, recorded).
    p.asked = res && res.sent != null ? res.sent : p.seq;
    var slot = keyOf(capability, p.what);
    p.slot = slot;
    var k = slot;
    var held = problems[slot];
    // A refused key or a spent day holds its kind's place, and another
    // failure of the same kind is kept beside it, not over it: the
    // calendar's company names refused for TO (401) and failed for LSE
    // (500) had the 500 take the panel, which the LSE line already said,
    // and nobody said the 401 that TO's line pointed at. A refusal that
    // comes after another failure of its kind takes the place, and moves
    // that failure beside it.
    if (held && held.pinned && !p.pinned) k = slot + BESIDE;
    else if (held && !held.pinned && p.pinned) problems[slot + BESIDE] = held;
    // Said again from memory, and still standing: nothing new.
    if (p.kept && problems[k] && problems[k].status === p.status) return;
    var before = problems[k];
    problems[k] = carry(before, p, res);
    // A failure of a kind the screen's lines have named, after a success
    // settled the last one: said where those lines are, as the last one
    // was. The portfolio's price history hung on Risk, Correlation and
    // Monte Carlo, and the panel came up over Backtest, What-If, Tax and
    // Macro, which show nothing of it: a history served in between had
    // settled what the lines had named, and the late failures of the tabs
    // left behind came back as new ones with no line.
    var gone = named[slot];
    if (!before && gone && gone.kind === p.kind && gone.status === p.status) problems[k].seen = gone.seen;
    watch();
    notify(capability);
  }
  // Where a failure of a kind is kept beside the refusal holding its place.
  var BESIDE = ' +';
  // The failures of each kind a line of the screen's named, when a success
  // settled them (keep()).
  var named = {};
  function settled(k) {
    var p = problems[k];
    if (!p) return;
    if (p.seen) named[p.slot || k] = { kind: p.kind, status: p.status, seen: p.seen };
    delete problems[k];
  }

  // What a record carries over from the one it replaces when the cause is
  // the same: a repeat that fails as the last one did is the same failure,
  // and its line -- already on the page, or already waited for -- stands.
  // The panel came back with each repeat and pushed the page down each time.
  function carry(before, p, res) {
    p.wait = (res && res.wait) || null;
    p.part = (res && res.part) || null;
    p.idle = (res && res.idle) || null;
    var same = before && before.kind === p.kind && before.status === p.status && before.allowed === p.allowed;
    p.since = same ? before.since : Date.now();
    p.seen = same ? before.seen : 0;
    p.shown = same ? Boolean(before.shown) : false;
    p.pointed = same ? before.pointed || 0 : 0;
    if (same && before.wait === true) p.wait = true;
    if (same && before.part && !p.part) p.part = before.part;
    return p;
  }

  /**
   * The screen's own failure lines, as the page shows them.
   *
   * A module marks a line that names a request's failure
   * data-own-fail="<what>" -- the kind of request: "quotes", "history",
   * "exchange-hours" -- in every layout, whatever else the line says. Read
   * from the page: an element of the view (never the shell's own panels)
   * that is drawn and has words. A line that sends the reader to the panel
   * ("… did not load. See the panel above.", marked data-see-panel too)
   * names the failure only to point at it: the panel says it, and stays
   * while that line is drawn.
   */
  var POINTS = /see the panel above/i;
  function viewRoots() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return [];
    var views = Array.prototype.slice.call(document.querySelectorAll('[data-app-view]'));
    if (views.length) return views;
    var root = document.getElementById('root') || document.body;
    return root ? [root] : [];
  }
  // An element not drawn, with what is inside it: hidden, aria-hidden or
  // inert, or no box at all (display: none). One with display: contents has
  // no box of its own and draws its children.
  function unseen(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return true;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) {
      var display = '';
      try { display = window.getComputedStyle(el).display; } catch (_) { display = ''; }
      return display !== 'contents';
    }
    return Boolean(el.style && el.style.display === 'none');
  }
  // The words of `el` a reader can see: the text of what is drawn, never
  // that of a hidden element inside it. "Could not check AAPL" in a <p
  // hidden> named a failure nobody saw.
  // `words`: the line's own words, without its buttons' -- a line whose
  // sentence is hidden and whose Try again shows names nothing.
  function visibleText(el, words) {
    if (!el) return '';
    if (typeof document === 'undefined' || !document.createTreeWalker) return String(el.textContent || '');
    var out = [];
    var walker = document.createTreeWalker(el, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return 1; /* FILTER_ACCEPT */
        if (words && (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button')) return 2;
        return unseen(n) ? 2 /* FILTER_REJECT */ : 3; /* FILTER_SKIP */
      },
    });
    var node;
    while ((node = walker.nextNode())) out.push(node.nodeValue);
    return out.join(' ');
  }
  function drawn(el) {
    if (!el || !el.isConnected) return false;
    for (var a = el; a && a.nodeType === 1; a = a.parentElement) {
      if (unseen(a)) return false;
    }
    return Boolean(visibleText(el, true).trim());
  }

  /**
   * What a line's data-own-fail names, when the value is not a kind of
   * request of its own (api.js, whatOf): a line about several feeds at
   * once, or a word the modules use for one. Each value is checked against
   * these and the client's kinds when an app is generated
   * (scripts/generate.js), so a mark the shell cannot read stops the build.
   */
  //
  // A value in OTHER names no request of the data client -- the AI
  // assistant's own service, the app's saved settings -- and so no failure
  // the panel keeps; the line still names a failure below (partial()).
  var OTHER = ['ai', 'ai-data', 'ai-tokens', 'backtest', 'preferences', 'storage'];
  var NAMES = {
    // A code typed in a search field is checked with a quote
    // (SymbolCode.listed): the field's line says that failure too.
    search: ['search', 'quotes'],
    // The portfolio's economic data: its rates and yields are quotes
    // (US10Y.GBOND), said in the same line as its indicators.
    macro: ['macro', 'quotes'],
    calendar: ['earnings', 'dividends', 'splits', 'ipos', 'economic-events'],
    feeds: ['earnings', 'dividends', 'splits', 'ipos', 'economic-events'],
    holidays: ['exchange-hours'],
    prices: ['quotes'],
    rates: ['quotes'],
    benchmark: ['history'],
    index: ['index-list', 'index-constituents'],
  };
  function whatsNamed(value) {
    var out = [];
    String(value == null ? '' : value).split(/[\s,]+/).forEach(function (v) {
      if (!v) return;
      [].concat(has(NAMES, v) ? NAMES[v] : v).forEach(function (w) { if (out.indexOf(w) === -1) out.push(w); });
    });
    return out;
  }

  // The screen's failure lines on the page: the kinds each names, and
  // whether it points at the panel.
  function ownLines() {
    var out = [];
    var roots = viewRoots();
    for (var r = 0; r < roots.length; r++) {
      var found;
      try { found = roots[r].querySelectorAll('[data-own-fail]'); } catch (_) { found = []; }
      for (var i = 0; i < found.length; i++) {
        var el = found[i];
        if (!drawn(el)) continue;
        out.push({ whats: whatsNamed(el.getAttribute('data-own-fail')), points: el.getAttribute('data-see-panel') === 'true' || POINTS.test(visibleText(el)) });
      }
    }
    return out;
  }

  // What the page says of a failure of these kinds of request: 'points' (a
  // line sends the reader to the panel), 'names' (a line says it), or ''.
  function onScreen(whats, lines) {
    var found = '';
    for (var i = 0; i < lines.length; i++) {
      var hit = false;
      for (var j = 0; j < lines[i].whats.length && !hit; j++) hit = whats.indexOf(lines[i].whats[j]) !== -1;
      if (!hit) continue;
      if (lines[i].points) return 'points';
      found = 'names';
    }
    return found;
  }

  // The kinds of request a failure is about. The per-minute limit is the
  // key's, whichever request met it: a line that names it for one names it
  // for all, a request the client held inside the wait included (api.js
  // records one as a 429). The panel's "Too many requests at once" stood
  // over the Benchmark's "The price history for the comparison did not
  // load: EODHD's per-minute request limit was reached", about the
  // fundamentals' 429 that no line on that tab said.
  function whatsOf(p) {
    if (p.whats) return p.whats;
    if (p.status !== 429) return [p.what || ''];
    var out = [];
    for (var k in problems) {
      if (has(problems, k) && problems[k].status === 429 && out.indexOf(problems[k].what) === -1) out.push(problems[k].what);
    }
    return out;
  }

  // How long a failure waits for its line before the panel says it,
  // counted from when nothing is in flight any more: the screen draws its
  // lines once its loads have settled. Short: what no line says is the
  // panel's.
  function waitMs() { return Number(window.EODHD_LINE_WAIT_MS) >= 0 ? Number(window.EODHD_LINE_WAIT_MS) : 1200; }
  var settledAt = 0;
  // When a wait counted from `t` ends.
  function graceEnd(t) { return Math.max(t || 0, settledAt) + waitMs(); }

  // Whether a line of the screen's may come for it: true, false, or
  // undefined while the caller cannot tell yet (the options chain's first
  // page still out). A function is asked until it answers yes, and kept so.
  function waits(p) {
    if (!p || !p.wait) return false;
    if (p.wait === true) return true;
    var yes;
    try { yes = p.wait(); } catch (_) { yes = false; }
    if (yes == null) return undefined;
    if (yes) p.wait = true;
    return Boolean(yes);
  }
  // Waited for, with no line yet, and the screen still busy drawing it.
  // Not once the panel has said it: a request going out meanwhile (the
  // repeat after a 429's wait) took the panel down and the failed repeat
  // put it back, and the page moved each time.
  function waiting(p) {
    if (!p || p.seen || p.shown || waits(p) === false) return false;
    return inFlight() > 0 || Date.now() < graceEnd(p.since);
  }
  // Whether no screen on the page uses the request now (an exchange's
  // hours under the heatmap's Crypto tab: ExchangeStatus.inUse).
  function idle(p) {
    if (!p || typeof p.idle !== 'function') return false;
    try { return Boolean(p.idle()); } catch (_) { return false; }
  }
  // Whether data of the same set came, so what is below is partial.
  function partOf(p) {
    if (!p || !p.part) return false;
    if (p.part === true) return true;
    try { return Boolean(p.part()); } catch (_) { return false; }
  }

  /**
   * Who says a failure now: 'panel', 'screen', or 'wait' (nobody yet: a
   * line of the screen's may still come). `lines`: ownLines(), when the
   * caller has read them already.
   *
   * The panel speaks for a failure only while no line of the screen's names
   * it. A refused key, a spent day and a plan's 402 are the panel's
   * whoever asked: no line has a word of .env or of when the day resets. A
   * line that points at the panel leaves the failure to it. One that named
   * it and is gone, with the failure not settled, set it aside: a tab that
   * does not use the request (the heatmap's Crypto and Forex, for the US
   * market hours), or a retry on its way. Its line comes back with the tab
   * that uses it; the panel came up over the other tabs instead, and moved
   * the page each time. A request no screen uses now (idle) is said by
   * nobody, whatever it was.
   */
  function said(p, lines) {
    if (!p) return 'panel';
    if (idle(p)) return 'screen';
    if (p.pinned) {
      var at = onScreen(whatsOf(p), lines || (lines = ownLines()));
      if (at === 'points') p.pointed = Date.now();
      if (p.settled) return at === 'points' || !gone(p, lines) ? 'panel' : 'screen';
    }
    if (p.status === 401 || p.status === 402) return 'panel';
    var on = onScreen(whatsOf(p), lines || ownLines());
    if (on === 'names') { p.seen = Date.now(); return 'screen'; }
    if (on !== 'points' && p.seen) return 'screen';
    if (on !== 'points' && waiting(p)) return 'wait';
    p.shown = true;
    return 'panel';
  }

  // A refused key or a spent day served since (record): gone once no line
  // of the screen's points at it and the screen has had its moment to draw
  // one (the requests in flight settled, and the wait for a line after).
  function gone(p, lines) {
    if (onScreen(whatsOf(p), lines || ownLines()) === 'points') return false;
    return inFlight() === 0 && Date.now() >= graceEnd(p.settled);
  }

  /**
   * Is something below partial, or naming a failure of its own? Then the
   * panel does not say that nothing below is missing: any failure line of
   * the screen's on the page -- one that says it, or one that points at the
   * panel -- or a set that came in part (the options chain's first page,
   * its later pages refused). "Nothing below is missing data; the requests
   * were refused before any data was read" stood over a chain cut to its
   * first page.
   */
  function partial(lines) {
    if ((lines || ownLines()).length) return true;
    // A request of a kind served on this page before it was asked: part of
    // its set is below (the quotes of some positions, an earlier month's
    // events). Not one served alongside it: the chain's later pages,
    // answered while its first failed, put nothing on the page.
    for (var k in problems) {
      var kind = has(problems, k) ? problems[k].slot || k : k;
      if (has(problems, k) && (partOf(problems[k]) || (has(servedKinds, kind) && servedKinds[kind] < problems[k].asked))) return true;
    }
    for (var c in state) if (has(state, c) && state[c].allowed === false && partOf(state[c])) return true;
    return false;
  }

  /**
   * The page is watched while anything failed: a line coming or going
   * changes what the panel says, and nothing else would tell it. Told only
   * when that changes, on a short delay so a burst of drawing is one look.
   */
  var observer = null;
  var lookTimer = null;
  var lastLook = '';
  // Every failure kept: the request problems and the refused feeds.
  function claims() {
    var out = [];
    for (var k in problems) if (has(problems, k)) out.push(['p', k, problems[k]]);
    for (var c in state) if (has(state, c) && state[c].allowed === false) out.push(['d', c, state[c]]);
    return out;
  }
  function sign() {
    var lines = ownLines();
    return claims().map(function (x) { return x[0] + x[1] + said(x[2], lines).charAt(0); }).join(' ')
      + (partial(lines) ? ' +' : '');
  }
  function look() {
    lookTimer = null;
    // A refused key or a spent day served since, that nothing points at now.
    var lines = ownLines();
    var dropped = false;
    for (var k in problems) {
      if (has(problems, k) && problems[k].settled && gone(problems[k], lines)) { settled(k); dropped = true; }
    }
    if (dropped) notify(null);
    var all = claims();
    if (!all.length) { unwatch(); lastLook = ''; return; }
    var now = sign();
    if (now !== lastLook) notify(null);
    // A wait ends by the clock, which no mutation reports: looked at once
    // more when the first of them ends, and no more after; while anything
    // is in flight, its end brings the look (settle).
    if (inFlight() > 0) return;
    var next = 0;
    all.forEach(function (x) {
      var end = waiting(x[2]) ? graceEnd(x[2].since) : x[2].settled ? graceEnd(x[2].settled) : 0;
      if (end && (!next || end < next)) next = end;
    });
    // Only a time still ahead: a kept panel whose grace has run out stays
    // while a line points at it, and the page changing brings the next look
    // (the observer) -- not a look every 20 ms for as long as it stands.
    if (next && next > Date.now()) lookSoon(next - Date.now() + 20);
  }
  // At most one look pending, at the earliest time asked for: a page that
  // draws without pause (a countdown, a chart) still gets looked at.
  var lookDue = 0;
  function lookSoon(ms) {
    var due = Date.now() + (ms == null ? 50 : ms);
    if (lookTimer && lookDue <= due) return;
    if (lookTimer) clearTimeout(lookTimer);
    lookDue = due;
    lookTimer = setTimeout(look, due - Date.now());
  }
  function watch() {
    lookSoon();
    if (observer || typeof MutationObserver !== 'function' || typeof document === 'undefined' || !document.body) return;
    observer = new MutationObserver(function () { lookSoon(); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'inert', 'style', 'data-own-fail', 'data-see-panel'] });
  }
  function unwatch() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // The sentence a problem's body carries, or ''. A JSON body is read for
  // its message (messageOf): a 429 put {"message":"Too Many Requests"} into
  // the banner as typed. HTML pages and long bodies say nothing. Where the
  // panel quotes it, quote() drops this end mark again.
  function bodySentence(body) {
    var text = messageOf(body);
    if (text.charAt(0) === '<' || text.length > 200) return '';
    if (text && !/[.!?…]$/.test(text)) text += '.';
    return text;
  }

  // The view fetches its own data, so a denial is discovered after render.
  // Without a way to hear about it, the upgrade panel would never appear.
  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (l) { return l !== fn; });
    };
  }

  function known(capability) {
    return has(state, capability);
  }

  function get(capability) {
    return state[capability] || { allowed: null, reason: null };
  }

  /**
   * Every refused feed, with its sentence, in the order they were learned.
   *
   * One line per distinct sentence, not per refused request. Several feeds of
   * one app refuse with the same wording -- the heatmap's two, the options
   * app's three -- and the panel repeated it verbatim two and three times.
   */
  //
  // Feeds the app does not announce (meta.json silentRefusals, handed over by
  // the frame) are left out here, before the lines are made one per sentence.
  // They were filtered afterwards, by the frame: when a silent feed and an
  // announced one refused in the same words, whichever answer came back first
  // kept the line -- and when that was the silent one, the panel had nothing
  // to show while the view, asking explained(), said "See the panel above".
  // Half the heatmap's loads on a free key went like that.
  //
  // Not one a line of the screen's says ("… is not included in this plan"):
  // a refusal the screen names is its own (said()).
  function denied() {
    var out = [];
    var seen = {};
    var lines = ownLines();
    for (var key in state) {
      if (has(state, key) && state[key].allowed === false && !silentCaps[key] && said(state[key], lines) === 'panel') {
        var reason = state[key].reason || '';
        // Every feed behind a line is kept with it: a note that says what
        // still works has to know that only one feed was refused.
        if (seen[reason]) { seen[reason].capabilities.push(key); continue; }
        seen[reason] = { capability: key, reason: state[key].reason, capabilities: [key] };
        out.push(seen[reason]);
      }
    }
    return out;
  }

  /**
   * Has anything been refused?
   *
   * Each vendored view carries its own fallback -- "Failed to load screener
   * data", "Failed to load news" -- written for a terminal where nothing else
   * explains a refusal. Here the upgrade panel is already on screen, directly
   * above, saying "Not included in this plan" and quoting EODHD's own
   * sentence. A second red box under it about the same 403 adds nothing and is
   * vaguer than the message it sits beneath.
   */
  function anyDenied() {
    return denied().length > 0;
  }

  /** Has anything actually come back 200? The "everything else keeps working"
   *  line is only true when something else has, in fact, worked. */
  function anyAllowed() {
    for (var key in state) {
      if (has(state, key) && state[key].allowed === true) return true;
    }
    return false;
  }

  /**
   * The most pressing request problem, or null.
   *
   * One at a time, in the order a reader can act on them: a refused key first
   * (fix .env), then a spent day, then the per-minute limit (wait, or
   * upgrade), then upstream being down (wait). Whichever is shown, the views
   * below are not "empty"; their requests never came back.
   */
  //
  // Only one the panel says (said()): not while a line of the screen's names
  // it, nor while one may still come. `partial`: something below names a
  // failure of its own or came in part, so the panel does not say that
  // nothing below is missing.
  var ORDER = [
    function (p) { return p.kind === 'key'; },
    function (p) { return p.kind === 'quota' && p.status !== 429; },
    function (p) { return p.kind === 'quota' && p.status === 429; },
    function (p) { return p.kind === 'upstream'; },
  ];
  function problem() {
    var lines = ownLines();
    for (var i = 0; i < ORDER.length; i++) {
      for (var k in problems) {
        var p = problems[k];
        if (has(problems, k) && ORDER[i](p) && said(p, lines) === 'panel') {
          return { kind: p.kind, status: p.status, reason: p.reason, capability: p.capability, daily: Boolean(p.daily), seq: p.seq, partial: partial(lines) };
        }
      }
    }
    return null;
  }

  /** Is a panel already on screen explaining why something is missing? The
   *  views consult this before printing their own red "Failed to load". */
  function explained() {
    return anyDenied() || problem() !== null;
  }

  /**
   * Is this problem about the key rather than about its feed?
   *
   * A refused key is, and so is a spent limit: the day's counter and the
   * per-minute throttle belong to the key, whichever request happened to run
   * into them. A Marketplace product's own allowance is the exception. An
   * upstream failure is not: one feed can be down while the others answer.
   */
  function aboutKey(p) {
    if (!p) return false;
    if (p.kind === 'key') return true;
    if (p.kind !== 'quota') return false;
    return p.status === 429 || Boolean(p.daily) || !MARKETPLACE[p.capability];
  }

  /**
   * A success settles the per-minute limit met before it was asked.
   *
   * The minute is the key's, so any feed answering proves it is over -- as
   * long as that request was sent after the 429. Arriving after it is not
   * enough: the last request the minute allowed and the first it refused
   * leave together, and can come back in either order. A Marketplace feed's
   * success proves nothing about the key's own counters, so it settles only
   * itself. A refused key and a spent day are pinned (keep): only their own
   * kind of request served settles them.
   */
  function clearKeyWide(capability, sent) {
    if (sent == null || MARKETPLACE[capability]) return;
    for (var k in problems) {
      var p = problems[k];
      if (has(problems, k) && !p.pinned && aboutKey(p) && p.seq <= sent) {
        delete problems[k];
        notify(p.capability);
      }
    }
  }

  // The latest send mark of a request that was served: whatever was refused
  // before it can be worth asking again.
  var served = 0;
  function lastServed() { return served; }

  // Requests that have left and not been answered, by their mark, and who is
  // waiting for them to settle.
  var pending = {};
  var waiters = [];
  function settle(sent) {
    if (sent == null || !pending[sent]) return;
    delete pending[sent];
    var still = [];
    waiters.forEach(function (w) { if (!w()) still.push(w); });
    waiters = still;
    // A failure waits for its line while anything is in flight; the clock
    // starts now.
    if (!inFlight()) {
      settledAt = Date.now();
      if (observer || lookTimer) lookSoon();
    }
  }

  /**
   * Resolves true as soon as a request sent after `after` has been served,
   * false once nothing is in flight that could be. For a caller that has a
   * refusal to ask about again and should ask only when a retry is going
   * well: right away it would be refused again, and asking on every render
   * would be one refused request per render.
   */
  //
  // And never longer than `limitMs` (15 s by default), whatever is still in
  // flight: every request gives its mark back, but a wait that depended on
  // that being true everywhere would hang a view the day one path did not.
  function servedSince(after, limitMs) {
    return new Promise(function (resolve) {
      var timer = null;
      var check = function () {
        var answer = null;
        if (served > after) answer = true;
        else {
          var busy = false;
          for (var k in pending) { if (has(pending, k)) { busy = true; break; } }
          if (!busy) answer = false;
        }
        if (answer === null) return false;
        if (timer) clearTimeout(timer);
        resolve(answer);
        return true;
      };
      if (check()) return;
      waiters.push(check);
      timer = setTimeout(function () {
        waiters = waiters.filter(function (w) { return w !== check; });
        resolve(served > after);
      }, limitMs == null ? 15000 : limitMs);
    });
  }

  /** A request that ended without an answer to record gives its mark back. */
  function release(sent) { settle(sent); }

  /** How many requests are in flight: for the tests that prove none is left. */
  function inFlight() {
    var n = 0;
    for (var k in pending) { if (has(pending, k)) n += 1; }
    return n;
  }

  /** Taken when a request leaves, and handed back with its answer as `sent`. */
  function mark() {
    seq += 1;
    pending[seq] = true;
    return seq;
  }

  /**
   * The standing problem that is about the key, or null. While there is one,
   * another request would be refused the same way; shell/options.js asks
   * before it sends four of them at once. A refused key or a spent day
   * stands until a request sent after it is served: the panel says it
   * longer, until its own kind of request is (keep).
   */
  //
  // The screen's own count too: a spent minute is the key's, whichever line
  // says so.
  // Not a refusal the client only repeated from memory (kept): a key that
  // answered since is not turned away by that.
  function keyWide() {
    for (var k in problems) {
      var p = problems[k];
      if (has(problems, k) && aboutKey(p) && !p.kept && !(served > p.seq)) {
        return { kind: p.kind, status: p.status, capability: p.capability };
      }
    }
    return null;
  }

  // Problems of requests that never got an answer (status 0) are about the
  // network: the browser saying it is back online settles them -- "You are
  // offline" stayed up after the connection returned until the next click.
  // Not one a line of the screen's points at: the panel stays while that
  // line says "See the panel above", and says it did not answer.
  function backOnline() {
    var lines = ownLines();
    for (var k in problems) {
      var p = problems[k];
      if (has(problems, k) && p.kind === 'upstream' && !p.status && onScreen(whatsOf(p), lines) !== 'points') {
        delete problems[k];
        notify(p.capability);
      }
    }
    notify(null);
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', backOnline);
    // A screen that starts or stops reading an exchange's hours (idle).
    window.addEventListener('exchange-status:use', function () { if (claims().length) lookSoon(0); });
  }

  var silentCaps = {};
  /** The feeds whose refusal this app does not announce. */
  function setSilent(list) {
    silentCaps = {};
    [].concat(list || []).forEach(function (c) { silentCaps[c] = true; });
  }

  function reset() {
    state = {};
    problems = {};
    servedKinds = {};
    named = {};
    listeners = [];
    seq = 0;
    served = 0;
    pending = {};
    waiters = [];
    silentCaps = {};
    settledAt = 0;
    unwatch();
    if (lookTimer) { clearTimeout(lookTimer); lookTimer = null; }
    lastLook = '';
  }

  window.Entitlement = {
    fromResponse: fromResponse,
    known: known,
    get: get,
    denied: denied,
    anyDenied: anyDenied,
    anyAllowed: anyAllowed,
    problem: problem,
    partial: function () { return partial(); },
    keyWide: keyWide,
    mark: mark,
    setSilent: setSilent,
    lastServed: lastServed,
    servedSince: servedSince,
    release: release,
    inFlight: inFlight,
    now: now,
    explained: explained,
    subscribe: subscribe,
    reset: reset,
    FEEDS: FEEDS,
    // What a line's data-own-fail may name besides a kind of request
    // (scripts/generate.js checks every mark against these).
    NAMES: NAMES,
    OTHER: OTHER,
    messageOf: messageOf,
    quote: quote,
    isLimitBody: isRateLimitBody,
    // For the tests: the screen's failure lines on the page.
    ownLines: ownLines,
  };
})();
