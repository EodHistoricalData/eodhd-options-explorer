// Unusual Options Activity Scanner — detects anomalous volume/OI spikes
// Ported from: UnusualVolumeDetector (7-sigma detection algorithm)

// How far out of the money a contract is, in percent of spot: positive = OTM,
// negative = ITM. Per type, because the direction flips: a call is OTM above
// the spot, a put below it. The scanner used `strike / spot - 1` for both, so a
// put struck at 340 with AAPL at 329.40 went into the paid AI prompt as
// "3.2% OTM" -- it is 3.2% in the money.
window.optionOtmPct = (type, strike, spot) => {
  if (!(spot > 0) || !(strike > 0)) return 0;
  const isPut = String(type || '').toUpperCase().startsWith('P');
  return (isPut ? (1 - strike / spot) : (strike / spot - 1)) * 100;
};
window.optionMoneynessLabel = (otmPct) => {
  if (Math.abs(otmPct) < 0.05) return 'ATM';
  return Math.abs(otmPct) + '% ' + (otmPct > 0 ? 'OTM' : 'ITM');
};

window.UnusualActivityScanner = ({ optionsData, currentPrice, isDark, apiKey }) => {
  // The prices of this screen's AI actions, from the server's list.
  const useFeatureCost = (() => null);
  const whyCost = useFeatureCost('options_ai_unusual');
  const { useState, useMemo } = React;
  const C3 = window.C3;

  const [sortBy, setSortBy] = useState('sigma'); // 'sigma' | 'volume' | 'oi' | 'strike'
  const [filterType, setFilterType] = useState('all'); // 'all' | 'calls' | 'puts'
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [selectedAnomaly, setSelectedAnomaly] = useState(null);

  const spotPrice = useMemo(() => {
    if (currentPrice) return currentPrice;
    if (!optionsData?.data?.[0]?.options) return 0;
    const calls = optionsData.data[0].options.CALL || [];
    const atm = calls.reduce((best, c) => c.delta && Math.abs(c.delta - 0.5) < Math.abs((best?.delta || 0) - 0.5) ? c : best, null);
    return atm?.strike || calls[Math.floor(calls.length / 2)]?.strike || 0;
  }, [currentPrice, optionsData]);

  // Scan all options for unusual activity
  const anomalies = useMemo(() => {
    if (!optionsData?.data) return [];
    const results = [];

    // Collect all options across expiries with volume data
    optionsData.data.forEach(exp => {
      const expDate = exp.expirationDate;
      const dte = Math.max(1, Math.round((new Date(expDate) - new Date()) / 864e5));

      ['CALL', 'PUT'].forEach(type => {
        const opts = exp.options?.[type] || [];
        if (opts.length === 0) return;

        // Calculate mean and stddev of volume across strikes for this expiry/type
        const volumes = opts.map(o => o.volume || 0).filter(v => v > 0);
        if (volumes.length < 3) return; // need enough data points

        const mean = volumes.reduce((s, v) => s + v, 0) / volumes.length;
        const variance = volumes.reduce((s, v) => s + (v - mean) ** 2, 0) / volumes.length;
        const stddev = Math.sqrt(variance);

        if (stddev < 1) return; // no meaningful variation

        opts.forEach(opt => {
          const vol = opt.volume || 0;
          const oi = opt.openInterest || 0;
          if (vol < 100) return; // skip very low volume

          // Sigma calculation
          const sigma = stddev > 0 ? (vol - mean) / stddev : 0;

          // Volume/OI ratio (unusual if > 1, very unusual if > 3)
          const volOiRatio = oi > 0 ? vol / oi : vol > 100 ? 999 : 0;

          // Flag if sigma >= 3 OR volume/OI ratio >= 3
          const isUnusual = sigma >= 3 || volOiRatio >= 3;
          if (!isUnusual) return;

          const moneyness = window.optionOtmPct(type, opt.strike, spotPrice);

          results.push({
            type: type === 'CALL' ? 'Call' : 'Put',
            strike: opt.strike,
            expiry: expDate,
            dte,
            volume: vol,
            openInterest: oi,
            volOiRatio: Math.round(volOiRatio * 10) / 10,
            sigma: Math.round(sigma * 10) / 10,
            premium: opt.lastPrice || opt.ask || 0,
            iv: opt.impliedVolatility ? (opt.impliedVolatility > 5 ? opt.impliedVolatility / 100 : opt.impliedVolatility) : 0,
            delta: opt.delta || 0,
            bid: opt.bid || 0,
            ask: opt.ask || 0,
            moneyness: Math.round(moneyness * 10) / 10,
            notional: vol * (opt.lastPrice || opt.ask || 0) * 100,
            meanVol: Math.round(mean),
          });
        });
      });
    });

    return results;
  }, [optionsData, spotPrice]);

  // Filter and sort
  const filtered = useMemo(() => {
    let list = anomalies;
    if (filterType === 'calls') list = list.filter(a => a.type === 'Call');
    if (filterType === 'puts') list = list.filter(a => a.type === 'Put');

    const sortFns = {
      sigma: (a, b) => b.sigma - a.sigma,
      volume: (a, b) => b.volume - a.volume,
      oi: (a, b) => b.volOiRatio - a.volOiRatio,
      strike: (a, b) => a.strike - b.strike,
      notional: (a, b) => b.notional - a.notional,
    };
    return list.sort(sortFns[sortBy] || sortFns.sigma);
  }, [anomalies, filterType, sortBy]);

  // AI analysis of selected anomaly
  const handleAI = async (anomaly) => {
    // One charge, the server's: chatWithTokens names the feature to
    // /api/ai/chat. The client spent a token on /tokens/consume and the chat
    // charged again on top.
    setAiLoading(true);
    setSelectedAnomaly(anomaly);
    try {
      const aiService = window.AIService;
      if (!aiService?.getSettings()?.enabled) { setAiResult({ error: 'AI analysis is off. Add OPENAI_API_KEY to .env and restart to enable it.' }); setAiLoading(false); return; }
      const settings = aiService.getSettings();
      // The chain envelope carries `code`, not `symbol`.
      const ticker = window.OptionsDeepLink ? window.OptionsDeepLink.tickerOf(optionsData) : (optionsData?.code || 'Unknown');
      const prompt = `You are an options flow analyst. Analyze this unusual options activity for ${ticker} at $${spotPrice}:

- Type: ${anomaly.type}
- Strike: $${anomaly.strike} (${window.optionMoneynessLabel(anomaly.moneyness)})
- Expiry: ${anomaly.expiry} (${anomaly.dte} days)
- Volume: ${anomaly.volume.toLocaleString('en-US')} (${anomaly.sigma}σ above the same-expiry strike average of ${anomaly.meanVol.toLocaleString('en-US')})
- Open Interest: ${anomaly.openInterest.toLocaleString('en-US')}
- Vol/OI Ratio: ${anomaly.volOiRatio}x
- Premium: $${anomaly.premium.toFixed(2)}, IV: ${(anomaly.iv * 100).toFixed(1)}%
- Notional: $${(anomaly.notional / 1000).toFixed(0)}K
- Delta: ${anomaly.delta.toFixed(2)}

Explain in plain language:
1. Why is this unusual? What does it suggest?
2. Is this likely a hedge, speculative bet, or institutional flow?
3. What price move is being bet on?
4. Risk considerations
Keep it concise (120 words). Use **bold** for key terms.`;

      const resp = await aiService.chatWithTokens('options_ai_unusual', [{ role: 'user', content: prompt }]);
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

  // Summary stats
  const totalCalls = anomalies.filter(a => a.type === 'Call').length;
  const totalPuts = anomalies.filter(a => a.type === 'Put').length;
  const topSigma = anomalies.length > 0 ? Math.max(...anomalies.map(a => a.sigma)) : 0;
  const totalNotional = anomalies.reduce((s, a) => s + a.notional, 0);
  const callNotional = anomalies.filter(a => a.type === 'Call').reduce((s, a) => s + a.notional, 0);
  const sentiment = totalNotional > 0 ? (callNotional / totalNotional * 100) : 50;

  return React.createElement('div', null,
    // EOD badge
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', fontSize: '11px', color: isDark ? 'rgba(255,255,255, 0.7)' : 'rgba(0,0,0,0.7)' } },
      React.createElement('span', { style: { background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', padding: '2px 8px', borderRadius: '4px' } }, 'EOD Data'),
      'Anomalies detected from end-of-day volume data. Threshold: 3σ+ or Vol/OI 3x+'
    ),

    // Summary cards
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' } },
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Unusual Strikes'),
        React.createElement('div', { style: { fontSize: '22px', fontWeight: '700', color: anomalies.length > 0 ? (window.A11yColor ? window.A11yColor.text('#f59e0b', isDark) : '#f59e0b') : isDark ? C3.textDark : C3.textLightTheme } }, anomalies.length)
      ),
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Calls / Puts'),
        React.createElement('div', { style: { fontSize: '18px', fontWeight: '700' } },
          React.createElement('span', { style: { color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e') } }, totalCalls),
          ' / ',
          React.createElement('span', { style: { color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') } }, totalPuts)
        )
      ),
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Max Sigma'),
        React.createElement('div', { style: { fontSize: '22px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text(topSigma >= 7 ? '#ef4444' : topSigma >= 5 ? '#f59e0b' : '#22c55e', isDark) : (topSigma >= 7 ? '#ef4444' : topSigma >= 5 ? '#f59e0b' : '#22c55e')) } }, topSigma.toFixed(1) + 'σ')
      ),
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Flow Sentiment'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', marginTop: '4px' } },
          React.createElement('span', { style: { fontSize: '11px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#22c55e', (typeof isDark !== 'undefined' && isDark)) : '#22c55e') } }, sentiment.toFixed(0) + '%'),
          React.createElement('div', { style: { width: '60px', height: '6px', borderRadius: '3px', background: '#ef4444', overflow: 'hidden' } },
            React.createElement('div', { style: { width: sentiment + '%', height: '100%', background: '#22c55e', borderRadius: '3px' } })
          ),
          React.createElement('span', { style: { fontSize: '11px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text('#ef4444', (typeof isDark !== 'undefined' && isDark)) : '#ef4444') } }, (100 - sentiment).toFixed(0) + '%')
        ),
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: '2px' } },
          sentiment > 60 ? 'Bullish Flow' : sentiment < 40 ? 'Bearish Flow' : 'Neutral Flow'
        )
      ),
      React.createElement('div', { style: { ...cardStyle, textAlign: 'center', marginBottom: 0 } },
        React.createElement('div', { style: { fontSize: '10px', opacity: 0.7 } }, 'Total Notional'),
        React.createElement('div', { style: { fontSize: '18px', fontWeight: '700', color: isDark ? C3.textDark : C3.textLightTheme } },
          totalNotional >= 1e6 ? '$' + (totalNotional / 1e6).toFixed(1) + 'M' : '$' + (totalNotional / 1e3).toFixed(0) + 'K'
        )
      )
    ),

    // Filter bar
    React.createElement('div', { style: { display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' } },
      // Type filter
      ...['all', 'calls', 'puts'].map(f =>
        React.createElement('button', {
          key: f, onClick: () => setFilterType(f), 'aria-pressed': filterType === f,
          style: {
            padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: '600', border: 'none', cursor: 'pointer',
            background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
            color: isDark ? C3.textDark : C3.textLightTheme,
            ...window.ToggleStyle.value(filterType === f, isDark),
          }
        }, f === 'all' ? 'All' : f === 'calls' ? 'Calls Only' : 'Puts Only')
      ),
      React.createElement('span', { style: { marginLeft: 'auto', fontSize: '11px', opacity: 0.7 } }, 'Sort: '),
      ...['sigma', 'volume', 'notional', 'oi'].map(s =>
        React.createElement('button', {
          key: s, onClick: () => setSortBy(s), 'aria-pressed': sortBy === s,
          // A 24 px hit area around the 20 px chip (WCAG 2.5.8).
          'data-hit': '',
          style: {
            padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '600', border: 'none', cursor: 'pointer',
            background: 'transparent',
            color: isDark ? C3.textDark : C3.textLightTheme,
            ...window.ToggleStyle.value(sortBy === s, isDark),
          }
        }, s === 'sigma' ? 'Sigma' : s === 'volume' ? 'Volume' : s === 'notional' ? 'Notional' : 'Vol/OI')
      )
    ),

    // Results table
    filtered.length === 0
      ? React.createElement('div', { style: { ...cardStyle, textAlign: 'center', padding: '40px 16px' } },
          React.createElement('div', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '8px' } }, 'No Unusual Activity Detected'),
          React.createElement('div', { style: { fontSize: '13px', opacity: 0.7 } }, 'All options are trading within normal volume ranges for this ticker.')
        )
      : React.createElement('div', { style: { ...cardStyle, padding: '0', overflow: 'hidden' } },
          React.createElement('div', { style: { overflowX: 'auto' } },
            React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '700px' } },
              React.createElement('thead', null,
                React.createElement('tr', { style: { background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)' } },
                  ['Type', 'Strike', 'Expiry', 'DTE', 'Volume', 'Strike avg vol', 'σ vs strikes', 'OI', 'Vol/OI', 'Premium', 'IV', 'Notional']
                    // The AI column exists only when a model is configured;
                    // twenty-six "Why?" buttons with nothing behind them is
                    // what the test report found.
                    .concat(window.AIService?.getSettings?.()?.enabled ? ['AI'] : []).map(h =>
                    React.createElement('th', { key: h, style: { padding: '10px 6px', textAlign: h === 'Type' || h === 'Strike' ? 'left' : 'right', fontWeight: '600', opacity: 0.7, fontSize: '11px', borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}` } }, h)
                  )
                )
              ),
              React.createElement('tbody', null,
                ...filtered.slice(0, 30).map((a, idx) => {
                  const sigmaColor = a.sigma >= 7 ? '#ef4444' : a.sigma >= 5 ? '#f59e0b' : '#22c55e';
                  return React.createElement('tr', {
                    key: idx,
                    style: {
                      borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'}`,
                      background: selectedAnomaly === a ? (isDark ? C3.fillDark : C3.fillLight) : 'transparent',
                    }
                  },
                    React.createElement('td', { style: { padding: '8px 6px', fontWeight: '700', color: (window.A11yColor ? window.A11yColor.text((a.type === 'Call' ? '#22c55e' : '#ef4444'), (typeof isDark !== 'undefined' && isDark)) : (a.type === 'Call' ? '#22c55e' : '#ef4444')) } }, a.type),
                    React.createElement('td', { style: { padding: '8px 6px', fontWeight: '600' } },
                      '$' + a.strike,
                      React.createElement('span', { style: { fontSize: '10px', opacity: 0.7, marginLeft: '4px' } }, window.optionMoneynessLabel(a.moneyness))
                    ),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', fontSize: '11px' } }, a.expiry),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right' } }, a.dte + 'd'),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', fontWeight: '700' } }, a.volume.toLocaleString('en-US')),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', opacity: 0.75 } }, a.meanVol.toLocaleString('en-US')),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right' } },
                      React.createElement('span', { style: { padding: '2px 8px', borderRadius: '4px', fontWeight: '700', fontSize: '11px', color: 'white', background: (window.A11yColor ? window.A11yColor.fill(sigmaColor) : sigmaColor) } }, a.sigma + 'σ')
                    ),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right' } }, a.openInterest.toLocaleString('en-US')),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', fontWeight: '600', color: a.volOiRatio >= 3 ? (window.A11yColor ? window.A11yColor.text(a.volOiRatio >= 5 ? '#ef4444' : '#f59e0b', isDark) : (a.volOiRatio >= 5 ? '#ef4444' : '#f59e0b')) : isDark ? C3.textDark : C3.textLightTheme } }, (a.openInterest > 0 ? a.volOiRatio + 'x' : 'new OI')),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right' } }, '$' + a.premium.toFixed(2)),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right' } }, (a.iv * 100).toFixed(0) + '%'),
                    React.createElement('td', { style: { padding: '8px 6px', textAlign: 'right', fontWeight: '600' } },
                      a.notional >= 1e6 ? '$' + (a.notional / 1e6).toFixed(1) + 'M' : '$' + (a.notional / 1e3).toFixed(0) + 'K'
                    ),
                    Boolean(window.AIService?.getSettings?.()?.enabled) && React.createElement('td', { style: { padding: '8px 6px', textAlign: 'center' } },
                      React.createElement('button', {
                        onClick: () => handleAI(a),
                        disabled: aiLoading,
                        'aria-label': whyCost ? `Why? AI explanation, ${whyCost}` : 'Why? AI explanation',
                        title: whyCost ? `AI explanation · ${whyCost}` : 'AI explanation',
                        style: { padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '600', border: 'none', cursor: 'pointer', background: C3.logoGradient, color: 'white', opacity: aiLoading && selectedAnomaly === a ? 0.5 : 1 }
                      }, whyCost ? `Why? · ${whyCost.replace(' tokens', '').replace(' token', '')}` : 'Why?')
                    )
                  );
                })
              )
            )
          )
        ),

    // AI Result
    aiResult && aiResult.error && (window.AIText
      ? window.AIText.errorBox(aiResult.error, isDark)
      : React.createElement('div', { role: 'alert', style: { marginTop: '12px', fontSize: '13px', color: C3.error } }, aiResult.error)),
    aiResult && !aiResult.error && React.createElement('div', { style: { ...cardStyle, marginTop: '12px', background: isDark ? C3.fillDark : C3.fillLight, border: `1px solid ${isDark ? C3.lineDark : C3.lineLight}` } },
      selectedAnomaly && React.createElement('div', { style: { fontSize: '11px', fontWeight: '700', marginBottom: '8px', color: isDark ? C3.textDark : C3.textLightTheme } },
        'AI Analysis: ' + selectedAnomaly.type + ' $' + selectedAnomaly.strike + ' ' + selectedAnomaly.expiry
      ),
      React.createElement('div', { style: { fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap' } }, formatAI(aiResult)),
      React.createElement('div', { style: { fontSize: '10px', opacity: 0.7, marginTop: '10px', fontStyle: 'italic' } }, 'AI-generated — not financial advice')
    ),

    // Education
    React.createElement('div', { style: { ...cardStyle, background: isDark ? 'rgba(245,158,11,0.06)' : 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.12)' } },
      React.createElement('h4', { style: { fontWeight: '700', fontSize: '13px', marginBottom: '8px', color: (window.A11yColor ? window.A11yColor.text('#f59e0b', (typeof isDark !== 'undefined' && isDark)) : '#f59e0b') } }, 'How to Read Unusual Activity'),
      React.createElement('div', { style: { fontSize: '12px', lineHeight: '1.6', opacity: 0.8 } },
        React.createElement('strong', null, 'Sigma (σ)'), ' — how many standard deviations this strike’s volume sits above the average of the other strikes of the same expiry today (not a history). 3σ+ is notable, 7σ+ is extreme. ',
        React.createElement('strong', null, 'Vol/OI Ratio'), ' — volume vs open interest. Above 3x suggests new positions being opened. ',
        React.createElement('strong', null, 'Notional'), ' — total dollar value of traded contracts (volume × premium × 100). Large notional = institutional-sized bets. ',
        'High sigma + high Vol/OI + large notional = strongest signal of unusual activity.'
      )
    )
  );
};
