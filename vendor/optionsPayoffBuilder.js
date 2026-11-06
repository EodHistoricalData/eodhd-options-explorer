// Options Payoff Builder — Multi-leg strategy builder with Probability of Profit
// Ported from: option-payoff (React+D3), optionlab (PoP), blackscholes (Greeks)

// A rounded figure that came out as "-0.00" reads "0.00": a tiny negative is
// no sign worth printing.
window.PayoffZero = (s) => (/^-0\.?0*$/.test(String(s)) ? String(s).slice(1) : s);

// The expiry the builder opens on: the first one 7 or more days out, else the
// furthest listed, else null. Expiries are { expirationDate: 'YYYY-MM-DD' }.
window.PayoffDefaultExpiry = (data, now) => {
  const list = (Array.isArray(data) ? data : []).filter(d => d && d.expirationDate);
  if (!list.length) return null;
  const t0 = now instanceof Date ? now.getTime() : Date.now();
  const days = (d) => (new Date(d.expirationDate + 'T21:00:00Z').getTime() - t0) / 86400000;
  const week = list.find(d => days(d) >= 7);
  return (week || list[list.length - 1]).expirationDate;
};

// Exact payoff-at-expiry geometry. The payoff is piecewise linear with kinks
// only at the strikes, so breakevens and the profit zones can be solved on
// the whole line [0, ∞) instead of read off a chart grid. The grid covered
// 70-130% of spot: a long put's profit zone started at 0.7·S instead of 0
// (PoP 8.6% vs 43.8%), a breakeven past 1.3·S vanished (PoP 0%), and a
// payoff landing on 0 at a grid point was counted twice. Plain functions, tested.
window.PayoffMath = {
  payoffAt(legs, price) {
    let total = 0;
    legs.forEach(leg => {
      const mult = leg.action === 'buy' ? 1 : -1;
      const qty = leg.quantity * 100; // per contract
      if (leg.type === 'call') {
        total += (Math.max(0, price - leg.strike) - leg.premium) * mult * qty;
      } else if (leg.type === 'put') {
        total += (Math.max(0, leg.strike - price) - leg.premium) * mult * qty;
      } else if (leg.type === 'stock') {
        total += (price - leg.strike) * leg.quantity * (leg.action === 'buy' ? 100 : -100);
      }
    });
    return total;
  },

  // Profit intervals [lo, hi] (hi may be Infinity) and the breakevens between.
  analyze(legs) {
    const EPS = 1e-9;
    const kinks = [...new Set(legs.filter(l => l.type !== 'stock').map(l => Number(l.strike)).filter(k => k > 0))]
      .sort((a, b) => a - b);
    const pts = [0, ...kinks];
    const f = (x) => this.payoffAt(legs, x);
    const raw = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const fa = f(a);
      if (i < pts.length - 1) {
        const b = pts[i + 1];
        const fb = f(b);
        if (fa > EPS && fb > EPS) raw.push([a, b]);
        else if (fa > EPS) raw.push([a, a + (b - a) * fa / (fa - fb)]);
        else if (fb > EPS) raw.push([a + (b - a) * (-fa) / (fb - fa), b]);
      } else {
        // Past the last strike every leg is linear: the slope is forever.
        const slope = f(a + 1) - fa;
        if (fa > EPS && slope >= -EPS) raw.push([a, Infinity]);
        else if (fa > EPS) raw.push([a, a + fa / -slope]);
        else if (slope > EPS) raw.push([a + (-fa) / slope, Infinity]);
      }
    }
    // Merge zones that meet at a kink.
    const ranges = [];
    raw.forEach(r => {
      const last = ranges[ranges.length - 1];
      if (last && Math.abs(last[1] - r[0]) < 1e-7) last[1] = r[1];
      else ranges.push([r[0], r[1]]);
    });
    const breakevens = [];
    ranges.forEach(([lo, hi]) => {
      if (lo > EPS) breakevens.push(lo);
      if (Number.isFinite(hi)) breakevens.push(hi);
    });
    const unique = breakevens.sort((a, b) => a - b).filter((b, i, arr) => i === 0 || b - arr[i - 1] > 1e-7);
    return { ranges, breakevens: unique };
  },

  // P(lo < S_T < hi) summed over the profit zones, S_T lognormal with
  // log-mean m and log-sd s.
  probability(ranges, m, s, cdf) {
    if (!(s > 0)) return 0;
    const z = (x) => x <= 0 ? -Infinity : (x === Infinity ? Infinity : (Math.log(x) - m) / s);
    const c = (v) => v === -Infinity ? 0 : v === Infinity ? 1 : cdf(v);
    return ranges.reduce((p, [lo, hi]) => p + c(z(hi)) - c(z(lo)), 0);
  },

  // Conditional mean profit / loss over a log-spaced grid spanning ±6 sd,
  // not just the chart window.
  expected(legs, m, s, cdf) {
    let expProfit = 0, expLoss = 0, probProfit = 0, probLoss = 0;
    if (!(s > 0)) return { expectedProfit: 0, expectedLoss: 0 };
    const N = 600;
    const lo = m - 6 * s;
    const hi = m + 6 * s;
    for (let i = 0; i < N; i++) {
      const a = lo + (hi - lo) * i / N;
      const b = lo + (hi - lo) * (i + 1) / N;
      const prob = cdf((b - m) / s) - cdf((a - m) / s);
      const payoff = this.payoffAt(legs, Math.exp((a + b) / 2));
      if (payoff >= 0) { expProfit += payoff * prob; probProfit += prob; }
      else { expLoss += payoff * prob; probLoss += prob; }
    }
    return {
      expectedProfit: probProfit > 0 ? expProfit / probProfit : 0,
      expectedLoss: probLoss > 0 ? expLoss / probLoss : 0,
    };
  },

  // Chain IV as a fraction; the feed mixes 0.24 and 24. Out-of-range values
  // (0, or thousands of percent on a dead wing) are not a volatility.
  normIV(raw) {
    const v = Number(raw);
    if (!(v > 0)) return null;
    const iv = v > 5 ? v / 100 : v;
    return iv > 0.01 && iv < 3 ? iv : null;
  },

  // At-the-money IV: the call/put average at the listed strike nearest spot.
  // PoP used the plain mean over every strike of the expiry, where deep-OTM
  // wings at 100-290% dominate: AAPL 16d read 64.5% against an ATM 24.1%,
  // and a straddle showed PoP 76.6% instead of 42.4%. The lognormal model takes one sigma; the ATM one is the
  // market's estimate of the move.
  atmIV(calls, puts, spot) {
    if (!(spot > 0)) return null;
    const byStrike = new Map();
    [...(calls || []), ...(puts || [])].forEach(o => {
      const iv = this.normIV(o && o.impliedVolatility);
      const k = Number(o && o.strike);
      if (iv == null || !(k > 0)) return;
      if (!byStrike.has(k)) byStrike.set(k, []);
      byStrike.get(k).push(iv);
    });
    let best = null;
    for (const k of byStrike.keys()) {
      if (best === null || Math.abs(k - spot) < Math.abs(best - spot)) best = k;
    }
    if (best === null) return null;
    const ivs = byStrike.get(best);
    return ivs.reduce((a, b) => a + b, 0) / ivs.length;
  },

  // Market premium of one contract and where it came from: the bid/ask mid
  // when both sides quote a sane spread (a last trade can be hours old and
  // outside today's market), else the last trade, else the
  // one side that quotes. null when nothing does (an untraded strike's
  // lastPrice of 0 is not a price).
  quoteOf(opt) {
    if (!opt) return null;
    const last = Number(opt.lastPrice), bid = Number(opt.bid), ask = Number(opt.ask);
    if (bid > 0 && ask > 0 && ask >= bid) return { premium: (bid + ask) / 2, source: 'mid' };
    if (last > 0) return { premium: last, source: 'last' };
    if (ask > 0) return { premium: ask, source: 'ask' };
    if (bid > 0) return { premium: bid, source: 'bid' };
    return null;
  },
  quote(opt) {
    const q = this.quoteOf(opt);
    return q ? q.premium : null;
  },

  // Strikes for the preset strategies, picked from the strikes the chain
  // actually lists: ATM, ~5% and ~10% out on each side, each one distinct
  // and on the right side of the one before. Rounding to $5 collapsed every
  // leg on a $12 stock onto $10/$15 (Iron Condor net zero, PoP 0%) and
  // priced unlisted strikes at a made-up 30% vol. A side with no
  // listed strike left is null; the caller says so instead of inventing one.
  presetStrikes(strikes, spot) {
    let list = [...new Set((strikes || []).map(Number).filter(k => k > 0))].sort((a, b) => a - b);
    if (!(spot > 0)) return null;
    if (list.length === 0) {
      // No chain: a grid at a step that suits the price.
      const step = spot < 5 ? 0.5 : spot < 25 ? 1 : spot < 100 ? 2.5 : 5;
      const base = Math.round(spot / step) * step;
      list = [];
      for (let i = -8; i <= 8; i++) { const k = +(base + i * step).toFixed(2); if (k > 0) list.push(k); }
    }
    const nearest = (t) => list.reduce((b, k) => (Math.abs(k - t) < Math.abs(b - t) ? k : b), list[0]);
    const above = (t, floor) => { const k = nearest(t); return k > floor ? k : (list.find(x => x > floor) ?? null); };
    const below = (t, ceil) => { const k = nearest(t); return k < ceil ? k : ([...list].reverse().find(x => x < ceil) ?? null); };
    const atm = nearest(spot);
    const otmUp = above(spot * 1.05, atm);
    const otmDown = below(spot * 0.95, atm);
    const farUp = otmUp == null ? null : above(spot * 1.10, otmUp);
    const farDown = otmDown == null ? null : below(spot * 0.90, otmDown);
    return { atm, otmUp, otmDown, farUp, farDown };
  },
};

