// IV Surface Visualizer — Implied Volatility heatmap and skew analysis
// Ported from: volvisualizer (IV surface construction, skew/smile extraction)

window.IVSurfaceView = ({ optionsData, currentPrice, isDark, apiKey }) => {
  // The prices of this screen's AI actions, from the server's list.
  const useFeatureCost = (() => null);
  const ivCost = useFeatureCost('options_ai_iv');
  const { useState, useMemo } = React;
  const C3 = window.C3;

  const [viewMode, setViewMode] = useState('heatmap'); // 'heatmap' | 'skew' | 'term'
  const [aiResult, setAiResult] = useState(null);
  // The Skew and Term charts' width on screen: a 700 px drawing scaled to a
  // phone was 214 x 92 with 4-5 px labels. Drawn at the
  // width it is shown at, once known.
  const [chartW0, setChartW0] = useState(0);
  const chartObserver = React.useRef(null);
  const chartRef = React.useCallback((el) => {
    if (chartObserver.current) { chartObserver.current.disconnect(); chartObserver.current = null; }
    if (!el) return;
    setChartW0(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'function') {
      chartObserver.current = new ResizeObserver((entries) => setChartW0(Math.round(entries[0].contentRect.width)));
      chartObserver.current.observe(el);
    }
  }, []);
  const [aiLoading, setAiLoading] = useState(false);

  const spotPrice = useMemo(() => {
    if (currentPrice) return currentPrice;
    if (!optionsData?.data?.[0]?.options) return 0;
    const calls = optionsData.data[0].options.CALL || [];
    const atm = calls.reduce((best, c) => c.delta && Math.abs(c.delta - 0.5) < Math.abs((best?.delta || 0) - 0.5) ? c : best, null);
    return atm?.strike || calls[Math.floor(calls.length / 2)]?.strike || 0;
  }, [currentPrice, optionsData]);

  // Build IV surface data: { expiries, strikes, grid[expiry][strike] = IV }
  const surfaceData = useMemo(() => {
    if (!optionsData?.data || !spotPrice) return null;
    const expiryMap = {};
    const allStrikes = new Set();

    optionsData.data.forEach(exp => {
      const dte = Math.max(1, Math.round((new Date(exp.expirationDate) - new Date()) / 864e5));
      const opts = [...(exp.options?.CALL || []), ...(exp.options?.PUT || [])];
      const ivByStrike = {};
      opts.forEach(o => {
        let iv = o.impliedVolatility;
        if (!iv || iv <= 0) return;
        // EODHD returns IV in percent (e.g., 30.5 = 30.5%), convert to decimal
        if (iv > 5) iv = iv / 100;
        if (iv < 0.01 || iv > 3) return;
        const strike = o.strike;
        // Average call/put IV at same strike
        if (!ivByStrike[strike]) ivByStrike[strike] = [];
        ivByStrike[strike].push(iv);
        allStrikes.add(strike);
      });
      const avgIV = {};
      Object.entries(ivByStrike).forEach(([s, ivs]) => {
        avgIV[Number(s)] = ivs.reduce((a, b) => a + b, 0) / ivs.length;
      });
      if (Object.keys(avgIV).length > 0) {
        expiryMap[exp.expirationDate] = { dte, ivByStrike: avgIV };
      }
    });

    const expiries = Object.keys(expiryMap).sort();
    // Filter strikes to ±30% of spot
    const strikes = [...allStrikes].filter(s => s >= spotPrice * 0.7 && s <= spotPrice * 1.3).sort((a, b) => a - b);
    // Thin out if too many
    const maxStrikes = 40;
    const skipN = strikes.length > maxStrikes ? Math.ceil(strikes.length / maxStrikes) : 1;
    const displayStrikes = strikes.filter((_, i) => i % skipN === 0);

    // IV Rank: current IV vs 52-week range (approximate from available data)
    let allIVs = [];
    Object.values(expiryMap).forEach(e => Object.values(e.ivByStrike).forEach(iv => allIVs.push(iv)));
    const minIV = Math.min(...allIVs);
    const maxIV = Math.max(...allIVs);
    const atmIV = expiryMap[expiries[0]]?.ivByStrike[displayStrikes.reduce((best, s) => Math.abs(s - spotPrice) < Math.abs(best - spotPrice) ? s : best, displayStrikes[0])] || 0;
    // Where the at-the-money volatility sits between the lowest and the
    // highest in this chain. It was labelled "IV Rank", which is a 52-week
    // statistic needing a year of history the chain does not carry: on a
    // normal smile the at-the-money is the cheapest point, so it read 0%
    // against a "19% - 45%" range, and a flat surface fell back to 50%.
    const ivSpread = maxIV - minIV;
    const ivPosition = ivSpread > 1e-9 ? ((atmIV - minIV) / ivSpread * 100) : null;

    return { expiries, strikes: displayStrikes, expiryMap, minIV, maxIV, atmIV, ivPosition };
  }, [optionsData, spotPrice]);

  // AI analysis
  const handleAI = async () => {
    // One charge, the server's: chatWithTokens names the feature to
    // /api/ai/chat. The client spent a token on /tokens/consume and the chat
    // charged again on top.
    setAiLoading(true);
    try {
      const aiService = window.AIService;
      if (!aiService?.getSettings()?.enabled) { setAiResult({ error: 'AI analysis is off. Add OPENAI_API_KEY to .env and restart to enable it.' }); setAiLoading(false); return; }
      const settings = aiService.getSettings();
      // The chain envelope carries `code`, not `symbol`; reading
      // `.symbol` sent "Unknown" as the ticker in every IV prompt.
      const ticker = window.OptionsDeepLink ? window.OptionsDeepLink.tickerOf(optionsData) : (optionsData?.code || 'Unknown');

      // The prompt asked "Is IV high or low historically?" and sent no
      // history -- the chain has none -- and its range ran 5%-292% because
      // an expiry on its last day carries absurd IVs.
      // It now gets what the chain does hold: ATM IV by expiry (the term
      // structure), with expiries under a week left out of the range and
      // the skew.
      const settled = (surfaceData?.expiries || []).filter(e => (surfaceData.expiryMap[e]?.dte || 0) >= 7);
      const usable = settled.length ? settled : (surfaceData?.expiries || []);
      const atmOf = (exp) => {
        const ivs = surfaceData.expiryMap[exp]?.ivByStrike || {};
        const ks = Object.keys(ivs).map(Number);
        if (!ks.length) return null;
        const k = ks.reduce((b, s) => (Math.abs(s - spotPrice) < Math.abs(b - spotPrice) ? s : b), ks[0]);
        return ivs[k];
      };
      const termInfo = usable.slice(0, 6).map(e => {
        const iv = atmOf(e);
        return iv == null ? null : `${e} (${surfaceData.expiryMap[e].dte}d): ${(iv * 100).toFixed(1)}%`;
      }).filter(Boolean).join('; ');
      const rangeIVs = [];
      usable.forEach(e => Object.values(surfaceData.expiryMap[e]?.ivByStrike || {}).forEach(v => rangeIVs.push(v)));
      const rangeMin = rangeIVs.length ? Math.min(...rangeIVs) : 0;
      const rangeMax = rangeIVs.length ? Math.max(...rangeIVs) : 0;

      // Build skew summary
      let skewInfo = '';
      if (surfaceData) {
        const nearExp = usable[0] || surfaceData.expiries[0];
        const ivs = surfaceData.expiryMap[nearExp]?.ivByStrike || {};
        const entries = Object.entries(ivs).sort(([a], [b]) => Number(a) - Number(b));
        const otmPuts = entries.filter(([s]) => Number(s) < spotPrice * 0.95);
        const atm = entries.filter(([s]) => Math.abs(Number(s) - spotPrice) < spotPrice * 0.05);
        const otmCalls = entries.filter(([s]) => Number(s) > spotPrice * 1.05);
        const avgOTMPut = otmPuts.length > 0 ? otmPuts.reduce((s, [, v]) => s + v, 0) / otmPuts.length : 0;
        const avgATM = atm.length > 0 ? atm.reduce((s, [, v]) => s + v, 0) / atm.length : 0;
        const avgOTMCall = otmCalls.length > 0 ? otmCalls.reduce((s, [, v]) => s + v, 0) / otmCalls.length : 0;
        skewInfo = `Skew at ${nearExp}: OTM Put IV ${(avgOTMPut * 100).toFixed(1)}%, ATM IV ${(avgATM * 100).toFixed(1)}%, OTM Call IV ${(avgOTMCall * 100).toFixed(1)}%`;
      }

      const prompt = `You are an IV surface analyst. Analyze the implied volatility surface for ${ticker} at $${spotPrice}, from today's option chain only (no IV history is available):
- ATM IV by expiry (term structure): ${termInfo || 'n/a'}
- IV range across strikes within ±30% of spot${settled.length ? ', expiries a week or more out' : ''}: ${(rangeMin * 100).toFixed(1)}% - ${(rangeMax * 100).toFixed(1)}%
- ${skewInfo}
- Expiries available: ${surfaceData?.expiries?.length || 0}

Analyze: 1) What does the term structure say (near-term IV above or below longer expiries, and what that implies)? 2) What does the skew tell us? 3) Is downside protection expensive relative to upside calls? 4) Which strategies suit this surface? Do not claim whether IV is high or low versus its history -- that data was not given. Use **bold**. 120 words max.`;

      const resp = await aiService.chatWithTokens('options_ai_iv', [{ role: 'user', content: prompt }]);
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
      part.startsWith('**') && part.endsWith('**') ? React.createElement('strong', { key: i, style: { color: '#E0E3EB' } }, part.slice(2, -2)) : part
    ));
  };

  const cardStyle = {
    padding: '16px', borderRadius: '12px', marginBottom: '16px',
    background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
  };

  if (!surfaceData) return React.createElement('div', { style: { padding: '32px', textAlign: 'center', color: isDark ? C3.textMutedDark : C3.textMutedLight } }, 'Loading IV data...');

  // Color scale: low IV = blue, mid = green/yellow, high IV = red
  const ivToColor = (iv) => {
    if (!iv) return 'rgba(128,128,128,0.2)';
    const norm = (iv - surfaceData.minIV) / (surfaceData.maxIV - surfaceData.minIV || 0.01);
    const r = Math.round(norm > 0.5 ? 255 : norm * 2 * 255);
    const g = Math.round(norm < 0.5 ? norm * 2 * 200 : (1 - norm) * 2 * 200);
    const b = Math.round(norm < 0.3 ? (1 - norm / 0.3) * 200 : 0);
    return `rgba(${r},${g},${b},0.7)`;
  };
  // White read 2.7-3.0:1 on the yellow cells. The cell is a
  // 70% tint over the card, so the text is whichever of white and near-black
  // reads better on the colour actually shown.
  const ivTextColor = (cell) => {
    const A = window.A11yColor;
    if (!A) return 'white';
    const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(cell);
    if (!m) return 'white';
    const ground = A.composite([+m[1], +m[2], +m[3]], +m[4], isDark ? '#1C1A14' : '#ffffff');
    return A.contrast('#ffffff', ground) >= A.contrast('#000000', ground) ? '#ffffff' : '#000000';
  };
  // Mid-tone cells (the purples) gave neither ink 4.5:1 -- 54/55/56 read
  // 4.27-4.41 at 9 px. There the cell itself moves: towards
  // white under black ink, towards black under white ink, until it reads.
  const ivCell = (iv) => {
    const cell = ivToColor(iv);
    const A = window.A11yColor;
    const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(cell);
    if (!A || !m) return { background: cell, color: ivTextColor(cell) };
    let ground = A.composite([+m[1], +m[2], +m[3]], +m[4], isDark ? '#1C1A14' : '#ffffff');
    const ink = ivTextColor(cell);
    const toward = ink === '#000000' ? [255, 255, 255] : [0, 0, 0];
    const rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    for (let t = 0; t < 1 && A.contrast(ink, ground) < 4.6; t += 0.05) {
      const g = rgb(ground).map((v, i) => Math.round(v * 0.95 + toward[i] * 0.05));
      ground = '#' + g.map(v => v.toString(16).padStart(2, '0')).join('');
    }
    return { background: ground, color: ink };
  };

  const { expiries, strikes, expiryMap } = surfaceData;

  return React.createElement('div', null,
    // Summary cards
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' } },
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'ATM IV'),
        React.createElement('div', { style: { fontSize: '22px', fontWeight: '700', color: isDark ? C3.textDark : C3.textLightTheme } }, (surfaceData.atmIV * 100).toFixed(1) + '%')
      ),
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'ATM in IV range'),
        React.createElement('div', { style: { fontSize: '22px', fontWeight: '700', color: surfaceData.ivPosition == null ? (isDark ? C3.textMutedDark : C3.textMutedLight) : (window.A11yColor ? window.A11yColor.text(surfaceData.ivPosition > 70 ? '#ef4444' : surfaceData.ivPosition > 40 ? '#f59e0b' : '#22c55e', isDark) : (surfaceData.ivPosition > 70 ? '#ef4444' : surfaceData.ivPosition > 40 ? '#f59e0b' : '#22c55e')) } }, surfaceData.ivPosition == null ? 'N/A' : surfaceData.ivPosition.toFixed(0) + '%'),
        React.createElement('div', { style: { width: '80%', height: '4px', borderRadius: '2px', background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', margin: '6px auto 0', overflow: 'hidden' } },
          React.createElement('div', { style: { width: (surfaceData.ivPosition || 0) + '%', height: '100%', background: surfaceData.ivPosition == null ? 'transparent' : surfaceData.ivPosition > 70 ? '#ef4444' : surfaceData.ivPosition > 40 ? '#f59e0b' : '#22c55e', borderRadius: '2px' } })
        )
      ),
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'IV Range'),
        React.createElement('div', { style: { fontSize: '16px', fontWeight: '700' } },
          React.createElement('span', { style: { color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e') } }, (surfaceData.minIV * 100).toFixed(0) + '%'),
          ' — ',
          React.createElement('span', { style: { color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') } }, (surfaceData.maxIV * 100).toFixed(0) + '%')
        )
      ),
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Expiries'),
        React.createElement('div', { style: { fontSize: '22px', fontWeight: '700' } }, expiries.length)
      )
    ),

    // View mode tabs
    React.createElement('div', { style: { display: 'flex', gap: '4px', marginBottom: '16px', padding: '4px', borderRadius: '10px', background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' } },
      ...['heatmap', 'skew', 'term'].map(m =>
        React.createElement('button', {
          key: m, onClick: () => setViewMode(m),
          style: {
            flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: '600', border: 'none', cursor: 'pointer',
            background: 'transparent',
            color: isDark ? C3.textDark : C3.textLightTheme,
            ...window.ToggleStyle.value(viewMode === m, isDark),
          }
        }, m === 'heatmap' ? 'IV Heatmap' : m === 'skew' ? 'Volatility Skew' : 'Term Structure')
      )
    ),

    // Heatmap view
    viewMode === 'heatmap' && React.createElement('div', { style: { ...cardStyle, padding: '8px', overflowX: 'auto' } },
      React.createElement('table', { style: { borderCollapse: 'collapse', fontSize: '10px', width: '100%', minWidth: strikes.length * 40 + 80 + 'px' } },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', { style: { padding: '4px 6px', textAlign: 'left', fontSize: '10px', fontWeight: '600', opacity: 0.7, position: 'sticky', left: 0, background: isDark ? '#12121f' : '#f8f8fa', zIndex: 1 } }, 'Expiry \\ Strike'),
            ...strikes.map(s => React.createElement('th', { key: s, style: { padding: '4px 3px', textAlign: 'center', fontSize: '9px', fontWeight: Math.abs(s - spotPrice) < spotPrice * 0.02 ? '700' : '400', color: Math.abs(s - spotPrice) < spotPrice * 0.02 ? (window.A11yColor ? window.A11yColor.text('#6366f1', isDark) : '#6366f1') : undefined } }, s))
          )
        ),
        React.createElement('tbody', null,
          ...expiries.map(exp => {
            const data = expiryMap[exp];
            return React.createElement('tr', { key: exp },
              React.createElement('td', { style: { padding: '4px 6px', fontSize: '10px', fontWeight: '600', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: isDark ? '#12121f' : '#f8f8fa', zIndex: 1 } }, exp + ' (' + data.dte + 'd)'),
              ...strikes.map(s => {
                const iv = data.ivByStrike[s];
                return React.createElement('td', {
                  key: s,
                  style: { padding: '3px 2px', textAlign: 'center', fontSize: '9px', fontWeight: '600', ...(iv ? ivCell(iv) : { background: 'transparent', color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)' }), borderRadius: '2px' }
                }, iv ? (iv * 100).toFixed(0) : '·');
              })
            );
          })
        )
      ),
      // Color legend
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', fontSize: '10px', opacity: 0.7 } },
        React.createElement('span', null, 'Low IV'),
        React.createElement('div', { style: { width: '100px', height: '8px', borderRadius: '4px', background: 'linear-gradient(to right, rgba(0,100,200,0.7), rgba(0,200,100,0.7), rgba(255,200,0,0.7), rgba(255,0,0,0.7))' } }),
        React.createElement('span', null, 'High IV')
      )
    ),

    // Skew view (IV vs Strike for each expiry)
    viewMode === 'skew' && React.createElement('div', { style: cardStyle },
      React.createElement('div', { ref: chartRef }, (() => {
        const svgW = chartW0 > 0 ? Math.max(200, chartW0) : 700;
        const svgH = chartW0 > 0 ? Math.max(220, Math.min(300, Math.round(svgW / 2.4))) : 300;
        const padL = 46, padR = 34, padT = 20, padB = 40;
        // One strike label per ~60 px of chart.
        const xEvery = Math.max(1, Math.ceil(strikes.length / Math.max(2, Math.floor((svgW - padL - padR) / 60))));
        const chartW = svgW - padL - padR, chartH = svgH - padT - padB;
        const minS = strikes[0], maxS = strikes[strikes.length - 1];
        const sx = (s) => padL + ((s - minS) / (maxS - minS)) * chartW;
        const sy = (iv) => padT + chartH - ((iv - surfaceData.minIV) / (surfaceData.maxIV - surfaceData.minIV || 0.01)) * chartH;

        const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#06b6d4', '#84cc16'];

        const shown = expiries.slice(0, 6).filter(exp => strikes.filter(s => expiryMap[exp].ivByStrike[s]).length >= 2);
        const label = 'Implied volatility by strike for ' + shown.length + (shown.length === 1 ? ' expiry' : ' expiries')
          + ' (' + shown.map(exp => expiryMap[exp].dte + 'd').join(', ') + '), from $' + minS + ' to $' + maxS
          + ': between ' + (surfaceData.minIV * 100).toFixed(0) + '% and ' + (surfaceData.maxIV * 100).toFixed(0) + '%; at the money $' + Number(spotPrice).toFixed(2) + '.';
        return React.createElement('svg', { role: 'img', 'aria-label': label, focusable: 'false', viewBox: `0 0 ${svgW} ${svgH}`, style: { width: '100%', height: 'auto', display: 'block' } },
          // Grid
          React.createElement('line', { x1: padL, y1: svgH - padB, x2: svgW - padR, y2: svgH - padB, stroke: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)', strokeWidth: 1 }),
          React.createElement('line', { x1: padL, y1: padT, x2: padL, y2: svgH - padB, stroke: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)', strokeWidth: 1 }),
          // Current price line
          React.createElement('line', { x1: sx(spotPrice), y1: padT, x2: sx(spotPrice), y2: svgH - padB, stroke: '#6366f1', strokeWidth: 1, strokeDasharray: '4 3' }),
          React.createElement('text', { x: sx(spotPrice), y: padT - 4, fill: (window.A11yColor ? window.A11yColor.text('#6366f1', isDark) : '#6366f1'), fontSize: '11', textAnchor: 'middle' }, 'ATM'),
          // Lines per expiry
          ...expiries.slice(0, 6).map((exp, eIdx) => {
            const data = expiryMap[exp];
            const pts = strikes.filter(s => data.ivByStrike[s]).map(s => ({ x: sx(s), y: sy(data.ivByStrike[s]) }));
            if (pts.length < 2) return null;
            const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
            return React.createElement('g', { key: exp },
              React.createElement('path', { d: path, fill: 'none', stroke: colors[eIdx % colors.length], strokeWidth: 2, opacity: 0.8 }),
              React.createElement('text', { x: pts[pts.length - 1].x + 4, y: pts[pts.length - 1].y + 3, fill: colors[eIdx % colors.length], fontSize: '11', fontWeight: '600' }, data.dte + 'd')
            );
          }),
          // Y axis labels
          React.createElement('text', { x: padL - 6, y: padT + 6, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '11', textAnchor: 'end' }, (surfaceData.maxIV * 100).toFixed(0) + '%'),
          React.createElement('text', { x: padL - 6, y: svgH - padB, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '11', textAnchor: 'end' }, (surfaceData.minIV * 100).toFixed(0) + '%'),
          // X axis
          ...strikes.filter((_, i) => i % xEvery === 0).map(s =>
            React.createElement('text', { key: s, x: sx(s), y: svgH - padB + 14, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '11', textAnchor: 'middle' }, '$' + s)
          )
        );
      })())
    ),

    // Term Structure view (ATM IV vs DTE)
    viewMode === 'term' && React.createElement('div', { style: cardStyle },
      React.createElement('div', { ref: chartRef }, (() => {
        // Get ATM IV for each expiry
        const atmStrike = strikes.reduce((best, s) => Math.abs(s - spotPrice) < Math.abs(best - spotPrice) ? s : best, strikes[0]);
        const termData = expiries.map(exp => ({
          dte: expiryMap[exp].dte,
          iv: expiryMap[exp].ivByStrike[atmStrike] || 0,
          expiry: exp,
        })).filter(d => d.iv > 0);

        if (termData.length < 2) return React.createElement('div', { style: { padding: '20px', textAlign: 'center', opacity: 0.5 } }, 'Not enough data for term structure');

        const svgW = chartW0 > 0 ? Math.max(200, chartW0) : 700;
        const svgH = chartW0 > 0 ? Math.max(220, Math.min(280, Math.round(svgW / 2.5))) : 280;
        const padL = 46, padR = 30, padT = 24, padB = 40;
        // Point labels and day labels thinned to ~one per 48 px.
        const tEvery = Math.max(1, Math.ceil(termData.length / Math.max(2, Math.floor((svgW - padL - padR) / 48))));
        const chartW = svgW - padL - padR, chartH = svgH - padT - padB;
        const minDTE = termData[0].dte, maxDTE = termData[termData.length - 1].dte;
        const minIV = Math.min(...termData.map(d => d.iv));
        const maxIV = Math.max(...termData.map(d => d.iv));
        const sx = (dte) => padL + ((dte - minDTE) / (maxDTE - minDTE || 1)) * chartW;
        const sy = (iv) => padT + chartH - ((iv - minIV) / (maxIV - minIV || 0.01)) * chartH;

        const path = termData.map((d, i) => `${i === 0 ? 'M' : 'L'}${sx(d.dte).toFixed(1)},${sy(d.iv).toFixed(1)}`).join(' ');
        const areaPath = path + ` L${sx(termData[termData.length - 1].dte).toFixed(1)},${(svgH - padB).toFixed(1)} L${sx(termData[0].dte).toFixed(1)},${(svgH - padB).toFixed(1)} Z`;

        const label = 'At-the-money implied volatility ($' + atmStrike + ') by days to expiry: '
          + termData.map(d => d.dte + 'd ' + (d.iv * 100).toFixed(1) + '%').join(', ') + '.';
        return React.createElement('svg', { role: 'img', 'aria-label': label, focusable: 'false', viewBox: `0 0 ${svgW} ${svgH}`, style: { width: '100%', height: 'auto', display: 'block' } },
          React.createElement('path', { d: areaPath, fill: 'rgba(168,85,247,0.1)' }),
          React.createElement('path', { d: path, fill: 'none', stroke: '#a855f7', strokeWidth: 2.5 }),
          // Data points
          ...termData.map((d, i) =>
            React.createElement('g', { key: i, 'data-show-label': i % tEvery === 0 ? 'true' : undefined },
              React.createElement('circle', { cx: sx(d.dte), cy: sy(d.iv), r: 4, fill: '#a855f7', stroke: isDark ? '#1a1a2e' : '#fff', strokeWidth: 2 }),
              i % tEvery === 0 && React.createElement('text', { x: sx(d.dte), y: sy(d.iv) - 10, fill: (window.A11yColor ? window.A11yColor.text('#a855f7', (typeof isDark !== 'undefined' && isDark)) : '#a855f7'), fontSize: '11', textAnchor: 'middle', fontWeight: '600' }, (d.iv * 100).toFixed(1) + '%')
            )
          ),
          // X axis labels
          ...termData.filter((_, i) => i % tEvery === 0).map((d, i) =>
            React.createElement('text', { key: 'x' + i, x: sx(d.dte), y: svgH - padB + 14, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '11', textAnchor: 'middle' }, d.dte + 'd')
          ),
          // Y axis
          React.createElement('text', { x: padL - 6, y: padT + 6, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '11', textAnchor: 'end' }, (maxIV * 100).toFixed(0) + '%'),
          React.createElement('text', { x: padL - 6, y: svgH - padB, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '11', textAnchor: 'end' }, (minIV * 100).toFixed(0) + '%'),
          // Title
          React.createElement('text', { x: svgW / 2, y: svgH - 2, fill: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)', fontSize: '11', textAnchor: 'middle' }, 'ATM IV ($' + atmStrike + ') vs Days to Expiry')
        );
      })())
    ),

    // AI button -- only when a model is configured; the check used to sit in
    // the click handler and the button rendered regardless.
    Boolean(window.AIService?.getSettings?.()?.enabled) && React.createElement('button', {
      onClick: handleAI, disabled: aiLoading,
      style: { width: '100%', padding: '12px', borderRadius: '12px', border: 'none', cursor: 'pointer', background: C3.logoGradient, color: 'white', fontWeight: '700', fontSize: '13px', opacity: aiLoading ? 0.6 : 1, marginBottom: '12px' }
    }, aiLoading ? 'Analyzing...' : (ivCost ? `AI IV Surface Analysis · ${ivCost}` : 'AI IV Surface Analysis')),

    aiResult && aiResult.error && (window.AIText
      ? window.AIText.errorBox(aiResult.error, isDark)
      : React.createElement('div', { role: 'alert', style: { marginBottom: '12px', fontSize: '13px', color: C3.error } }, aiResult.error)),
    aiResult && !aiResult.error && React.createElement('div', { style: { ...cardStyle, background: isDark ? C3.fillDark : C3.fillLight, border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}` } },
      React.createElement('div', { style: { fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap' } }, formatAI(aiResult)),
      React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: '10px', fontStyle: 'italic' } }, 'AI-generated — not financial advice')
    ),

    // Education
    React.createElement('div', { style: { ...cardStyle, background: isDark ? C3.fillDark : C3.fillLight, border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}` } },
      React.createElement('h4', { style: { fontWeight: '700', fontSize: '13px', marginBottom: '8px', color: isDark ? C3.textDark : C3.textLightTheme } }, 'Understanding IV Surface'),
      React.createElement('div', { style: { fontSize: '12px', lineHeight: '1.6', opacity: 0.8 } },
        React.createElement('strong', null, 'ATM in IV range'), ' — where the at-the-money IV sits between the lowest and highest IV across the strikes and expiries of this chain today (0% = lowest, 100% = highest). It is not the 52-week IV Rank: the chain carries no IV history. ',
        React.createElement('strong', null, 'Volatility Skew'), ' — IV varies by strike: OTM puts usually have higher IV (fear premium). Steep skew = market pricing more downside risk. ',
        React.createElement('strong', null, 'Term Structure'), ' — how IV changes across expirations. Upward slope (contango) = normal. Inverted = near-term fear/event.'
      )
    )
  );
};
