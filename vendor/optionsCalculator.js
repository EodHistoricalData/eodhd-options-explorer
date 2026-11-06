// Options Calculator — Black-Scholes-Merton pricing and Greeks
// Inputs: Spot, Strike, DTE, IV, Rate, Dividend yield, Call/Put. Optional Market price → IV solver.

// Implied volatility from a market price, bracketed.
//
// OptionsBS.impliedVolatility is a bare Newton step from 30%: on a high-vol
// OTM option it overshoots, clamps to 0.1%, finds vega ≈ 0 there and returns
// the clamp — "Solved IV 0.10%" for a 100%-vol biotech call, or the 30% seed
// when it never moves. Price is monotonic in σ, so a
// bisection on [0.01%, 500%] after a no-arbitrage check always lands, and
// says so when there is nothing to land on.
window.OptionsCalcIV = {
  LO: 1e-4,
  HI: 5,

  solve(S, K, T, r, price, type, q, priceAt) {
    q = q || 0;
    if (!(S > 0 && K > 0 && T > 0 && price > 0) || typeof priceAt !== 'function') {
      return { iv: null, reason: 'bad_input' };
    }
    const dfS = S * Math.exp(-q * T);
    const dfK = K * Math.exp(-r * T);
    const lower = type === 'call' ? Math.max(0, dfS - dfK) : Math.max(0, dfK - dfS);
    const upper = type === 'call' ? dfS : dfK;
    if (price <= lower) return { iv: null, reason: 'below_intrinsic' };
    if (price >= upper) return { iv: null, reason: 'above_max' };
    let lo = this.LO;
    let hi = this.HI;
    if (priceAt(lo) > price) return { iv: null, reason: 'below_range' };
    if (priceAt(hi) < price) return { iv: null, reason: 'above_range' };
    for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
      const mid = (lo + hi) / 2;
      if (priceAt(mid) < price) lo = mid; else hi = mid;
    }
    return { iv: (lo + hi) / 2, reason: null };
  },

  reasonText(reason) {
    return {
      below_intrinsic: 'No IV: the price is at or below intrinsic value.',
      above_max: 'No IV: the price is above what any volatility can justify.',
      below_range: 'No IV: below 0.01%.',
      above_range: 'No IV: above 500%.',
      bad_input: '',
    }[reason] || '';
  },

  // What the solver says about the market price field before solving: an
  // empty field asks nothing; 0 or a negative price left the answer empty
  // with no word. Text that is not a number is the
  // field's own message ("Enter a number").
  priceNote(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (t === '') return null;
    const n = window.NumberInput ? window.NumberInput.parse(t) : Number(t);
    if (!Number.isFinite(n)) return null;
    return n > 0 ? null : 'No IV: a market price has to be more than $0.';
  },
};

