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
  var state = {};     // capability -> { allowed, reason }    (plan verdicts)
  var problems = {};  // capability -> { kind, status, reason } (request problems)
  // Problems the screen says itself: the request's caller shows its own
  // line and its own Try again (api.js marks the request `owned`). The panel
  // above was a second message about one failure -- "EODHD did not answer
  // … Nothing below is missing data" over the options chain's "Part of the
  // options chain did not load", and over the portfolio's "1 without a
  // price". Kept apart, so they never take the place of the panel's.
  var said = {};      // capability -> { kind, status, reason }
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
  }

  function fromResponse(res, capability) {
    var verdict = record(res, capability);
    settle(res && res.sent);
    return verdict;
  }

  /** Where we are in the count, without taking a number for a request. */
  function now() { return seq; }

  function record(res, capability) {
    var status = res && res.status;
    var verdict;

    if (status === 200) {
      verdict = { allowed: true, reason: null };
      if (capability) {
        state[capability] = verdict;
        // A success settles any earlier problem on the same feed: the quota
        // reset, the network came back, the key was fixed. Earlier means
        // asked for earlier: with two requests to one feed in flight, the
        // second can be refused before the first comes back served, and the
        // first must not take the second's refusal off the screen. A caller
        // that does not say when it asked is taken at its word, as before.
        var sent = res ? res.sent : null;
        [problems, said].forEach(function (map) {
          if (map[capability] && (sent == null || map[capability].seq <= sent)) delete map[capability];
        });
        clearKeyWide(capability, sent);
        if (sent != null && sent > served) served = sent;
        // A request that never got an answer (status 0: offline, a dropped
        // connection) says nothing about its feed, only about the network --
        // and any answer at all proves the network is back. Kept per feed,
        // "EODHD did not answer" stayed up after the heatmap's Refresh and the
        // calendar's next month had loaded, because those re-ask other feeds.
        clearNetworkProblems();
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
        state[capability] = verdict;
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
   * `res.owned` says the screen that asked names the failure itself (its
   * own line, its own Try again): true, or a function asked when the panel
   * is drawn, for a caller that knows only later -- an exchange's status,
   * whose line comes once ExchangeStatus keeps the failure (the current
   * module keeps a 500 not at all); a later page of the options chain,
   * the chain's own once its first page came with contracts. True goes to
   * `said`, and the panel's own stay where they were.
   *
   * Either way, only what such a line says as well as the panel does
   * leaves the panel (lineSays): EODHD's error, no answer, the per-minute
   * limit. A refused key and a spent day are the panel's whoever asked --
   * the line has no word of .env, or of when the day resets. An owner
   * asked later used to take them too: a 401 on the options chain's
   * second page hid the panel that had to say the key was refused.
   */
  function lineSays(p) { return p.kind === 'upstream' || p.status === 429; }

  function keep(capability, p, res) {
    var owned = res && res.owned;
    if (owned === true) {
      said[capability] = p;
      if (lineSays(p)) { notify(capability); return; }
    } else if (typeof owned === 'function') {
      p.owner = owned;
    }
    problems[capability] = p;
    // Told after the caller has had the answer, so the panel is drawn once
    // the owner knows; until then nothing has changed on the screen.
    if (p.owner) setTimeout(function () { notify(capability); }, 0);
    else notify(capability);
  }

  // Whether the problem's owner has taken it. Asked until it answers yes,
  // and kept so: a retry clears the module's failure while it asks again,
  // and the panel would come back for the length of each one.
  function taken(p) {
    if (!p || !p.owner) return false;
    if (p.owner === true) return true;
    var yes = false;
    try { yes = Boolean(p.owner()); } catch (_) { yes = false; }
    if (yes) p.owner = true;
    return yes;
  }

  // The screen says it: taken, and a failure its line says in full.
  function saidBelow(p) { return lineSays(p) && taken(p); }

  /** Is something on the screen naming a failure of its own? */
  function partial() {
    for (var cap in said) {
      if (Object.prototype.hasOwnProperty.call(said, cap)) return true;
    }
    for (var c in problems) {
      if (Object.prototype.hasOwnProperty.call(problems, c) && taken(problems[c])) return true;
    }
    return false;
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
    return Object.prototype.hasOwnProperty.call(state, capability);
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
  function denied() {
    var out = [];
    var seen = {};
    for (var key in state) {
      if (Object.prototype.hasOwnProperty.call(state, key) && state[key].allowed === false && !silentCaps[key]) {
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
      if (Object.prototype.hasOwnProperty.call(state, key) && state[key].allowed === true) return true;
    }
    return false;
  }

  /**
   * The most pressing request problem, or null.
   *
   * One at a time, in the order a reader can act on them: a refused key first
   * (fix .env), then a spent quota (wait, or upgrade), then upstream being
   * down (wait). Whichever is shown, the views below are not "empty"; their
   * requests never came back.
   */
  //
  // Not one the screen says itself (saidBelow). `partial`: something below
  // names a failure of its own, so the panel does not say that nothing
  // below is missing.
  function problem() {
    var order = ['key', 'quota', 'upstream'];
    for (var i = 0; i < order.length; i++) {
      for (var cap in problems) {
        if (Object.prototype.hasOwnProperty.call(problems, cap) && problems[cap].kind === order[i] && !saidBelow(problems[cap])) {
          return { kind: problems[cap].kind, status: problems[cap].status, reason: problems[cap].reason, capability: cap, daily: Boolean(problems[cap].daily), seq: problems[cap].seq, partial: partial() };
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
  function keyWideProblem(cap, map) {
    var p = (map || problems)[cap];
    if (!p) return false;
    if (p.kind === 'key') return true;
    if (p.kind !== 'quota') return false;
    return p.status === 429 || Boolean(p.daily) || !MARKETPLACE[cap];
  }

  /**
   * A success settles the key-wide problems that came before it was asked.
   *
   * Problems are kept per feed, and were only ever cleared by a success on
   * the same feed. But a view's "Try again" does not ask for everything
   * again: the calendar re-asks its events and not the exchanges' hours, the
   * heatmap its quotes and not the index's member list. Those first refusals
   * were never asked again, so "Daily request limit reached... Nothing below
   * is missing data" stayed above data that had loaded.
   *
   * The limit is the key's, so any feed answering proves it is over -- as
   * long as that request was sent after the refusal. Arriving after it is
   * not enough: the last request the day allowed and the first it refused
   * leave together, and can come back in either order. A Marketplace feed's
   * success proves nothing about the key's day, so it settles only itself.
   */
  function clearKeyWide(capability, sent) {
    if (sent == null || MARKETPLACE[capability]) return;
    [problems, said].forEach(function (map) {
      for (var cap in map) {
        if (Object.prototype.hasOwnProperty.call(map, cap) && keyWideProblem(cap, map) && map[cap].seq <= sent) {
          delete map[cap];
          notify(cap);
        }
      }
    });
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
          for (var k in pending) { if (Object.prototype.hasOwnProperty.call(pending, k)) { busy = true; break; } }
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
    for (var k in pending) { if (Object.prototype.hasOwnProperty.call(pending, k)) n += 1; }
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
   * before it sends four of them at once.
   */
  //
  // The screen's own count too: a spent minute is the key's, whichever line
  // says so.
  function keyWide() {
    var maps = [problems, said];
    for (var m = 0; m < maps.length; m++) {
      for (var cap in maps[m]) {
        if (Object.prototype.hasOwnProperty.call(maps[m], cap) && keyWideProblem(cap, maps[m])) {
          return { kind: maps[m][cap].kind, status: maps[m][cap].status, capability: cap };
        }
      }
    }
    return null;
  }

  // Problems of requests that never got an answer (status 0) are about the
  // network, not a feed: any answer, or the browser saying it is back online,
  // settles them. Without the `online` listener "You are offline" stayed up
  // after the connection returned until the next click.
  function clearNetworkProblems() {
    [problems, said].forEach(function (map) {
      for (var cap in map) {
        if (Object.prototype.hasOwnProperty.call(map, cap) && map[cap].kind === 'upstream' && !map[cap].status) {
          delete map[cap];
          notify(cap);
        }
      }
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', clearNetworkProblems);
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
    said = {};
    listeners = [];
    seq = 0;
    served = 0;
    pending = {};
    waiters = [];
    silentCaps = {};
  }

  window.Entitlement = {
    fromResponse: fromResponse,
    known: known,
    get: get,
    denied: denied,
    anyDenied: anyDenied,
    anyAllowed: anyAllowed,
    problem: problem,
    partial: partial,
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
    messageOf: messageOf,
    quote: quote,
  };
})();
