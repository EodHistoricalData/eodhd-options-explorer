// Options GEX Dashboard — Gamma Exposure analysis with client-side Black-Scholes
// Ported from: SPX-Gamma-Exposure, Gamma-Vanna-Options-Exposure, BlackScholesJS, blackscholes

// ==================== Client-side Black-Scholes Engine ====================
window.OptionsBS = (() => {
  const SQRT2PI = Math.sqrt(2 * Math.PI);

  // Standard Normal PDF
  const pdf = (x) => Math.exp(-(x * x) / 2) / SQRT2PI;

  // Standard Normal CDF (Hastings approximation, ±1e-6 accuracy)
  const cdf = (X) => {
    if (X === 0) return 0.5;
    const T = 1 / (1 + 0.2316419 * Math.abs(X));
    const D = 0.3989423 * Math.exp(-X * X / 2);
    let P = D * T * (0.3193815 + T * (-0.3565638 + T * (1.781478 + T * (-1.821256 + T * 1.330274))));
    return X > 0 ? 1 - P : P;
  };

  // d1, d2
  const d1 = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0) return 0;
    return (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  };
  const d2 = (d1v, T, sigma) => d1v - sigma * Math.sqrt(T);

  // Option price
  const callPrice = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0) return Math.max(S - K, 0);
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    return S * Math.exp(-q * T) * cdf(_d1) - K * Math.exp(-r * T) * cdf(_d2);
  };
  const putPrice = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0) return Math.max(K - S, 0);
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    return K * Math.exp(-r * T) * cdf(-_d2) - S * Math.exp(-q * T) * cdf(-_d1);
  };

  // 1st Order Greeks
  const delta = (S, K, T, r, sigma, q = 0, type = 'call') => {
    if (T <= 0 || sigma <= 0) return type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    const _d1 = d1(S, K, T, r, sigma, q);
    return type === 'call' ? Math.exp(-q * T) * cdf(_d1) : Math.exp(-q * T) * (cdf(_d1) - 1);
  };

  const gamma = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0 || S <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    return Math.exp(-q * T) * pdf(_d1) / (S * sigma * Math.sqrt(T));
  };

  const vega = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    return S * Math.exp(-q * T) * pdf(_d1) * Math.sqrt(T);
  };

  const theta = (S, K, T, r, sigma, q = 0, type = 'call') => {
    if (T <= 0 || sigma <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    const term1 = -S * Math.exp(-q * T) * pdf(_d1) * sigma / (2 * Math.sqrt(T));
    if (type === 'call') {
      return (term1 - r * K * Math.exp(-r * T) * cdf(_d2) + q * S * Math.exp(-q * T) * cdf(_d1)) / 365;
    }
    return (term1 + r * K * Math.exp(-r * T) * cdf(-_d2) - q * S * Math.exp(-q * T) * cdf(-_d1)) / 365;
  };

  // 2nd Order Greeks
  const vanna = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    return -pdf(_d1) * _d2 / sigma;
  };

  const charm = (S, K, T, r, sigma, q = 0, type = 'call') => {
    if (T <= 0 || sigma <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    const sqrtT = Math.sqrt(T);
    const inner = (2 * (r - q) * T - _d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);
    if (type === 'call') {
      return q * Math.exp(-q * T) * cdf(_d1) - Math.exp(-q * T) * pdf(_d1) * inner;
    }
    return -q * Math.exp(-q * T) * cdf(-_d1) - Math.exp(-q * T) * pdf(_d1) * inner;
  };

  const vomma = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    return vega(S, K, T, r, sigma, q) * _d1 * _d2 / sigma;
  };

  // 3rd Order Greeks
  const speed = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0 || S <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    const g = gamma(S, K, T, r, sigma, q);
    return -g / S * (_d1 / (sigma * Math.sqrt(T)) + 1);
  };

  const zomma = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    return gamma(S, K, T, r, sigma, q) * (_d1 * _d2 - 1) / sigma;
  };

  const color = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0 || S <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    const sqrtT = Math.sqrt(T);
    return -Math.exp(-q * T) * pdf(_d1) / (2 * S * T * sigma * sqrtT) *
      (2 * q * T + 1 + (2 * (r - q) * T - _d2 * sigma * sqrtT) / (sigma * sqrtT) * _d1);
  };

  const ultima = (S, K, T, r, sigma, q = 0) => {
    if (T <= 0 || sigma <= 0) return 0;
    const _d1 = d1(S, K, T, r, sigma, q);
    const _d2 = d2(_d1, T, sigma);
    const d1d2 = _d1 * _d2;
    return -vega(S, K, T, r, sigma, q) / (sigma * sigma) * (d1d2 * (1 - d1d2) + _d1 * _d1 + _d2 * _d2);
  };

  // IV solver (Newton-Raphson)
  const impliedVolatility = (S, K, T, r, marketPrice, type = 'call', q = 0) => {
    if (T <= 0 || marketPrice <= 0) return 0;
    let sigma = 0.3; // initial guess
    for (let i = 0; i < 100; i++) {
      const price = type === 'call' ? callPrice(S, K, T, r, sigma, q) : putPrice(S, K, T, r, sigma, q);
      const v = vega(S, K, T, r, sigma, q);
      if (Math.abs(v) < 1e-12) break;
      const diff = price - marketPrice;
      if (Math.abs(diff) < 1e-6) break;
      // vega() above is per unit of sigma -- 37.52 at S=K=100, T=1, σ=0.2 --
      // so the Newton step is diff/v as it stands. This divided by a further
      // hundred on the belief that vega was "per 1% move", which made every
      // step a hundredth of the size it needed to be: a hundred iterations
      // then never left the neighbourhood of the 0.3 starting guess, and a
      // price implying exactly 20% came back as 23.67%.
      sigma -= diff / v;
      if (sigma <= 0.001) sigma = 0.001;
      if (sigma > 5) sigma = 5;
    }
    return sigma;
  };

  return { pdf, cdf, d1, d2, callPrice, putPrice, delta, gamma, vega, theta, vanna, charm, vomma, speed, zomma, color, ultima, impliedVolatility };
})();


