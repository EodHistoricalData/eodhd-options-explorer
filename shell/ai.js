/**
 * Analysis on the developer's own model key.
 *
 * The vendored modules already ask for this in a fixed shape, because the
 * terminal supports user-configured providers alongside its own backend:
 *
 *     const aiService = window.AIService;
 *     if (!aiService?.getSettings()?.enabled) return 'AI not configured...';
 *     const s = aiService.getSettings();
 *     const resp = await aiService.chat(s.provider, s.apiKey, messages);
 *
 * So the shape is kept exactly and only the location of the key changes. It
 * lives in .env beside the data key and is added by the proxy. The provider and
 * apiKey arguments are accepted and ignored -- there is no key in the browser
 * to pass, which is the entire point.
 *
 * Optional throughout. With no OPENAI_API_KEY the apps work completely and the
 * AI affordances do not render: an absent button beats a present one that
 * explains why it cannot help.
 *
 * Failures reject, and the sentence rides on the Error.
 *
 * This started the other way round -- resolving with an apology -- on the
 * assumption that the call sites drop the return value straight into the page
 * and would show a blank card on a rejection. That was worth checking and
 * turned out to be false: every one of the five, in the calendar, the news
 * view, the screener and the earnings card, already wraps the call in
 * try/catch and has an error state with a Try Again button.
 *
 * So resolving put "Incorrect API key provided" inside the answer card, under
 * a heading reading Week Ahead Briefing and a footer reading "Powered by AI".
 * A failure dressed as an answer. Rejecting sends the same sentence to the
 * place built for it.
 */
