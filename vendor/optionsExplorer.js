// Options Explorer — standalone full-screen view for exploring options chains

// Which suggestion Enter opens ("MSFT" + Enter did
// nothing; only a click opened a chain). The row the arrow keys highlighted
// wins; otherwise the row whose code IS what was typed ("MSFT" or "MSFT.US"),
// so a ticker typed in full never opens a lookalike; otherwise the first row.
// -1 when there is nothing to open.
// A code typed with its exchange, class or "^" opens that listing's row or
// none (-1): "^GSPC" opened GSPCX, a mutual fund.
window.OptionsSearchPick = function (results, query, activeIdx) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return -1;
  if (activeIdx >= 0 && activeIdx < list.length) return activeIdx;
  const SC = window.SymbolCode;
  if (SC && SC.bestRow) return list.indexOf(SC.bestRow(list, query));
  const q = String(query || '').trim().toUpperCase().replace(/\.US$/, '');
  const exact = list.findIndex(r => String((r && r.Code) || '').toUpperCase() === q);
  return exact >= 0 ? exact : 0;
};

// What a chain cell shows. "NA" (how EODHD writes an empty number) became
// "NaN" across a whole row, and a contract with no trades showed "Last 0.00"
// next to a live bid and ask, which reads as a trade at zero. A price of 0 is no price; a count of 0 is no activity; a
// greek of 0 is a value. Counts are grouped the English way, like every other
// number on the page ("204.467" next to "+140.490M" in de-DE).
window.OptionsChainCell = (function () {
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    num,
    price: (v) => { const n = num(v); return n != null && n > 0 ? n.toFixed(2) : '-'; },
    count: (v) => { const n = num(v); return n != null && n > 0 ? Math.round(n).toLocaleString('en-US') : '-'; },
    // A tiny negative Greek rounds to "-0.000"; zero has no sign.
    greek: (v, d) => { const n = num(v); if (n == null) return '-'; const t = n.toFixed(d); return /^-0\.?0*$/.test(t) ? t.slice(1) : t; },
    iv: (v) => { const n = num(v); return n != null && n > 0 ? (n * 100).toFixed(1) + '%' : '-'; },
  };
})();