// ==================== GEX Calculation Engine ====================
window.GEXEngine = {
  /**
   * Calculate GEX for all options in a chain
   * @param {Array} calls - call options [{strike, openInterest, delta, gamma, impliedVolatility, ...}]
   * @param {Array} puts - put options [{strike, openInterest, delta, gamma, impliedVolatility, ...}]
   * @param {number} spotPrice - current underlying price
   * @returns {Object} { byStrike, totalGEX, gammaFlip, maxGEX, minGEX }
   */
  calculate(calls, puts, spotPrice) {
    const byStrike = {};
    // One gamma per contract, for the totals and the profile alike: the
    // feed's, else Black-Scholes at spot from the contract's own IV -- what
    // the profile below re-prices with. A feed without gamma left the total
    // at +0.00M "Dealers Short Gamma" while the profile, from IV, drew a
    // flip at $342 "Price ABOVE flip".
    const now = Date.now();
    const gammaOf = (opt) => {
      const g = Number(opt.gamma);
      if (g > 0) return g;
      const iv = this._iv(opt);
      const T = this._years(opt, now);
      const K = Number(opt.strike);
      if (!iv || !T || !(K > 0) || !(spotPrice > 0)) return 0;
      return window.OptionsBS.gamma(spotPrice, K, T, 0.04, iv);
    };
    const counted = (opt) => opt && opt.openInterest >= 10 && gammaOf(opt) > 0;

    // Process calls (positive GEX for dealer)
    calls.forEach(opt => {
      if (!counted(opt)) return;
      const strike = opt.strike;
      const gamma = gammaOf(opt);
      const gex = 100 * opt.openInterest * gamma * spotPrice * 1e-6;
      if (!byStrike[strike]) byStrike[strike] = { strike, callGEX: 0, putGEX: 0, callOI: 0, putOI: 0, callDelta: 0, putDelta: 0, callGamma: 0, putGamma: 0 };
      byStrike[strike].callGEX += gex;
      byStrike[strike].callOI += opt.openInterest || 0;
      byStrike[strike].callDelta = opt.delta || 0;
      byStrike[strike].callGamma = gamma;
    });

    // Process puts (negative GEX for dealer)
    puts.forEach(opt => {
      if (!counted(opt)) return;
      const strike = opt.strike;
      const gamma = gammaOf(opt);
      const gex = -100 * opt.openInterest * gamma * spotPrice * 1e-6;
      if (!byStrike[strike]) byStrike[strike] = { strike, callGEX: 0, putGEX: 0, callOI: 0, putOI: 0, callDelta: 0, putDelta: 0, callGamma: 0, putGamma: 0 };
      byStrike[strike].putGEX += gex;
      byStrike[strike].putOI += opt.openInterest || 0;
      byStrike[strike].putDelta = opt.delta || 0;
      byStrike[strike].putGamma = gamma;
    });

    // Compute totals
    const strikes = Object.values(byStrike).sort((a, b) => a.strike - b.strike);
    strikes.forEach(s => { s.totalGEX = s.callGEX + s.putGEX; });

    const totalGEX = strikes.reduce((sum, s) => sum + s.totalGEX, 0);
    const maxGEX = Math.max(...strikes.map(s => s.totalGEX), 0);
    const minGEX = Math.min(...strikes.map(s => s.totalGEX), 0);

    // Gamma flip: the SPOT at which dealers' total gamma changes sign.
    //
    // This used to be the first place where one strike's net GEX had a
    // different sign from the next strike's, walking up from the lowest
    // strike. That is not a flip level, it is noise: on the live AAPL chain
    // (2026-09-30, 3,542 contracts, spot $329.40) per-strike GEX changes sign
    // 23 times and the first change is among the deep-OTM puts, so the card
    // read "Gamma Flip $45.74 -- price ABOVE flip" and the chart drew the line
    // at its left edge. The number also went into the paid AI prompt.
    //
    // A flip is a property of the whole book re-priced at another spot, so
    // that is what is computed: total GEX re-evaluated over hypothetical spots
    // within ±20% of the current one (Black-Scholes gamma per contract, with
    // its own IV and time to expiry), and the zero crossing nearest to spot.
    // Only the contracts the totals count: the two cards read one book.
    // A counted contract the profile cannot re-price (no IV, no expiry) would
    // leave the profile on part of the book while the total has all of it:
    // no flip is drawn from part of the book.
    const profile = this.gexProfile(calls.filter(counted), puts.filter(counted), spotPrice);
    const repriceable = (opt) => !!this._iv(opt) && !!this._years(opt, now) && Number(opt.strike) > 0;
    const flipPartial = calls.concat(puts).some(o => counted(o) && !repriceable(o));
    // A chain with IV and no gamma, where the estimate rounds to nothing,
    // printed a table of "−0.000M" and still a flip with "Price ABOVE flip"
    // over a flat profile. What prints as zero is zero:
    // no strike rows of it, and no flip on a flat line.
    const zero = (v) => this.isZero(v);
    const gammaInData = calls.concat(puts).some(o => counted(o) && Number(o.gamma) > 0);
    const flat = strikes.length > 0 && strikes.every(s => zero(s.callGEX) && zero(s.putGEX));
    const profileFlat = profile.grid.every(p => zero(p.gex));
    const gammaFlip = strikes.length && !flipPartial && !flat && !profileFlat ? profile.flip : null;

    // Key levels are the walls, not "biggest positive / biggest negative net
    // strike". The old pairing called the max +GEX strike support and the max
    // -GEX strike resistance, so on AAPL support ($340) sat above the price
    // and resistance ($327.50) below it. The standard reading:
    //   call wall = strike with the most call GEX -> resistance
    //   put wall  = strike with the most (absolute) put GEX -> support
    const callWall = strikes.reduce((best, s) => s.callGEX > (best ? best.callGEX : 0) ? s : best, null);
    const putWall = strikes.reduce((best, s) => Math.abs(s.putGEX) > (best ? Math.abs(best.putGEX) : 0) ? s : best, null);

    return {
      byStrike: strikes,
      totalGEX,
      gammaFlip,
      // false: the book never changes sign within ±20% of spot (say so rather
      // than "none detected", which reads like missing data).
      flipInRange: gammaFlip != null,
      flipPartial,
      flipWindow: profile.window,
      maxGEX,
      minGEX,
      supportLevel: putWall ? putWall.strike : undefined,
      resistanceLevel: callWall ? callWall.strike : undefined,
      isPositiveGamma: totalGEX > 0, // dealers long gamma = stabilizing
      // No contract with 10+ open and a gamma (the feed's, or from its IV):
      // nothing to conclude from. A total of zero is not "short gamma".
      // Nor is a book whose every strike rounds to zero.
      empty: strikes.length === 0 || flat,
      // Why: 'no-gamma' when contracts are open (10+) but none has a gamma,
      // nor an IV to estimate one from -- it read "Not enough open interest"
      // over 700+ contracts a line; 'open-interest'
      // when no contract has 10 open; 'zero' when every strike rounds to 0.
      emptyReason: strikes.length === 0
        ? (calls.concat(puts).some(o => o && o.openInterest >= 10) ? 'no-gamma' : 'open-interest')
        : flat ? 'zero' : null,
      // false: every gamma here is estimated from implied volatility.
      gammaInData,
    };
  },

  // What prints as 0.000M.
  isZero(v) { return !(Math.abs(Number(v)) >= 0.0005); },

  // "+1.234M", "−0.500M", and never "−0.000M": a zero has no sign.
  fmtM(v, digits = 3, plus = true) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const t = Math.abs(n).toFixed(digits);
    if (Number(t) === 0) return t + 'M';
    return (n < 0 ? '−' : plus ? '+' : '') + t + 'M';
  },

  // A contract's IV as a fraction (the legacy feed sent percentages), or null.
  _iv(opt) {
    let iv = Number(opt && opt.impliedVolatility);
    if (!(iv > 0)) return null;
    if (iv > 5) iv = iv / 100;
    return iv;
  },

  // Time to expiry in years. A contract expiring today still carries gamma
  // for the rest of the session, so it is floored at one day rather than
  // dropped; a zero would make Black-Scholes gamma undefined.
  _years(opt, now) {
    let days = Number(opt.daysBeforeExpiration);
    if (!Number.isFinite(days) && opt.expirationDate) {
      days = (Date.parse(opt.expirationDate + 'T21:00:00Z') - now) / 86400000;
    }
    if (!Number.isFinite(days)) return null;
    return Math.max(days, 1) / 365;
  },

  /**
   * Total dealer GEX as a function of a hypothetical spot.
   *
   * Standard dealer sign convention (dealers long the calls customers sold
   * them, short the puts customers bought): calls +, puts -. Each contract is
   * re-priced with Black-Scholes gamma at every grid spot, using its own IV,
   * times open interest and the 100-share multiplier. Values are $ per 1% move
   * (gamma * OI * 100 * S^2 * 0.01) in millions; only the sign matters for
   * the flip.
   *
   * @returns {{ grid: Array<{spot, gex}>, flip: number|null, window: [lo, hi] }}
   */
  gexProfile(calls, puts, spotPrice, opts = {}) {
    const span = opts.span || 0.2;
    const steps = opts.steps || 160;
    const r = opts.rate != null ? opts.rate : 0.04;
    const lo = spotPrice * (1 - span);
    const hi = spotPrice * (1 + span);
    const out = { grid: [], flip: null, window: [lo, hi] };
    if (!(spotPrice > 0)) return out;

    const now = Date.now();
    const book = [];
    const add = (opt, sign) => {
      if (!opt.openInterest || opt.openInterest < 10) return;
      const iv = this._iv(opt);
      if (!iv) return;
      const T = this._years(opt, now);
      const K = Number(opt.strike);
      if (!T || !(K > 0)) return;
      book.push({ K, T, iv, w: sign * opt.openInterest * 100 });
    };
    (calls || []).forEach(o => add(o, 1));
    (puts || []).forEach(o => add(o, -1));
    if (!book.length) return out;

    const gammaAt = window.OptionsBS.gamma;
    for (let i = 0; i <= steps; i++) {
      const S = lo + (hi - lo) * i / steps;
      let g = 0;
      for (const c of book) g += c.w * gammaAt(S, c.K, c.T, r, c.iv);
      out.grid.push({ spot: S, gex: g * S * S * 0.01 / 1e6 });
    }

    // Every zero crossing on the grid, linearly interpolated; the one nearest
    // the current spot is the flip that matters for the next move.
    let best = null;
    for (let i = 1; i < out.grid.length; i++) {
      const a = out.grid[i - 1], b = out.grid[i];
      if ((a.gex < 0 && b.gex >= 0) || (a.gex > 0 && b.gex <= 0)) {
        const x = a.spot + (b.spot - a.spot) * (Math.abs(a.gex) / (Math.abs(a.gex) + Math.abs(b.gex)));
        if (best == null || Math.abs(x - spotPrice) < Math.abs(best - spotPrice)) best = x;
      }
    }
    out.flip = best;
    return out;
  },

  /**
   * Calculate DEX (Delta Exposure) for all options
   */
  calculateDEX(calls, puts) {
    let callDEX = 0, putDEX = 0;
    calls.forEach(opt => {
      if (!opt.openInterest || opt.openInterest < 10) return;
      callDEX += (opt.delta || 0) * opt.openInterest * 100;
    });
    puts.forEach(opt => {
      if (!opt.openInterest || opt.openInterest < 10) return;
      putDEX += (opt.delta || 0) * opt.openInterest * 100;
    });
    const totalDEX = callDEX + putDEX;
    // Nothing open, or no delta in the feed: no bias to read, not "Neutral".
    const empty = callDEX === 0 && putDEX === 0;
    const bullPct = (Math.abs(callDEX) + Math.abs(putDEX)) > 0
      ? Math.abs(callDEX) / (Math.abs(callDEX) + Math.abs(putDEX)) * 100 : 50;
    return { callDEX, putDEX, totalDEX, bullPct, bearPct: 100 - bullPct, empty };
  },
};