// A number cell in the legs table. It keeps the text as typed and hands the
// leg a number only when the text reads as one (window.NumberInput): a
// Chrome-EN number field turned a premium of "2,5" into 25.
// When the leg's number changes from outside (a new strike re-prices the
// premium) the text follows, unless it already says that number.
// A text that is not a valid number is said under the field (role=alert,
// tied to it by aria-describedby) as the Calculator does, not only in a
// tooltip; and the leg is told (onProblem), so the totals are not worked out
// from the value the field had before -- Qty 0 still read "Debit $1050".
window.PayoffNumberCell = function PayoffNumberCell({ value, onCommit, onProblem, ariaLabel, integer, min, style, isDark }) {
  const NI = window.NumberInput;
  const [text, setText] = React.useState(String(value ?? ''));
  const msgId = React.useId();
  React.useEffect(() => {
    const shown = NI ? NI.parse(text) : Number(text);
    if (shown !== value) setText(String(value ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const check = NI ? NI.check(text, { integer }) : { value: Number(text), error: null };
  let problem = check.error;
  if (!problem && !check.empty) {
    if (integer && !Number.isInteger(check.value)) problem = 'Whole number';
    else if (min != null && check.value < min) problem = `At least ${min}`;
  } else if (!problem && check.empty) problem = 'Enter a number';
  React.useEffect(() => { if (onProblem) onProblem(problem || null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [problem]);
  const input = React.createElement('input', {
    ...(NI ? NI.fieldProps : { type: 'number' }),
    value: text,
    'aria-label': ariaLabel,
    'aria-invalid': problem ? 'true' : undefined,
    'aria-describedby': problem ? msgId : undefined,
    title: problem || undefined,
    onChange: (e) => {
      const t = e.target.value;
      setText(t);
      const c = NI ? NI.check(t) : { value: Number(t), error: null, empty: t === '' };
      if (c.error || c.empty) return;
      if (integer && !Number.isInteger(c.value)) return;
      if (min != null && c.value < min) return;
      onCommit(c.value);
    },
    style: { ...style, ...(problem ? { borderColor: '#ef4444' } : null) },
  });
  return React.createElement(React.Fragment, null, input,
    problem && React.createElement('div', {
      id: msgId, role: 'alert', 'data-payoff-problem': 'true',
      style: { marginTop: 2, fontSize: '10px', fontWeight: 600, lineHeight: 1.3, color: isDark ? '#fca5a5' : '#b91c1c' },
    }, ariaLabel + ': ' + problem.charAt(0).toLowerCase() + problem.slice(1)));
};

window.PayoffBuilder = ({ optionsData, currentPrice, isDark, apiKey }) => {
  // The prices of this screen's AI actions, from the server's list.
  const useFeatureCost = (() => null);
  const payoffAiCost = useFeatureCost('options_ai_strategy');
  const { useState, useEffect, useMemo, useCallback } = React;
  const C3 = window.C3;
  const BS = window.OptionsBS;

  // Use spotPrice fallback same as GEX
  const spotPrice = useMemo(() => {
    if (currentPrice) return currentPrice;
    if (!optionsData?.data?.[0]?.options) return 0;
    const calls = optionsData.data[0].options.CALL || [];
    const atm = calls.reduce((best, c) => c.delta && Math.abs(c.delta - 0.5) < Math.abs((best?.delta || 0) - 0.5) ? c : best, null);
    return atm?.strike || calls[Math.floor(calls.length / 2)]?.strike || 0;
  }, [currentPrice, optionsData]);

  // The first expiry a week or more out, else the furthest there is. The
  // nearest (often tomorrow) priced far wings at about zero, and an Iron
  // Condor came out in debit with a negative "Max Profit".
  const [selectedExpiry, setSelectedExpiry] = useState(() => window.PayoffDefaultExpiry(optionsData?.data));
  const [legs, setLegs] = useState([]);
  const [showPresets, setShowPresets] = useState(true);
  const [ivAdjust, setIvAdjust] = useState(0); // -50 to +50 percent adjustment
  // The point of the payoff line being read, by the arrow keys or the mouse
  // (the Chain tab's diagram and GEX could be read this way; this one could not).
  const [readAt, setReadAt] = useState(null);
  // The chart's width on screen. A phone drew the 1200 x 400 drawing at a
  // quarter of its size -- labels 2-4 px tall. Under 600 px the
  // drawing is made at the size it is shown, and a little taller.
  const [plotW, setPlotW] = useState(0);
  const plotObserver = React.useRef(null);
  const plotEl = React.useRef(null);
  const plotRef = React.useCallback((el) => {
    plotEl.current = el;
    if (plotObserver.current) { plotObserver.current.disconnect(); plotObserver.current = null; }
    if (!el) return;
    setPlotW(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'function') {
      plotObserver.current = new ResizeObserver((entries) => setPlotW(Math.round(entries[0].contentRect.width)));
      plotObserver.current.observe(el);
    }
  }, []);
  // The breakeven labels' halo is the colour painted behind the chart (the
  // card's tint over the page), measured; a fixed #fff / #1a1a2e drew a box
  // around each label.
  const [halo, setHalo] = useState(null);
  React.useLayoutEffect(() => {
    if (plotEl.current && window.A11yColor && window.A11yColor.groundOf) {
      setHalo(window.A11yColor.groundOf(plotEl.current, isDark ? '#1a1a2e' : '#ffffff'));
    }
  }, [isDark, plotW]);
  const [dteAdjust, setDteAdjust] = useState(0); // days to subtract from DTE
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  // Available strikes from chain data
  const chainData = useMemo(() => {
    if (!optionsData?.data || !selectedExpiry) return { calls: [], puts: [], strikes: [] };
    const exp = optionsData.data.find(d => d.expirationDate === selectedExpiry);
    if (!exp) return { calls: [], puts: [], strikes: [] };
    const calls = exp.options?.CALL || [];
    const puts = exp.options?.PUT || [];
    const strikeSet = new Set([...calls.map(c => c.strike), ...puts.map(p => p.strike)]);
    const strikes = [...strikeSet].sort((a, b) => a - b);
    return { calls, puts, strikes };
  }, [optionsData, selectedExpiry]);

  // Days to expiry
  const baseDTE = useMemo(() => {
    if (!selectedExpiry) return 30;
    const diff = (new Date(selectedExpiry) - new Date()) / (1000 * 60 * 60 * 24);
    return Math.max(1, Math.round(diff));
  }, [selectedExpiry]);

  const effectiveDTE = Math.max(1, baseDTE - dteAdjust);

  // Find option data for a given strike/type from chain
  const findOption = useCallback((strike, type) => {
    const list = type === 'call' ? chainData.calls : chainData.puts;
    return list.find(o => o.strike === strike) || null;
  }, [chainData]);

  // ATM implied volatility of the selected expiry (null when none quotes).
  const atmIV = useMemo(
    () => window.PayoffMath.atmIV(chainData.calls, chainData.puts, spotPrice),
    [chainData, spotPrice]
  );

  // Premium for a strike: the chain's quote, else a Black-Scholes estimate
  // at the ATM IV, flagged so the table can say it is not a market price.
  const getPremium = useCallback((strike, type) => {
    const q = window.PayoffMath.quoteOf(findOption(strike, type));
    if (q) return { premium: q.premium, estimated: false, source: q.source };
    if (spotPrice && strike) {
      const T = effectiveDTE / 365;
      const sigma = atmIV || 0.3;
      const p = type === 'call' ? BS.callPrice(spotPrice, strike, T, 0.05, sigma) : BS.putPrice(spotPrice, strike, T, 0.05, sigma);
      return { premium: p, estimated: true };
    }
    return { premium: 0, estimated: true };
  }, [findOption, spotPrice, effectiveDTE, atmIV]);

  const [presetNote, setPresetNote] = useState(null);
  const presetsRef = React.useRef(null);
  const legsHeadingRef = React.useRef(null);

  // Add a leg
  const addLeg = (type = 'call', action = 'buy', strike = null) => {
    const s = strike || window.PayoffMath.presetStrikes(chainData.strikes, spotPrice)?.atm || 100;
    const { premium, estimated, source: quoteSource } = getPremium(s, type);
    setLegs(prev => [...prev, {
      // Unique, as the presets' are: two legs added in one millisecond (or
      // under a fixed clock) shared Date.now(), and a premium or quantity
      // typed into one was written into both.
      id: Date.now() + Math.random(),
      type, // 'call' | 'put' | 'stock'
      action, // 'buy' | 'sell'
      strike: s,
      premium: Math.round(premium * 100) / 100,
      estimated,
      quoteSource,
      quantity: 1,
    }]);
    setShowPresets(false);
  };

  // Remove a leg
  // The row leaves with its button, and focus fell to <body>: it goes to the
  // "Remove leg" that takes its place, else the one before, else "+ Buy Call".
  const legsCardRef = React.useRef(null);
  const removeLeg = (id) => {
    const card = legsCardRef.current;
    const buttons = card ? Array.prototype.slice.call(card.querySelectorAll('[aria-label="Remove leg"]')) : [];
    const at = buttons.indexOf(document.activeElement);
    setLegs(prev => prev.filter(l => l.id !== id));
    noteProblem(id, 'premium', null);
    noteProblem(id, 'quantity', null);
    if (at !== -1) setTimeout(() => {
      const left = card ? card.querySelectorAll('[aria-label="Remove leg"]') : [];
      const target = left[Math.min(at, left.length - 1)] || (card && card.querySelector('[data-add-leg]'));
      if (target) target.focus();
    }, 0);
  };

  // The expiry changed: every leg is priced again from that expiry's chain.
  // Only the strike or the type re-priced a leg, so after 24d -> 3d the
  // premium and the debit stayed 24d's while DTE, the Greeks and PoP were
  // 3d's. A strike the new expiry does not list is
  // priced by the model and the leg says the strike is not listed there.
  // A premium the person typed is theirs, and stays: the expiry change wrote
  // the chain's price over it. Only the
  // premiums the builder filled itself are priced again.
  const pricedExpiryRef = React.useRef(selectedExpiry);
  useEffect(() => {
    if (pricedExpiryRef.current === selectedExpiry) return;
    pricedExpiryRef.current = selectedExpiry;
    setLegs(prev => prev.map(l => {
      if (l.type === 'stock' || l.quoteSource === 'manual') return l;
      const q = getPremium(l.strike, l.type);
      return { ...l, premium: Math.round(q.premium * 100) / 100, estimated: q.estimated, quoteSource: q.source };
    }));
  }, [selectedExpiry, getPremium]);

  // A leg field whose text is not a valid number ({ legId: { field: msg } }).
  const [legProblems, setLegProblems] = useState({});
  const noteProblem = (id, field, problem) => setLegProblems(prev => {
    const cur = (prev[id] || {})[field] || null;
    if (cur === (problem || null)) return prev;
    const forLeg = { ...(prev[id] || {}) };
    if (problem) forLeg[field] = problem; else delete forLeg[field];
    const next = { ...prev };
    if (Object.keys(forLeg).length) next[id] = forLeg; else delete next[id];
    return next;
  });
  const legsInvalid = legs.some(l => legProblems[l.id]);
  // An option leg on a strike the chosen expiry does not list.
  const unlisted = (leg) => leg.type !== 'stock' && chainData.strikes.length > 0 && !findOption(leg.strike, leg.type);

  // Update a leg field
  const updateLeg = (id, field, value) => {
    setLegs(prev => prev.map(l => {
      if (l.id !== id) return l;
      const updated = { ...l, [field]: value };
      // Auto-update premium when strike changes
      if (field === 'strike' || field === 'type') {
        const q = getPremium(field === 'strike' ? value : l.strike, field === 'type' ? value : l.type);
        updated.premium = Math.round(q.premium * 100) / 100;
        updated.estimated = q.estimated;
        updated.quoteSource = q.source;
      }
      // A premium typed in by hand is the user's price, not our estimate.
      if (field === 'premium') { updated.estimated = false; updated.quoteSource = 'manual'; }
      return updated;
    }));
  };

  // Preset strategies
  const loadPreset = (preset) => {
    if (!spotPrice) return;
    const k = window.PayoffMath.presetStrikes(chainData.strikes, spotPrice);
    if (!k) return;
    const { atm, otmUp, otmDown, farUp, farDown } = k;

    const presets = {
      long_call: [{ type: 'call', action: 'buy', strike: atm }],
      long_put: [{ type: 'put', action: 'buy', strike: atm }],
      covered_call: [{ type: 'stock', action: 'buy', strike: spotPrice }, { type: 'call', action: 'sell', strike: otmUp }],
      straddle: [{ type: 'call', action: 'buy', strike: atm }, { type: 'put', action: 'buy', strike: atm }],
      strangle: [{ type: 'call', action: 'buy', strike: otmUp }, { type: 'put', action: 'buy', strike: otmDown }],
      bull_call_spread: [{ type: 'call', action: 'buy', strike: atm }, { type: 'call', action: 'sell', strike: otmUp }],
      bear_put_spread: [{ type: 'put', action: 'buy', strike: atm }, { type: 'put', action: 'sell', strike: otmDown }],
      iron_condor: [
        { type: 'put', action: 'buy', strike: farDown },
        { type: 'put', action: 'sell', strike: otmDown },
        { type: 'call', action: 'sell', strike: otmUp },
        { type: 'call', action: 'buy', strike: farUp },
      ],
      iron_butterfly: [
        { type: 'put', action: 'buy', strike: otmDown },
        { type: 'put', action: 'sell', strike: atm },
        { type: 'call', action: 'sell', strike: atm },
        { type: 'call', action: 'buy', strike: otmUp },
      ],
      // No calendar spread: this builder prices every leg at one expiry, so
      // "sell ATM + buy ATM" cancelled to a flat zero with a breakeven at
      // every grid point. It needs two expiries to mean anything.
    };

    const template = presets[preset];
    if (!template) return;
    // Not enough listed strikes on one side for this shape: say so rather
    // than stack two legs on one strike.
    if (template.some(t => t.strike == null)) {
      setPresetNote('This expiry does not list enough strikes on both sides of the price for that strategy.');
      return;
    }
    setPresetNote(null);
    const newLegs = template.map(t => {
      const q = t.type === 'stock' ? { premium: 0, estimated: false } : getPremium(t.strike, t.type);
      return {
        id: Date.now() + Math.random(),
        type: t.type,
        action: t.action,
        strike: t.strike,
        premium: Math.round(q.premium * 100) / 100,
        estimated: q.estimated,
        quoteSource: q.source,
        quantity: 1,
      };
    });
    // The preset row leaves with the button just pressed, and focus fell to
    // <body>: it goes to the legs' heading, which now
    // names the strategy's leg count.
    const fromPresets = presetsRef.current && presetsRef.current.contains(document.activeElement);
    setLegs(newLegs);
    setShowPresets(false);
    if (fromPresets) setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && document.contains(a)) return;
      if (legsHeadingRef.current) legsHeadingRef.current.focus();
    }, 0);
  };

  // Calculate payoff across price range
  const payoffData = useMemo(() => {
    if (!spotPrice || legs.length === 0 || legsInvalid) return null;
    const low = spotPrice * 0.7;
    const high = spotPrice * 1.3;
    const step = (high - low) / 100;
    const payoffs = [];

    const payoffAt = (price) => {
      let total = 0;
      legs.forEach(leg => {
        const mult = leg.action === 'buy' ? 1 : -1;
        const qty = leg.quantity * 100; // per contract
        if (leg.type === 'call') {
          total += (Math.max(0, price - leg.strike) - leg.premium) * mult * qty;
        } else if (leg.type === 'put') {
          total += (Math.max(0, leg.strike - price) - leg.premium) * mult * qty;
        } else if (leg.type === 'stock') {
          total += (price - leg.strike) * leg.quantity * (leg.action === 'buy' ? 100 : -100);
        }
      });
      return total;
    };

    for (let price = low; price <= high; price += step) {
      payoffs.push({ price: Math.round(price * 100) / 100, payoff: Math.round(payoffAt(price) * 100) / 100 });
    }

    // Whether profit or loss is bounded is a property of the strategy's shape,
    // not of where the chart happens to stop. This used to read the extremes
    // off the 70%-130% window and call anything above spot × 100 "Unlimited",
    // so a long SPY call showed "Max Profit $18,980". Above the
    // last strike every leg is linear in price, so the slope there is the
    // slope forever: rising means unbounded profit, falling means unbounded
    // loss. Below zero a price cannot go, so the downside extreme is the
    // payoff at zero.
    const farRight = Math.max(high, ...legs.map(l => l.strike || 0)) * 2;
    const slope = payoffAt(farRight + 1) - payoffAt(farRight);
    const atZero = payoffAt(0);
    // Extremes of a piecewise-linear payoff sit at its kinks (the strikes),
    // wherever they are relative to the chart window.
    const inWindow = payoffs.map(p => p.payoff).concat(legs.filter(l => l.type !== 'stock').map(l => payoffAt(l.strike)));
    const maxProfit = slope > 1e-9 ? Infinity : Math.max(...inWindow, atZero, payoffAt(farRight));
    const maxLoss = slope < -1e-9 ? -Infinity : Math.min(...inWindow, atZero, payoffAt(farRight));

    // Breakevens and profit zones, solved exactly on [0, ∞).
    const { breakevens, ranges: profitRanges } = window.PayoffMath.analyze(legs);

    // Net debit/credit
    let netCost = 0;
    legs.forEach(leg => {
      if (leg.type === 'stock') {
        netCost += leg.strike * leg.quantity * (leg.action === 'buy' ? 100 : -100);
      } else {
        netCost += leg.premium * leg.quantity * (leg.action === 'buy' ? 100 : -100);
      }
    });

    return { payoffs, breakevens, profitRanges, maxProfit, maxLoss, netCost };
  }, [legs, spotPrice, legsInvalid]);

  // Probability of Profit (lognormal CDF approach from optionlab)
  const popData = useMemo(() => {
    if (!payoffData || !spotPrice) return null;
    // ATM IV of the expiry (PayoffMath.atmIV), not the mean over all strikes.
    const baseIV = atmIV || 0.3;

    const adjustedIV = baseIV * (1 + ivAdjust / 100);
    const T = effectiveDTE / 365;
    const r = 0.05; // risk-free rate
    const q = 0; // dividend yield
    const sigma = adjustedIV * Math.sqrt(T);
    const drift = (r - q - 0.5 * adjustedIV * adjustedIV) * T;
    const m = Math.log(spotPrice) + drift;

    // Profit zones over the whole price line, 0 to ∞ (PayoffMath.analyze),
    // weighted by the lognormal terminal distribution.
    const ranges = payoffData.profitRanges;
    const pop = window.PayoffMath.probability(ranges, m, sigma, BS.cdf);
    const exp = window.PayoffMath.expected(legs, m, sigma, BS.cdf);

    return {
      pop: Math.min(1, Math.max(0, pop)),
      expectedProfit: exp.expectedProfit,
      expectedLoss: exp.expectedLoss,
      avgIV: adjustedIV,
      profitRanges: ranges,
    };
  }, [payoffData, legs, spotPrice, atmIV, ivAdjust, effectiveDTE]);

  // Greeks per leg. One leg with an empty premium or a quantity of "abc" put
  // Delta and Theta of every leg at 0.00, Delta in red.
  // A leg's Greeks do not depend on its premium, so a premium that does not
  // read leaves them as they are; a quantity that does not read gives that
  // leg none (null, shown as "—"), and the other legs keep theirs.
  const legsGreeks = useMemo(() => {
    if (!spotPrice || legs.length === 0) return [];
    const T = effectiveDTE / 365;
    return legs.map(leg => {
      if (legProblems[leg.id] && legProblems[leg.id].quantity) return null;
      if (leg.type === 'stock') return { delta: leg.action === 'buy' ? 1 : -1, gamma: 0, theta: 0, vega: 0, iv: 0 };
      const opt = findOption(leg.strike, leg.type);
      const iv = window.PayoffMath.normIV(opt?.impliedVolatility) || atmIV || 0.3;
      const mult = leg.action === 'buy' ? 1 : -1;
      return {
        delta: BS.delta(spotPrice, leg.strike, T, 0.05, iv, 0, leg.type) * mult * leg.quantity,
        gamma: BS.gamma(spotPrice, leg.strike, T, 0.05, iv) * mult * leg.quantity,
        theta: BS.theta(spotPrice, leg.strike, T, 0.05, iv, 0, leg.type) * mult * leg.quantity,
        vega: BS.vega(spotPrice, leg.strike, T, 0.05, iv) * mult * leg.quantity / 100,
        iv,
      };
    });
  }, [legs, spotPrice, effectiveDTE, findOption, atmIV, legProblems]);

  // Shown only when every leg reads (the totals row below).
  const totalGreeks = useMemo(() => {
    if (legsGreeks.length === 0) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
    return legsGreeks.filter(Boolean).reduce((acc, g) => ({
      delta: acc.delta + g.delta,
      gamma: acc.gamma + g.gamma,
      theta: acc.theta + g.theta,
      vega: acc.vega + g.vega,
    }), { delta: 0, gamma: 0, theta: 0, vega: 0 });
  }, [legsGreeks]);

  // AI Explain Trade
  const handleAI = async (type) => {
    // One charge, the server's: chatWithTokens names the feature to
    // /api/ai/chat. The client spent a token on /tokens/consume and the chat
    // charged again on top.
    setAiLoading(true);
    try {
      const aiService = window.AIService;
      if (!aiService?.getSettings()?.enabled) { setAiResult({ error: 'AI analysis is off. Add OPENAI_API_KEY to .env and restart to enable it.' }); setAiLoading(false); return; }
      const settings = aiService.getSettings();
      // The envelope carries `code`, not `symbol`: every prompt said "a stock".
      const ticker = (window.OptionsDeepLink ? window.OptionsDeepLink.tickerOf(optionsData) : optionsData?.code) || 'a stock';
      const legsDesc = legs.map(l => `${l.action.toUpperCase()} ${l.quantity}x ${l.type} @ $${l.strike} (premium $${l.premium})`).join(', ');
      let prompt;
      if (type === 'explain') {
        prompt = `You are an options trading expert. Explain this options strategy in plain language for ${ticker} at $${spotPrice}:
Legs: ${legsDesc}
Max Profit: ${Number.isFinite(payoffData?.maxProfit) ? '$' + payoffData.maxProfit.toFixed(0) : 'unlimited'}, Max Loss: ${Number.isFinite(payoffData?.maxLoss) ? '$' + Math.abs(payoffData.maxLoss).toFixed(0) : 'unlimited'}, Breakevens: ${payoffData?.breakevens?.map(b => '$' + b.toFixed(1)).join(', ') || 'none'}
PoP: ${popData ? (popData.pop * 100).toFixed(1) + '%' : 'N/A'}
Greeks: Delta ${totalGreeks.delta.toFixed(2)}, Gamma ${totalGreeks.gamma.toFixed(4)}, Theta ${totalGreeks.theta.toFixed(2)}, Vega ${totalGreeks.vega.toFixed(2)}

Explain: 1) What is this strategy? 2) When does it profit/lose? 3) Key risks 4) Best market conditions for this trade. Use **bold** for key terms. 120 words max.`;
      } else {
        prompt = `You are an options trading expert. The user has this strategy for ${ticker} at $${spotPrice}:
Legs: ${legsDesc}
PoP: ${popData ? (popData.pop * 100).toFixed(1) + '%' : 'N/A'}, Max Profit: ${Number.isFinite(payoffData?.maxProfit) ? '$' + payoffData.maxProfit.toFixed(0) : 'unlimited'}, Max Loss: ${Number.isFinite(payoffData?.maxLoss) ? '$' + Math.abs(payoffData.maxLoss).toFixed(0) : 'unlimited'}
Suggest improvements: better strikes, different expiry, or alternative strategy with better risk/reward. Use **bold**. 120 words max.`;
      }
      const resp = await aiService.chatWithTokens('options_ai_strategy', [{ role: 'user', content: prompt }]);
      const text = typeof resp === 'string' ? resp : (resp?.content || resp?.message || '');
      setAiResult(text ? text : { error: 'The model returned nothing.' });
    } catch (e) {
      // A failure is an error state, not an answer.
      setAiResult({ error: window.AIText ? window.AIText.error(e) : String((e && e.message) || e) });
    }
    setAiLoading(false);
  };

  const formatAI = (text) => {
    if (!text) return null;
    if (window.AIText) return window.AIText.markdown(text);
    return React.createElement('span', null, ...text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**')
        ? React.createElement('strong', { key: i, style: { color: '#E0E3EB' } }, part.slice(2, -2))
        : part
    ));
  };

  const cardStyle = {
    padding: '16px', borderRadius: '12px', marginBottom: '16px',
    background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
  };

  if (!spotPrice) return React.createElement('div', { style: { padding: '32px', textAlign: 'center', color: isDark ? C3.textMutedDark : C3.textMutedLight } }, 'Loading...');

  // ── RENDER ──
  return React.createElement('div', null,
    // Expiry selector
    React.createElement('div', { style: { display: 'flex', gap: '6px', marginBottom: '16px', flexWrap: 'wrap' } },
      ...(optionsData?.data || []).slice(0, 8).map(exp =>
        React.createElement('button', {
          key: exp.expirationDate,
          onClick: () => setSelectedExpiry(exp.expirationDate),
          'aria-pressed': selectedExpiry === exp.expirationDate,
          style: {
            padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: '600', border: 'none', cursor: 'pointer',
            background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
            color: isDark ? C3.textDark : C3.textLightTheme,
            ...window.ToggleStyle.value(selectedExpiry === exp.expirationDate, isDark),
          }
        }, exp.expirationDate + ' (' + Math.max(1, Math.round((new Date(exp.expirationDate) - new Date()) / 864e5)) + 'd)')
      )
    ),

    // Preset strategies (shown when no legs)
    (legs.length === 0 || showPresets) && React.createElement('div', { ref: presetsRef, style: cardStyle },
      React.createElement('h3', { style: { fontWeight: '700', fontSize: '14px', marginBottom: '12px' } }, 'Quick Strategies'),
      React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        ...[
          { id: 'long_call', label: 'Long Call', emoji: '' },
          { id: 'long_put', label: 'Long Put', emoji: '' },
          { id: 'covered_call', label: 'Covered Call', emoji: '' },
          { id: 'straddle', label: 'Straddle', emoji: '' },
          { id: 'strangle', label: 'Strangle', emoji: '' },
          { id: 'bull_call_spread', label: 'Bull Call Spread', emoji: '' },
          { id: 'bear_put_spread', label: 'Bear Put Spread', emoji: '' },
          { id: 'iron_condor', label: 'Iron Condor', emoji: '' },
          { id: 'iron_butterfly', label: 'Iron Butterfly', emoji: '' },
        ].map(s => React.createElement('button', {
          key: s.id, onClick: () => loadPreset(s.id),
          style: {
            padding: '8px 14px', borderRadius: '10px', fontSize: '12px', fontWeight: '600', border: 'none', cursor: 'pointer',
            background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
            color: isDark ? C3.textDark : C3.textLightTheme,
          }
        }, s.label))
      ),
      presetNote && React.createElement('div', { role: 'status', style: { marginTop: '12px', fontSize: '12px', color: (window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b') } }, presetNote),
      legs.length === 0 && React.createElement('div', { style: { marginTop: '12px', fontSize: '12px', opacity: 0.7 } },
        'Or add custom legs below'
      )
    ),

    // Leg Manager
    React.createElement('div', { ref: legsCardRef, style: cardStyle },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
        React.createElement('h3', { ref: legsHeadingRef, tabIndex: -1, 'data-payoff-legs': 'true', style: { fontWeight: '700', fontSize: '14px', margin: 0 } }, 'Legs (' + legs.length + ')'),
        React.createElement('div', { style: { display: 'flex', gap: '6px' } },
          React.createElement('button', { 'data-add-leg': 'true', onClick: () => addLeg('call', 'buy'), style: { padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: '600', border: 'none', cursor: 'pointer', background: (window.A11yColor ? window.A11yColor.fill('#22c55e') : '#22c55e'), color: 'white' } }, '+ Buy Call'),
          React.createElement('button', { onClick: () => addLeg('put', 'buy'), style: { padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: '600', border: 'none', cursor: 'pointer', background: (window.A11yColor ? window.A11yColor.fill('#ef4444') : '#ef4444'), color: 'white' } }, '+ Buy Put'),
          React.createElement('button', { onClick: () => addLeg('call', 'sell'), style: { padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: '600', border: 'none', cursor: 'pointer', background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)', color: isDark ? C3.textDark : C3.textLightTheme } }, '+ Sell Call'),
          React.createElement('button', { onClick: () => addLeg('put', 'sell'), style: { padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: '600', border: 'none', cursor: 'pointer', background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)', color: isDark ? C3.textDark : C3.textLightTheme } }, '+ Sell Put'),
        )
      ),
      // Legs table. In its own scrolling box: the card clips what leaves it,
      // and at 390 px Delta, Theta and the "Remove leg" buttons were cut off
      // with no way to reach them. Wide enough to hold its eight columns; on
      // a desktop the box is wider than that and nothing scrolls.
      legs.length > 0 && React.createElement('div', {
        style: { overflowX: 'auto', WebkitOverflowScrolling: 'touch' },
        tabIndex: 0, role: 'region', 'aria-label': 'Legs (scrolls sideways)',
      }, React.createElement('table', { style: { width: '100%', minWidth: '500px', borderCollapse: 'collapse', fontSize: '12px' } },
        React.createElement('thead', null,
          React.createElement('tr', { style: { borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}` } },
            ['Action', 'Type', 'Strike', 'Premium', 'Qty', 'Delta', 'Theta', ''].map(h =>
              React.createElement('th', { key: h, style: { padding: '8px 4px', textAlign: 'center', fontWeight: '600', opacity: 0.7, fontSize: '11px' } }, h)
            )
          )
        ),
        React.createElement('tbody', null,
          ...legs.map((leg, idx) => {
            // null: this leg's quantity does not read -- no Greeks, said "—".
            const greeks = legsGreeks[idx] || null;
            const muted = isDark ? C3.textMutedDark : C3.textMutedLight;
            const greekCell = (v, ink) => React.createElement('td', {
              style: { padding: '6px 4px', textAlign: 'center', fontSize: '10px', color: v == null ? muted : (window.A11yColor ? window.A11yColor.text(ink, (typeof isDark !== 'undefined' && isDark)) : ink) },
            }, v == null ? '—' : window.PayoffZero(v.toFixed(2)));
            return React.createElement('tr', { key: leg.id, style: { borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'}` } },
              // Action toggle
              React.createElement('td', { style: { padding: '6px 4px', textAlign: 'center' } },
                React.createElement('button', {
                  // A 24 px hit area around the 20 px chip (WCAG 2.5.8), its look kept.
                  'data-hit': '',
                  onClick: () => updateLeg(leg.id, 'action', leg.action === 'buy' ? 'sell' : 'buy'),
                  style: { padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '700', border: 'none', cursor: 'pointer',
                    background: leg.action === 'buy' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                    color: (window.A11yColor ? window.A11yColor.text((leg.action === 'buy' ? '#22c55e' : '#ef4444'), (typeof isDark !== 'undefined' && isDark), 0.15) : (leg.action === 'buy' ? '#22c55e' : '#ef4444')) }
                }, leg.action.toUpperCase())
              ),
              // Type toggle
              React.createElement('td', { style: { padding: '6px 4px', textAlign: 'center' } },
                leg.type === 'stock' ? React.createElement('span', { style: { fontSize: '11px', opacity: 0.7 } }, 'STOCK') :
                React.createElement('button', {
                  'data-hit': '',
                  onClick: () => updateLeg(leg.id, 'type', leg.type === 'call' ? 'put' : 'call'),
                  style: { padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '700', border: 'none', cursor: 'pointer',
                    background: leg.type === 'call' ? 'rgba(59,130,246,0.15)' : 'rgba(168,85,247,0.15)',
                    color: (window.A11yColor ? window.A11yColor.text((leg.type === 'call' ? '#3b82f6' : '#a855f7'), (typeof isDark !== 'undefined' && isDark), 0.15) : (leg.type === 'call' ? '#3b82f6' : '#a855f7')) }
                }, leg.type.toUpperCase())
              ),
              // Strike input
              React.createElement('td', { style: { padding: '6px 4px', textAlign: 'center' } },
                React.createElement(window.PortalDropdown, {
                  value: leg.strike,
                  options: (unlisted(leg) ? [leg.strike] : []).concat(chainData.strikes).sort((a, b) => a - b).map(s => ({ value: s, label: '$' + s })),
                  onChange: (v) => updateLeg(leg.id, 'strike', Number(v)),
                  isDark,
                  style: { width: '90px', padding: '4px 22px 4px 8px', fontSize: 11, borderRadius: 6, fontWeight: 600 },
                  minWidth: 80,
                  ariaLabel: 'Strike',
                }),
                // The expiry was changed under a leg whose strike it does not
                // list: priced by the model, and said.
                unlisted(leg) && React.createElement('div', {
                  'data-payoff-unlisted': 'true',
                  style: { fontSize: '10px', fontWeight: 600, lineHeight: 1.3, marginTop: 2, color: (window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b') },
                }, 'No $' + leg.strike + ' ' + leg.type + ' on ' + selectedExpiry)
              ),
              // Premium input
              React.createElement('td', { style: { padding: '6px 4px', textAlign: 'center' } },
                React.createElement(window.PayoffNumberCell, {
                  value: leg.premium, min: 0, isDark,
                  onCommit: (v) => updateLeg(leg.id, 'premium', v),
                  onProblem: (p) => noteProblem(leg.id, 'premium', p),
                  ariaLabel: 'Premium',
                  style: { width: '60px', padding: '4px', borderRadius: '6px', fontSize: '11px', textAlign: 'center', border: `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}`, background: isDark ? '#1a1a2e' : '#fff', color: isDark ? '#e0e3eb' : '#1a1a2e' }
                }),
                // No quote on the chain for this strike: the number is a model
                // estimate, and the table says so.
                leg.estimated && leg.type !== 'stock' && React.createElement('div', {
                  title: 'No market quote for this strike: Black-Scholes estimate at the ATM implied volatility',
                  style: { fontSize: '9px', fontWeight: 600, color: (window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b'), marginTop: 2 },
                }, 'est.'),
                // Not a live two-sided market: say what the number is.
                !leg.estimated && leg.type !== 'stock' && /^(last|ask|bid)$/.test(leg.quoteSource || '') && React.createElement('div', {
                  title: leg.quoteSource === 'last'
                    ? 'No live bid/ask for this strike: last trade price, which may be stale'
                    : 'Only the ' + leg.quoteSource + ' side is quoted for this strike',
                  style: { fontSize: '9px', fontWeight: 600, color: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', marginTop: 2 },
                }, leg.quoteSource === 'last' ? 'last trade' : leg.quoteSource + ' only')
              ),
              // Quantity
              React.createElement('td', { style: { padding: '6px 4px', textAlign: 'center' } },
                React.createElement(window.PayoffNumberCell, {
                  value: leg.quantity, min: 1, integer: true, isDark,
                  onCommit: (v) => updateLeg(leg.id, 'quantity', Math.min(100, v)),
                  onProblem: (p) => noteProblem(leg.id, 'quantity', p),
                  ariaLabel: 'Quantity',
                  style: { width: '40px', padding: '4px', borderRadius: '6px', fontSize: '11px', textAlign: 'center', border: `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}`, background: isDark ? '#1a1a2e' : '#fff', color: isDark ? '#e0e3eb' : '#1a1a2e' }
                })
              ),
              // Greeks
              greekCell(greeks ? greeks.delta : null, greeks && Number(window.PayoffZero(greeks.delta.toFixed(2))) < 0 ? '#ef4444' : '#22c55e'),
              greekCell(greeks ? greeks.theta : null, '#f59e0b'),
              // Delete
              React.createElement('td', { style: { padding: '6px 4px', textAlign: 'center' } },
                React.createElement('button', { 'aria-label': 'Remove leg', 'data-hit': '',
                  onClick: () => removeLeg(leg.id),
                  style: { background: 'none', border: 'none', cursor: 'pointer', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444'), fontSize: '14px', padding: '2px 6px' }
                }, '\u00D7')
              )
            );
          })
        )
      )),
      // A field that reads no number: no totals from the value it had before.
      legs.length > 0 && legsInvalid && React.createElement('div', {
        role: 'status', 'data-payoff-held': 'true',
        style: { marginTop: '12px', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)' },
      }, 'Totals, the payoff chart and PoP wait until every leg has a valid premium and quantity.'),
      // Total Greeks row
      legs.length > 0 && !legsInvalid && React.createElement('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: '16px', marginTop: '12px', padding: '8px 12px', borderRadius: '8px', background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)', fontSize: '11px' }
      },
        React.createElement('span', null, 'Net: '),
        // A net delta that rounds to zero is neither sign: it read "Δ -0.00" in red
        // for a strangle.
        React.createElement('span', { style: { color: (window.A11yColor ? window.A11yColor.text((Number(window.PayoffZero(totalGreeks.delta.toFixed(2))) >= 0 ? '#22c55e' : '#ef4444'), (typeof isDark !== 'undefined' && isDark)) : (Number(window.PayoffZero(totalGreeks.delta.toFixed(2))) >= 0 ? '#22c55e' : '#ef4444')) } }, '\u0394 ' + window.PayoffZero(totalGreeks.delta.toFixed(2))),
        React.createElement('span', { style: { color: (window.A11yColor ? window.A11yColor.text('#3b82f6', (typeof isDark !== 'undefined' && isDark)) : '#3b82f6') } }, '\u0393 ' + window.PayoffZero(totalGreeks.gamma.toFixed(4))),
        React.createElement('span', { style: { color: (window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b') } }, '\u0398 ' + window.PayoffZero(totalGreeks.theta.toFixed(2))),
        React.createElement('span', { style: { color: (window.A11yColor ? window.A11yColor.text('#a855f7', (typeof isDark !== 'undefined' && isDark)) : '#a855f7') } }, '\u03BD ' + window.PayoffZero(totalGreeks.vega.toFixed(2))),
        payoffData && React.createElement('span', { style: { marginLeft: 'auto', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text((payoffData.netCost >= 0 ? '#ef4444' : '#22c55e'), (typeof isDark !== 'undefined' && isDark)) : (payoffData.netCost >= 0 ? '#ef4444' : '#22c55e')) } },
          payoffData.netCost >= 0 ? 'Debit: $' + payoffData.netCost.toFixed(0) : 'Credit: $' + Math.abs(payoffData.netCost).toFixed(0)
        )
      )
    ),

    // Payoff Chart + PoP + Metrics (only when legs exist)
    payoffData && React.createElement('div', null,
      // Metrics row
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '10px', marginBottom: '16px' } },
        React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
          React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Prob. of Profit'),
          React.createElement('div', { style: { fontSize: '20px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text((popData && popData.pop > 0.5 ? '#22c55e' : '#ef4444'), (typeof isDark !== 'undefined' && isDark)) : (popData && popData.pop > 0.5 ? '#22c55e' : '#ef4444')) } },
            popData ? (popData.pop * 100).toFixed(1) + '%' : '-'
          ),
          popData && React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: 2 } },
            'at ' + (popData.avgIV * 100).toFixed(1) + '% IV' + (atmIV ? ' (ATM)' : ' (assumed)'))
        ),
        React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
          React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Max Profit'),
          // A position that cannot make money at expiry says so, in red: it
          // read "$-3" in profit green.
          (() => {
            const mp = payoffData.maxProfit;
            const none = Number.isFinite(mp) && mp <= 0;
            const ink = none ? '#ef4444' : '#22c55e';
            return React.createElement('div', { style: { fontSize: '20px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text(ink, (typeof isDark !== 'undefined' && isDark)) : ink) } },
              !Number.isFinite(mp) ? 'Unlimited' : none ? 'None' : '$' + mp.toFixed(0));
          })(),
          Number.isFinite(payoffData.maxProfit) && payoffData.maxProfit <= 0 && React.createElement('div', { style: { fontSize: '10px', opacity: 0.8, marginTop: 2 } },
            payoffData.maxProfit < 0 ? 'loses at least $' + Math.abs(payoffData.maxProfit).toFixed(0) : 'breaks even at best')
        ),
        React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
          React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Max Loss'),
          React.createElement('div', { style: { fontSize: '20px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') } },
            Number.isFinite(payoffData.maxLoss) ? '$' + Math.abs(payoffData.maxLoss).toFixed(0) : 'Unlimited'
          )
        ),
        payoffData.breakevens.length > 0 && React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
          React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Breakeven'),
          React.createElement('div', { style: { fontSize: '16px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b') } },
            payoffData.breakevens.map(b => '$' + b.toFixed(1)).join(' / ')
          )
        ),
        popData && React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
          React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Exp. Profit'),
          React.createElement('div', { style: { fontSize: '16px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e') } }, '$' + popData.expectedProfit.toFixed(0))
        ),
        popData && React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
          React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Exp. Loss'),
          React.createElement('div', { style: { fontSize: '16px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') } }, '$' + Math.abs(popData.expectedLoss).toFixed(0))
        )
      ),

      // SVG Payoff Chart
      React.createElement('div', { style: cardStyle },
        (() => {
          const { payoffs } = payoffData;
          const _isWeb = window.APP_PLATFORM === 'WEB';
          // Drawn at the width it is shown at, whatever that is: a fixed
          // drawing scaled to fit put 2-4 px labels on a phone and 6-7 px on
          // a tablet. Until the width is known, the old fixed drawing.
          const measured = plotW > 0;
          const svgW = measured ? Math.max(200, plotW) : (_isWeb ? 1200 : 700);
          const svgH = measured ? Math.max(240, Math.min(400, Math.round(svgW / 3))) : (_isWeb ? 400 : 280);
          const padL = measured ? 52 : (_isWeb ? 70 : 60), padR = measured ? 12 : 20, padT = 18, padB = 35;
          // Label sizes in drawing units, 1:1 with the screen once measured.
          const fsLabel = '11', fsAxis = '11';
          const chartW = svgW - padL - padR, chartH = svgH - padT - padB;
          const minP = payoffs[0].price, maxP = payoffs[payoffs.length - 1].price;
          const payoffMax = Math.max(Math.abs(Math.min(...payoffs.map(p => p.payoff))), Math.abs(Math.max(...payoffs.map(p => p.payoff)))) || 100;
          const sx = (pr) => padL + ((pr - minP) / (maxP - minP)) * chartW;
          const sy = (pf) => padT + chartH / 2 - (pf / payoffMax) * (chartH / 2);
          const zy = sy(0);

          let path = payoffs.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.price).toFixed(1)},${sy(p.payoff).toFixed(1)}`).join(' ');
          let gFill = `M${sx(minP).toFixed(1)},${zy.toFixed(1)}`;
          let rFill = `M${sx(minP).toFixed(1)},${zy.toFixed(1)}`;
          payoffs.forEach(p => {
            gFill += ` L${sx(p.price).toFixed(1)},${p.payoff > 0 ? sy(p.payoff).toFixed(1) : zy.toFixed(1)}`;
            rFill += ` L${sx(p.price).toFixed(1)},${p.payoff < 0 ? sy(p.payoff).toFixed(1) : zy.toFixed(1)}`;
          });
          gFill += ` L${sx(maxP).toFixed(1)},${zy.toFixed(1)} Z`;
          rFill += ` L${sx(maxP).toFixed(1)},${zy.toFixed(1)} Z`;

          const lowest = Math.min(0, ...payoffs.map(p => p.payoff)), highest = Math.max(0, ...payoffs.map(p => p.payoff));
          const shownBE = payoffData.breakevens.filter(be => be >= minP && be <= maxP);
          const n = payoffs.length;
          const nearest = (pr) => payoffs.reduce((b, p, i) => (Math.abs(p.price - pr) < Math.abs(payoffs[b].price - pr) ? i : b), 0);
          const at = readAt != null && payoffs[readAt] ? payoffs[readAt] : null;
          return React.createElement('div', {
            ref: plotRef, tabIndex: 0, role: 'group', className: 'opt-chart',
            'aria-label': 'Payoff of the position. Left and right arrows read the profit or loss at each price.',
            style: { position: 'relative' },
            onKeyDown: (e) => {
              const k = e.key;
              if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
              e.preventDefault();
              const step = Math.max(1, Math.round(n / 40));
              setReadAt(readAt == null ? nearest(spotPrice)
                : k === 'Home' ? 0 : k === 'End' ? n - 1
                : k === 'ArrowRight' ? Math.min(n - 1, readAt + step) : Math.max(0, readAt - step));
            },
            onBlur: () => setReadAt(null),
            onMouseMove: (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const pr = minP + (((e.clientX - r.left) / r.width) * svgW - padL) / chartW * (maxP - minP);
              if (pr < minP || pr > maxP) { if (readAt != null) setReadAt(null); return; }
              const i = nearest(pr);
              if (i !== readAt) setReadAt(i);
            },
            onMouseLeave: () => setReadAt(null),
          },
          // The chart's own ring, in the other charts' colours.
          React.createElement('style', null, '.opt-chart:focus-visible{outline:2px solid ' + (isDark ? '#f97316' : '#c2410c') + ' !important;outline-offset:2px !important}'),
          // The reading sits in its own line above the chart. Laid over the
          // chart's top edge it covered the peak and the spot label on a
          // 320 px phone, where the chart is 71 px tall. The status region is
          // there from the start, empty: one that enters the page together
          // with its text is not announced by every screen reader.
          React.createElement('div', { role: 'status', style: { display: 'flex', justifyContent: 'flex-end', minHeight: 24, marginBottom: 4 } },
            at && React.createElement('span', {
              className: 'opt-chart-hint',
              style: { padding: '3px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none',
                background: isDark ? '#0f172a' : '#ffffff', color: isDark ? '#ffffff' : '#0f172a', border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.45)' : '#0f172a') },
            }, 'At $' + at.price.toFixed(2) + ': ' + (at.payoff >= 0 ? 'profit' : 'loss') + ' $' + Math.abs(at.payoff).toFixed(2))),
          React.createElement('svg', { role: 'img', focusable: 'false',
            'aria-label': 'Payoff of the ' + legs.length + '-leg position for prices from $' + minP.toFixed(0) + ' to $' + maxP.toFixed(0)
              + ': between a loss of $' + Math.abs(lowest).toFixed(0) + ' and a profit of $' + highest.toFixed(0)
              + (shownBE.length ? '; breakeven at ' + shownBE.map(b => '$' + b.toFixed(2)).join(' and ') : '')
              + '; current price $' + spotPrice.toFixed(2) + '. The figures are in the cards above.',
            viewBox: `0 0 ${svgW} ${svgH}`, style: { width: '100%', height: 'auto' } },
            React.createElement('path', { d: gFill, fill: 'rgba(34,197,94,0.12)' }),
            React.createElement('path', { d: rFill, fill: 'rgba(239,68,68,0.12)' }),
            React.createElement('line', { x1: padL, y1: zy, x2: svgW - padR, y2: zy, stroke: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)', strokeWidth: 1, strokeDasharray: '4 3' }),
            React.createElement('path', { d: path, fill: 'none', stroke: isDark ? '#fff' : '#333', strokeWidth: 2.5 }),
            // Current price
            React.createElement('line', { x1: sx(spotPrice), y1: padT + 15, x2: sx(spotPrice), y2: svgH - padB, stroke: '#6366f1', strokeWidth: 1.5, strokeDasharray: '4 3' }),
            // #6366f1 is 4.0:1 on the dark card and 3.8:1 on the light one; the
            // label takes the readable ink of that hue, as the Chain tab's does.
            React.createElement('text', { x: sx(spotPrice), y: padT + 10, fill: (window.A11yColor ? window.A11yColor.text('#6366f1', isDark) : '#6366f1'), fontSize: fsLabel, textAnchor: 'middle', fontWeight: '600' }, '$' + spotPrice.toFixed(0)),
            // Strike markers for each leg
            ...legs.filter(l => l.type !== 'stock').map((leg, i) =>
              // (a marker within the price label's width starts under the label, like the price line)
              React.createElement('line', { key: 'ls' + i, x1: sx(leg.strike), y1: Math.abs(sx(leg.strike) - sx(spotPrice)) < 24 ? padT + 15 : padT, x2: sx(leg.strike), y2: svgH - padB,
                stroke: leg.type === 'call' ? '#3b82f6' : '#a855f7', strokeWidth: 1, strokeDasharray: '2 4', opacity: 0.5 })
            ),
            // Axes labels
            React.createElement('text', { x: padL - 6, y: padT + 8, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: fsAxis, textAnchor: 'end' }, '+$' + payoffMax.toFixed(0)),
            React.createElement('text', { x: padL - 6, y: zy + 3, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: fsAxis, textAnchor: 'end' }, '$0'),
            React.createElement('text', { x: padL - 6, y: svgH - padB - 2, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: fsAxis, textAnchor: 'end' }, '-$' + payoffMax.toFixed(0)),
            React.createElement('text', { x: padL, y: svgH - 4, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: fsAxis }, '$' + minP.toFixed(0)),
            React.createElement('text', { x: svgW - padR, y: svgH - 4, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: fsAxis, textAnchor: 'end' }, '$' + maxP.toFixed(0)),
            // Breakevens, drawn after the strike markers and the axis labels:
            // drawn before them, the legs' dashed strike lines crossed "$344".
            // Breakevens are exact now and may lie beyond the chart window;
            // only the ones on the chart get a marker (all are listed above).
            // Two breakevens close together (a straddle on a phone) wrote
            // over each other: the second label goes above the zero line.
            ...shownBE.map((be, i) =>
              React.createElement('g', { key: 'be' + i },
                React.createElement('circle', { cx: sx(be), cy: zy, r: 5, fill: '#f59e0b', stroke: halo || (isDark ? '#1a1a2e' : '#fff'), strokeWidth: 2 }),
                // A halo of the card's colour: the raised label lay on the
                // payoff line and the price line and could hardly be read.
                React.createElement('text', { x: sx(be), y: i > 0 && Math.abs(sx(be) - sx(shownBE[i - 1])) < 44 ? zy - 9 : zy + 16, fill: (window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b'), stroke: halo || (isDark ? '#1a1a2e' : '#fff'), strokeWidth: 3, strokeLinejoin: 'round', style: { paintOrder: 'stroke' }, fontSize: fsLabel, textAnchor: 'middle', fontWeight: '600' }, '$' + be.toFixed(0))
              )
            ),
            at && React.createElement('g', null,
              React.createElement('line', { x1: sx(at.price), y1: padT, x2: sx(at.price), y2: svgH - padB, stroke: isDark ? '#fff' : '#0f172a', strokeWidth: 1 }),
              React.createElement('circle', { cx: sx(at.price), cy: sy(at.payoff), r: 5, fill: isDark ? '#fff' : '#0f172a' }))
          ));
        })()
      ),

      // Scenario Sliders
      React.createElement('div', { style: { ...cardStyle, display: 'flex', gap: '24px', flexWrap: 'wrap' } },
        React.createElement('div', { style: { flex: '1 1 200px' } },
          React.createElement('div', { style: { fontSize: '11px', fontWeight: '600', marginBottom: '6px' } }, 'IV Adjustment: ' + (ivAdjust >= 0 ? '+' : '') + ivAdjust + '%'),
          React.createElement('input', { type: 'range', 'aria-label': 'IV adjustment, percent', min: -50, max: 50, value: ivAdjust, onChange: (e) => setIvAdjust(Number(e.target.value)),
            // 24 px tall: the thumb is a finger's target, the track unchanged.
            style: { width: '100%', height: 24, margin: 0, accentColor: C3.logoGradient } })
        ),
        React.createElement('div', { style: { flex: '1 1 200px' } },
          React.createElement('div', { style: { fontSize: '11px', fontWeight: '600', marginBottom: '6px' } }, 'Days Forward: ' + (dteAdjust ? '-' + dteAdjust : '0') + 'd (DTE: ' + effectiveDTE + ')'),
          React.createElement('input', { type: 'range', 'aria-label': 'Days forward', min: 0, max: Math.max(1, baseDTE - 1), value: dteAdjust, onChange: (e) => setDteAdjust(Number(e.target.value)),
            style: { width: '100%', height: 24, margin: 0, accentColor: '#3b82f6' } })
        )
      ),

      // AI buttons -- only when a model is configured.
      Boolean(window.AIService?.getSettings?.()?.enabled) && React.createElement('div', { style: { display: 'flex', gap: '10px', marginBottom: '12px' } },
        React.createElement('button', {
          onClick: () => handleAI('explain'), disabled: aiLoading,
          style: { flex: 1, padding: '12px', borderRadius: '12px', border: 'none', cursor: 'pointer', background: C3.logoGradient, color: 'white', fontWeight: '700', fontSize: '13px', opacity: aiLoading ? 0.6 : 1 }
        }, aiLoading ? 'Analyzing...' : (payoffAiCost ? `AI Explain Trade · ${payoffAiCost}` : 'AI Explain Trade')),
        React.createElement('button', {
          onClick: () => handleAI('optimize'), disabled: aiLoading,
          style: { flex: 1, padding: '12px', borderRadius: '12px', border: 'none', cursor: 'pointer', background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: isDark ? C3.textDark : C3.textLightTheme, fontWeight: '700', fontSize: '13px', opacity: aiLoading ? 0.6 : 1, border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}` }
        }, payoffAiCost ? `AI Optimize Strategy · ${payoffAiCost}` : 'AI Optimize Strategy')
      ),
      aiResult && aiResult.error && (window.AIText
        ? window.AIText.errorBox(aiResult.error, isDark)
        : React.createElement('div', { role: 'alert', style: { marginTop: '12px', fontSize: '13px', color: C3.error } }, aiResult.error)),
      aiResult && !aiResult.error && React.createElement('div', { style: { ...cardStyle, background: isDark ? C3.fillDark : C3.fillLight, border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}` } },
        React.createElement('div', { style: { fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap' } }, formatAI(aiResult)),
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: '10px', fontStyle: 'italic' } }, 'AI-generated — not financial advice')
      )
    )
  );
};