(function () {
  var CHAT_URL = '/api/_ai/chat';
  var available = false;

  function setAvailable(flag) {
    available = Boolean(flag);
  }

  // Synchronous: the modules call this inside render, so the answer has to be
  // known already. shell/keygate.js learns it from /api/_status at boot.
  function getSettings() {
    return {
      provider: 'proxy',
      // Null rather than a placeholder string. A placeholder would invite
      // somebody to start passing it around as though it meant something.
      apiKey: null,
      enabled: available,
    };
  }

  var OFF = 'AI analysis is off. Add OPENAI_API_KEY to .env and restart to enable it.';

  function chat(_provider, _apiKey, messages) {
    if (!available) return Promise.reject(new Error(OFF));
    return fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Only the messages. Whatever a caller passed as a key stays here.
      body: JSON.stringify({ messages: messages }),
    })
      .then(function (res) {
        if (!res.ok) {
          // The proxy answers a provider failure with {"content": "AI
          // provider: ..."}. Thrown as the raw body, that JSON reached the
          // page verbatim in every app with AI. The sentence inside it is
          // the message.
          return res.text().then(function (t) {
            var message = t;
            try {
              var body = JSON.parse(t);
              var inner = body && (body.content || body.error || body.message);
              if (inner && typeof inner === 'object') inner = inner.message;
              if (typeof inner === 'string' && inner.trim()) message = inner.trim();
            } catch (_) { /* not JSON: the text is the message */ }
            throw new Error(message || ('AI unavailable: ' + res.status));
          });
        }
        return res.json().then(function (body) {
          var content = body && body.content;
          if (!content) throw new Error('The model returned nothing.');
          // The proxy reduces a provider error to this same field, so an
          // answer that is only an error is one too.
          if (content.indexOf('AI provider: ') === 0) throw new Error(content);
          return content;
        });
      })
      .catch(function (e) {
        // Network faults arrive here as TypeError with a browser-specific
        // message. Anything already explained keeps its own wording.
        if (e instanceof TypeError) {
          throw new Error('Could not reach the local server for AI analysis.');
        }
        throw e;
      });
  }

  // ---- Named features -------------------------------------------------
  //
  // The modules do not call chat() directly. Each asks for a feature by name
  // -- digestNews, weekAheadBriefing, getEarningsPreview -- and the terminal's
  // aiService.js answers with a purpose-built prompt before its token gate.
  //
  // Only the gate is ours to drop. The prompts come across as they are,
  // because the prompt is the feature: an app that shipped the button and
  // improvised the instructions would give a worse answer than the terminal
  // for the same money, which is the opposite of the point.
  //
  // Missing them is not a quiet degradation. The call is
  // `await window.AIService.digestNews(news)`, so an absent method is a
  // TypeError rendered into the page as a red card. A test on the generator's
  // side reads the vendored modules and fails if any method they call is not
  // here; the tests are not shipped with the app.

  function text(value, limit) {
    var s = value == null ? '' : String(value);
    return limit ? s.substring(0, limit) : s;
  }

  function newsDigestMessages(articles) {
    // Twenty, trimmed hard. The terminal learned this from a 400 on an
    // over-long payload, and a longer prompt does not buy a better digest.
    var list = articles.slice(0, 20).map(function (a, i) {
      var entry = (i + 1) + '. ' + text(a.title, 140);
      if (a.content) entry += ' — ' + text(a.content, 100);
      if (a.symbols && a.symbols.length) entry += ' [' + a.symbols.slice(0, 3).join(', ') + ']';
      if (a.source) entry += ' (' + text(a.source, 30) + ')';
      return entry;
    }).join('\n').substring(0, 12000);

    return [
      { role: 'system', content: 'You are a senior market analyst creating a daily news briefing. Synthesize the provided headlines into a concise, actionable digest. Format:\n\n**Market Pulse**\nOne-sentence overall market mood.\n\n**Key Movers**\nBullet the 3-4 most impactful stories with tickers and why they matter.\n\n**Watch List**\nThings that could move markets next.\n\n**Takeaway**\nOne actionable insight for investors.\n\nBe sharp and concise. Use bold for tickers and key terms.' },
      { role: 'user', content: 'Create a hot news digest from these top headlines:\n\n' + list },
    ];
  }

  function weekAheadMessages(events) {
    var list = events.slice(0, 30).map(function (e, i) {
      var raw = e.raw || {};
      var line = (i + 1) + '. [' + String(e.type || '').toUpperCase() + '] ' + e.date + ' — ' + e.title;
      if (raw.estimate != null) line += ' (EPS est: ' + raw.estimate + ')';
      if (raw.actual != null) line += ' (actual: ' + raw.actual + ')';
      if (e.beatMiss) line += ' [' + e.beatMiss + ']';
      if (raw.dividend != null) line += ' ($' + raw.dividend + ')';
      if (raw.forecast != null) line += ' (forecast: ' + raw.forecast + ')';
      if (raw.previous != null) line += ' (prev: ' + raw.previous + ')';
      if (e.time) line += ' ' + e.time;
      return line;
    }).join('\n');

    return [
      { role: 'system', content: 'You are a senior market strategist creating a weekly briefing. Format:\n\n**Week Ahead Overview**\nOne-sentence market mood and what to watch.\n\n**Key Earnings**\nBullet the most impactful earnings reports and what to expect.\n\n**Economic Calendar**\nImportant economic releases and their potential market impact.\n\n**Dividends & Corporate Actions**\nNotable ex-dates, splits, IPOs.\n\n**Bottom Line**\nOne actionable takeaway for investors.\n\nBe concise and sharp. Use bold for tickers and key terms.' },
      { role: 'user', content: 'Create a week ahead briefing from these upcoming events:\n\n' + list },
    ];
  }

  function earningsPreviewMessages(symbol, earnings, fundamentals) {
    var ctx = 'Symbol: ' + symbol + '\n';
    if (earnings.length) {
      ctx += '\nLast ' + earnings.length + ' quarters:\n';
      earnings.forEach(function (e) {
        ctx += '- ' + e.date + ': EPS est ' + e.epsEstimate + ', actual ' + e.epsActual;
        if (e.epsDifference) {
          ctx += ' (' + (e.epsDifference > 0 ? 'beat' : 'missed') + ' by ' + Math.abs(e.epsDifference).toFixed(2) + ')';
        }
        ctx += '\n';
      });
    }
    if (fundamentals) {
      var h = fundamentals.Highlights || {};
      ctx += '\nKey metrics: P/E ' + (h.PERatio || 'N/A')
        + ', Mkt Cap $' + ((h.MarketCapitalization || 0) / 1e9).toFixed(1) + 'B'
        + ', Revenue Growth ' + (h.RevenueGrowthQuarterlyYOY || 'N/A')
        + ', EPS (TTM) ' + (h.EarningsShare || 'N/A');
    }

    return [
      { role: 'system', content: 'You are a senior equity analyst previewing upcoming earnings. Provide:\n1. **Expectations** — what the market expects based on estimates\n2. **Track Record** — beat/miss pattern from recent quarters\n3. **Key Metrics to Watch** — revenue, margins, guidance\n4. **Risk Factors** — what could cause a miss\n5. **Prediction** — bullish/bearish lean with reasoning\n\nBe specific and data-driven. Use bold for key terms.' },
      { role: 'user', content: 'Preview upcoming earnings for:\n\n' + ctx },
    ];
  }

  // A portfolio summary in the shape the prompts expect.
  //
  // In the portfolio tracker the calculations module writes it: the
  // portfolio's own currency, two decimals, quantities, weights and sectors.
  // This used to be the only version, and it wrote "$" and an unrounded
  // toLocaleString() whatever the portfolio was kept in -- a EUR portfolio
  // showing "TOTAL VALUE €6,756.66" went to the model as "$6,756.665", with
  // no quantities and no sectors, so "what is my sector exposure?" could
  // only be guessed at. The terminal's aiService does the same hand-off.
  //
  // The rest is the fallback for the apps that hold no portfolio, where the
  // call sites are reached with an empty list.
  function portfolioContext(holdings, holdingsData) {
    var calc = window.PortfolioCalculations;
    if (calc && typeof calc.portfolioPromptContext === 'function') {
      return calc.portfolioPromptContext(holdings, holdingsData || {});
    }
    if (!holdings || !holdings.length) return 'Empty portfolio';
    var data = holdingsData || {};
    var total = 0;
    var positions = [];
    holdings.forEach(function (h) {
      var d = data[h.id] || {};
      var value = d.currentValue || 0;
      total += value;
      if (value > 0) {
        positions.push({
          symbol: (h.symbol && h.symbol.split('.')[0]) || h.name,
          value: value,
          pnlPercent: d.pnlPercent || 0,
        });
      }
    });
    positions.sort(function (a, b) { return b.value - a.value; });
    var out = 'Total Portfolio Value: $' + total.toLocaleString() + '\n\nHoldings (' + positions.length + '):\n';
    positions.forEach(function (p) {
      out += '- ' + p.symbol + ': $' + p.value.toLocaleString()
        + ' (' + (p.pnlPercent >= 0 ? '+' : '') + p.pnlPercent.toFixed(1) + '%)\n';
    });
    return out;
  }

  // The user turn of a portfolio question, as analyzePortfolio sends it and
  // as the terminal's AIService.portfolioQuestion builds it. The portfolio
  // tracker's chat measures a question with this before sending it, so the
  // length it checks is the length that goes out, portfolio and all.
  function portfolioQuestion(holdings, holdingsData, question) {
    return 'Here is my portfolio:\n\n' + portfolioContext(holdings, holdingsData) + '\n\nQuestion: ' + String(question || '');
  }

  function eventLines(events) {
    return events.slice(0, 30).map(function (e, i) {
      var raw = e.raw || {};
      var line = (i + 1) + '. [' + String(e.type || '').toUpperCase() + '] ' + e.date + ' — ' + e.title;
      if (raw.estimate != null) line += ' (EPS est: ' + raw.estimate + ')';
      if (raw.actual != null) line += ' (actual: ' + raw.actual + ')';
      if (raw.dividend != null) line += ' ($' + raw.dividend + ')';
      if (e.time) line += ' ' + e.time;
      return line;
    }).join('\n');
  }

  // The screener's parser is the one feature that does not return prose. Its
  // caller reads `result.filters` and `result.description`, and it handles a
  // rejected promise properly -- so this one throws where the others answer.
  // Returning the usual apology sentence here would land as
  // `Object.keys(undefined)` inside the click handler.
  var SCREENER_SYSTEM = "You are a stock screener filter parser. Convert natural language queries into JSON filters for a stock screener API.\n\nReturn ONLY valid JSON with this exact shape (all values as strings):\n{\n  \"filters\": {\n    \"exchange\": \"us\",\n    \"minMarketCap\": \"\", \"maxMarketCap\": \"\",\n    \"minPE\": \"\", \"maxPE\": \"\",\n    \"sector\": \"\",\n    \"minDividendYield\": \"\", \"maxDividendYield\": \"\",\n    \"minEPS\": \"\",\n    \"minPrice\": \"\", \"maxPrice\": \"\",\n    \"minVolume\": \"\",\n    \"minChangeP\": \"\", \"maxChangeP\": \"\",\n    \"sortBy\": \"market_capitalization\", \"sortOrder\": \"desc\"\n  },\n  \"description\": \"Brief description of what was understood\"\n}\n\nRULES:\n- CRITICAL: Only set a filter when the user EXPLICITLY asked for it. Every field the user didn't mention MUST stay as the empty string \"\". Do NOT infer market cap, P/E, price, sector, etc. from unrelated criteria. Example: \"high volume\" sets ONLY minVolume — minMarketCap, minPE, minPrice, etc. must all stay \"\". Adding an implicit market cap filter silently narrows results to ~10 rows.\n- All filter values MUST be strings (e.g. \"20\" not 20). Empty string \"\" means no filter.\n- exchange codes: US=\"us\", UK=\"lse\", Canada=\"tsx\", Hong Kong=\"hkex\", Germany=\"xetra\", France=\"pa\", Netherlands=\"as\", Australia=\"au\", Italy=\"mi\", Spain=\"mc\", Switzerland=\"sw\", India=\"nse\", South Africa=\"jse\". Default \"us\".\n- sector values (exact): Technology, Healthcare, Financial Services, Consumer Cyclical, Communication Services, Industrials, Consumer Defensive, Energy, Utilities, Real Estate, Basic Materials\n- dividendYield as percentage number (e.g. \"3\" means 3%)\n- Market cap as raw number: 1B = \"1000000000\", 1M = \"1000000\", 1T = \"1000000000000\"\n- Common mappings: \"large cap\" = minMarketCap \"10000000000\", \"mega cap\" = minMarketCap \"200000000000\", \"mid cap\" = minMarketCap \"2000000000\" + maxMarketCap \"10000000000\", \"small cap\" = minMarketCap \"300000000\" + maxMarketCap \"2000000000\", \"micro cap\" = maxMarketCap \"300000000\"\n- \"penny stocks\" = maxPrice \"5\", \"profitable\" = minEPS \"0.01\", \"gainers\"/\"rising\" = minChangeP \"1\", \"losers\"/\"falling\" = maxChangeP \"-1\"\n- \"cheap\" or \"undervalued\" = maxPE \"15\", \"high growth\" = minChangeP \"2\"\n- sortBy options: market_capitalization, refund_1d_p (daily change %), earnings_share (EPS), dividend_yield, avgvol_1d (volume), adjusted_close (price)\n- \"top gainers\" → sortBy \"refund_1d_p\" sortOrder \"desc\", \"biggest losers\" → sortBy \"refund_1d_p\" sortOrder \"asc\"\n- \"momentum\" / \"momentum stocks\" / \"strong movers\" → minChangeP \"3\" + sortBy \"refund_1d_p\" sortOrder \"desc\" (match the Momentum preset)\n- If user mentions \"high volume\" without a number, use minVolume \"5000000\"\n- \"52 week low\" / \"52-week low\" / \"near 52w low\" → no direct filter; sortBy \"adjusted_close\" sortOrder \"asc\" and note in description that user should look for stocks trading near their yearly low\n- \"52 week high\" / \"near 52w high\" / \"all-time high\" → sortBy \"refund_1d_p\" sortOrder \"desc\" and note in description\n- \"oversold\" → maxChangeP \"-3\", sortBy \"refund_1d_p\" sortOrder \"asc\"\n- \"overbought\" → minChangeP \"3\", sortBy \"refund_1d_p\" sortOrder \"desc\"\n- If the query mentions anything stock/market-related (even if no concrete filter fits — e.g. \"52 week low\", \"momentum stocks\", \"bluechips\"), ALWAYS return a valid filters object (use empty strings where no mapping exists) and describe your interpretation. Only return the error object when the query is completely unrelated to stocks/investing (e.g. \"what's the weather\").\n- Error response (only for truly off-topic queries): {\"error\": \"I can only help with stock screening queries. Try something like 'tech stocks with P/E under 20'.\"}\n- Return ONLY the JSON object. No markdown, no code fences, no explanation.";

  function parseScreenerQuery(query) {
    return chat(null, null, [
      { role: 'system', content: SCREENER_SYSTEM },
      { role: 'user', content: String(query || '') },
    ]).then(function (answer) {
      var text = String(answer || '').trim();
      // Models wrap JSON in fences however firmly you ask them not to.
      if (text.indexOf('```') === 0) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // chat() answers failures in prose, so this is also where a 503 or a
        // dead proxy arrives. Passing the sentence on beats "Unexpected token".
        throw new Error(text.length < 200 ? text : 'The model did not return filters.');
      }
      if (parsed.error) throw new Error(parsed.error);
      if (!parsed.filters) throw new Error('The model did not return filters.');
      return parsed;
    });
  }

  // ---- The portfolio builder ------------------------------------------
  //
  // The terminal builds on its server (one charge, the answer checked before
  // it is billed). Here the model is the developer's own, so the same prompt
  // goes out through chat() and the same checks run in the page: a name,
  // 3 to 12 distinct tickers with positive weights summing to about 100
  // (scaled to exactly 100), a risk of 1 to 5. The view draws the result as
  // a table, so anything that is not a portfolio has to come back as
  // { error }, never as the model's raw text.
  var BUILDER_SYSTEM = 'You build an illustrative investment portfolio from the user\'s description. '
    + 'Return ONLY valid JSON, no markdown: {"name": "<short name>", '
    + '"holdings": [{"ticker": "<code with exchange suffix, e.g. VOO.US>", "weight": <percent>}], '
    + '"risk": <1-5>, "returnRange": "<e.g. 6-9%>", "rationale": "<2-3 sentences>"}. '
    + 'Use 5 to 8 US-listed stocks or ETFs whose weights sum to 100. '
    + 'If the description is not about building a portfolio, return ONLY '
    + '{"error": "<one short sentence to the user saying what to describe>"}.';
  var BUILDER_TICKER = /^[A-Z0-9][A-Z0-9-]{0,14}(\.[A-Z]{1,8})?$/;

  function squash(value, limit) {
    return String(value == null ? '' : value).split(/\s+/).filter(Boolean).join(' ').slice(0, limit);
  }

  /** The model's answer as a portfolio, or null. */
  function builtPortfolio(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error) return null;
    var name = parsed.name;
    var rows = parsed.holdings;
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(rows)) return null;
    var holdings = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== 'object') return null;
      var t = String(r.ticker || '').trim().toUpperCase();
      if (t && t.indexOf('.') === -1) t += '.US';
      var w = typeof r.weight === 'number' ? r.weight : parseFloat(r.weight);
      if (!BUILDER_TICKER.test(t) || seen[t] || !(w > 0) || !isFinite(w)) return null;
      seen[t] = true;
      holdings.push({ ticker: t, weight: w });
    }
    if (holdings.length < 3 || holdings.length > 12) return null;
    var total = holdings.reduce(function (n, h) { return n + h.weight; }, 0);
    if (total < 95 || total > 105) return null;
    holdings.forEach(function (h) { h.weight = Math.round(h.weight * 1000 / total) / 10; });
    var risk = parseInt(parsed.risk, 10);
    if (!(risk >= 1 && risk <= 5)) return null;
    return {
      name: squash(name, 60), holdings: holdings, risk: risk,
      returnRange: squash(parsed.returnRange, 20), rationale: squash(parsed.rationale, 600),
    };
  }

  function buildPortfolio(description) {
    var d = String(description || '').trim().slice(0, 500);
    if (!d) return Promise.resolve({ error: 'Describe the portfolio you want built.' });
    return chat(null, null, [
      { role: 'system', content: BUILDER_SYSTEM },
      { role: 'user', content: d },
    ]).then(function (answer) {
      var text = String(answer || '').trim();
      if (text.indexOf('```') === 0) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      var parsed = null;
      try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      var portfolio = builtPortfolio(parsed);
      if (portfolio) return { portfolio: portfolio };
      var hint = parsed && typeof parsed === 'object' && typeof parsed.error === 'string' ? squash(parsed.error, 200) : '';
      return { error: (hint ? hint + ' ' : 'The AI answer was not a usable portfolio. ') + 'Try describing it differently.' };
    }, function (e) {
      return { error: (e && e.message) || 'AI is unavailable right now.' };
    });
  }

  window.AIService = {
    getSettings: getSettings,
    setAvailable: setAvailable,
    chat: chat,

    parseScreenerQuery: parseScreenerQuery,
    buildPortfolio: buildPortfolio,
    _builtPortfolio: builtPortfolio,

    // The terminal's token gate, which is what the name refers to. Here there
    // is no gate -- the developer pays their own provider directly -- so the
    // feature label is accepted and dropped and the messages go straight out.
    // Kept under this name because the call sites use it: what-if scenarios in
    // the portfolio tracker build their own prompt and call this.
    chatWithTokens: function (_feature, messages) {
      return chat(null, null, messages);
    },

    // Resolves with null when AI is off -- what the terminal does when the
    // auto-insights feature is switched off. A failure rejects like every
    // other feature here. It used to resolve null on any error, so the
    // tracker's AI card could only say "the model returned nothing" while
    // the provider's actual reason was thrown away; its caller has a catch
    // that shows that reason now.
    getQuickInsights: function (holdings, holdingsData) {
      if (!available) return Promise.resolve(null);
      return chat(null, null, [
        { role: 'system', content: 'You are a portfolio analyst. Provide 2-3 brief, actionable insights about the portfolio. Be concise - each insight should be 1-2 sentences max.' },
        { role: 'user', content: 'Analyze this portfolio and give me 2-3 quick insights:\n\n' + portfolioContext(holdings, holdingsData) },
      ]);
    },

    getDetailedAnalysis: function (holdings, holdingsData) {
      return chat(null, null, [
        { role: 'system', content: 'You are a senior portfolio analyst. Provide a comprehensive analysis covering:\n1. **Portfolio Health** - overall assessment\n2. **Concentration Risk** - is the portfolio too concentrated in any position or sector?\n3. **Diversification** - gaps in sector/geography/asset class coverage\n4. **Key Risks** - what could hurt this portfolio\n5. **Opportunities** - what could be improved\n\nBe specific and reference actual holdings. Use bold for key terms. Keep each section to 2-3 sentences.' },
        { role: 'user', content: 'Provide a detailed analysis of this portfolio:\n\n' + portfolioContext(holdings, holdingsData) },
      ]);
    },

    // The terminal's names for the two pieces of a portfolio question. The
    // tracker's chat reads them to size a question before it is sent; without
    // them it measured the question alone and missed the portfolio around it.
    portfolioQuestion: portfolioQuestion,
    buildPortfolioContext: portfolioContext,

    // The bounds the chat checks a question against before sending it, in
    // characters. Without them it used the terminal server's (8,000 a
    // message), and a large portfolio's question was stopped here although
    // this app's own server would pass it. The real bound is the server's
    // AI_BODY_LIMIT, 256 KB for the whole request: these leave room for the
    // JSON around the text and for two-byte letters.
    CHAT_LIMITS: { message: 60000, total: 120000 },

    analyzePortfolio: function (holdings, holdingsData, question) {
      return chat(null, null, [
        { role: 'system', content: 'You are a helpful financial assistant analyzing a user\'s investment portfolio. Be concise and actionable. Use data provided to give specific insights. Format responses with bullet points when listing items. Do not give specific buy/sell recommendations, but you can discuss general strategy.' },
        { role: 'user', content: portfolioQuestion(holdings, holdingsData, question) },
      ]);
    },

    analyzeNews: function (article, holdings) {
      var a = article || {};
      var ctx = 'Title: ' + text(a.title);
      if (a.content || a.description) ctx += '\n\nSummary: ' + text(a.content || a.description);
      if (a.source) ctx += '\nSource: ' + text(a.source);
      if (a.date) ctx += '\nDate: ' + text(a.date);
      if (a.symbols && a.symbols.length) ctx += '\nRelated tickers: ' + a.symbols.join(', ');
      if (a.tags && a.tags.length) ctx += '\nTags: ' + a.tags.join(', ');
      if (a.sentiment) ctx += '\nAPI sentiment: ' + JSON.stringify(a.sentiment);

      var symbols = (holdings || []).map(function (h) {
        return h.symbol ? h.symbol.split('.')[0] : null;
      }).filter(Boolean);

      return chat(null, null, [
        { role: 'system', content: 'You are a senior financial news analyst. Analyze the article summary and metadata provided. Start with a clear **Sentiment:** (Bullish/Bearish/Neutral) line. Then provide:\n1. **Key Impact** - who/what is affected and why\n2. **Market Implications** - short-term and potential long-term effects\n3. **Action Items** - what investors should watch for\nBe concise but insightful. Use bold for key terms.' },
        { role: 'user', content: 'Analyze this financial news:\n\n' + ctx + '\n\n'
          + (symbols.length ? 'My portfolio includes: ' + symbols.join(', ') + '. How might this news affect my holdings?' : '') },
      ]);
    },

    getRebalancingSuggestion: function (holdings, holdingsData, riskProfile, goals) {
      var profile = riskProfile || 'balanced';
      var aims = goals || 'not specified';
      return chat(null, null, [
        { role: 'system', content: 'You are a senior portfolio strategist specializing in portfolio optimization and rebalancing. The investor\'s risk profile is: ' + profile + '. Their investment goals: ' + aims + '.\n\nProvide a detailed rebalancing plan:\n1. **Current Assessment** — evaluate the current allocation against the stated risk profile\n2. **Target Allocation** — where the data gives a holding\'s target weight, measure the drift from it; otherwise suggest allocation percentages by asset class/sector and say they are a suggestion\n3. **Specific Actions** — list exact trades (reduce X by Y%, add Z) with reasoning\n4. **Risk Impact** — how the rebalanced portfolio better matches the risk profile\n5. **Timeline** — suggest whether to rebalance all at once or gradually\n6. **Tax Considerations** — positions at a loss could be harvested; purchase dates and holding periods are not given, so do not say whether a gain is short- or long-term\n\nBe specific with tickers, percentages, and amounts in the portfolio\'s currency (stated in the data) when possible. Use bold for key terms.' },
        { role: 'user', content: 'Rebalance my portfolio for a ' + profile + ' risk profile:\n\n'
          + portfolioContext(holdings, holdingsData)
          + '\n\nMy goals: ' + (goals || 'General wealth building') },
      ]);
    },

    whatMattersForMe: function (events, holdings, holdingsData) {
      return chat(null, null, [
        { role: 'system', content: 'You are a personal portfolio advisor. The user wants to know which upcoming events matter specifically for THEIR holdings. For each relevant event:\n1. Explain why it matters for their portfolio\n2. Quantify the potential impact if possible (e.g., dividend amount based on shares held)\n3. Suggest what to watch or do\n\nOnly discuss events that directly relate to the user\'s holdings. If none match, explain what economic events could indirectly affect their portfolio. Be specific and actionable. Use bold for tickers.' },
        { role: 'user', content: 'My portfolio:\n' + portfolioContext(holdings, holdingsData) + '\n\nUpcoming events:\n' + eventLines(events || []) + '\n\nWhich of these events matter for my specific holdings and why?' },
      ]);
    },

    getPersonalizedDigest: function (holdings, news) {
      var symbols = (holdings || []).map(function (h) {
        return h.symbol ? h.symbol.split('.')[0] : null;
      }).filter(Boolean);
      var list = (news || []).slice(0, 20).map(function (a, i) {
        var entry = (i + 1) + '. ' + text(a.title);
        if (a.content) entry += ' — ' + text(a.content, 100);
        if (a.symbols && a.symbols.length) entry += ' [' + a.symbols.slice(0, 3).join(', ') + ']';
        return entry;
      }).join('\n');
      return chat(null, null, [
        { role: 'system', content: 'You are a personal financial news curator. The user has specific holdings. Filter and analyze the news focusing ONLY on stories relevant to their portfolio. Format:\n\n**Your Holdings in the News**\nStories directly mentioning portfolio stocks.\n\n**Sector Watch**\nNews affecting sectors where the user has exposure.\n\n**Market Context**\nBroader market moves that could impact their portfolio.\n\n**Action Items**\nAnything requiring attention based on the news.\n\nIgnore irrelevant news. Be specific about which holdings are affected.' },
        { role: 'user', content: 'My holdings: ' + symbols.join(', ') + '\n\nToday\'s news:\n' + list + '\n\nWhat matters for MY portfolio?' },
      ]);
    },

    digestNews: function (articles) {
      return chat(null, null, newsDigestMessages(articles || []));
    },
    weekAheadBriefing: function (events) {
      return chat(null, null, weekAheadMessages(events || []));
    },
    getEarningsPreview: function (symbol, earnings, fundamentals) {
      return chat(null, null, earningsPreviewMessages(symbol, earnings || [], fundamentals));
    },
  };
})();