window.OptionsCalculator = ({ optionsData, currentPrice, isDark, apiKey }) => {
  const { useState, useMemo } = React;
  const C3 = window.C3;
  const BS = window.OptionsBS;

  const spotDefault = useMemo(() => {
    if (currentPrice) return currentPrice;
    const calls = optionsData?.data?.[0]?.options?.CALL || [];
    const atm = calls.reduce((b, c) => c.delta && Math.abs(c.delta - 0.5) < Math.abs((b?.delta || 0) - 0.5) ? c : b, null);
    return atm?.strike || calls[Math.floor(calls.length / 2)]?.strike || 100;
  }, [currentPrice, optionsData]);

  const firstExpiry = optionsData?.data?.[0]?.expirationDate;
  const dteDefault = useMemo(() => {
    if (!firstExpiry) return 30;
    const days = Math.ceil((new Date(firstExpiry) - new Date()) / 86400000);
    return Math.max(1, days);
  }, [firstExpiry]);

  const atmIvDefault = useMemo(() => {
    const calls = optionsData?.data?.[0]?.options?.CALL || [];
    if (!calls.length) return 30;
    const atm = calls.reduce((b, c) => Math.abs(c.strike - spotDefault) < Math.abs((b?.strike || Infinity) - spotDefault) ? c : b, null);
    const iv = atm?.impliedVolatility || 0;
    const norm = iv > 5 ? iv : iv * 100;
    return norm > 0 && norm < 500 ? Math.round(norm * 10) / 10 : 30;
  }, [optionsData, spotDefault]);

  const [spot, setSpot] = useState(spotDefault);
  const [strike, setStrike] = useState(spotDefault);
  const [dte, setDte] = useState(dteDefault);
  const [iv, setIv] = useState(atmIvDefault);
  const [rate, setRate] = useState(5);
  const [divYield, setDivYield] = useState(0);
  const [type, setType] = useState('call');
  const [marketPrice, setMarketPrice] = useState('');

  // Fields are text read by window.NumberInput: a Chrome-EN number field turned
  // "250,5" into 2505 before the page saw it.
  const nv = (v) => (typeof v === 'number' ? v : window.NumberInput ? window.NumberInput.parse(v) : Number(v));
  // What is wrong with the inputs, in words, or null. The results used to
  // vanish without a word for a spot of 0 or -5, a strike of 0 or an empty
  // field, and 0 or -3 days were silently priced as 1 day.
  const inputProblem = useMemo(() => {
    const need = [['Spot price', spot], ['Strike', strike], ['Days to expiry', dte], ['Implied volatility', iv], ['Risk-free rate', rate], ['Dividend yield', divYield]];
    for (const [label, v] of need) {
      if (String(v == null ? '' : v).trim() === '') return label + ': enter a value.';
      if (!Number.isFinite(nv(v))) return label + ': enter a number, e.g. 250.5.';
    }
    if (!(nv(spot) > 0)) return 'Spot price: must be more than 0.';
    if (!(nv(strike) > 0)) return 'Strike: must be more than 0.';
    if (!(nv(dte) >= 1)) return 'Days to expiry: at least 1 day.';
    if (!(nv(iv) > 0)) return 'Implied volatility: must be more than 0%.';
    if (nv(divYield) < 0) return 'Dividend yield: cannot be negative.';
    return null;
  }, [spot, strike, dte, iv, rate, divYield]);
  const result = useMemo(() => {
    if (inputProblem) return null;
    const S = nv(spot);
    const K = nv(strike);
    const T = nv(dte) / 365;
    const sigma = Math.max(0.0001, nv(iv) / 100);
    const r = nv(rate) / 100;
    const q = nv(divYield) / 100;
    if (!S || !K || ![T, sigma, r, q].every(Number.isFinite)) return null;

    const price = type === 'call' ? BS.callPrice(S, K, T, r, sigma, q) : BS.putPrice(S, K, T, r, sigma, q);
    const d1 = BS.d1(S, K, T, r, sigma, q);
    const d2 = BS.d2(d1, T, sigma);
    const cdf = BS.cdf;

    // Rho (per 1% rate move)
    const rho = type === 'call'
      ? K * T * Math.exp(-r * T) * cdf(d2) / 100
      : -K * T * Math.exp(-r * T) * cdf(-d2) / 100;

    const mkt = nv(marketPrice);
    const ivSolve = mkt > 0
      ? window.OptionsCalcIV.solve(S, K, T, r, mkt, type, q,
          (sig) => type === 'call' ? BS.callPrice(S, K, T, r, sig, q) : BS.putPrice(S, K, T, r, sig, q))
      : null;
    const solvedIV = ivSolve ? ivSolve.iv : null;
    const ivNote = ivSolve && ivSolve.iv == null
      ? window.OptionsCalcIV.reasonText(ivSolve.reason)
      : window.OptionsCalcIV.priceNote(marketPrice);

    // Intrinsic & time value
    const intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    const timeValue = Math.max(0, price - intrinsic);
    // At the money is a state of its own. The calculator opens with spot
    // equal to strike, and that read "ITM • intrinsic $0.00".
    const atBand = Math.max(K * 0.001, 0.01);
    const moneyness = Math.abs(S - K) <= atBand
      ? 'ATM'
      : (type === 'call' ? (S > K ? 'ITM' : 'OTM') : (S < K ? 'ITM' : 'OTM'));

    return {
      price,
      delta: BS.delta(S, K, T, r, sigma, q, type),
      gamma: BS.gamma(S, K, T, r, sigma, q),
      theta: BS.theta(S, K, T, r, sigma, q, type),
      vega: BS.vega(S, K, T, r, sigma, q) / 100, // per 1% vol
      rho,
      intrinsic,
      timeValue,
      moneyness,
      solvedIV,
      ivNote,
      marketDiff: mkt > 0 ? mkt - price : null,
    };
  }, [spot, strike, dte, iv, rate, divYield, type, marketPrice]);

  const bg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const textColor = isDark ? C3.textDark : C3.textLightTheme;
  const muted = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';

  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: '8px',
    background: isDark ? 'rgba(0,0,0,0.25)' : 'white',
    border: `1px solid ${border}`, color: textColor, fontSize: '14px',
    fontFamily: 'inherit', outline: 'none',
    // width: 100% plus its padding and border was 26 px wider than the grid
    // column wherever no stylesheet sets border-box for everything (the
    // terminal's does): the fields ran into each other.
    boxSizing: 'border-box',
  };

  const labelStyle = { display: 'block', fontSize: '12px', fontWeight: '600', color: muted, marginBottom: '6px' };

  // Called as a function, not mounted as a component: a component type made
  // anew on every render remounted the input and dropped focus each keystroke.
  const Field = ({ label, value, setValue, suffix }) => {
    const id = 'oc-' + label.toLowerCase().replace(/[^a-z]+/g, '-');
    const problem = window.NumberInput ? window.NumberInput.check(value).error : null;
    return React.createElement('div', { key: id },
      React.createElement('label', { style: labelStyle, htmlFor: id }, label),
      React.createElement('div', { style: { position: 'relative' } },
        React.createElement('input', {
          id, className: 'oc-field', ...(window.NumberInput ? window.NumberInput.fieldProps : { type: 'number' }), value,
          'aria-invalid': problem ? 'true' : undefined,
          onChange: (e) => setValue(e.target.value),
          style: { ...inputStyle, paddingRight: suffix ? '32px' : '12px' },
        }),
        suffix && React.createElement('span', {
          style: { position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: muted, fontSize: '12px', pointerEvents: 'none' }
        }, suffix)
      ),
      problem && React.createElement('div', { role: 'alert', style: { marginTop: 4, fontSize: 12, lineHeight: 1.4, color: isDark ? '#fca5a5' : '#b91c1c' } }, problem)
    );
  };

  const StatCard = ({ label, value, accent, sub }) => (
    React.createElement('div', {
      style: {
        padding: '14px', borderRadius: '10px', background: bg, border: `1px solid ${border}`,
      }
    },
      React.createElement('div', { style: { fontSize: '11px', fontWeight: '600', color: muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' } }, label),
      React.createElement('div', { style: { fontSize: '20px', fontWeight: '700', color: accent ? (window.A11yColor ? window.A11yColor.text(accent, isDark) : accent) : textColor } }, value),
      sub && React.createElement('div', { style: { fontSize: '11px', color: muted, marginTop: '4px' } }, sub)
    )
  );

  // A figure that rounds to zero has no sign: Theta "-$0.00" for a deep
  // in-the-money call, Rho "-$0.00" for a far put.
  // window.PayoffZero is the one normaliser (optionsPayoffBuilder.js).
  const noNegZero = (str) => (window.PayoffZero ? window.PayoffZero(str) : str);
  const fmt = (n, d = 4) => (n == null || !isFinite(n)) ? '—' : noNegZero(Number(n).toFixed(d));
  const fmtMoney = (n) => {
    if (n == null || !isFinite(n)) return '—';
    const abs = Math.abs(Number(n)).toFixed(2);
    return `${Number(n) < 0 && /[1-9]/.test(abs) ? '-' : ''}$${abs}`;
  };

  return React.createElement('div', { style: { padding: '4px' } },
    // The fields set outline: none and were left with whatever ring the host
    // page draws -- #f97316 on a white field is 2.8:1.
    // Their own ring: 5.2:1 on white, 6.8:1 on the dark field.
    // Light: #9a3412, so the ring holds on the grey of the IV solver's card too
    // (#c2410c read 4.37:1 there against 5.2:1 on white).
    React.createElement('style', null, '.oc-field:focus-visible{outline:2px solid ' + (isDark ? '#f97316' : '#9a3412') + ' !important;outline-offset:2px !important}'),
    // Inputs grid
    React.createElement('div', {
      style: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '12px', marginBottom: '20px',
      }
    },
      Field({ label: 'Spot price', value: spot, setValue: setSpot, step: '0.01', suffix: '$' }),
      Field({ label: 'Strike', value: strike, setValue: setStrike, step: '0.5', suffix: '$' }),
      Field({ label: 'Days to expiry', value: dte, setValue: setDte, step: '1' }),
      Field({ label: 'Implied volatility', value: iv, setValue: setIv, step: '0.1', suffix: '%' }),
      Field({ label: 'Risk-free rate', value: rate, setValue: setRate, step: '0.05', suffix: '%' }),
      Field({ label: 'Dividend yield', value: divYield, setValue: setDivYield, step: '0.05', suffix: '%' }),
    ),

    // Type toggle
    React.createElement('div', {
      style: { display: 'flex', gap: '8px', marginBottom: '20px', padding: '4px', borderRadius: '10px', background: bg, maxWidth: '300px' }
    },
      ['call', 'put'].map(t =>
        React.createElement('button', {
          key: t, onClick: () => setType(t),
          style: {
            flex: 1, padding: '10px 16px', borderRadius: '8px', fontSize: '14px', fontWeight: '600',
            border: 'none', cursor: 'pointer',
            // Picked in the accent like Calls/Puts on the chain (it was a
            // solid green or red); the transition comes with it.
            background: 'transparent',
            color: textColor,
            ...window.ToggleStyle.value(type === t, isDark),
          },
        }, t.toUpperCase())
      )
    ),

    // Results, or what keeps them from being computed.
    inputProblem && React.createElement('div', {
      role: 'alert',
      style: { marginBottom: '20px', padding: '12px 14px', borderRadius: '10px', fontSize: '13px', lineHeight: 1.5,
        border: '1px solid ' + (isDark ? 'rgba(239,68,68,0.45)' : 'rgba(200,30,44,0.35)'),
        background: isDark ? 'rgba(239,68,68,0.08)' : 'rgba(200,30,44,0.05)',
        color: isDark ? (window.A11yColor ? window.A11yColor.text('#ef4444', true) : '#f87171') : '#b91c1c' },
    }, inputProblem),
    result && React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '20px' } },
      React.createElement(StatCard, {
        label: 'Theoretical price', value: fmtMoney(result.price),
        accent: type === 'call' ? '#10b981' : '#ef4444',
        sub: `${result.moneyness} • intrinsic ${fmtMoney(result.intrinsic)}`,
      }),
      React.createElement(StatCard, { label: 'Delta', value: fmt(result.delta, 4), sub: 'Δ per $1 spot' }),
      React.createElement(StatCard, { label: 'Gamma', value: fmt(result.gamma, 5), sub: 'Δ change per $1' }),
      React.createElement(StatCard, { label: 'Theta / day', value: fmtMoney(result.theta), sub: 'Daily decay' }),
      React.createElement(StatCard, { label: 'Vega / 1% IV', value: fmtMoney(result.vega), sub: 'Per 1 vol point' }),
      React.createElement(StatCard, { label: 'Rho / 1% rate', value: fmtMoney(result.rho), sub: 'Per 1% rate move' }),
      React.createElement(StatCard, { label: 'Time value', value: fmtMoney(result.timeValue), sub: 'Extrinsic premium' }),
    ),

    // IV solver
    React.createElement('div', {
      style: { padding: '16px', borderRadius: '10px', border: `1px solid ${border}`, background: bg }
    },
      React.createElement('div', { style: { fontSize: '13px', fontWeight: '600', color: textColor, marginBottom: '10px' } }, 'Implied Volatility solver'),
      React.createElement('div', { style: { fontSize: '12px', color: muted, marginBottom: '12px' } },
        'Enter an observed market price — get the IV that reproduces it.'
      ),
      // The price and its answer side by side where both fit, else one under
      // the other: at 320-390 px the answer column was 0-44 px and "40.89%"
      // was cut off.
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', alignItems: 'end' } },
        Field({ label: 'Market price', value: marketPrice, setValue: setMarketPrice, step: '0.01', suffix: '$' }),
        result && result.solvedIV != null && React.createElement('div', null,
          React.createElement('div', { style: { fontSize: '11px', color: muted, marginBottom: '4px' } }, 'Solved IV'),
          React.createElement('div', { style: { fontSize: '18px', fontWeight: '700', color: textColor } },
            `${(result.solvedIV * 100).toFixed(2)}%`,
            result.marketDiff != null && React.createElement('span', {
              style: { fontSize: '12px', color: muted, marginLeft: '10px', fontWeight: '400', display: 'inline-block' }
            }, `(market ${result.marketDiff >= 0 ? 'above' : 'below'} model by ${fmtMoney(Math.abs(result.marketDiff))})`)
          )
        ),
        // No solution is an answer too — shown instead of a clamped 0.10%.
        result && result.solvedIV == null && result.ivNote && React.createElement('div', {
          style: { fontSize: '12px', color: muted, paddingBottom: '10px' }
        }, result.ivNote)
      )
    ),

    React.createElement('div', {
      style: { marginTop: '16px', fontSize: '11px', color: muted, textAlign: 'center' }
    }, 'Black-Scholes-Merton model. Greeks shown per conventional units (Vega per 1% IV, Theta per day, Rho per 1% rate).')
  );
};