window.OptionsExplorerView = ({ apiKey, theme, onSelectAsset, onClose, activeTab, onTabChange, onSettingsClick, onShowOptionsSettings, onUpgradeClick }) => {
  const { useState, useEffect, useRef, useCallback, useMemo } = React;

  const C3 = window.C3;
  const isDark = theme === 'dark';

  // Standalone: the key in .env reaches the Options feed or EODHD refuses it,
  // and the frame shows that refusal. There is no paywall of ours in between.
  const hasOptionsAccess = true;

  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const optExpSearchRef = React.useRef(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimeout = useRef(null);
  // Keyboard on the suggestions: the arrow-highlighted row (-1 = none), and
  // an Enter pressed before the debounced search answered, honoured when the
  // results arrive (typing "MSFT" + Enter fast is the normal way to do it).
  const [activeIdx, setActiveIdx] = useState(-1);
  const pendingEnter = useRef(false);
  const latestQuery = useRef('');
  // The last list that came back, for ArrowDown to bring back after Escape or
  // Tab closed it.
  const lastFound = useRef({ query: '', rows: [] });
  // Try again asked for the chain again: when it has loaded, the focus goes to
  // what came back. The button left with the old result and the focus stayed
  // on <body>.
  const retryFocusRef = useRef(false);
  const focusNext = (window.useFocusWhenReady || (() => (f) => setTimeout(() => { const el = f(); if (el) el.focus(); }, 0)))();

  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [optionsData, setOptionsData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedExpiry, setSelectedExpiry] = useState(null);
  // The symbol search turns the browser's outline off and drew nothing in its
  // place, so it was the one control on the screen with no focus indicator.
  const [searchFocused, setSearchFocused] = useState(false);
  // The point of the payoff line under the mouse or the arrow keys
  // (the diagram was a picture with no name and no values).
  const [payoffAt, setPayoffAt] = useState(null);
  // The payoff chart's width on screen: on a phone the web drawing (1000 x
  // 300) was shown at a quarter of its size and its labels could not be read.
  // Under 600 px it is drawn at the size it is shown.
  const [payoffW, setPayoffW] = useState(0);
  const payoffObserver = useRef(null);
  const payoffEl = useRef(null);
  const payoffRef = useCallback((el) => {
    payoffEl.current = el;
    if (payoffObserver.current) { payoffObserver.current.disconnect(); payoffObserver.current = null; }
    if (!el) return;
    setPayoffW(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'function') {
      payoffObserver.current = new ResizeObserver((entries) => setPayoffW(Math.round(entries[0].contentRect.width)));
      payoffObserver.current.observe(el);
    }
  }, []);
  // The breakeven labels' halo: the colour painted behind the chart, measured
  // (a fixed #fff / #1a1a2e drew a box on the tinted card).
  const [payoffHalo, setPayoffHalo] = useState(null);
  React.useLayoutEffect(() => {
    if (payoffEl.current && window.A11yColor && window.A11yColor.groundOf) {
      setPayoffHalo(window.A11yColor.groundOf(payoffEl.current, isDark ? '#1a1a2e' : '#ffffff'));
    }
  }, [isDark, payoffW]);
  const expiryGroupRef = useRef(null);
  const laterDatesRef = useRef(null);
  // "Later dates" answered with nothing: there are none, and the button that
  // stayed and did nothing is taken away (per symbol).
  const [noLaterDates, setNoLaterDates] = useState(false);
  // ...and the press that found nothing says so for a moment, as the button goes.
  const [laterNote, setLaterNote] = useState(false);
  useEffect(() => { setNoLaterDates(false); setLaterNote(false); }, [selectedSymbol]);
  const [optionType, setOptionType] = useState('all'); // 'all' | 'calls' | 'puts'
  const [payoffStrategy, setPayoffStrategy] = useState('long_call');
  const [currentPrice, setCurrentPrice] = useState(null);
  const isWebPlatform = window.APP_PLATFORM === 'WEB';
  const [showGreeks, setShowGreeks] = useState(isWebPlatform); // Greeks visible by default on Web
  const [strategyLegs, setStrategyLegs] = useState([]); // Strategy Builder legs
  const [showStrategyBuilder, setShowStrategyBuilder] = useState(false);
  const [optionsTab, setOptionsTab] = useState('chain'); // 'chain' | 'gex' | 'payoff'

  // Popular tickers for quick selection
  const popularTickers = [
    { symbol: 'AAPL.US', name: 'Apple' },
    { symbol: 'MSFT.US', name: 'Microsoft' },
    { symbol: 'NVDA.US', name: 'NVIDIA' },
    { symbol: 'TSLA.US', name: 'Tesla' },
    { symbol: 'AMZN.US', name: 'Amazon' },
    { symbol: 'GOOGL.US', name: 'Alphabet' },
    { symbol: 'META.US', name: 'Meta' },
    { symbol: 'SPY.US', name: 'S&P 500 ETF' },
    { symbol: 'QQQ.US', name: 'Nasdaq ETF' },
    { symbol: 'AMD.US', name: 'AMD' },
    { symbol: 'NFLX.US', name: 'Netflix' },
    { symbol: 'JPM.US', name: 'JPMorgan' },
  ];

  const Icon = ({ name, size = 24, color = 'currentColor' }) => {
    return React.createElement('svg', { 'aria-hidden': true, focusable: 'false',
      width: size, height: size,
      viewBox: "0 0 24 24", fill: "none",
      stroke: color, strokeWidth: "2",
      strokeLinecap: "round", strokeLinejoin: "round"
    }, React.createElement('path', { d: window.IconPaths[name] || "" }));
  };

  // Search
  // What Enter found nothing to open for, said under the field.
  const [searchNote, setSearchNote] = useState(null);
  const openTypedRef = useRef(null);
  // The quote check a typed code is waiting for: a newer Enter or a pick
  // ends it.
  const typedCheckRef = useRef(0);
  const handleSearch = useCallback((query) => {
    setSearchQuery(query);
    latestQuery.current = query;
    setActiveIdx(-1);
    setSearchNote(null);
    pendingEnter.current = false;
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    // The code alone for Yahoo's suffix (search/VOD.L answers nothing), and
    // nothing at all for text that is no ticker (window.SymbolCode.searchText).
    const SC = window.SymbolCode;
    const text = SC && SC.searchText ? SC.searchText(query) : query;
    if (!query || query.length < 2 || !text) {
      lastFound.current = { query, rows: [] };
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchTimeout.current = setTimeout(async () => {
      let found = [];
      let failed = false;
      try {
        const results = await window.EODHD_API.searchStocks(apiKey, text, { throwErrors: true });
        // Filter to US stocks (options are mainly US)
        found = (results || []).filter(r => ['US', 'NYSE', 'NASDAQ'].includes(r.Exchange)).slice(0, 10);
      } catch (e) {
        found = [];
        failed = true;
      }
      // An answer for a query the user has already typed past is dropped.
      if (query !== latestQuery.current) return;
      lastFound.current = { query, rows: found, failed };
      setSearchResults(found);
      setSearchLoading(false);
      // An Enter kept for this answer, which has no row: the typed code
      // decides (an index, a listing outside the US, not found). It waited
      // for a row and nothing happened.
      if (!found.length && pendingEnter.current) { pendingEnter.current = false; if (openTypedRef.current) openTypedRef.current(query, true); }
    }, 350);
  }, [apiKey]);

  // Select a ticker
  // Resolved once. Three call sites used to inline the same fallback, and the
  // standalone build has to strip it — there is no demo key there.
  const effectiveKey = apiKey;

  // A link to a chain opens that chain. Runs once, after selectTicker exists.
  //
  // `#/options?symbol=AAPL.US` is the shape the Academy links into and the shape a
  // reload can follow; the legacy bare `#AAPL.US` this screen used to write is still
  // read (optionsDeepLink.js), so a link somebody already has keeps working.
  // A link whose symbol reads as nothing ("#/options?symbol=..") is said so,
  // with nothing asked; it opened the landing page with no word.
  const showLinkProblem = () => {
    const why = window.OptionsDeepLink && window.OptionsDeepLink.linkProblem && window.OptionsDeepLink.linkProblem(window.location.hash);
    if (!why) return;
    loadSeqRef.current++;
    setLoading(false); setSelectedSymbol(null); setCurrentPrice(null);
    setOptionsData({ empty: true, junk: true, message: why });
  };
  const showLinkProblemRef = useRef(showLinkProblem);
  showLinkProblemRef.current = showLinkProblem;
  const bootedFromUrl = useRef(false);
  const optionsTabRef = useRef(optionsTab);
  optionsTabRef.current = optionsTab;
  useEffect(() => {
    if (bootedFromUrl.current) return;
    bootedFromUrl.current = true;
    const link = window.OptionsDeepLink && window.OptionsDeepLink.consume();
    if (!link) { showLinkProblem(); return; }
    // The tool the link was on, where this build has it (no AI Advisor in
    // every build).
    if (link.tab && (link.tab !== 'advisor' || window.OptionsAIAdvisor)) {
      optionsTabRef.current = link.tab;
      setOptionsTab(link.tab);
    }
    // The name, not the symbol twice: a link to AAPL.US read "AAPL.US"
    // where a pick read "Apple".
    const known = popularTickers.find(t => t.symbol === link.symbol);
    selectTicker(link.symbol, known ? known.name : '');
  }, []);

  // A link followed while the explorer is open: the address changed and the
  // screen kept the old chain (options?symbol=AAPL.US → MSFT.US stayed on
  // AAPL). Our own replaceState fires no hashchange.
  const selectedRef = useRef(null);
  selectedRef.current = selectedSymbol;
  // What is on screen for it, for a refused entry to leave alone (openTyped).
  const optionsDataRef = useRef(null);
  optionsDataRef.current = optionsData;
  const selectTickerRef = useRef(null);
  useEffect(() => {
    const onHash = () => {
      const link = window.OptionsDeepLink && window.OptionsDeepLink.parse(window.location.hash);
      if (!link) { showLinkProblemRef.current(); return; }
      if (link.tab && link.tab !== optionsTabRef.current && (link.tab !== 'advisor' || window.OptionsAIAdvisor)) {
        optionsTabRef.current = link.tab;
        setOptionsTab(link.tab);
      }
      const cur = selectedRef.current && selectedRef.current.symbol;
      if (String(cur || '').toUpperCase() === link.symbol || !selectTickerRef.current) return;
      const known = popularTickers.find(t => t.symbol === link.symbol);
      selectTickerRef.current(link.symbol, known ? known.name : '');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The open tool goes into the link with the ticker.
  useEffect(() => {
    if (!selectedSymbol || !selectedSymbol.symbol || !window.OptionsDeepLink) return;
    try { window.history.replaceState(null, '', window.OptionsDeepLink.linkFor(selectedSymbol.symbol, optionsTab)); } catch (e) { /* a convenience */ }
  }, [optionsTab]);

  // The newest pick owns the screen. AAPL picked, then MSFT before AAPL's
  // answers came: MSFT's strikes were drawn against AAPL's price ("Current:
  // $334.16"), and ITM, GEX and the payoff were computed from it. Each pick takes a number; an answer for an older number is dropped.
  const loadSeqRef = useRef(0);
  // The expiries already asked for one by one, for the chain on screen.
  const askedExpiryRef = useRef(new Set());
  const selectTicker = useCallback(async (symbol, name) => {
    const seq = ++loadSeqRef.current;
    const current = () => seq === loadSeqRef.current;
    setSelectedSymbol({ symbol, name });
    // The screen someone is looking at is worth a link. Nothing was reflected
    // in the URL, so a reload lost the ticker and the tab and there was no way
    // to send anybody a particular chain.
    try {
      // Written in the routable form: the old `#AAPL.US` survived only while this
      // screen was open, because on a reload the app router found no such tab.
      if (typeof window !== 'undefined' && window.location && window.history && window.OptionsDeepLink) {
        window.history.replaceState(null, '', window.OptionsDeepLink.linkFor(symbol, optionsTabRef.current));
      }
    } catch (e) { /* a convenience, not a requirement */ }
    setSearchQuery('');
    // A refusal said under the field is about the entry this pick replaces.
    setSearchNote(null);
    setSearchResults([]);
    setOptionsData(null);
    askedExpiryRef.current = new Set();
    setSelectedExpiry(null);
    window.Haptics?.light();

    // A ticker picked by hand is asked for again, even one refused a moment
    // ago: the open apps' client keeps refused chains back to spare metered
    // requests, and a re-pick of the same ticker then sent nothing and read
    // "No Options Available" until a reload. Absent here, a no-op.
    if (window.EODHD_API.forgetOptionsRefusal) window.EODHD_API.forgetOptionsRefusal(symbol);

    // US underlyings only: the feed is keyed by the bare ticker, so SHEL.LSE
    // came back as the NYSE ADR's chain priced against the London quote, and a
    // trial account paid a unit for it. Nothing is fetched for a non-US line.
    // An index (^GSPC, GSPC.INDX), a pair or a code that names nothing is told
    // in its own words (optionsDeepLink.js whyNot).
    if (window.OptionsDeepLink && window.OptionsDeepLink.isUSListed && !window.OptionsDeepLink.isUSListed(symbol)) {
      const why = window.OptionsDeepLink.whyNot ? window.OptionsDeepLink.whyNot(symbol) : null;
      setCurrentPrice(null);
      setLoading(false);
      setOptionsData({ empty: true, notUS: true, index: /^Options on an index/.test(why || ''),
        message: why || 'Options are available for US-listed underlyings. ' + symbol + ' is listed outside the US.' });
      return;
    }
    setLoading(true);

    try {
      // Fetch current price. When the real-time feed is not in the plan the
      // quote is null, and moneyness, GEX and the payoff window were then
      // computed from a spot of zero while the numbers stayed on screen. The
      // last end-of-day close is on every tier and is a day old at worst, so
      // it stands in, and the frame's panel says why real-time is missing.
      const quote = await window.EODHD_API.getRealTimeData(effectiveKey, symbol);
      if (!current()) return;
      let spot = quote ? (parseFloat(quote.close) || parseFloat(quote.previousClose) || null) : null;
      if (!spot) {
        try {
          const to = new Date().toISOString().slice(0, 10);
          const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
          const eod = await window.EODHD_API.getHistoricalData(effectiveKey, symbol, from, to);
          if (!current()) return;
          const lastBar = Array.isArray(eod) && eod.length ? eod[eod.length - 1] : null;
          spot = lastBar ? (parseFloat(lastBar.adjusted_close) || parseFloat(lastBar.close) || null) : null;
        } catch (e) { spot = null; }
      }
      if (!current()) return;
      setCurrentPrice(spot);

      // Fetch options chain
      const data = await window.EODHD_API.getOptionsChain(effectiveKey, symbol);
      if (!current()) return;
      if (data && !data.error && data.data && data.data.length > 0) {
        setOptionsData(data);
        setSelectedExpiry(data.data[0].expirationDate);
      } else if (!data || data.notServed || (data.complete === false && !data.error && !(data.data && data.data.length))) {
        // Nothing came back (no page answered): the limit, no connection. Said with
        // the reason -- not "No options data available", which is an answer
        // (RateLimitWait.failure; at the limit Try again counts down).
        // A refusal the open apps' panel already explains is pointed to.
        // `notServed`: what the client knows of why, so a 500 is named as
        // one; a chain answered with no contracts is not
        // this, it is "No Options Available" below.
        const f = window.RateLimitWait.failure(data && data.notServed ? data.notServed : null);
        // Pointed to only for a refusal or no answer: an error of EODHD's
        // (500) or an answer it could not read is named here, not "did not
        // answer for this key" under a panel reading HTTP 500.
        const explained = !f.limited && !f.unreadable && !(f.status >= 500) && window.Entitlement && window.Entitlement.explained && window.Entitlement.explained();
        setOptionsData({ empty: true, retry: true, failed: f, message: explained
          ? 'The options feed did not answer for this key — see the panel above. This is not a statement about ' + symbol.split('.')[0] + '.'
          : window.RateLimitWait.failText('The options chain for ' + symbol.split('.')[0], f) });
      } else {
        // Pages not served are worth a retry; a chain that came back whole
        // and empty is an answer.
        setOptionsData({ empty: true, retry: true, message: (window.Entitlement && window.Entitlement.explained && window.Entitlement.explained())
          ? 'The options feed did not answer for this key — see the panel above. This is not a statement about ' + symbol.split('.')[0] + '.'
          : (data?.error || 'No options data available for ' + symbol.split('.')[0]) });
      }
    } catch (e) {
      if (!current()) return;
      console.error('[OptionsExplorer] Load error:', e);
      const f = window.RateLimitWait.failure(e);
      setOptionsData({ empty: true, retry: true, failed: f, message: (!f.limited && window.Entitlement && window.Entitlement.explained()) ? '' : window.RateLimitWait.failText('The options chain', f) });
    }
    if (current()) setLoading(false);
  }, [apiKey]);
  selectTickerRef.current = selectTicker;

  // Enter with no row to open: what the typed text is (window.SymbolCode),
  // the same answer a link gives. An index or a listing typed with its
  // exchange -- Yahoo's too, VOD.L is VOD.LSE -- is named by the page
  // without a request ("No index options", "listed outside the US"); text
  // that is no ticker reads "Not a ticker"; a code the search has no US row
  // for is "No listing found". Enter needed a search row, so VOD.LSE,
  // SAP.XETRA and GSPC.INDX did nothing.
  // afterAnswer: called for an Enter kept for the search that just answered.
  // A ticker on screen stays when the entry is refused. "AAPL$" + Enter over
  // AAPL's chain with Payoff legs built wiped the tabs and the chain, left
  // only "not a ticker", and Esc brought nothing back.
  // With a ticker shown, a refusal -- not a ticker, an index, a listing
  // outside the US, not found, the limit -- is said under the field (where
  // not found and the limit already were) and the chain, the tab and the
  // legs are as they were; Esc puts the entry away. With none shown, the
  // page says it in its own place, as accepted.
  const refuseTyped = (words) => {
    typedCheckRef.current++;
    setSearchNote(words);
  };
  // A ticker on screen: a chain, or one loading, failed or with no options.
  // The page's own refusal of a code (outside the US, an index, not a
  // ticker) is not one -- a new entry takes its place, as before.
  const tickerShown = () => {
    const sel = selectedRef.current;
    const d = optionsDataRef.current;
    return Boolean(sel && sel.symbol) && !(d && (d.notUS || d.junk || d.index));
  };
  // An index, a listing outside the US or a pair: named by the page without
  // a request. Over a ticker on screen it is a refusal under the field.
  const openOrRefuse = (sym) => {
    const DL = window.OptionsDeepLink;
    if (tickerShown() && DL && DL.isUSListed && !DL.isUSListed(sym)) {
      refuseTyped((DL.whyNot && DL.whyNot(sym)) || ('Options are available for US-listed underlyings. ' + sym + ' is listed outside the US.'));
      return;
    }
    selectTicker(sym, '');
  };
  const openTyped = (q, afterAnswer) => {
    const SC = window.SymbolCode;
    const t = SC && SC.parse ? SC.parse(q) : null;
    pendingEnter.current = false;
    setActiveIdx(-1);
    setSearchResults([]);
    if (!t || t.kind === 'empty') return;
    if (t.kind === 'index' || t.kind === 'listing') { openOrRefuse(t.symbol); return; }
    if (t.kind === 'junk') {
      const why = window.OptionsDeepLink && window.OptionsDeepLink.whyNot ? window.OptionsDeepLink.whyNot(String(q).trim()) : null;
      const words = why || ('"' + String(q).trim().slice(0, 30) + '" is not a ticker. Use a US code, e.g. AAPL or AAPL.US.');
      if (tickerShown()) { refuseTyped(words); return; }
      loadSeqRef.current++;
      setLoading(false); setSelectedSymbol(null); setCurrentPrice(null);
      setOptionsData({ empty: true, junk: true, message: words });
      return;
    }
    const last = lastFound.current;
    if (last && last.query === q && last.failed) {
      const A = window.EODHD_API;
      const until = A && typeof A.rateLimitedUntil === 'function' ? Number(A.rateLimitedUntil()) || 0 : 0;
      const left = until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
      // "Press Enter to try again" meant it: this Enter asks the search
      // again and is kept for its answer. It read the old failure and said
      // the same line, offline or back online. Inside a
      // 429 wait nothing is sent; an Enter kept for a search that failed
      // again says so once, and does not ask by itself.
      if (left || afterAnswer) {
        setSearchNote(left ? SC.limitNote(left) : 'The ticker search did not answer. Press Enter to try again.');
        return;
      }
      handleSearch(q);
      pendingEnter.current = true;
      return;
    }
    // A code with no US row -- one letter is never searched (F, V, T, C) --
    // is what SymbolCode.listed says, as a link is: "F" read "No listing found for
    // F" unchecked, and #/options?symbol=F opens Ford.
    const rows = last && last.query === q ? last.rows : [];
    const notFound = () => SC.noneNote(q) + '.' + (SC.didYouMean(rows, q) || ' Options are offered for US-listed codes, e.g. AAPL.');
    if (t.kind === 'code') {
      const sym = SC.of(q);
      // A pair (BTC-USD, EURUSD): the page names it without a request.
      if (sym && !/\.US$/.test(sym)) { openOrRefuse(sym); return; }
      const api = SC.apiFor(window.EODHD_API, apiKey);
      const seq = ++typedCheckRef.current;
      Promise.resolve(SC.listed(sym, api)).then((ok) => {
        if (seq !== typedCheckRef.current || latestQuery.current !== q) return;
        if (ok === true) selectTicker(sym, '');
        else if (ok === 'limited') setSearchNote(SC.limitNote(api.limited()));
        else if (ok && ok.failed !== undefined) setSearchNote(SC.failNote(q, ok.failed, ok.unreadable));
        else setSearchNote(notFound());
      });
      return;
    }
    setSearchNote(notFound());
  };
  openTypedRef.current = openTyped;
  const openSuggestion = (idx) => {
    typedCheckRef.current++;
    const item = searchResults[idx];
    if (!item) { openTyped(latestQuery.current); return; }
    pendingEnter.current = false;
    setActiveIdx(-1);
    selectTicker(item.Code + '.' + (item.Exchange || 'US'), item.Name || item.Code);
  };

  // The Enter that came before the suggestions did.
  useEffect(() => {
    if (!pendingEnter.current || !searchResults.length) return;
    openSuggestion(window.OptionsSearchPick(searchResults, latestQuery.current, -1));
  }, [searchResults]);

  useEffect(() => {
    if (loading || !retryFocusRef.current) return;
    retryFocusRef.current = false;
    focusNext(() => document.querySelector('[role="tablist"][aria-label="Options tools"] [aria-selected="true"]')
      || document.querySelector('[data-opt-retry]')
      || document.querySelector('[data-opt-empty-heading]'));
  }, [loading]);

  const onSearchKeyDown = (e) => {
    const n = searchResults.length;
    // Tab leaves the field: the list closes with it. It stayed open over the
    // page, and the focus went to a button it covered.
    if (e.key === 'Tab' && n) { setSearchResults([]); setActiveIdx(-1); return; }
    // ArrowDown (or Alt+ArrowDown) in a field with text opens the list again.
    if (e.key === 'ArrowDown' && !n && String(searchQuery || '').trim().length >= 2) {
      e.preventDefault();
      if (lastFound.current.query === searchQuery && lastFound.current.rows.length) setSearchResults(lastFound.current.rows);
      else handleSearch(searchQuery);
      return;
    }
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      setActiveIdx(i => (i + 1) % n);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      setActiveIdx(i => (i <= 0 ? n - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // While a newer search is in flight the list on screen is for an older
      // prefix ("MS" -> Morgan Stanley first): wait for the answer to what
      // was actually typed, unless a row was picked with the arrows.
      if (n && (!searchLoading || activeIdx >= 0)) openSuggestion(window.OptionsSearchPick(searchResults, searchQuery, activeIdx));
      else if (searchLoading) pendingEnter.current = true;
      // No rows: the typed text decides, as a link does.
      else if (String(searchQuery || '').trim()) openTyped(searchQuery);
    } else if (e.key === 'Escape' && n) {
      setSearchResults([]);
      setActiveIdx(-1);
    } else if (e.key === 'Escape' && searchNote) {
      // A refused entry is put away: the field and its sentence are cleared,
      // and what is on screen was never touched.
      e.preventDefault();
      typedCheckRef.current++;
      handleSearch('');
    }
  };

  // An expiry the chain came back without is fetched when it is picked.
  //
  // getOptionsChain returns the nearest expiries complete, which is every one
  // for a normal name and the first ten or so for SPY — its chain is 12,608
  // live contracts and thirteen pages. The rest arrive here, one request each,
  // two to four seconds, complete. Nothing is missing; it is only not fetched
  // before anybody has asked for it.
  const [loadingExpiry, setLoadingExpiry] = useState(false);
  // An expiry, or the later dates, that did not load: what failed and why
  // ({ kind: 'expiry' | 'later', date, failure }), said under the dates with
  // a Try again. The expiry stayed an empty strip of strikes and the later
  // dates read "No later dates" for a 500, the limit or a page that could
  // not be read. `expiryTry` asks the expiry again.
  const [dateFail, setDateFail] = useState(null);
  const [expiryTry, setExpiryTry] = useState(0);
  useEffect(() => { setDateFail(null); }, [selectedSymbol]);
  useEffect(() => {
    if (!selectedExpiry || !optionsData?.data || !selectedSymbol) return;
    const entry = optionsData.data.find(d => d.expirationDate === selectedExpiry);
    if (!entry || entry.options?.CALL?.length || entry.options?.PUT?.length) return;
    // Asked once for this chain: an expiry that answered with no contracts
    // was swapped in empty, which changed the chain and asked again, a
    // metered request each time, for as long as it was picked. One that was
    // not served (null) may be asked again on the next change.
    const key = selectedSymbol.symbol + '|' + selectedExpiry;
    if (askedExpiryRef.current.has(key)) return;
    askedExpiryRef.current.add(key);

    let cancelled = false;
    let done = false;
    setLoadingExpiry(true);
    (async () => {
      const got = await window.EODHD_API.getOptionsExpiry(
        effectiveKey, selectedSymbol.symbol, selectedExpiry);
      done = true;
      // Null (an older client) or not served: kept as it is, said, and
      // asked again on Try again or the next change.
      const failedNow = !got || Boolean(got.notServed);
      const filled = failedNow ? null : got;
      if (failedNow) askedExpiryRef.current.delete(key);
      if (!cancelled) setDateFail(failedNow ? { kind: 'expiry', date: selectedExpiry, failure: window.RateLimitWait.failure(got && got.notServed ? got.notServed : null) } : null);
      if (cancelled || !filled) { setLoadingExpiry(false); return; }
      setOptionsData(prev => (prev && prev.data ? {
        ...prev,
        data: prev.data.map(d => (d.expirationDate === selectedExpiry ? filled : d)),
      } : prev));
      setLoadingExpiry(false);
    })();
    return () => { cancelled = true; if (!done) askedExpiryRef.current.delete(key); };
  }, [selectedExpiry, selectedSymbol, apiKey, optionsData, expiryTry]);

  // Dates beyond the ones already on screen, asked for rather than guessed.
  //
  // The ref, not the state, is the guard: three clicks in the same tick all
  // saw loadingExpiry still false and sent three identical requests
  // The spot price narrows the query to a few strikes, so one
  // click brings every remaining date rather than four.
  const loadingMoreRef = useRef(false);
  const loadMoreExpirations = useCallback(async () => {
    if (!optionsData?.data?.length || !selectedSymbol || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingExpiry(true);
    const last = optionsData.data[optionsData.data.length - 1].expirationDate;
    const dates = await window.EODHD_API.getMoreOptionsExpirations(
      effectiveKey, selectedSymbol.symbol, last, currentPrice);
    // Not served: not "No later dates" -- said, with a Try again, and the
    // button stays.
    setDateFail(dates.failed ? { kind: 'later', failure: window.RateLimitWait.failure(dates.failed) } : null);
    if (dates.failed) {
      // nothing to add
    } else if (dates.length) {
      // The answer held every remaining date: nothing is left to ask for.
      if (dates.complete === true) setNoLaterDates(true);
      setOptionsData(prev => (prev && prev.data ? {
        ...prev,
        // Listed empty: the effect above fills whichever one is picked.
        data: prev.data.concat(dates.map(d => ({
          expirationDate: d, options: { CALL: [], PUT: [] },
        }))),
      } : prev));
      // Focus follows what the press brought: the first of the new dates --
      // if it is still on the button that was pressed.
      setTimeout(() => {
        const group = expiryGroupRef.current;
        if (!group || (document.activeElement !== laterDatesRef.current && document.activeElement !== document.body)) return;
        const chip = group.querySelector('[data-expiry="' + dates[0] + '"]');
        if (chip) chip.focus();
      }, 0);
    } else {
      // The button leaves the page; focus goes to the last date there is.
      const hadFocus = document.activeElement === laterDatesRef.current;
      setNoLaterDates(true);
      setLaterNote(true);
      setTimeout(() => setLaterNote(false), 4000);
      if (hadFocus) setTimeout(() => {
        const chips = expiryGroupRef.current ? expiryGroupRef.current.querySelectorAll('[data-expiry]') : [];
        if (chips.length) chips[chips.length - 1].focus();
      }, 0);
    }
    loadingMoreRef.current = false;
    setLoadingExpiry(false);
  }, [optionsData, selectedSymbol, apiKey, currentPrice]);

  // Calculate payoff
  const calculatePayoff = useCallback(() => {
    if (!optionsData?.data || !selectedExpiry || !currentPrice) return null;
    const expiryData = optionsData.data.find(d => d.expirationDate === selectedExpiry);
    if (!expiryData) return null;

    const calls = expiryData.options?.CALL || [];
    const puts = expiryData.options?.PUT || [];
    if (calls.length === 0) return null;

    // Strikes the chain lists and the chain's own quotes for them. The legs
    // used to be $5-rounded strikes priced as 0.6x / 0.5x / 0.3x of the ATM
    // premium, and the breakeven was the next grid point ($333 for a true
    // $331.61). Same helpers as the Payoff Builder.
    const PM = window.PayoffMath;
    const strikes = [...new Set([...calls, ...puts].map(o => o.strike))];
    const k = PM.presetStrikes(strikes, currentPrice);
    if (!k) return null;
    const atmStrike = k.atm;
    const atmIV = PM.atmIV(calls, puts, currentPrice) || 0.3;
    const T = Math.max(1, (new Date(selectedExpiry) - new Date()) / 864e5) / 365;
    let estimated = false;
    const price = (type, strike) => {
      const opt = (type === 'call' ? calls : puts).find(o => o.strike === strike);
      const q = PM.quote(opt);
      if (q != null) return q;
      estimated = true;
      const BS = window.OptionsBS;
      return type === 'call' ? BS.callPrice(currentPrice, strike, T, 0.05, atmIV) : BS.putPrice(currentPrice, strike, T, 0.05, atmIV);
    };
    const leg = (type, action, strike) => ({ type, action, strike, premium: type === 'stock' ? 0 : price(type, strike), quantity: 1 });

    const shapes = {
      long_call: () => [leg('call', 'buy', k.atm)],
      long_put: () => [leg('put', 'buy', k.atm)],
      covered_call: () => [leg('stock', 'buy', currentPrice), leg('call', 'sell', k.otmUp)],
      straddle: () => [leg('call', 'buy', k.atm), leg('put', 'buy', k.atm)],
      strangle: () => [leg('call', 'buy', k.otmUp), leg('put', 'buy', k.otmDown)],
      bull_call_spread: () => [leg('call', 'buy', k.atm), leg('call', 'sell', k.otmUp)],
      iron_condor: () => [leg('put', 'buy', k.farDown), leg('put', 'sell', k.otmDown), leg('call', 'sell', k.otmUp), leg('call', 'buy', k.farUp)],
    };
    // A shape whose strikes this expiry does not list is not drawn at all.
    const needs = { covered_call: [k.otmUp], strangle: [k.otmUp, k.otmDown], bull_call_spread: [k.otmUp], iron_condor: [k.farDown, k.otmDown, k.otmUp, k.farUp] };
    if ((needs[payoffStrategy] || []).some(x => x == null)) return { unavailable: true };
    const legs = (shapes[payoffStrategy] || shapes.long_call)();

    const low = currentPrice * 0.7;
    const high = currentPrice * 1.3;
    const step = (high - low) / 60;
    const payoffs = [];
    for (let p = low; p <= high + 1e-9; p += step) {
      const pr = Math.round(p * 100) / 100;
      payoffs.push({ price: pr, payoff: Math.round(PM.payoffAt(legs, pr) * 100) / 100 });
    }
    // Exact breakevens (PayoffMath.analyze); only the ones inside the drawn
    // window get a marker.
    const breakevens = PM.analyze(legs).breakevens.filter(b => b >= low && b <= high);
    const callPremium = price('call', atmStrike);
    const putPremium = price('put', atmStrike);

    return { payoffs, currentPrice, atmStrike, callPremium, putPremium, breakevens, estimated };
  }, [optionsData, selectedExpiry, payoffStrategy, currentPrice]);

  // Styles
  const cardStyle = {
    ...(isDark ? C3.glassDark : C3.glassLight),
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  };

  const DEMO_STRIKE_LIMIT = 5;

  // Render subscribe page for users without options access
  const renderSubscribePage = () => (
    <div style={{ padding: '0' }}>
      {/* Tip: select a ticker above to preview options data */}
      <div style={{
        ...cardStyle, textAlign: 'center',
        background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
      }}>
        <p style={{ fontSize: '13px', color: isDark ? C3.textMutedDark : C3.textMutedLight, margin: '0 0 4px' }}>
          Select a ticker above to preview options chain data
        </p>
      </div>

      {/* Features */}
      <div style={cardStyle}>
        <h3 style={{ fontWeight: '700', fontSize: '15px', marginBottom: '12px', marginTop: 0 }}>Options Intelligence</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[
            { icon: 'layers', title: 'Full Options Chain', desc: '6,000+ US stocks, all strikes & expirations' },
            { icon: 'tool', title: 'Greeks Analysis', desc: 'Delta, Gamma, Theta, Vega, Rho — 43 fields per contract' },
            { icon: 'trendUp', title: 'Payoff Diagrams', desc: 'Visual P&L for Long Call, Put, Straddle, Covered Call' },
            { icon: 'clock', title: '2-Year History', desc: 'EOD bid/ask, volume, open interest with full lookback' },
          ].map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0, marginTop: '2px' }}>{React.createElement(Icon, { name: f.icon, size: 20 })}</span>
              <div>
                <p style={{ fontWeight: '600', fontSize: '14px', margin: '0 0 2px' }}>{f.title}</p>
                <p style={{ fontSize: '12px', color: isDark ? C3.textMutedDark : C3.textMutedLight, margin: 0 }}>{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pricing */}
      <div style={{
        ...cardStyle,
        background: isDark ? C3.fillDark : C3.fillLight,
        border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}`,
        textAlign: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '12px' }}>
          {/* One price. The struck $39.99 beside $24.99 with a Save badge was a
              permanent sale, and $24.99 had been wrong since the add-on moved to
              $29.99. */}
          <span style={{ fontSize: '22px', fontWeight: '700', color: C3.glowOrange }}>
            {'$29.99/mo'}
          </span>
        </div>
        <button onClick={() => onShowOptionsSettings ? onShowOptionsSettings() : onUpgradeClick()} style={{
          width: '100%', padding: '14px', background: C3.logoGradient, border: 'none',
          borderRadius: '12px', color: 'white', fontSize: '16px', fontWeight: '700', cursor: 'pointer',
          fontFamily: "'Sora', sans-serif",
        }}>
          Subscribe to Options Intelligence
        </button>
      </div>
    </div>
  );

  const renderOptionsChain = () => {
    if (!optionsData?.data || optionsData.data.length === 0) return null;
    const showPaywall = !hasOptionsAccess;
    // The Greek columns' purple: #6A5ACD was 2.90:1 on the dark card at 11px,
    // 626 of 1,546 texts in the dark chain under AA. Lighter on
    // dark; a shade darker on light, so it holds on the green/red ITM tints.
    const greekInk = isDark ? '#a39bf0' : '#5b4bc4';

    const expiryData = optionsData.data.find(d => d.expirationDate === selectedExpiry);
    if (!expiryData) return null;

    const calls = expiryData.options?.CALL || [];
    const puts = expiryData.options?.PUT || [];
    const price = currentPrice || 0;

    // Build strike map
    const strikeMap = {};
    calls.forEach(c => { strikeMap[c.strike] = { ...(strikeMap[c.strike] || {}), call: c }; });
    puts.forEach(p => { strikeMap[p.strike] = { ...(strikeMap[p.strike] || {}), put: p }; });
    const allStrikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);
    const strikes = showPaywall ? allStrikes.slice(0, DEMO_STRIKE_LIMIT) : allStrikes;
    // Opaque, so the scrolled price cells pass under it.
    const strikeSticky = { position: 'sticky', left: 0, right: 0, zIndex: 1, background: isDark ? '#25231d' : '#f4f4f6' };
    const hasMoreStrikes = showPaywall && allStrikes.length > DEMO_STRIKE_LIMIT;

    return (
      <div>
        {/* Expiry Selector */}
        <div style={cardStyle}>
          <h3 id="opt-expiry-heading" style={{ fontWeight: '700', marginBottom: '12px', fontSize: '15px' }}>Expiration Date</h3>
          {/* A group of toggles: the picked date says so to a screen reader
              (expiry buttons had neither aria-pressed nor -selected). */}
          <div ref={expiryGroupRef} role="group" aria-labelledby="opt-expiry-heading" style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px', WebkitOverflowScrolling: 'touch' }}>
            {(showPaywall ? optionsData.data.slice(0, 2) : optionsData.data).map(exp => (
              <button key={exp.expirationDate} type="button" data-expiry={exp.expirationDate} aria-pressed={selectedExpiry === exp.expirationDate} onClick={() => setSelectedExpiry(exp.expirationDate)} style={{
                padding: '8px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: '600',
                whiteSpace: 'nowrap', cursor: 'pointer', border: 'none',
                background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                color: isDark ? C3.textDark : C3.textLightTheme,
                ...window.ToggleStyle.value(selectedExpiry === exp.expirationDate, isDark),
              }}>
                {exp.expirationDate}
              </button>
            ))}
            {showPaywall && optionsData.data.length > 2 && (
              <div style={{
                padding: '8px 14px', borderRadius: '10px', fontSize: '12px',
                background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                color: isDark ? C3.textMutedDark : C3.textMutedLight,
                display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap',
              }}>
                <Icon name="lock" size={12} /> +{optionsData.data.length - 2} more
              </div>
            )}
            {/* The chain arrives with the nearest expiries — for SPY that is
                ten or twelve of thirty-one, because its 12,608 live contracts
                are thirteen pages. Rather than let the strip look like the end
                of the list, ask for what comes after it. */}
            {laterNote && (
              <span role="status" style={{ padding: '8px 4px', fontSize: '12px', whiteSpace: 'nowrap', alignSelf: 'center', color: isDark ? C3.textMutedDark : C3.textMutedLight }}>No later dates</span>
            )}
            {!showPaywall && !noLaterDates && optionsData.complete !== true && (
              <button ref={laterDatesRef} onClick={() => { if (!loadingExpiry) loadMoreExpirations(); }}
                // aria-disabled, not disabled: a disabled button gives its
                // focus up to <body> while the dates load.
                aria-disabled={loadingExpiry || undefined} style={{
                padding: '8px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: '600',
                whiteSpace: 'nowrap', cursor: loadingExpiry ? 'default' : 'pointer',
                border: '1px dashed ' + (isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)'),
                background: isDark ? '#0d0d12' : '#ffffff', opacity: loadingExpiry ? 0.5 : 1,
                color: isDark ? C3.textMutedDark : C3.textMutedLight,
                position: 'sticky', right: 0, zIndex: 1,
                boxShadow: isDark ? '-12px 0 12px -6px rgba(0,0,0,0.75)' : '-12px 0 12px -6px rgba(0,0,0,0.18)',
              // A soft edge where it overlaps the chips it sits on.
              boxShadow: isDark ? '-12px 0 12px -6px rgba(0,0,0,0.75)' : '-12px 0 12px -6px rgba(0,0,0,0.18)',
              }}>
                {loadingExpiry ? 'Loading…' : 'Later dates'}
              </button>
            )}
          </div>
          {dateFail && !loadingExpiry && (dateFail.kind === 'later' || dateFail.date === selectedExpiry) && (
            <window.RateLimitWait.FailNote panel={'options-dates-' + dateFail.kind}
              what={dateFail.kind === 'later' ? 'The later dates' : 'The contracts for ' + dateFail.date}
              failure={dateFail.failure} isDark={isDark} data-opt-date-fail={dateFail.kind}
              onRetry={() => {
                if (dateFail.kind === 'later') { loadMoreExpirations(); return; }
                setDateFail(null);
                setExpiryTry((n) => n + 1);
              }}
              style={{ marginTop: 10 }} />
          )}
        </div>

        {/* Option Type Filter */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          {[
            { id: 'all', label: 'All' },
            { id: 'calls', label: 'Calls' },
            { id: 'puts', label: 'Puts' },
          ].map(t => (
            <button key={t.id} onClick={() => setOptionType(t.id)} aria-pressed={optionType === t.id} style={{
              flex: 1, padding: '8px', borderRadius: '10px', fontSize: '13px', fontWeight: '600',
              cursor: 'pointer', border: 'none',
              background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              color: isDark ? C3.textDark : C3.textLightTheme,
              ...window.ToggleStyle.value(optionType === t.id, isDark),
            }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Options Chain Table */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ fontWeight: '700', margin: 0, fontSize: '15px' }}>Options Chain</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* A toggle in the chrome: off, the neutral fill and hairline;
                  on, the accent like every value toggle (ToggleStyle). It was a
                  lavender pill (rgba(106,90,205,0.15)), a purple left over from
                  design stage 1; the Greek columns below keep their purple,
                  which is data. */}
              <button data-hit="" onClick={() => setShowGreeks(!showGreeks)} aria-pressed={showGreeks} style={{
                padding: '4px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: '600',
                cursor: 'pointer',
                border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}`,
                background: isDark ? C3.fillDark : C3.fillLight,
                color: isDark ? C3.textMutedDark : C3.textMutedLight,
                ...window.ToggleStyle.value(showGreeks, isDark, { bordered: true }),
              }}>
                Greeks {showGreeks ? 'ON' : 'OFF'}
              </button>
              <span style={{ fontSize: '12px', color: isDark ? C3.textMutedDark : C3.textMutedLight }}>
                {showPaywall ? `${DEMO_STRIKE_LIMIT} of ${allStrikes.length}` : `${allStrikes.length}`} strikes
              </span>
            </div>
          </div>
          {price > 0 && (
            <div style={{
              fontSize: '12px', color: isDark ? C3.textMutedDark : C3.textMutedLight,
              marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px',
            }}>
              <span>Current: </span>
              <span style={{ fontWeight: '700', color: isDark ? C3.textDark : C3.textLightTheme }}>${price.toFixed(2)}</span>
            </div>
          )}
          {/* The strike column stays in view (sticky both sides) while the
              chain scrolls sideways: at 360-390 px it sat at 471-530 px, off
              screen, beside rows of prices with no strike. */}
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }} tabIndex={0} role="region" aria-label="Options chain (scrolls sideways)">
            <table style={{ width: '100%', minWidth: showGreeks ? (optionType === 'all' ? '900px' : '500px') : (optionType === 'all' ? '580px' : '320px'), borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}` }}>
                  {(optionType === 'all' || optionType === 'calls') && (
                    <th colSpan={showGreeks ? 9 : 5} style={{ padding: '4px', textAlign: 'center', color: isDark ? C3.success : (C3.successLight || '#047857'), fontWeight: '700', fontSize: '11px', letterSpacing: '0.5px' }}>CALLS</th>
                  )}
                  {/* Muted ink, not the table's faded header ink: #8a8270 on the
                      sticky column's #25231d read 4.11:1 in the dark theme. */}
                  <th style={{ padding: '4px', textAlign: 'center', fontWeight: '800', fontSize: '11px', color: isDark ? C3.textMutedDark : C3.textMutedLight, ...strikeSticky }}>STRIKE</th>
                  {(optionType === 'all' || optionType === 'puts') && (
                    <th colSpan={showGreeks ? 9 : 5} style={{ padding: '4px', textAlign: 'center', color: isDark ? '#f87171' : (C3.errorLight || '#c81e2c'), fontWeight: '700', fontSize: '11px', letterSpacing: '0.5px' }}>PUTS</th>
                  )}
                </tr>
                <tr style={{ borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}` }}>
                  {(optionType === 'all' || optionType === 'calls') && (
                    <>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>Last</th>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>Bid</th>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>Ask</th>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>Vol</th>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>OI</th>
                      {showGreeks && <>
                        <th style={{ padding: '6px 3px', textAlign: 'right', color: greekInk, fontSize: '10px' }}>IV</th>
                        <th style={{ padding: '6px 3px', textAlign: 'right', color: greekInk, fontSize: '10px' }}>{'\u0394'}</th>
                        <th style={{ padding: '6px 3px', textAlign: 'right', color: greekInk, fontSize: '10px' }}>{'\u0393'}</th>
                        <th style={{ padding: '6px 3px', textAlign: 'right', color: greekInk, fontSize: '10px' }}>{'\u0398'}</th>
                      </>}
                    </>
                  )}
                  <th style={{ padding: '6px 3px', textAlign: 'center', fontSize: '10px', fontWeight: '700', ...strikeSticky }}></th>
                  {(optionType === 'all' || optionType === 'puts') && (
                    <>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>Last</th>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>Bid</th>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>Ask</th>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>Vol</th>
                      <th style={{ padding: '6px 3px', textAlign: 'right', color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '10px' }}>OI</th>
                      {showGreeks && <>
                        <th style={{ padding: '6px 3px', textAlign: 'right', color: greekInk, fontSize: '10px' }}>IV</th>
                        <th style={{ padding: '6px 3px', textAlign: 'right', color: greekInk, fontSize: '10px' }}>{'\u0394'}</th>
                        <th style={{ padding: '6px 3px', textAlign: 'right', color: greekInk, fontSize: '10px' }}>{'\u0393'}</th>
                        <th style={{ padding: '6px 3px', textAlign: 'right', color: greekInk, fontSize: '10px' }}>{'\u0398'}</th>
                      </>}
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {strikes.map(strike => {
                  const Cell = window.OptionsChainCell;
                  const c = strikeMap[strike]?.call || {};
                  const p = strikeMap[strike]?.put || {};
                  const callITM = price > strike;
                  const putITM = price < strike;
                  return (
                    <tr key={strike} style={{ borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'}` }}>
                      {(optionType === 'all' || optionType === 'calls') && (
                        <>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.price(c.lastPrice)}</td>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.price(c.bid)}</td>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.price(c.ask)}</td>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.count(c.volume)}</td>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.count(c.openInterest)}</td>
                          {showGreeks && <>
                            <td style={{ padding: '7px 3px', textAlign: 'right', fontSize: '11px', color: greekInk, background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.iv(c.impliedVolatility)}</td>
                            <td style={{ padding: '7px 3px', textAlign: 'right', fontSize: '11px', color: greekInk, background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.greek(c.delta, 3)}</td>
                            <td style={{ padding: '7px 3px', textAlign: 'right', fontSize: '11px', color: greekInk, background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.greek(c.gamma, 4)}</td>
                            <td style={{ padding: '7px 3px', textAlign: 'right', fontSize: '11px', color: greekInk, background: callITM ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)') : 'transparent' }}>{Cell.greek(c.theta, 4)}</td>
                          </>}
                        </>
                      )}
                      <td style={{
                        padding: '7px 3px', textAlign: 'center', fontWeight: '800', fontSize: '12px',
                        color: isDark ? C3.textDark : C3.textLightTheme,
                        ...strikeSticky,
                      }}>${strike}</td>
                      {(optionType === 'all' || optionType === 'puts') && (
                        <>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.price(p.lastPrice)}</td>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.price(p.bid)}</td>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.price(p.ask)}</td>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.count(p.volume)}</td>
                          <td style={{ padding: '7px 3px', textAlign: 'right', background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.count(p.openInterest)}</td>
                          {showGreeks && <>
                            <td style={{ padding: '7px 3px', textAlign: 'right', fontSize: '11px', color: greekInk, background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.iv(p.impliedVolatility)}</td>
                            <td style={{ padding: '7px 3px', textAlign: 'right', fontSize: '11px', color: greekInk, background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.greek(p.delta, 3)}</td>
                            <td style={{ padding: '7px 3px', textAlign: 'right', fontSize: '11px', color: greekInk, background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.greek(p.gamma, 4)}</td>
                            <td style={{ padding: '7px 3px', textAlign: 'right', fontSize: '11px', color: greekInk, background: putITM ? (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)') : 'transparent' }}>{Cell.greek(p.theta, 4)}</td>
                          </>}
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Paywall upsell */}
          {hasMoreStrikes && (
            <div style={{
              textAlign: 'center', padding: '16px 12px', marginTop: '8px',
              background: isDark ? C3.fillDark : C3.fillLight,
              borderRadius: '12px', border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}`,
            }}>
              <p style={{ fontSize: '13px', fontWeight: '600', marginBottom: '8px', color: isDark ? C3.textDark : C3.textLightTheme }}>
                {allStrikes.length - DEMO_STRIKE_LIMIT} more strikes + Payoff Diagrams & Greeks
              </p>
              <p style={{ fontSize: '12px', color: isDark ? C3.textMutedDark : C3.textMutedLight, marginBottom: '8px' }}>
                Options Intelligence — {'$29.99/mo'}
              </p>
              <button onClick={() => onShowOptionsSettings ? onShowOptionsSettings() : onUpgradeClick()} style={{
                padding: '10px 24px', background: C3.logoGradient, border: 'none',
                borderRadius: '10px', color: 'white', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
              }}>
                Subscribe to Options Intelligence
              </button>
            </div>
          )}
        </div>

        {/* Payoff Diagram — only for subscribers */}
        {!showPaywall && (() => {
          const payoffData = calculatePayoff();
          if (!payoffData) return null;

          // Strikes for this shape not listed at this expiry: keep the
          // selector, say why there is no chart (the axis math below runs on
          // a flat placeholder and is not drawn).
          const unavailable = Boolean(payoffData.unavailable);
          const payoffs = unavailable ? [{ price: 0, payoff: 0 }, { price: 1, payoff: 0 }] : payoffData.payoffs;
          const cp = payoffData.currentPrice || 0;
          const _isWebGEX = window.APP_PLATFORM === 'WEB';
          // Drawn at the width it is shown at, at every width (a phone and a
          // tablet both got a scaled-down drawing with unreadable labels).
          // Until the width is known, the old fixed drawing.
          const measuredPayoff = payoffW > 0;
          const svgW = measuredPayoff ? Math.max(200, payoffW) : (_isWebGEX ? 1000 : 320);
          const svgH = measuredPayoff ? Math.max(220, Math.min(320, Math.round(svgW / 3.2))) : (_isWebGEX ? 300 : 180);
          const padL = measuredPayoff ? 52 : (_isWebGEX ? 60 : 50), padR = 10, padT = 16, padB = 30;
          const fsAxis = measuredPayoff ? '11' : '9';
          const chartW = svgW - padL - padR, chartH = svgH - padT - padB;
          const minPrice = payoffs[0].price, maxPrice = payoffs[payoffs.length - 1].price;
          const payoffRange = Math.max(Math.abs(Math.min(...payoffs.map(p => p.payoff))), Math.abs(Math.max(...payoffs.map(p => p.payoff)))) || 100;
          const scaleX = (pr) => padL + ((pr - minPrice) / (maxPrice - minPrice)) * chartW;
          const scaleY = (pf) => padT + chartH / 2 - (pf / payoffRange) * (chartH / 2);
          const zeroY = scaleY(0);

          let fullPath = payoffs.map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(p.price).toFixed(1)},${scaleY(p.payoff).toFixed(1)}`).join(' ');
          let greenFill = `M${scaleX(minPrice).toFixed(1)},${zeroY.toFixed(1)}`;
          let redFill = `M${scaleX(minPrice).toFixed(1)},${zeroY.toFixed(1)}`;
          payoffs.forEach(p => {
            const x = scaleX(p.price);
            greenFill += ` L${x.toFixed(1)},${p.payoff > 0 ? scaleY(p.payoff).toFixed(1) : zeroY.toFixed(1)}`;
            redFill += ` L${x.toFixed(1)},${p.payoff < 0 ? scaleY(p.payoff).toFixed(1) : zeroY.toFixed(1)}`;
          });
          greenFill += ` L${scaleX(maxPrice).toFixed(1)},${zeroY.toFixed(1)} Z`;
          redFill += ` L${scaleX(maxPrice).toFixed(1)},${zeroY.toFixed(1)} Z`;

          const breakevens = payoffData.breakevens || [];

          return (
            <div style={cardStyle}>
              <h3 style={{ fontWeight: '700', marginBottom: '12px', fontSize: '15px' }}>Payoff Diagram</h3>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', flexWrap: 'wrap' }}>
                {[
                  { id: 'long_call', label: 'Long Call' },
                  { id: 'long_put', label: 'Long Put' },
                  { id: 'covered_call', label: 'Covered Call' },
                  { id: 'straddle', label: 'Straddle' },
                  ...(isWebPlatform ? [
                    { id: 'strangle', label: 'Strangle' },
                    { id: 'bull_call_spread', label: 'Bull Spread' },
                    { id: 'iron_condor', label: 'Iron Condor' },
                  ] : []),
                ].map(s => (
                  <button key={s.id} aria-pressed={payoffStrategy === s.id} onClick={() => { if (window.MIAnalytics) window.MIAnalytics.track('dl_mi_options_strategy', { strategy: s.id }); setPayoffStrategy(s.id); }} style={{
                    padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: '600',
                    cursor: 'pointer', border: 'none',
                    background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                    color: isDark ? C3.textDark : C3.textLightTheme,
                    ...window.ToggleStyle.value(payoffStrategy === s.id, isDark),
                  }}>
                    {s.label}
                  </button>
                ))}
              </div>
              {unavailable ? (
                <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: '13px', color: isDark ? C3.textMutedDark : C3.textMutedLight }}>
                  This expiry does not list enough strikes around the price for this strategy.
                </div>
              ) : (
              <div
                // One stop for the whole diagram: the arrows walk the line and
                // the mouse reads the point under it.
                tabIndex={0} role="group" className="opt-chart"
                ref={payoffRef}
                aria-label="Payoff diagram. Left and right arrows read the profit or loss at each price."
                style={{ position: 'relative' }}
                onKeyDown={(e) => {
                  const n = payoffs.length; const k = e.key;
                  if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
                  e.preventDefault();
                  // Starts at the current price, where the reader's question is.
                  const start = payoffs.reduce((b, p, i) => (Math.abs(p.price - cp) < Math.abs(payoffs[b].price - cp) ? i : b), 0);
                  const step = Math.max(1, Math.round(n / 40));
                  setPayoffAt(payoffAt == null ? start
                    : k === 'Home' ? 0 : k === 'End' ? n - 1
                    : k === 'ArrowRight' ? Math.min(n - 1, payoffAt + step) : Math.max(0, payoffAt - step));
                }}
                onBlur={() => setPayoffAt(null)}
                onMouseMove={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const pr = minPrice + (((e.clientX - r.left) / r.width) * svgW - padL) / chartW * (maxPrice - minPrice);
                  if (pr < minPrice || pr > maxPrice) { if (payoffAt != null) setPayoffAt(null); return; }
                  const at = payoffs.reduce((b, p, i) => (Math.abs(p.price - pr) < Math.abs(payoffs[b].price - pr) ? i : b), 0);
                  if (at !== payoffAt) setPayoffAt(at);
                }}
                onMouseLeave={() => setPayoffAt(null)}
              >
              {/* The reading has its own line above the chart: laid over the
                  chart it covered the peak and the spot label on a phone. The
                  status region is there from the start, empty, so screen
                  readers announce what is written into it. */}
              <div role="status" style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 24, marginBottom: 4 }}>
                {payoffAt != null && payoffs[payoffAt] && (
                  <span className="opt-chart-hint" style={{
                    padding: '3px 8px', borderRadius: 6,
                    fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none',
                    // Follows the theme: the light theme repaints inline white text dark.
                    background: isDark ? '#0f172a' : '#ffffff', color: isDark ? '#ffffff' : '#0f172a',
                    border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.45)' : '#0f172a'),
                  }}>
                    At ${payoffs[payoffAt].price.toFixed(2)}: {payoffs[payoffAt].payoff >= 0 ? 'profit' : 'loss'} ${Math.abs(payoffs[payoffAt].payoff).toFixed(2)}
                  </span>
                )}
              </div>
              <svg role="img" focusable="false"
                aria-label={'Payoff at expiry for prices from $' + minPrice.toFixed(0) + ' to $' + maxPrice.toFixed(0)
                  + ': between a loss of $' + Math.abs(Math.min(0, ...payoffs.map(p => p.payoff))).toFixed(0)
                  + ' and a profit of $' + Math.max(0, ...payoffs.map(p => p.payoff)).toFixed(0)
                  + (breakevens.length ? '; breakeven at ' + breakevens.map(b => '$' + b.toFixed(2)).join(' and ') : '')
                  + '; current price $' + cp.toFixed(2) + '.'}
                viewBox={`0 0 ${svgW} ${svgH}`} style={{ width: '100%', height: 'auto' }}>
                <path d={greenFill} fill={`${C3.success}20`} />
                <path d={redFill} fill={`${C3.error}20`} />
                <line x1={padL} y1={zeroY} x2={svgW - padR} y2={zeroY} stroke={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'} strokeWidth="1" strokeDasharray="4,3" />
                <path d={fullPath} fill="none" stroke={isDark ? '#fff' : '#333'} strokeWidth="2" />
                <line x1={scaleX(cp)} y1={padT} x2={scaleX(cp)} y2={svgH - padB} stroke="#6366f1" strokeWidth="1" strokeDasharray="3,3" />
                <text x={scaleX(cp)} y={padT + 10} fill={(window.A11yColor ? window.A11yColor.text('#6366f1', isDark) : '#6366f1')} fontSize={fsAxis} textAnchor="middle">Current</text>
                {/* Two breakevens close together (a straddle on a phone) wrote
                    over each other, "$32$3.50": the second label goes above
                    the zero line, as in the Payoff Builder.
                    A halo of the card's colour keeps a label readable where
                    the payoff line or the price line crosses it. */}
                {breakevens.map((be, i) => (
                  <g key={i}>
                    <circle cx={scaleX(be)} cy={zeroY} r="4" fill="#f59e0b" stroke={payoffHalo || (isDark ? '#1a1a2e' : '#fff')} strokeWidth="1.5" />
                    <text x={scaleX(be)} y={i > 0 && Math.abs(scaleX(be) - scaleX(breakevens[i - 1])) < 60 ? zeroY - 8 : zeroY + 16}
                      fill={(window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b')}
                      stroke={payoffHalo || (isDark ? '#1a1a2e' : '#fff')} strokeWidth="3" strokeLinejoin="round" style={{ paintOrder: 'stroke' }}
                      fontSize={fsAxis} textAnchor="middle">${be.toFixed(2)}</text>
                  </g>
                ))}
                <text x={padL - 4} y={padT + 8} fill={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)'} fontSize={fsAxis} textAnchor="end">+${(payoffRange).toFixed(0)}</text>
                <text x={padL - 4} y={zeroY + 3} fill={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)'} fontSize={fsAxis} textAnchor="end">$0</text>
                <text x={padL - 4} y={svgH - padB - 2} fill={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)'} fontSize={fsAxis} textAnchor="end">-${(payoffRange).toFixed(0)}</text>
                <text x={padL} y={svgH - padB + 14} fill={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)'} fontSize={fsAxis} textAnchor="start">${minPrice.toFixed(0)}</text>
                <text x={svgW - padR} y={svgH - padB + 14} fill={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)'} fontSize={fsAxis} textAnchor="end">${maxPrice.toFixed(0)}</text>
                {payoffAt != null && payoffs[payoffAt] && (
                  <g>
                    <line x1={scaleX(payoffs[payoffAt].price)} y1={padT} x2={scaleX(payoffs[payoffAt].price)} y2={svgH - padB} stroke={isDark ? '#fff' : '#0f172a'} strokeWidth="1" />
                    <circle cx={scaleX(payoffs[payoffAt].price)} cy={scaleY(payoffs[payoffAt].payoff)} r="4" fill={isDark ? '#fff' : '#0f172a'} />
                  </g>
                )}
              </svg>
              </div>
              )}
              {payoffData.estimated && !unavailable && (
                <div style={{ marginTop: '8px', fontSize: '11px', color: '#b45309' }}>
                  A strike in this shape has no market quote; its premium is a Black-Scholes estimate at the ATM implied volatility.
                </div>
              )}
              <div style={{
                marginTop: '12px', padding: '10px 12px', borderRadius: '10px',
                background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                fontSize: '12px', color: isDark ? C3.textMutedDark : C3.textMutedLight,
              }}>
                {payoffStrategy === 'long_call' && 'Long Call: Bullish bet. Max loss = premium paid. Unlimited upside.'}
                {payoffStrategy === 'long_put' && 'Long Put: Bearish bet. Max loss = premium paid. Profit if stock drops below strike.'}
                {payoffStrategy === 'covered_call' && 'Covered Call: Own stock + sell call. Collect premium, cap upside at strike.'}
                {payoffStrategy === 'straddle' && 'Straddle: Buy call + put at same strike. Profit from large move in either direction.'}
                {payoffStrategy === 'strangle' && 'Strangle: Buy OTM call + OTM put. Cheaper than straddle, needs bigger move.'}
                {payoffStrategy === 'bull_call_spread' && 'Bull Call Spread: Buy ATM call, sell higher call. Limited risk and reward. Bullish.'}
                {payoffStrategy === 'iron_condor' && 'Iron Condor: Sell OTM strangle + buy further OTM protection. Profit if price stays in range.'}
              </div>
            </div>
          );
        })()}
      </div>
    );
  };

  return (
    <window.AppLayout activeTab={activeTab} onTabChange={onTabChange} onSettingsClick={onSettingsClick} theme={theme}>
      {/* Keyframes travel with the view (hosts without the global CSS). */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }
.opt-chart:focus-visible { outline: 2px solid ${isDark ? '#f97316' : '#c2410c'} !important; outline-offset: 2px !important; }`}</style>
      <div style={{ padding: '16px', paddingTop: '20px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          {!isWebPlatform && <button onClick={onClose} aria-label="Back" style={{
            width: '36px', height: '36px', borderRadius: '12px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
            border: 'none', cursor: 'pointer',
            color: isDark ? C3.textDark : C3.textLightTheme,
          }}>
            <Icon name="arrowLeft" size={20} />
          </button>}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <h1 style={{ fontSize: '20px', fontWeight: '700', margin: 0 }}>Options Explorer</h1>
              {window.HelpTooltip && <HelpTooltip title="Options Explorer" text="Analyze options chains with Greeks, build multi-leg strategies, view payoff diagrams, and track unusual activity for 6,000+ US stocks." isDark={isDark} />}
            </div>
            <p style={{ fontSize: '13px', color: isDark ? C3.textMutedDark : C3.textMutedLight, margin: 0 }}>
              EOD options chains for 6,000+ US stocks
            </p>
          </div>
        </div>


        {/* Search — always visible for all users */}
        <div style={{ marginBottom: '16px' }}>
          {/* A tap anywhere on the frame focuses the field: the field is 21 px
              of a 55 px frame, and a tap above or below it did nothing. */}
          <div ref={optExpSearchRef} data-field-frame=""
            onMouseDown={(e) => { if (!e.target.closest('input, button, a, [role="option"], [role="listbox"]')) e.preventDefault(); }}
            onClick={(e) => {
              if (e.target.closest('input, button, a, [role="option"], [role="listbox"]')) return;
              const f = e.currentTarget.querySelector('input[aria-label="Search ticker"]');
              if (f) f.focus();
            }}
            style={{
            ...cardStyle, marginBottom: 0, position: 'relative', cursor: 'text',
            backdropFilter: 'none', WebkitBackdropFilter: 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* The icon keeps its size: at 320 px the field would not shrink
                  and squeezed it to a dot. */}
              <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0 }}>
                <Icon name="search" size={18} color={isDark ? C3.textMutedDark : C3.textMutedLight} />
              </span>
              <input {...window.TickerFieldProps}
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                onKeyDown={onSearchKeyDown}
                data-esc-own={searchResults.length || searchNote ? 'true' : undefined}
                // Fits a 320 px screen ("…(e.g. AAPL, T" was cut).
                placeholder="Search ticker, e.g. AAPL"
                aria-label="Search ticker"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={searchResults.length > 0}
                aria-controls="opt-exp-suggestions"
                aria-activedescendant={activeIdx >= 0 && searchResults[activeIdx] ? `opt-exp-sugg-${activeIdx}` : undefined}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                style={{
                  flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
                  // Solid, and the darker orange on light: the translucent
                  // one read 1.78:1 against the field.
                  boxShadow: searchFocused ? '0 0 0 2px ' + (isDark ? '#f97316' : '#c2410c') : 'none',
                  borderRadius: 6, padding: '2px 4px',
                  color: isDark ? C3.textDark : C3.textLightTheme,
                  fontSize: '15px', fontFamily: "'Sora', sans-serif",
                }}
              />
              {searchLoading && (
                <div style={{
                  width: '16px', height: '16px',
                  border: '2px solid rgba(255,255,255,0.1)', borderTopColor: C3.glowOrange,
                  borderRadius: '50%', animation: 'spin 0.8s linear infinite',
                }} />
              )}
            </div>
          </div>
          {/* Always there, so a reader hears the line when it appears; the
              marker too ("" while it says nothing), so a check can read it. */}
          <div role="status" aria-live="polite" data-no-listing={searchNote ? 'true' : ''}
            style={searchNote ? { marginTop: 6, fontSize: 12, lineHeight: 1.4, overflowWrap: 'anywhere', color: isDark ? C3.textMutedDark : C3.textMutedLight } : undefined}>
            {searchNote || ''}
          </div>

          {React.createElement(window.PortalSearchPopup, {
            anchorRef: optExpSearchRef,
            id: 'opt-exp-suggestions',
            role: 'listbox',
            open: searchResults.length > 0,
            onClose: () => setSearchResults([]),
            isDark,
            maxHeight: 320,
          },
            searchResults.map((item, i) =>
              React.createElement('button', {
                key: i,
                id: `opt-exp-sugg-${i}`,
                role: 'option',
                'aria-selected': i === activeIdx,
                onClick: () => openSuggestion(i),
                style: {
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 16px', border: 'none', cursor: 'pointer', textAlign: 'left',
                  background: i === activeIdx ? (isDark ? 'rgba(249,115,22,0.14)' : 'rgba(249,115,22,0.10)') : 'transparent',
                  color: isDark ? C3.textDark : C3.textLightTheme,
                  borderBottom: i < searchResults.length - 1 ? `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}` : 'none',
                },
              },
                React.createElement('div', null,
                  React.createElement('span', { style: { fontWeight: 700, fontSize: 14 } }, item.Code),
                  React.createElement('span', { style: { fontSize: 12, color: isDark ? C3.textMutedDark : C3.textMutedLight, marginLeft: 8 } }, item.Name),
                ),
                React.createElement('span', { style: { fontSize: 11, color: isDark ? C3.textMutedDark : C3.textMutedLight } }, item.Exchange),
              )
            )
          )}
        </div>

        {/* Popular Tickers */}
        {/* Landing page — before ticker selection */}
        {!selectedSymbol && !loading && !(optionsData && optionsData.junk) && (<>
          {/* Most Active Options */}
          <div style={cardStyle}>
            <h3 style={{ fontWeight: '700', fontSize: '15px', marginBottom: '12px', marginTop: 0 }}>Most Active Options</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' }}>
              {popularTickers.map(t => (
                <button key={t.symbol} onClick={() => {
                  selectTicker(t.symbol, t.name);
                  // The button leaves with the landing page; the focus fell to
                  // <body> whether the chain came or was refused. The chosen ticker's line takes it.
                  focusNext(() => document.querySelector('[data-opt-symbol-heading]'));
                }} style={{
                  padding: '12px 14px', borderRadius: '10px', textAlign: 'left',
                  background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                  border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
                  cursor: 'pointer', color: isDark ? C3.textDark : C3.textLightTheme,
                  fontFamily: "'Sora', sans-serif",
                }}>
                  <div style={{ fontWeight: '700', fontSize: '15px' }}>{t.symbol.split('.')[0]}</div>
                  <div style={{ fontSize: '11px', marginTop: '2px', color: isDark ? 'rgba(255,255,255,0.7)' : C3.textMutedLight }}>{t.name}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Feature showcase */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '12px', marginBottom: '20px' }}>
            {/* Hero 1: GEX Dashboard */}
            <div style={{
              ...cardStyle, marginBottom: 0, cursor: 'default',
              background: isDark ? 'rgba(34,197,94,0.06)' : 'rgba(34,197,94,0.04)',
              border: '1px solid rgba(34,197,94,0.15)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="activity" size={18} color="#22c55e" />
                </div>
                <div>
                  <div style={{ fontWeight: '700', fontSize: '14px' }}>GEX Dashboard</div>
                  <div style={{ fontSize: '11px', color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e'), fontWeight: '600' }}>Dealer Positioning</div>
                </div>
              </div>
              <p style={{ fontSize: '12px', lineHeight: '1.5', opacity: 0.7, margin: '0 0 10px' }}>
                See where market makers are hedging. Gamma flip levels act as support/resistance zones.
              </p>
              {/* Mini GEX preview SVG */}
              <svg aria-hidden="true" focusable="false" viewBox="0 0 200 60" style={{ width: '100%', height: 'auto', opacity: 0.6 }}>
                {[20,35,50,25,15,-10,-25,-40,-20,-5,10,30].map((v, i) => (
                  <rect key={i} x={8 + i * 16} y={v >= 0 ? 30 - v * 0.5 : 30} width={12} height={Math.abs(v) * 0.5} rx={1} fill={v >= 0 ? '#22c55e' : '#ef4444'} opacity={0.7} />
                ))}
                <line x1={0} y1={30} x2={200} y2={30} stroke={isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'} strokeDasharray="3 3" />
                <line x1={100} y1={5} x2={100} y2={55} stroke="#a855f7" strokeWidth={1.5} strokeDasharray="3 3" />
                {/* Label beside the dashed line, not on it: the line used to
                    strike "FLIP" through. */}
                <text x={104} y={11} fill={(window.A11yColor ? window.A11yColor.text('#a855f7', (typeof isDark !== 'undefined' && isDark)) : '#a855f7')} fontSize="7" textAnchor="start">FLIP</text>
              </svg>
              {/* A neutral illustration: the old "Gamma Flip at $185 for AAPL"
                  read as a live level while AAPL traded near $329. */}
              <div style={{ fontSize: '10px', opacity: 0.7, marginTop: '6px' }}>Illustration. Open a ticker to see its live flip level.</div>
            </div>

          </div>

          {/* Secondary feature cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '20px' }}>
            {[
              { icon: 'layers', color: (window.A11yColor ? window.A11yColor.text('#3b82f6', (typeof isDark !== 'undefined' && isDark)) : '#3b82f6'), title: 'Options Chain', desc: 'Full chain with Greeks, IV, volume, OI across all expiries',
                mini: React.createElement('svg', { 'aria-hidden': true, focusable: 'false', viewBox: '0 0 120 30', style: { width: '100%', opacity: 0.4 } },
                  ...[0,1,2,3,4].map(i => React.createElement('rect', { key: i, x: 0, y: i * 6, width: 120, height: 4, rx: 1, fill: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)' })),
                  React.createElement('rect', { x: 0, y: 12, width: 120, height: 4, rx: 1, fill: 'rgba(59,130,246,0.3)' })
                )
              },
              { icon: 'calculator', color: (window.A11yColor ? window.A11yColor.text('#10b981', (typeof isDark !== 'undefined' && isDark)) : '#10b981'), title: 'BS Calculator', desc: 'Black-Scholes pricing, Greeks (Δ Γ Θ V ρ), IV solver on any inputs',
                mini: React.createElement('svg', { 'aria-hidden': true, focusable: 'false', viewBox: '0 0 120 40', style: { width: '100%', opacity: 0.55 } },
                  // Intrinsic (hockey stick)
                  React.createElement('path', { d: 'M0,35 L60,35 L120,5', fill: 'none', stroke: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)', strokeWidth: 1, strokeDasharray: '2 2' }),
                  // BS smooth curve above intrinsic
                  React.createElement('path', { d: 'M0,36 Q30,33 55,24 Q80,12 120,4', fill: 'none', stroke: '#10b981', strokeWidth: 1.6 }),
                  // Strike marker
                  React.createElement('line', { x1: 60, y1: 2, x2: 60, y2: 40, stroke: '#10b981', strokeWidth: 1, strokeDasharray: '2 2', opacity: 0.5 }),
                  React.createElement('text', { x: 60, y: 9, fill: (window.A11yColor ? window.A11yColor.text('#10b981', (typeof isDark !== 'undefined' && isDark)) : '#10b981'), fontSize: '7', textAnchor: 'middle', opacity: 0.8 }, 'K')
                )
              },
              { icon: 'target', color: (window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b'), title: 'Payoff Builder', desc: '9 strategies, multi-leg, PoP, Greeks, scenario sliders',
                mini: React.createElement('svg', { 'aria-hidden': true, focusable: 'false', viewBox: '0 0 120 40', style: { width: '100%', opacity: 0.5 } },
                  React.createElement('path', { d: 'M0,35 L40,35 L55,5 L80,5 L120,5', fill: 'none', stroke: '#22c55e', strokeWidth: 1.5 }),
                  React.createElement('path', { d: 'M0,20 L40,35 L55,35 L120,35', fill: 'none', stroke: '#ef4444', strokeWidth: 1, strokeDasharray: '3 3' }),
                  React.createElement('line', { x1: 55, y1: 0, x2: 55, y2: 40, stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '2 2' })
                )
              },
              { icon: 'bell', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444'), title: 'Unusual Activity', desc: 'Smart money detection: volume spikes, sigma alerts, flow sentiment',
                mini: React.createElement('svg', { 'aria-hidden': true, focusable: 'false', viewBox: '0 0 120 30', style: { width: '100%', opacity: 0.5 } },
                  ...[5,8,4,6,3,35,7,4,9,5].map((h, i) => React.createElement('rect', { key: i, x: 4 + i * 12, y: 30 - h, width: 8, height: h, rx: 1, fill: h > 20 ? '#ef4444' : (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)') }))
                )
              },
              { icon: 'map', color: isDark ? C3.textMutedDark : C3.textMutedLight, title: 'IV Surface', desc: 'Heatmap, volatility skew, term structure, IV Rank',
                mini: React.createElement('svg', { 'aria-hidden': true, focusable: 'false', viewBox: '0 0 120 40', style: { width: '100%', opacity: 0.5 } },
                  ...[0,1,2,3].map(row => [0,1,2,3,4,5,6,7].map(col => {
                    const v = Math.sin(row * 0.8 + col * 0.4) * 0.5 + 0.5;
                    return React.createElement('rect', { key: `${row}-${col}`, x: col * 15 + 2, y: row * 10 + 2, width: 13, height: 8, rx: 1, fill: `rgba(168,85,247,${0.15 + v * 0.5})` });
                  })).flat()
                )
              },
            ].map(f => (
              <div key={f.title} style={{ ...cardStyle, marginBottom: 0, padding: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                  <Icon name={f.icon} size={14} color={f.color} />
                  <span style={{ fontWeight: '700', fontSize: '12px' }}>{f.title}</span>
                </div>
                <p style={{ fontSize: '10px', lineHeight: '1.4', opacity: 0.7, margin: '0 0 8px' }}>{f.desc}</p>
                {f.mini}
              </div>
            ))}
          </div>

          {/* How it works stepper */}
          {/* The whole line was at 0.7 opacity, white numbers on the gradient
              read 3.3:1. Full strength now, the numbers on a solid fill
              (5.2:1) and the words in the muted ink. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '16px', fontSize: '11px', color: isDark ? C3.textMutedDark : C3.textMutedLight }}>
            <span style={{ background: '#c2410c', color: '#ffffff', width: '18px', height: '18px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700' }}>1</span>
            <span>Pick a ticker</span>
            <span aria-hidden="true">→</span>
            <span style={{ background: '#c2410c', color: '#ffffff', width: '18px', height: '18px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700' }}>2</span>
            <span>Explore 6 analytics tabs</span>
            <span aria-hidden="true">→</span>
            <span style={{ background: '#c2410c', color: '#ffffff', width: '18px', height: '18px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700' }}>3</span>
            <span>Build & analyze trades</span>
          </div>
        </>)}

        {/* Subscribe banner for non-subscribers (before selecting a ticker) */}
        {!hasOptionsAccess && !selectedSymbol && !loading && renderSubscribePage()}

        {/* Selected Symbol Header */}
        {selectedSymbol && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: '12px', padding: '12px 16px', borderRadius: '12px',
            background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          }}>
            <div data-opt-symbol-heading="true" tabIndex={-1} style={{ outlineOffset: 2 }}>
              <span style={{ fontWeight: '700', fontSize: '16px' }}>{selectedSymbol.symbol.split('.')[0]}</span>
              <span style={{ fontSize: '13px', color: isDark ? C3.textMutedDark : C3.textMutedLight, marginLeft: '8px' }}>{selectedSymbol.name}</span>
            </div>
            <button onClick={() => {
              loadSeqRef.current++; setLoading(false); setSelectedSymbol(null); setOptionsData(null); setCurrentPrice(null);
              // To the search field it brings back, not <body>.
              focusNext(() => optExpSearchRef.current && optExpSearchRef.current.querySelector('input'));
            }} style={{
              padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: '600',
              background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
              border: 'none', cursor: 'pointer', color: isDark ? C3.textDark : C3.textLightTheme,
            }}>
              Change
            </button>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{
              width: '28px', height: '28px', margin: '0 auto',
              border: '2px solid rgba(255,255,255,0.1)', borderTopColor: C3.glowOrange,
              borderRadius: '50%', animation: 'spin 0.8s linear infinite',
            }} />
            <p style={{ color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '14px', marginTop: '12px' }}>
              Loading options for {selectedSymbol?.symbol.split('.')[0]}...
            </p>
          </div>
        )}

        {/* Options Data or Empty State */}
        {!loading && optionsData && (
          optionsData.empty ? (
            <div style={{ textAlign: 'center', padding: '32px 16px' }}>
              <div style={{ fontSize: '40px', marginBottom: '12px' }}>{React.createElement(Icon, { name: 'mail', size: 40 })}</div>
              <h3 data-opt-empty-heading="true" tabIndex={-1} style={{ fontWeight: '700', fontSize: '16px', marginBottom: '4px', outlineOffset: 2 }}>{optionsData.junk ? 'Not a ticker' : optionsData.index ? 'No index options' : optionsData.notUS ? 'US-listed underlyings only' : optionsData.failed ? 'Options did not load' : 'No Options Available'}</h3>
              <p role={optionsData.failed ? 'status' : undefined} style={{ color: isDark ? C3.textMutedDark : C3.textMutedLight, fontSize: '13px' }}>
                {optionsData.message || 'This symbol does not have options data.'}
              </p>
              {/* Without it, a refused or failed chain could only be asked
                  for again by picking the ticker anew. It counts the limit's
                  wait down and sends nothing inside it. */}
              {optionsData.retry && selectedSymbol && (
                <window.RateLimitWait.RetryButton isDark={isDark} data-opt-retry="true" onClick={() => { retryFocusRef.current = true; selectTicker(selectedSymbol.symbol, selectedSymbol.name); }} style={{
                  marginTop: '14px', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
                  border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'), background: 'transparent',
                  color: isDark ? C3.textDark : C3.textLightTheme,
                }} />
              )}
            </div>
          ) : (
            <div>
              {/* Sub-tabs: Chain | GEX | Payoff. Scrolls sideways on a phone:
                  six tabs need 427px and the page column clips at 390. */}
              {/* The tabs had role="tab" in a container with no tablist: tablist, roving tabindex, arrow keys. */}
              {/* Underlined text tabs (the terminal's stylesheet .mi-tabbar, design stage 2);
                  the file is web-only. */}
              <div role="tablist" aria-label="Options tools" className="mi-tabbar" onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
                const ids = [...e.currentTarget.querySelectorAll('[role="tab"]')].map(b => b.getAttribute('data-tab'));
                const i = ids.indexOf(optionsTab);
                const next = e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1]
                  : ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
                if (!next) return;
                e.preventDefault();
                setOptionsTab(next);
                const btn = e.currentTarget.querySelector('[data-tab="' + next + '"]');
                if (btn) btn.focus();
              }} style={{ marginBottom: 16 }}>
                {[
                  { id: 'chain', label: 'Chain' },
                  { id: 'calculator', label: 'Calculator' },
                  { id: 'gex', label: 'GEX' },
                  { id: 'payoff', label: 'Payoff Builder' },
                  { id: 'unusual', label: 'Unusual Activity' },
                  { id: 'iv', label: 'IV Surface' },
                ].map(tab => (
                  <button key={tab.id} type="button" className="mi-tab" onClick={() => setOptionsTab(tab.id)}
                    role="tab" aria-selected={optionsTab === tab.id} data-tab={tab.id} tabIndex={optionsTab === tab.id ? 0 : -1}>
                    {tab.label}
                  </button>
                ))}
              </div>
              {optionsTab === 'chain' && renderOptionsChain()}
              {optionsTab === 'calculator' && React.createElement(window.OptionsCalculator, { optionsData, currentPrice, isDark, apiKey })}
              {optionsTab === 'payoff' && React.createElement(window.PayoffBuilder, { optionsData, currentPrice, isDark, apiKey })}
              {optionsTab === 'gex' && React.createElement(window.GEXDashboard, { optionsData, currentPrice, isDark, apiKey })}
              {optionsTab === 'unusual' && React.createElement(window.UnusualActivityScanner, { optionsData, currentPrice, isDark, apiKey })}
              {optionsTab === 'iv' && React.createElement(window.IVSurfaceView, { optionsData, currentPrice, isDark, apiKey })}
            </div>
          )
        )}
      </div>
    </window.AppLayout>
  );
};