// ==================== GEX Dashboard Component ====================
window.GEXDashboard = ({ optionsData, currentPrice, isDark, apiKey }) => {
  // The prices of this screen's AI actions, from the server's list.
  const useFeatureCost = (() => null);
  const gexCost = useFeatureCost('options_ai_gex');
  const { useState, useEffect, useMemo } = React;
  const C3 = window.C3;

  const [selectedExpiry, setSelectedExpiry] = useState('all');
  const [showAI, setShowAI] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  // The bar chart's width is the card's: bars were sized for a fixed 600px
  // budget and filled about a third of a wide card.
  const [chartEl, setChartEl] = useState(null);
  // The bar under the mouse or the arrow keys (the
  // chart was a picture with no name and no way to read a bar).
  const [barAt, setBarAt] = useState(null);
  const [chartBoxW, setChartBoxW] = useState(0);
  useEffect(() => {
    if (!chartEl) return;
    const read = () => { const w = chartEl.clientWidth; if (w > 0) setChartBoxW(prev => (prev === w ? prev : w)); };
    read();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(chartEl);
    return () => ro.disconnect();
  }, [chartEl]);
  const [aiLoading, setAiLoading] = useState(false);

  // Estimate spot price from options data if currentPrice not available
  const spotPrice = useMemo(() => {
    if (currentPrice) return currentPrice;
    // Fallback: find ATM strike (highest OI call strike or midpoint of strikes)
    if (!optionsData?.data?.[0]?.options) return 0;
    const calls = optionsData.data[0].options.CALL || [];
    if (calls.length === 0) return 0;
    // Find strike where delta is closest to 0.5
    const atm = calls.reduce((best, c) => {
      if (!c.delta) return best;
      return Math.abs(c.delta - 0.5) < Math.abs((best?.delta || 0) - 0.5) ? c : best;
    }, null);
    if (atm) return atm.strike;
    // Last fallback: midpoint of all strikes
    const strikes = calls.map(c => c.strike).sort((a, b) => a - b);
    return strikes[Math.floor(strikes.length / 2)] || 0;
  }, [currentPrice, optionsData]);

  // Collect all options across expiries
  const gexData = useMemo(() => {
    if (!optionsData?.data || !spotPrice) return null;
    let allCalls = [], allPuts = [];
    const expiries = selectedExpiry === 'all' ? optionsData.data : optionsData.data.filter(d => d.expirationDate === selectedExpiry);
    expiries.forEach(exp => {
      (exp.options?.CALL || []).forEach(c => allCalls.push(c));
      (exp.options?.PUT || []).forEach(p => allPuts.push(p));
    });
    if (allCalls.length === 0 && allPuts.length === 0) return null;
    const gex = window.GEXEngine.calculate(allCalls, allPuts, spotPrice);
    const dex = window.GEXEngine.calculateDEX(allCalls, allPuts);
    return { ...gex, dex };
  }, [optionsData, spotPrice, selectedExpiry]);

  // AI interpretation
  const handleAIAnalysis = async () => {
    if (aiLoading) return;
    // One charge, the server's: chatWithTokens names the feature to
    // /api/ai/chat. The client spent a token on /tokens/consume and the chat
    // charged again on top.
    setAiLoading(true);
    setShowAI(true);
    try {
      // The envelope from api.js carries `code`, never `symbol`: this read
      // "Unknown" in every prompt it ever sent.
      const ticker = window.OptionsDeepLink ? window.OptionsDeepLink.tickerOf(optionsData) : (optionsData?.code || 'Unknown');
      const prompt = `You are an options market structure analyst. Analyze this Gamma Exposure (GEX) data for ${ticker} at $${spotPrice}:
- Total GEX: ${window.GEXEngine.fmtM(gexData.totalGEX, 2)}
- Gamma Flip Level (spot where total dealer gamma changes sign, nearest to the current price): ${gexData.gammaFlip ? '$' + gexData.gammaFlip.toFixed(2) : 'no flip within ±20% of spot'}
- Dealer Position: ${gexData.isPositiveGamma ? 'Long Gamma (stabilizing)' : 'Short Gamma (destabilizing)'}
- Key Support (put wall, strike with the most put gamma): $${gexData.supportLevel || 'N/A'}
- Key Resistance (call wall, strike with the most call gamma): $${gexData.resistanceLevel || 'N/A'}
- DEX Bull/Bear: ${gexData.dex.bullPct.toFixed(0)}% / ${gexData.dex.bearPct.toFixed(0)}%
- Top 5 GEX strikes: ${gexData.byStrike.slice().sort((a, b) => Math.abs(b.totalGEX) - Math.abs(a.totalGEX)).slice(0, 5).map(s => '$' + s.strike + ': ' + window.GEXEngine.fmtM(s.totalGEX, 2)).join(', ')}

Explain in plain language:
1. What this GEX profile means for price action
2. Where are the key support/resistance levels from dealer hedging
3. Is the market likely to be range-bound or volatile?
4. Any actionable insights for traders
Keep it concise (150 words max). Use **bold** for key terms.`;

      const aiService = window.AIService;
      if (!aiService?.getSettings()?.enabled) { setAiResult({ error: 'AI analysis is off. Add OPENAI_API_KEY to .env and restart to enable it.' }); setAiLoading(false); return; }
      const settings = aiService.getSettings();
      const resp = await aiService.chatWithTokens('options_ai_gex', [{ role: 'user', content: prompt }]);
      const text = typeof resp === 'string' ? resp : (resp?.content || resp?.message || '');
      setAiResult(text ? text : { error: 'The model returned nothing.' });
    } catch (e) {
      // A failure is not an answer: it used to be printed in the answer card
      // as "AI analysis failed: {"content":...}".
      setAiResult({ error: window.AIText ? window.AIText.error(e) : String((e && e.message) || e) });
    }
    setAiLoading(false);
  };

  const formatAI = (text) => {
    if (!text) return null;
    if (window.AIText) return window.AIText.markdown(text);
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return React.createElement('span', null, ...parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return React.createElement('strong', { key: i, style: { color: '#E0E3EB' } }, part.slice(2, -2));
      }
      return part;
    }));
  };

  if (!gexData) {
    return React.createElement('div', { style: { padding: '32px', textAlign: 'center', color: isDark ? C3.textMutedDark : C3.textMutedLight } },
      'Select a ticker and load options data to see GEX analysis'
    );
  }

  const cardStyle = {
    padding: '16px', borderRadius: '12px', marginBottom: '16px',
    background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
  };

  // GEX Bar Chart
  const chartH = 200, chartW = '100%';
  const maxAbs = Math.max(Math.abs(gexData.maxGEX), Math.abs(gexData.minGEX)) || 1;
  // Filter strikes to ±20% of current price for cleaner display
  const nearStrikes = gexData.byStrike.filter(s => s.strike >= spotPrice * 0.8 && s.strike <= spotPrice * 1.2);
  const displayStrikes = nearStrikes.length > 0 ? nearStrikes : gexData.byStrike;
  // Each strike gets an equal share of the card (60px for the axis); a chain
  // too dense for 4px bars scrolls sideways as before.
  const plotW = Math.max((chartBoxW || 600) - 60, 240);
  const barWidth = Math.max(3, Math.min(40, plotW / (displayStrikes.length || 1) - 2));

  return React.createElement('div', null,
    // EOD Data Badge
    React.createElement('div', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', fontSize: '11px', color: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)' }
    },
      React.createElement('span', { style: { background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', padding: '2px 8px', borderRadius: '4px' } }, 'EOD Data'),
      'Gamma Exposure estimates based on end-of-day open interest. Not real-time.'
    ),

    // Expiry Filter
    React.createElement('div', { role: 'group', 'aria-label': 'Expiry', style: { display: 'flex', gap: '6px', marginBottom: '16px', flexWrap: 'wrap' } },
      React.createElement('button', {
        onClick: () => setSelectedExpiry('all'),
        'aria-pressed': selectedExpiry === 'all',
        style: {
          padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: '600', border: 'none', cursor: 'pointer',
          background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
          color: isDark ? C3.textDark : C3.textLightTheme,
          ...window.ToggleStyle.value(selectedExpiry === 'all', isDark),
        }
      }, 'All Expiries'),
      ...(optionsData.data || []).slice(0, 6).map(exp =>
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
        }, exp.expirationDate)
      )
    ),

    // An empty book (no strike with 10+ contracts open and a gamma): said,
    // with no reading of dealer positioning from zeros.
    gexData.empty ? React.createElement('div', { role: 'status', 'data-gex-empty': 'true', 'data-gex-empty-reason': gexData.emptyReason || undefined, style: { ...cardStyle, textAlign: 'center', fontSize: '13px', lineHeight: 1.5 } },
      React.createElement('div', { style: { fontWeight: 700, marginBottom: 4 } }, gexData.emptyReason === 'zero' ? 'No gamma exposure to show'
        : gexData.emptyReason === 'no-gamma' ? 'No gamma or implied volatility in the data' : 'Not enough open interest'),
      gexData.emptyReason === 'zero'
        ? (gexData.gammaInData
          ? 'Every strike ' + (selectedExpiry === 'all' ? 'in this chain' : 'on ' + selectedExpiry) + ' has a gamma exposure that rounds to zero, so there is nothing to read from it.'
          : 'Gamma is not in the data for ' + (selectedExpiry === 'all' ? 'this chain' : selectedExpiry) + ', and the estimate from each contract’s implied volatility rounds to zero at every strike, so there is no gamma exposure to show.')
        : 'No strike ' + (selectedExpiry === 'all' ? 'in this chain' : 'on ' + selectedExpiry) + ' has 10 or more contracts open with a gamma (from the feed or its implied volatility), so there is no gamma exposure to estimate.',
      // Delta exposure needs no gamma: kept when the feed has it.
      !gexData.dex.empty && React.createElement('div', { 'data-gex-dex': 'true', style: { marginTop: 8 } },
        'Delta Exposure: ' + gexData.dex.bullPct.toFixed(0) + '% calls / ' + gexData.dex.bearPct.toFixed(0) + '% puts — '
        + (gexData.dex.bullPct > 55 ? 'Bullish Bias' : gexData.dex.bearPct > 55 ? 'Bearish Bias' : 'Neutral'))
    ) : React.createElement(React.Fragment, null,
    // Said once, above the figures, when none of them is the feed's gamma.
    !gexData.gammaInData && React.createElement('div', { 'data-gex-estimated': 'true', style: { fontSize: '12px', opacity: 0.8, marginBottom: '12px', lineHeight: 1.5 } },
      'Gamma is not in the data for this chain: every figure below is estimated from each contract’s implied volatility (Black-Scholes).'),
    // Summary Cards Row
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '16px' } },
      // Total GEX
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center' } },
        React.createElement('div', { style: { fontSize: '11px', opacity: 0.7, marginBottom: '4px' } }, 'Total GEX'),
        React.createElement('div', { style: { fontSize: '22px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text((gexData.totalGEX >= 0 ? '#22c55e' : '#ef4444'), (typeof isDark !== 'undefined' && isDark)) : (gexData.totalGEX >= 0 ? '#22c55e' : '#ef4444')) } },
          window.GEXEngine.fmtM(gexData.totalGEX, 2)
        ),
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: '2px' } },
          Math.abs(gexData.totalGEX) < 0.005 ? 'Flat: calls and puts offset' : gexData.totalGEX > 0 ? 'Dealers Long Gamma (Stabilizing)' : 'Dealers Short Gamma (Volatile)'
        )
      ),
      // Gamma Flip
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center' } },
        React.createElement('div', { style: { fontSize: '11px', opacity: 0.7, marginBottom: '4px' } }, 'Gamma Flip'),
        React.createElement('div', { style: { fontSize: '22px', fontWeight: '700', color: isDark ? C3.textDark : C3.textLightTheme } },
          gexData.gammaFlip ? '$' + gexData.gammaFlip.toFixed(1) : 'None'
        ),
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: '2px' } },
          gexData.gammaFlip ? (spotPrice > gexData.gammaFlip ? 'Price ABOVE flip' : 'Price BELOW flip') : gexData.flipPartial ? 'Not computed: some contracts have no implied volatility' : 'No flip within ±20% of spot'
        )
      ),
      // Support / Resistance
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center' } },
        React.createElement('div', { style: { fontSize: '11px', opacity: 0.7, marginBottom: '4px' } }, 'Key Levels'),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'center', gap: '16px' } },
          React.createElement('div', null,
            React.createElement('div', { style: { fontSize: '10px', color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e') }, title: 'Put wall: the strike with the most put gamma' }, 'Support (put wall)'),
            React.createElement('div', { style: { fontSize: '16px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e') } }, gexData.supportLevel ? '$' + gexData.supportLevel : '-')
          ),
          React.createElement('div', null,
            React.createElement('div', { style: { fontSize: '10px', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') }, title: 'Call wall: the strike with the most call gamma' }, 'Resistance (call wall)'),
            React.createElement('div', { style: { fontSize: '16px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') } }, gexData.resistanceLevel ? '$' + gexData.resistanceLevel : '-')
          )
        )
      ),
      // Bull/Bear Gauge
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center' } },
        React.createElement('div', { style: { fontSize: '11px', opacity: 0.7, marginBottom: '4px' } }, 'Delta Exposure'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' } },
          React.createElement('span', { style: { fontSize: '12px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e') } }, gexData.dex.empty ? '—' : gexData.dex.bullPct.toFixed(0) + '%'),
          React.createElement('div', { style: { width: '80px', height: '8px', borderRadius: '4px', background: gexData.dex.empty ? (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)') : '#ef4444', overflow: 'hidden' } },
            !gexData.dex.empty && React.createElement('div', { style: { width: gexData.dex.bullPct + '%', height: '100%', background: '#22c55e', borderRadius: '4px' } })
          ),
          React.createElement('span', { style: { fontSize: '12px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') } }, gexData.dex.empty ? '—' : gexData.dex.bearPct.toFixed(0) + '%')
        ),
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: '4px' } },
          gexData.dex.empty ? 'No delta in the feed' : gexData.dex.bullPct > 55 ? 'Bullish Bias' : gexData.dex.bearPct > 55 ? 'Bearish Bias' : 'Neutral'
        )
      )
    ),

    // GEX Bar Chart
    React.createElement('div', { style: cardStyle },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
        React.createElement('h3', { style: { fontWeight: '700', fontSize: '14px', margin: 0 } }, 'Gamma Exposure by Strike'),
        React.createElement('div', { style: { display: 'flex', gap: '12px', fontSize: '11px' } },
          React.createElement('span', null, React.createElement('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: '#22c55e', marginRight: '4px' } }), 'Calls (+)'),
          React.createElement('span', null, React.createElement('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: '#ef4444', marginRight: '4px' } }), 'Puts (-)')
        )
      ),
      // What the bar under the mouse or the arrow keys says. It lies over the
      // chart's top edge, so nothing moves when it appears.
      (() => {
        // The status region stays in the page, empty, so a screen reader
        // announces what is written into it; only the chip comes and goes.
        const s = barAt != null ? displayStrikes[barAt] : null;
        const m = (v) => window.GEXEngine.fmtM(v, 3);
        return React.createElement('div', { role: 'status', style: { position: 'relative', height: 0 } },
          s && React.createElement('div', {
            className: 'opt-chart-hint',
            // Dark on white in the light theme, white on dark in the dark one:
            // the terminal's light theme repaints inline white text dark, and
            // a fixed dark chip came out black on black.
            style: { position: 'absolute', right: 0, top: 0, zIndex: 2, padding: '3px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none', background: isDark ? '#0f172a' : '#ffffff', color: isDark ? '#ffffff' : '#0f172a', border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.45)' : '#0f172a') },
          }, 'Strike $' + s.strike + ' · net ' + m(s.totalGEX) + ' · calls ' + m(s.callGEX) + ' · puts ' + m(s.putGEX)));
      })(),
      // The chart's own focus ring, in the search field's colours: the host's
      // #f97316 is 2.8:1 on the light card.
      React.createElement('style', null, '.opt-chart:focus-visible{outline:2px solid ' + (isDark ? '#f97316' : '#c2410c') + ' !important;outline-offset:2px !important}'),
      React.createElement('div', {
        ref: setChartEl, style: { overflowX: 'auto', WebkitOverflowScrolling: 'touch' },
        // A scrolling box has to be reachable to be scrolled from the
        // keyboard; the same stop reads the bars.
        tabIndex: 0, role: 'group', className: 'opt-chart',
        'aria-label': 'Gamma exposure by strike. Left and right arrows read each strike.',
        onKeyDown: (e) => {
          const n = displayStrikes.length;
          if (!n) return;
          const k = e.key;
          if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
          e.preventDefault();
          const at = barAt == null ? (k === 'ArrowLeft' || k === 'End' ? n - 1 : 0)
            : k === 'Home' ? 0 : k === 'End' ? n - 1
            : k === 'ArrowRight' ? Math.min(n - 1, barAt + 1) : Math.max(0, barAt - 1);
          setBarAt(at);
          // Keep the bar being read inside the scrolled box.
          const box = e.currentTarget; const x = 45 + at * (barWidth + 2);
          if (x < box.scrollLeft + 45) box.scrollLeft = Math.max(0, x - 45);
          else if (x + barWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = x + barWidth - box.clientWidth + 10;
        },
        onBlur: () => setBarAt(null),
        onMouseMove: (e) => {
          const svg = e.currentTarget.firstChild;
          if (!svg) return;
          const i = Math.floor((e.clientX - svg.getBoundingClientRect().left - 45) / (barWidth + 2));
          const at = i >= 0 && i < displayStrikes.length ? i : null;
          if (at !== barAt) setBarAt(at);
        },
        onMouseLeave: () => setBarAt(null),
      },
        React.createElement('svg', { role: 'img', focusable: 'false',
          'aria-label': 'Bar chart of net gamma exposure for ' + displayStrikes.length + ' strikes'
            + (displayStrikes.length ? ' from $' + displayStrikes[0].strike + ' to $' + displayStrikes[displayStrikes.length - 1].strike : '')
            + ': total ' + window.GEXEngine.fmtM(gexData.totalGEX, 2)
            + (gexData.gammaFlip ? ', gamma flip at $' + gexData.gammaFlip.toFixed(1) : '')
            + '. The largest strikes are in the table below.',
          width: Math.max(displayStrikes.length * (barWidth + 2) + 60, 300),
          height: chartH + 40,
          style: { display: 'block' }
        },
          // The column being read.
          barAt != null && displayStrikes[barAt] && React.createElement('rect', {
            x: 45 + barAt * (barWidth + 2) - 1, y: 10, width: barWidth + 2, height: chartH,
            fill: 'none', stroke: isDark ? '#ffffff' : '#0f172a', strokeWidth: 1.5,
          }),
          // Zero line
          React.createElement('line', { x1: 40, y1: chartH / 2 + 10, x2: displayStrikes.length * (barWidth + 2) + 50, y2: chartH / 2 + 10, stroke: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)', strokeDasharray: '4 4' }),
          // Bars
          ...displayStrikes.map((s, i) => {
            const x = 45 + i * (barWidth + 2);
            const centerY = chartH / 2 + 10;
            const barH = Math.abs(s.totalGEX) / maxAbs * (chartH / 2 - 10);
            const y = s.totalGEX >= 0 ? centerY - barH : centerY;
            const isNearPrice = Math.abs(s.strike - spotPrice) < spotPrice * 0.01;
            return React.createElement('g', { key: s.strike },
              React.createElement('rect', {
                x, y, width: barWidth, height: Math.max(barH, 1),
                rx: 1,
                fill: s.totalGEX >= 0 ? '#22c55e' : '#ef4444',
                opacity: isNearPrice ? 1 : 0.7,
              }),
              // Strike label (every Nth)
              (i % Math.max(1, Math.floor(displayStrikes.length / 12)) === 0) &&
                React.createElement('text', { x: x + barWidth / 2, y: chartH + 28, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '9', textAnchor: 'middle', transform: `rotate(-45, ${x + barWidth / 2}, ${chartH + 28})` }, s.strike)
            );
          }),
          // Current price line
          (() => {
            const idx = displayStrikes.findIndex(s => s.strike >= spotPrice);
            if (idx >= 0) {
              const x = 45 + idx * (barWidth + 2);
              return React.createElement('g', null,
                React.createElement('line', { x1: x, y1: 5, x2: x, y2: chartH + 10, stroke: '#3b82f6', strokeWidth: 1.5, strokeDasharray: '6 3' }),
                React.createElement('text', { x: x, y: 8, fill: (window.A11yColor ? window.A11yColor.text('#3b82f6', (typeof isDark !== 'undefined' && isDark)) : '#3b82f6'), fontSize: '9', textAnchor: 'middle', fontWeight: '700' }, '$' + spotPrice.toFixed(0))
              );
            }
            return null;
          })(),
          // Gamma flip line
          (() => {
            if (!gexData.gammaFlip) return null;
            const idx = displayStrikes.findIndex(s => s.strike >= gexData.gammaFlip);
            if (idx >= 0) {
              const x = 45 + idx * (barWidth + 2) - barWidth / 2;
              return React.createElement('g', null,
                React.createElement('line', { x1: x, y1: 5, x2: x, y2: chartH + 10, stroke: '#a855f7', strokeWidth: 1.5, strokeDasharray: '3 3' }),
                React.createElement('text', { x: x, y: chartH + 10, fill: (window.A11yColor ? window.A11yColor.text('#a855f7', (typeof isDark !== 'undefined' && isDark)) : '#a855f7'), fontSize: '9', textAnchor: 'middle', fontWeight: '600' }, 'FLIP')
              );
            }
            return null;
          })(),
          // Y axis labels
          React.createElement('text', { x: 38, y: 14, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '9', textAnchor: 'end' }, '+' + maxAbs.toFixed(1) + 'M'),
          React.createElement('text', { x: 38, y: chartH + 6, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '9', textAnchor: 'end' }, '-' + maxAbs.toFixed(1) + 'M')
        )
      )
    ),

    // Top GEX Strikes Table
    React.createElement('div', { style: cardStyle },
      React.createElement('h3', { style: { fontWeight: '700', fontSize: '14px', marginBottom: '12px' } }, 'Top GEX Strikes'),
      React.createElement('div', { style: { overflowX: 'auto' } },
        React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } },
          React.createElement('thead', null,
            React.createElement('tr', { style: { borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}` } },
              ['Strike', 'Call GEX', 'Put GEX', 'Net GEX', 'Call OI', 'Put OI'].map(h =>
                React.createElement('th', { key: h, style: { padding: '8px 6px', textAlign: h === 'Strike' ? 'left' : 'right', fontWeight: '600', opacity: 0.7, fontSize: '11px' } }, h)
              )
            )
          ),
          React.createElement('tbody', null,
            ...gexData.byStrike.filter(s => !(window.GEXEngine.isZero(s.callGEX) && window.GEXEngine.isZero(s.putGEX))).sort((a, b) => Math.abs(b.totalGEX) - Math.abs(a.totalGEX)).slice(0, 15).map(s =>
              React.createElement('tr', {
                key: s.strike,
                style: {
                  borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'}`,
                  background: Math.abs(s.strike - spotPrice) < spotPrice * 0.01 ? (isDark ? 'rgba(59,130,246,0.1)' : 'rgba(59,130,246,0.05)') : 'transparent'
                }
              },
                React.createElement('td', { style: { padding: '8px 6px', fontWeight: '600' } }, '$' + s.strike),
                React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e') } }, window.GEXEngine.fmtM(s.callGEX, 3)),
                React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') } }, window.GEXEngine.fmtM(s.putGEX, 3)),
                React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text((s.totalGEX >= 0 ? '#22c55e' : '#ef4444'), (typeof isDark !== 'undefined' && isDark)) : (s.totalGEX >= 0 ? '#22c55e' : '#ef4444')) } }, window.GEXEngine.fmtM(s.totalGEX, 3)),
                React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', opacity: 0.7 } }, (s.callOI || 0).toLocaleString('en-US')),
                React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', opacity: 0.7 } }, (s.putOI || 0).toLocaleString('en-US'))
              )
            )
          )
        )
      )
    ),

    // What is GEX? Education
    React.createElement('div', { style: { ...cardStyle, background: isDark ? C3.fillDark : C3.fillLight, border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}` } },
      React.createElement('h4', { style: { fontWeight: '700', fontSize: '13px', marginBottom: '8px', color: isDark ? C3.textDark : C3.textLightTheme } }, 'What is Gamma Exposure (GEX)?'),
      React.createElement('p', { style: { fontSize: '12px', lineHeight: '1.6', margin: 0 } },
        'GEX measures the gamma exposure of market makers across option strikes. ',
        React.createElement('strong', null, 'Positive GEX'), ' (green) = dealers are long gamma, they sell rallies and buy dips → ',
        React.createElement('strong', null, 'stabilizing'), ', price tends to stay range-bound. ',
        React.createElement('strong', null, 'Negative GEX'), ' (red) = dealers are short gamma, they buy rallies and sell dips → ',
        React.createElement('strong', null, 'destabilizing'), ', expect larger moves. ',
        'The ', React.createElement('strong', { style: { color: (window.A11yColor ? window.A11yColor.text('#a855f7', (typeof isDark !== 'undefined' && isDark)) : '#a855f7') } }, 'Gamma Flip'), ' level is where dealer positioning switches from long to short gamma.'
      )
    ),

    // AI Analysis Button
    React.createElement('div', { style: { marginTop: '8px' } },
      // Only when a model is configured. The check used to live in the click
      // handler, so the button rendered and answered with an apology
      Boolean(window.AIService?.getSettings?.()?.enabled) && React.createElement('button', {
        onClick: handleAIAnalysis,
        disabled: aiLoading,
        style: {
          width: '100%', padding: '12px', borderRadius: '12px', border: 'none', cursor: aiLoading ? 'wait' : 'pointer',
          background: C3.logoGradient, color: 'white', fontWeight: '700', fontSize: '14px',
          opacity: aiLoading ? 0.6 : 1,
        }
      },
        aiLoading ? 'Analyzing...' : (gexCost ? `AI GEX Interpretation · ${gexCost}` : 'AI GEX Interpretation')
      ),
      showAI && aiResult && aiResult.error && (window.AIText
        ? window.AIText.errorBox(aiResult.error, isDark)
        : React.createElement('div', { role: 'alert', style: { marginTop: '12px', fontSize: '13px', color: C3.error } }, aiResult.error)),
      showAI && aiResult && !aiResult.error && React.createElement('div', {
        style: { ...cardStyle, marginTop: '12px', background: isDark ? C3.fillDark : C3.fillLight, border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}` }
      },
        React.createElement('div', { style: { fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap' } }, formatAI(aiResult)),
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: '10px', fontStyle: 'italic' } }, 'AI-generated — not financial advice')
      )
    )
    )
  );
};
