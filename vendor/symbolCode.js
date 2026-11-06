// The one reader of a typed or linked code: the EODHD symbol it names, with
// its exchange.
//
// Every screen had its own. What-If and Backtest read "SOL-NZD" as
// SOL-NZD.US and "^GSPC" as ^GSPC.US, while the Sentiment link read them as
// SOL-NZD.CC and GSPC.INDX; the link dropped "^GSPC.INDX" and "BRK.B" with
// no word, and What-If kept "BRK.B" as a ticker on an exchange called B.
// Pure, no React: loaded by the
// terminal and vendored by every open app that reads a code (portfolio
// tracker, news sentiment, index constituents, options explorer).
//
//   SymbolCode.read(raw, { held, rows })
//     -> { symbol: 'BRK-B.US' } or { symbol: null, reason: 'empty' | 'junk' }
//   SymbolCode.of(raw, opts)      -> the symbol, or null
//   SymbolCode.problem(read, raw) -> the sentence for a null, or null
//   SymbolCode.index(raw)         -> { code: 'GSPC.INDX' } | { foreign: 'GSPC.US', base: 'GSPC' } | { code: null, junk? }
//   SymbolCode.fromRow(row)       -> a search row's symbol ('IBM' on NYSE -> IBM.US)
//   SymbolCode.bestRow(rows, q)   -> the search row Enter takes for typed text, or null
//   SymbolCode.typedListing(q)    -> the symbol of text typed with its exchange or ^, or null
//   SymbolCode.parse(q)           -> what typed text is, and the text to search for
//   SymbolCode.searchText(q)      -> the text a picker sends to the search ("VOD.L" -> "VOD")
//   SymbolCode.resolve(q, opts)   -> Promise: Enter's answer, a listing or a sentence
//   SymbolCode.listed(sym, api)   -> Promise: whether a listing exists (the search, else its quote)
//   SymbolCode.searched(sym)      -> true when the search alone says whether sym exists
//   SymbolCode.unlisted(sym)      -> true for a market EODHD does not list ("D05.SI")
//   SymbolCode.strip(raw)         -> the text without invisible characters, NBSP as a space
//   SymbolCode.apiFor(api, key)   -> the search / quote / limit calls resolve() makes
//
// A code with no exchange is, in this order: the held listing with that code
// (`held`); the listing the search returned for exactly that code (`rows`);
// a crypto pair on CC (BTC-USD, SOL-NZD, ETH-BTC); a currency or metal pair
// on FOREX (EURUSD, XAUUSD, USDXAU); else the US listing.
(function () {
  // Currencies EODHD quotes on FOREX.
  const FIAT = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'CNH', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK', 'PLN',
    'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'ISK', 'TRY', 'ZAR', 'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'INR', 'KRW', 'RUB', 'UAH',
    'KZT', 'ILS', 'THB', 'IDR', 'MYR', 'PHP', 'TWD', 'VND', 'PKR', 'BDT', 'LKR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD',
    'EGP', 'MAD', 'NGN', 'KES', 'GHS',
    // The rest of ISO 4217 that EODHD quotes against USD/EUR (USDCRC, USDUYU, USDXAF read as US shares).
    'CRC', 'UYU', 'BOB', 'PYG', 'DOP', 'GTQ', 'HNL', 'NIO', 'JMD', 'TTD', 'BBD', 'BSD', 'BZD', 'XCD', 'AWG', 'ANG',
    'XAF', 'XOF', 'XPF', 'BYN', 'GEL', 'AMD', 'AZN', 'UZS', 'KGS', 'TJS', 'TMT', 'MNT', 'KHR', 'LAK', 'MMK', 'NPR',
    'MUR', 'MVR', 'SCR', 'TZS', 'UGX', 'RWF', 'ZMW', 'BWP', 'NAD', 'SZL', 'LSL', 'MWK', 'MZN', 'AOA', 'ETB', 'DZD',
    'TND', 'LYD', 'LBP', 'IQD', 'IRR', 'SYP', 'YER', 'AFN', 'RSD', 'MKD', 'ALL', 'BAM', 'MDL', 'FJD', 'PGK', 'BND',
    'MOP', 'XDR',
    // On 26.10: CDFUSD, EURKYD, GBPBMD read as US shares.
    'CDF', 'KYD', 'BMD', 'SOS', 'SDG', 'GNF', 'HTG', 'ERN', 'LRD', 'SLE', 'SLL', 'GMD', 'CVE', 'KMF', 'MGA', 'DJF',
    'BIF', 'SSP', 'ZWL', 'VES', 'VUV', 'WST', 'TOP', 'SBD', 'STN', 'SRD', 'GYD', 'FKP', 'GIP', 'SHP', 'CUP', 'BTN'];
  // Metals EODHD lists as FOREX pairs, either way round (XAUUSD, USDXAU).
  const METALS = ['XAU', 'XAG', 'XPT', 'XPD'];
  // What a crypto pair on CC is quoted against: any fiat, the stablecoins,
  // and the coins pairs are struck in.
  // A side that is neither is read as a share class (BRK-B, BAC-PL), so the
  // coins pairs are struck in are listed (BTC-SOL, ETH-DOGE).
  const CRYPTO_QUOTE = FIAT.concat(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'USDD', 'DAI', 'PYUSD', 'BTC', 'ETH', 'BNB',
    'SOL', 'XRP', 'ADA', 'DOGE', 'DOT', 'TRX', 'LTC', 'AVAX', 'MATIC', 'LINK', 'XLM', 'XMR', 'EURT', 'EURC']);
  // EODHD's names for American venues: all filed under .US.
  const US_VENUES = ['US', 'NYSE', 'NASDAQ', 'AMEX', 'BATS', 'ARCA', 'NYSE ARCA', 'NYSEARCA', 'NYSE MKT', 'CBOE', 'OTC', 'OTCQB', 'OTCQX', 'PINK', 'OTCMKTS'];
  // EODHD exchange codes of one letter. Every other one-letter tail is a
  // share class: BRK.B is BRK-B.US, while ABC.V (TSX Venture) and SAP.F
  // (Frankfurt) are listings.
  const ONE_LETTER_EXCHANGES = ['V', 'F'];
  // EODHD's exchange codes. A typed "X.SUFFIX" names a listing only when
  // SUFFIX is one of them (or a share class, below); "VOD.L", "7203.T" and
  // "SAP.DE" are Yahoo's codes and saved VOD-L.US, 7203-T.US and SAP.DE,
  // listings that do not exist.
  const EXCHANGES = US_VENUES.concat(['LSE', 'IL', 'TO', 'V', 'NEO', 'CN', 'XETRA', 'F', 'BE', 'DU', 'HM', 'HA', 'MU', 'STU',
    'LU', 'VI', 'PA', 'BR', 'MC', 'MI', 'SW', 'LS', 'AS', 'IR', 'HE', 'OL', 'CO', 'ST', 'IC', 'TA', 'AT', 'PR', 'BUD', 'WAR',
    // No SG: EODHD's exchanges-list has no Singapore, and Yahoo's
    // ".SG" is Stuttgart (YAHOO, below).
    'RO', 'ZSE', 'IS', 'KO', 'KQ', 'TSE', 'HK', 'SHG', 'SHE', 'TW', 'TWO', 'NSE', 'BSE', 'KAR', 'CM', 'JK', 'KLSE',
    'BK', 'PSE', 'VN', 'AU', 'NZ', 'SR', 'JSE', 'EGX', 'XNAI', 'XNSA', 'BRVM', 'GSE', 'XBOT', 'USE', 'DSE', 'RSE', 'MSE',
    'LUSE', 'VFEX', 'XZIM', 'SEM', 'SA', 'MX', 'BA', 'SN', 'LIM',
    'INDX', 'CC', 'FOREX', 'MONEY', 'GBOND', 'EUFUND', 'COMM', 'BOND', 'EUBOND']);
  // Yahoo's suffixes that are no EODHD code, and the EODHD exchange each
  // means: "VOD.L" is VOD.LSE, "7203.T" 7203.TSE, "SAP.DE" SAP.XETRA. "L" and
  // "T" are no share class. Each checked on 02.11 against EODHD's
  // exchanges-list and EXCHANGES above; the suffixes Yahoo shares with EODHD
  // (PA, AS, MI, SW, TO, V, HK, F, MC, ST, ...) are EODHD codes already. Read
  // as a share class, "VOD.L" was VOD-L.US and What-If added it. ".SG" is Stuttgart (EODHD STU) and ".CA" Cairo (EODHD EGX):
  // the list has STU and EGX and neither SG nor CA.
  // No target is itself a key: reading a code twice gives the same code. The
  // map had SI: 'SG' beside SG: 'STU', so "D05.SI" (Singapore) became D05.SG
  // and, read again after a reload, D05.STU -- Stuttgart.
  const YAHOO = { L: 'LSE', T: 'TSE', DE: 'XETRA', AX: 'AU', NS: 'NSE', BO: 'BSE', KS: 'KO', SS: 'SHG', SZ: 'SHE',
    WA: 'WAR', JO: 'JSE', KL: 'KLSE', BD: 'BUD', NE: 'NEO', SG: 'STU', CA: 'EGX' };
  // Yahoo's suffixes for markets EODHD has no exchange code for: the code
  // stays as written and names no listing EODHD has. Singapore: EODHD's
  // exchanges-list has none, and search/D05 and search/D05.SG answer [].
  const UNLISTED = { SI: 'Singapore' };
  // The exchanges whose every live listing the search lists, measured on
  // 03.11 (search with exchange=EX, and search/CODE.EX for a code known there):
  // for a code on one of them an empty search is the answer -- no listing --
  // and no price is asked. real-time and eod answer 404 for a code that does
  // not exist, and the browser logs every 404 as an error: 7203.T in What-If
  // asked real-time/7203.TSE, Import CSV eod/FOO.LSE.
  // Not here, so asked by their quote, which answers "NA" (200) for a code
  // it does not know: listings the search does not carry -- HK (0700.HK
  // quotes), EGX (COMI.EGX), JSE, MI, IS, BSE, SR, CM, the African
  // exchanges, LIM, INDX, GBOND, MONEY, COMM, BOND.
  const SEARCHED = ['US', 'LSE', 'IL', 'TO', 'V', 'NEO', 'XETRA', 'F', 'BE', 'DU', 'HM', 'HA', 'MU', 'STU', 'LU', 'VI', 'PA',
    'BR', 'MC', 'SW', 'LS', 'AS', 'IR', 'HE', 'OL', 'CO', 'ST', 'IC', 'TA', 'AT', 'PR', 'BUD', 'WAR', 'RO', 'ZSE', 'KO', 'KQ',
    'SHG', 'SHE', 'TW', 'TWO', 'NSE', 'KAR', 'JK', 'KLSE', 'BK', 'PSE', 'VN', 'AU', 'SA', 'MX', 'BA', 'SN', 'CC', 'FOREX',
    'EUFUND'];
  // The exchanges EODHD has no prices for at all: TSE and NZ. The
  // search lists nothing on them (search/7203.TSE answers []) and real-time
  // answers 404 for every code (7203.TSE, AIR.NZ). So, as for Singapore
  // (UNLISTED), nothing is asked for a code on them -- no search, no price,
  // no history -- and the answer is "No listing found": 7203.T and AIR.NZ
  // still sent search/7203.TSE, as one of SEARCHED. A listing on them found some other way is not priced either.
  const NO_PRICES = ['TSE', 'NZ'];

  // A code is letters and digits, with the joiners EODHD's own codes use:
  // "-" (BRK-B, BAJAJ-AUTO.NSE), "&" (M&M.NSE, J&KBANK.NSE) and "_". The
  // pattern without "&" turned the NSE's M&M away in Sentiment, What-If and
  // Backtest, which took it before 26.10. A joiner is never first, last or
  // doubled.
  const CODE = /^[A-Z0-9](?:[A-Z0-9&_-]{0,19})$/;
  const SUFFIX = /^[A-Z][A-Z0-9]{0,9}$/;

  // What a copy from a web page brings along and shows as nothing: the
  // zero-width space and joiners, the word joiner, the byte-order mark, the
  // soft hyphen and the other format characters (bidi marks). A no-break
  // space is a space. "TSLA" with a U+200B read as a code nobody lists, with
  // TSLA Tesla Inc in the list under the field.
  const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;
  const strip = (raw) => String(raw == null ? '' : raw).replace(INVISIBLE, '').replace(/[\u00A0\u2007\u202F]/g, ' ');
  const clean = (raw) => strip(raw).trim().toUpperCase()
    // The index mark as a link writes it: "%5EGSPC" is ^GSPC.
    .replace(/^%5E/, '^')
    // Spaces around a separator are typing, not part of the code.
    .replace(/\s*([.\-^&_])\s*/g, '$1');
  const codeOk = (c) => CODE.test(c) && !/[-&_]{2}|[-&_]$/.test(c);

  // A bare code that is a pair: 'CC', 'FOREX' or null.
  function pairVenue(code) {
    const s = String(code || '').trim().toUpperCase();
    // The base may carry hyphens of its own (ONTOLOGY-GAS-USD, YF-DAI-USD); the quote is the last part.
    const m = /^([A-Z0-9][A-Z0-9-]{0,24})-([A-Z]{3,5})$/.exec(s);
    if (m && CRYPTO_QUOTE.indexOf(m[2]) !== -1) return 'CC';
    if (/^[A-Z]{6}$/.test(s)) {
      const a = s.slice(0, 3);
      const b = s.slice(3);
      const fiat = (c) => FIAT.indexOf(c) !== -1;
      const metal = (c) => METALS.indexOf(c) !== -1;
      // Two different sides, each a currency or a metal, at least one a
      // currency: EUREUR and XAUXAG are no pair.
      if (a !== b && (fiat(a) || metal(a)) && (fiat(b) || metal(b)) && (fiat(a) || fiat(b))) return 'FOREX';
    }
    return null;
  }

  function venueOf(exchange) {
    const ex = String(exchange || '').trim().toUpperCase();
    if (!ex) return '';
    return US_VENUES.indexOf(ex) !== -1 ? 'US' : ex.replace(/\s+/g, '');
  }

  // A search row's symbol: its code and its exchange, American venues as US.
  // Read like typed text, so a row's "BRK.B" is BRK-B.US as typed BRK.B is,
  // and a row with junk for a code names nothing.
  function fromRow(row) {
    if (!row) return null;
    const code = clean(row.Code);
    const ex = venueOf(row.Exchange);
    if (!code || !ex) return null;
    return read(code + '.' + ex).symbol;
  }

  function read(raw, opts) {
    const o = opts || {};
    let s = clean(raw);
    if (!s) return { symbol: null, reason: 'empty' };
    // A caret is the index mark people type: "^GSPC" and "^GSPC.INDX" are
    // GSPC.INDX. One of it, in front, and only with no exchange or INDX.
    let index = false;
    if (s.charAt(0) === '^') { index = true; s = s.slice(1); }
    if (/[\^\s]/.test(s) || !s) return { symbol: null, reason: 'junk' };
    const dot = s.lastIndexOf('.');
    let code = dot === -1 ? s : s.slice(0, dot);
    let suffix = dot === -1 ? '' : s.slice(dot + 1);
    if (dot !== -1 && !suffix) return { symbol: null, reason: 'junk' };
    // Yahoo's suffix is the EODHD exchange it means (YAHOO, above).
    if (suffix && YAHOO[suffix]) suffix = YAHOO[suffix];
    // A one-letter tail that is no exchange is a share class.
    if (suffix.length === 1 && /[A-Z]/.test(suffix) && ONE_LETTER_EXCHANGES.indexOf(suffix) === -1) { code = code + '-' + suffix; suffix = ''; }
    // ... and so is one inside the code: "BRK.B.US" is BRK-B.US.
    code = code.replace(/\.([A-Z])(?=$)/, '-$1');
    if (!codeOk(code)) return { symbol: null, reason: 'junk' };
    if (suffix && !SUFFIX.test(suffix)) return { symbol: null, reason: 'junk' };
    if (index) {
      if (suffix && suffix !== 'INDX') return { symbol: null, reason: 'junk' };
      return { symbol: code + '.INDX' };
    }
    // A market EODHD does not list ("D05.SI"): the code as written, flagged,
    // never moved to an exchange it is not on.
    if (suffix && UNLISTED[suffix]) return { symbol: code + '.' + suffix, unlisted: true };
    if (suffix) return { symbol: code + '.' + venueOf(suffix) };
    // No exchange: the held listing, then the search's own row, then the pair
    // rules, then the US listing.
    const held = (o.held || []).map((h) => String(h || '').trim().toUpperCase()).filter(Boolean);
    if (held.indexOf(code + '.US') !== -1) return { symbol: code + '.US' };
    const same = held.filter((h) => h.slice(0, h.lastIndexOf('.') === -1 ? h.length : h.lastIndexOf('.')) === code);
    if (same.length === 1) return { symbol: same[0] };
    const rows = (o.rows || []).filter((r) => r && clean(r.Code) === code && venueOf(r.Exchange));
    // The US listing first among the rows, as the search ranks it otherwise.
    const row = rows.find((r) => venueOf(r.Exchange) === 'US') || rows[0];
    if (row) return { symbol: fromRow(row) };
    return { symbol: code + '.' + (pairVenue(code) || 'US') };
  }

  function of(raw, opts) { return read(raw, opts).symbol; }

  // What to say for a code that names nothing; null when it named something.
  function problem(result, raw) {
    if (!result || result.symbol) return null;
    if (result.reason === 'empty') return 'Enter a ticker, e.g. AAPL, BTC-USD or EURUSD.';
    const shown = strip(raw).trim().slice(0, 30);
    return '"' + shown + '" is not a ticker. Use the code with or without its exchange, e.g. AAPL, AAPL.US, BRK-B, BTC-USD.';
  }

  // An index code from a link or a card. No exchange or INDX: the index.
  // Another exchange ("GSPC.US") names a listing, not an index: told apart,
  // with the base code, so the page can open GSPC.INDX when the list has it
  // or say what is wrong (it asked comp/GSPC.US and read EODHD's 403 as "did
  // not answer").
  function index(raw) {
    let s = clean(raw);
    if (s.charAt(0) === '^') s = s.slice(1);
    if (!s) return { code: null };
    // Text that names no index is told apart from no text.
    if (/[\^\s]/.test(s) || s.length > 25) return { code: null, junk: true };
    const dot = s.lastIndexOf('.');
    const code = dot === -1 ? s : s.slice(0, dot);
    const suffix = dot === -1 ? '' : s.slice(dot + 1);
    if (!/^[A-Z0-9][A-Z0-9-]{0,24}$/.test(code) || /--|-$/.test(code) || (dot !== -1 && !SUFFIX.test(suffix))) return { code: null, junk: true };
    if (!suffix || suffix === 'INDX') return { code: code + '.INDX' };
    return { code: null, foreign: code + '.' + suffix, base: code };
  }

  // The search row Enter takes for what was typed. A code typed with its
  // exchange, class or index mark ("BRK.B", "^GSPC", "GSPC.INDX",
  // "SHEL.LSE") takes the row that is that listing, or none: the pickers cut
  // the text at its first dot and took the first row, so "BRK.B" added
  // BRK.TO and "^GSPC" GSPCX.US. A bare code takes
  // the row with that code, the US listing first; words take the first row
  // whose name holds them ("apple", "Apple Inc."). One word that is neither
  // a row's code nor in its name is a code nobody lists: none -- "AAPLE"
  // took APLE, Apple Hospitality REIT, the first row.
  // Several words with no row naming them: the search's first row.
  //   symbolOf(row) -> the row's symbol; by default the row's own `symbol`
  //   read here, else its Code and Exchange (fromRow).
  // A code with its exchange, class or "^": a dot or a caret and no space.
  // "Apple Inc." is a name, and keeps the name search's first row.
  const looksTyped = (q) => /[.^]/.test(q) && !/\s/.test(q);
  // What typed text with a dot or a caret is: { listing } (its symbol, null
  // for junk) when it names one outright -- the index mark, an EODHD
  // exchange, Yahoo's suffix for one ("VOD.L" is VOD.LSE), or a one-letter
  // share class on a US code (BRK.B) -- else { listing: null, unknown }: a
  // suffix that is no exchange ("FOO.ZZ"), or junk.
  function typedKind(q) {
    if (q.charAt(0) === '^') return { listing: of(q) };
    const dot = q.lastIndexOf('.');
    const code = q.slice(0, dot);
    const suffix = q.slice(dot + 1);
    if (UNLISTED[suffix]) { const rd = read(q); return { listing: rd.symbol, unlisted: !!rd.unlisted }; }
    if (EXCHANGES.indexOf(suffix) !== -1 || YAHOO[suffix] || /^[A-Z]$/.test(suffix)) return { listing: of(q) };
    if (!code || !suffix || !codeOk(code) || !SUFFIX.test(suffix)) return { listing: null };
    return { listing: null, unknown: true, code, suffix };
  }
  function bestRow(rows, query, symbolOf) {
    const list = (rows || []).filter(Boolean);
    const q = clean(query);
    if (!q || !list.length) return null;
    const sym = (r) => {
      try { return symbolOf ? of(symbolOf(r)) : (r.symbol ? of(r.symbol) : fromRow(r)); } catch (_) { return null; }
    };
    const base = (r) => { const x = sym(r) || ''; const d = x.lastIndexOf('.'); return d === -1 ? x : x.slice(0, d); };
    if (looksTyped(q)) {
      // The listing typed, or none. A row on another exchange is another
      // security: "FOO.L" with no FOO on LSE took FOO.PA, a fund in Paris,
      // and a suffix that is no exchange took the
      // first row outside the US.
      const t = typedKind(q);
      return t.listing ? (list.find((r) => sym(r) === t.listing) || null) : null;
    }
    const exact = list.filter((r) => base(r) === q);
    if (exact.length) return exact.find((r) => /\.US$/.test(sym(r) || '')) || exact[0];
    const words = q.split(/[^A-Z0-9&]+/).filter(Boolean);
    const named = (r) => {
      const name = clean(r.Name || r.name || '').split(/[^A-Z0-9&]+/).filter(Boolean);
      return words.length > 0 && words.every((w) => name.some((n) => n.indexOf(w) === 0));
    };
    return list.find(named) || (/\s/.test(q) ? list[0] : null);
  }

  // One edit apart (a letter dropped, added, changed, or two neighbours
  // swapped): the codes "Did you mean" offers.
  function oneSlip(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1) return false;
    if (a.length === b.length) {
      const d = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
      return d.length === 1 || (d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]]);
    }
    const [sh, lo] = a.length < b.length ? [a, b] : [b, a];
    for (let i = 0; i < lo.length; i++) if (lo.slice(0, i) + lo.slice(i + 1) === sh) return true;
    return false;
  }
  // "Did you mean AAPL (Apple Inc)?" from the rows the search answered, for
  // a code no row has: at most two, the last letter dropped first, then the
  // US listings, in the search's order. '' when none is one slip away.
  function didYouMean(rows, code) {
    const c = clean(code);
    const seen = {};
    const near = (rows || []).filter((r) => {
      const k = clean(r && (r.Code != null ? r.Code : String(r.symbol || '').split('.')[0]));
      if (!k || seen[k] || !oneSlip(c, k)) return false;
      seen[k] = true;
      return true;
    });
    const score = (r) => (clean(r.Code != null ? r.Code : String(r.symbol || '').split('.')[0]) === c.slice(0, -1) ? 2 : 0)
      + (/^(US|NYSE|NASDAQ|AMEX|BATS)$/.test(clean(r.Exchange || String(r.symbol || '').split('.')[1] || 'US')) ? 1 : 0);
    const best = near.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 2).map((x) => x.r);
    if (!best.length) return '';
    const say = (r) => {
      const k = clean(r.Code != null ? r.Code : String(r.symbol || '').split('.')[0]);
      const n = String(r.Name || r.name || '').trim();
      return n ? k + ' (' + n + ')' : k;
    };
    return ' Did you mean ' + best.map(say).join(' or ') + '?';
  }

  // Typed text that names one listing outright (an exchange, Yahoo's suffix
  // for one, a class or the index mark): its symbol, else null.
  function typedListing(query) {
    const q = clean(query);
    return looksTyped(q) ? (typedKind(q).listing || null) : null;
  }

  // What typed text is, before anything is asked:
  //   { kind: 'empty' } | { kind: 'junk' }
  //   { kind: 'index', symbol: 'GSPC.INDX' }          ^GSPC, %5EGSPC, GSPC.INDX
  //   { kind: 'listing', symbol: 'VOD.LSE' }          typed with its exchange
  //                                                   (EODHD's, Yahoo's) or class
  //   { kind: 'unknown', code, suffix }               a suffix that is no exchange
  //   { kind: 'code', code: 'AAPL' }                  a code with no exchange
  //   { kind: 'name' }                                words ("Apple Inc.")
  // `search` is the text to send to the search, '' for nothing to ask: the
  // code alone for Yahoo's suffix -- search/VOD.L and search/7203.T answer
  // nothing, search/VOD answers VOD.LSE -- else the
  // text as typed (search/VOD.LSE and search/BRK.B answer their rows).
  function parse(raw) {
    // What was typed, without what shows as nothing ("TSLA" + U+200B searched
    // for the invisible character too).
    const typed = strip(raw).trim();
    const q = clean(raw);
    if (!q) return { kind: 'empty', search: '' };
    if (/\s/.test(q)) return { kind: 'name', search: typed };
    if (looksTyped(q)) {
      const t = typedKind(q);
      if (t.listing) {
        const d = t.listing.lastIndexOf('.');
        const code = t.listing.slice(0, d);
        const exchange = t.listing.slice(d + 1);
        const suffix = q.slice(q.lastIndexOf('.') + 1);
        const yahoo = q.charAt(0) !== '^' && q.indexOf('.') !== -1 && !!(YAHOO[suffix] || UNLISTED[suffix]);
        // TSE and NZ (NO_PRICES): the search lists nothing there, so the code
        // alone, as for Yahoo's suffixes -- search/AIR.NZ was a request for
        // a listing the search never has.
        const priceless = NO_PRICES.indexOf(exchange) !== -1;
        const out = {
          kind: exchange === 'INDX' ? 'index' : 'listing', symbol: t.listing, code, exchange,
          search: yahoo || priceless ? code : (q.charAt(0) === '^' ? q : typed),
        };
        // On a market EODHD does not list: no listing, whatever is asked.
        if (t.unlisted) out.unlisted = true;
        return out;
      }
      if (t.unknown) return { kind: 'unknown', code: t.code, suffix: t.suffix, search: t.code };
      return { kind: 'junk', search: '' };
    }
    if (!codeOk(q)) return { kind: 'junk', search: '' };
    return { kind: 'code', code: q, search: typed };
  }
  function searchText(raw) {
    return parse(raw).search;
  }

  // The exchange of a symbol, as the search and the pickers name it.
  const exchangeOf = (symbol) => { const s = String(symbol || ''); const d = s.lastIndexOf('.'); return d === -1 ? '' : s.slice(d + 1).toUpperCase(); };
  // Whether a typed listing's existence is the search's to say (SEARCHED).
  const searched = (symbol) => SEARCHED.indexOf(venueOf(exchangeOf(symbol))) !== -1;
  // A symbol on a market EODHD does not list ("D05.SI").
  const unlisted = (symbol) => !!UNLISTED[exchangeOf(symbol)];
  // A symbol nothing can be priced for: an unlisted market, or an exchange
  // whose every quote is a 404 (NO_PRICES). Asking would only log errors.
  const unpriced = (symbol) => unlisted(symbol) || NO_PRICES.indexOf(exchangeOf(symbol)) !== -1;

  // Whether a listing exists: true, false (EODHD has no such listing),
  // 'limited' (the per-minute limit refused the check), or { failed: status }
  // (a 5xx, a refusal, no answer: nothing is known).
  // On an exchange the search covers (SEARCHED) the search for the full code
  // decides, by its row with that code and exchange: search/VOD.LSE answers
  // VOD's row, search/7203.TSE and search/FOO.LSE answer [] (200). Nothing
  // else is asked, so no 404 reaches the console. The
  // row it found is kept (listedRow) with its name and currency. Elsewhere
  // the quote decides, as before: a price or a last close is a listing, "NA"
  // or 404 is none. The free-text search is no witness: search/7203 answers
  // only 7203.KLSE. A market EODHD does not list is
  // none, asked of nobody. One request per listing: an answer is kept for
  // the page's life; a failure is not kept at all -- a 500 or a dropped
  // connection read "No listing found" for a minute, on every picker, for a
  // code that trades.
  // The calls must throw on a failure with its status (status,
  // upstreamStatus or statusCode), as apiFor's do; a null is no answer.
  const listedKept = new Map();
  const listedRows = new Map();
  const statusOf = (e) => (e && typeof e === 'object' ? (Number(e.upstreamStatus) || Number(e.status) || Number(e.statusCode) || 0) : 0);
  function listed(symbol, o) {
    const key = String(symbol || '').toUpperCase();
    const kept = listedKept.get(key);
    if (kept) return kept;
    if (unlisted(key)) { const none = Promise.resolve(false); listedKept.set(key, none); return none; }
    const left = () => (o && o.limited ? Number(o.limited()) || 0 : 0);
    if (left()) return Promise.resolve('limited');
    const failed = (e) => {
      const st = statusOf(e);
      if (st === 404) return false;
      listedKept.delete(key);
      if (st === 429 || (e && (e.rateLimited || e.name === 'EODHDRateLimitError')) || left()) return 'limited';
      // An answer that could not be read (a page of HTML with 200) says so:
      // with its 200 read as a status it was "EODHD answered 200".
      return e && e.unreadable ? { failed: st, unreadable: true } : { failed: st };
    };
    const bySearch = searched(key) && o && typeof o.search === 'function';
    // No search to ask, and its quote is a 404 whatever the code: none.
    if (!bySearch && unpriced(key)) { const none = Promise.resolve(false); listedKept.set(key, none); return none; }
    const value = bySearch
      ? Promise.resolve()
        .then(() => o.search(key))
        .then((rows) => {
          // No list is no answer (an error envelope sent with 200).
          if (!Array.isArray(rows)) { listedKept.delete(key); return left() ? 'limited' : { failed: 0 }; }
          const row = rows.find((r) => r && r.Code != null && fromRow(r) === key);
          if (!row) return false;
          listedRows.set(key, row);
          return true;
        }, failed)
      : Promise.resolve()
        .then(() => o.quote(key))
        .then((q) => {
          const n = (v) => { const x = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(x) && x > 0; };
          if (q && typeof q === 'object' && (n(q.close) || n(q.previousClose))) return true;
          // A quote that came back as an answer ("NA") is an answer.
          if (q && typeof q === 'object' && q.code) return false;
          listedKept.delete(key);
          return left() ? 'limited' : { failed: 0 };
        }, failed);
    listedKept.set(key, value);
    return value;
  }
  // The search's row for a listing listed() found by the search, or null.
  function listedRow(symbol) { return listedRows.get(String(symbol || '').toUpperCase()) || null; }
  // A search that answered, whoever asked it (the client calls this with
  // the rows as the search sent them). The search for a full code on an
  // exchange the search lists ("FOO.LSE") is listed()'s own check: its
  // answer is kept, so Enter after it decides without asking again. A
  // picker hands its own rows to resolve() -- [] for FOO.LSE -- and the
  // same metered search went out a second time.
  // Kept from the search's rows, not the screen's: Compare leaves out what
  // is compared, Add Position filters by type. Words, a bare code, a
  // failure or anything that is not a list say nothing.
  function noteSearch(text, rows) {
    if (!Array.isArray(rows)) return;
    const t = parse(text);
    if (t.kind !== 'listing' || t.unlisted || !t.symbol) return;
    const key = t.symbol;
    if (clean(t.search) !== key || !searched(key) || listedKept.has(key)) return;
    const row = rows.find((r) => r && r.Code != null && fromRow(r) === key);
    if (row) listedRows.set(key, row);
    listedKept.set(key, Promise.resolve(!!row));
  }

  // The sentence for each answer resolve() gives without a listing.
  function noneNote(raw) { return 'No listing found for ' + strip(raw).trim().slice(0, 30); }
  // The limit in RateLimitWait's words ("EODHD's per-minute request limit
  // was reached."), with the wait; the other failures in its words too
  // (RateLimitWait.failReason), with what to do. Kept here: this file is
  // vendored into apps that do not all ship rateLimitWait.js.
  function limitNote(left) {
    return "EODHD's per-minute request limit was reached." + (left ? ' Try again in ' + left + ' s.' : ' Try again in a minute.');
  }
  // `unreadable`: an answer came back that could not be read (RateLimitWait's
  // own words for it); its status (200) is no reason.
  function failReason(status, unreadable) {
    const s = Number(status) || 0;
    if (unreadable) return 'EODHD sent a response the app could not read.';
    return s === 401 ? 'EODHD did not accept the API key (401).'
      : (s === 402 || s === 403) ? 'it is not included in this plan (' + s + ').'
      : s >= 500 ? 'EODHD answered with an error (' + s + ').'
      : s ? 'EODHD answered ' + s + '.'
      : 'EODHD did not answer, or the connection dropped.';
  }
  const refusal = (s) => s === 401 || s === 402 || s === 403;
  function failNote(raw, status, unreadable) {
    const s = Number(status) || 0;
    return 'Could not check ' + strip(raw).trim().slice(0, 30) + ': ' + failReason(s, unreadable)
      + (refusal(s) && !unreadable ? '' : ' Try again.');
  }
  // What a picker says when its ticker search failed: never "no match" --
  // Compare, Alerts and Add Position read a 500 or a 429 as 'No asset
  // matches "MSFT"'. RateLimitWait's words ("... did not
  // load: <reason>"); the limit with its wait. err: what the search threw;
  // left: seconds of the per-minute wait (apiFor().limited()).
  function searchFailNote(err, left) {
    const s = statusOf(err);
    const w = Number(left) || 0;
    if (w || s === 429 || (err && (err.rateLimited || err.name === 'EODHDRateLimitError'))) {
      return "The ticker search did not load: EODHD's per-minute request limit was reached." + (w ? ' Try again in ' + w + ' s.' : ' Try again in a minute.');
    }
    const unreadable = !!(err && err.unreadable);
    return 'The ticker search did not load: ' + failReason(s, unreadable) + (refusal(s) && !unreadable ? '' : ' Try again.');
  }

  // Enter's answer for typed text, the same on every screen and in every
  // app. Resolves to
  //   { symbol, row }              a listing: the search's row, or a row made
  //                                from the symbol when the quote vouched
  //                                for it (row.checked)
  //   { symbol, index: true, row } an index; the screen says whether it takes one
  //   { symbol: null, reason, note }  reason: 'empty' | 'junk' | 'none' |
  //                                'limited' | 'failed' (ask again: nothing is known)
  // and never a listing nobody has: "ZZZQQ" was ZZZQQ.US, "VOD.L" VOD-L.US.
  // opts:
  //   rows      the search's answer for parse(raw).search, when the screen has it
  //   search    (text) -> Promise<rows>, asked when rows is not given
  //   quote     (symbol) -> Promise<quote|null>, the existence check
  //   limited   () -> seconds left of the per-minute wait, 0 when none
  //   held      symbols the portfolio holds: a code that names one is it
  function resolve(raw, opts) {
    const o = opts || {};
    const t = parse(raw);
    // A code no row has, with the codes one slip from it the rows list:
    // "AAPLE" offers AAPL and APLE, and takes neither.
    let answered = Array.isArray(o.rows) ? o.rows : null;
    const none = () => {
      const dym = t.kind === 'code' && answered ? didYouMean(answered, t.code) : '';
      return { symbol: null, reason: 'none', note: noneNote(raw) + (dym ? '.' + dym : '') };
    };
    const rowOf = (symbol, extra) => {
      const d = symbol.lastIndexOf('.');
      return Object.assign({ Code: symbol.slice(0, d), Exchange: symbol.slice(d + 1), Name: '' }, extra || {});
    };
    if (t.kind === 'empty' || t.kind === 'junk') {
      return Promise.resolve({ symbol: null, reason: t.kind, note: problem({ symbol: null, reason: t.kind }, raw) });
    }
    if (t.kind === 'index') return Promise.resolve({ symbol: t.symbol, index: true, row: rowOf(t.symbol) });
    // A held listing is one: "VOD" with VOD.LSE held, "AAPL" with AAPL.US.
    const held = (o.held || []).map((h) => String(h || '').trim().toUpperCase()).filter(Boolean);
    if (held.length && (t.kind === 'code' || t.kind === 'listing')) {
      const mine = of(raw, { held });
      const h = mine && (held.find((x) => x === mine) || held.find((x) => of(x) === mine));
      if (h) return Promise.resolve({ symbol: h, row: rowOf(h), held: true });
    }
    // A market EODHD does not list ("D05.SI"): none, nothing asked.
    if (t.unlisted) return Promise.resolve(none());
    const limitedNow = () => (o.limited ? Number(o.limited()) || 0 : 0);
    let searchFailed = 0;
    let searchUnreadable = false;
    const rowsP = Array.isArray(o.rows) ? Promise.resolve(o.rows)
      : (o.search && t.search ? Promise.resolve().then(() => o.search(t.search)).then((r) => (Array.isArray(r) ? r : []), (e) => { searchFailed = statusOf(e); searchUnreadable = !!(e && e.unreadable); return null; }) : Promise.resolve([]));
    return rowsP.then((rows) => {
      answered = rows;
      // A code takes the row with that code (the US listing first), never
      // the first row of the list: that is another security. Words take the
      // first row, as the search ranks them.
      // Rows as the search sends them ({ Code, Exchange }) or as a screen
      // keeps them ({ symbol }).
      const symOf = (r) => (!r ? null : r.Code != null ? fromRow(r) : (r.symbol ? of(r.symbol) : null));
      const baseOf = (s) => (s ? s.slice(0, s.lastIndexOf('.')) : '');
      const exact = t.kind === 'code' ? (rows || []).filter((r) => baseOf(symOf(r)) === t.code) : null;
      const row = exact ? (exact.find((r) => /\.US$/.test(symOf(r))) || exact[0] || null) : bestRow(rows || [], raw);
      const symbol = row && symOf(row);
      if (symbol) return { symbol, row };
      // The search that failed was for that very listing ("SHEL.LSE"): it is
      // the check, and asking it again at once only fails twice.
      if (rows == null && t.kind === 'listing' && clean(t.search) === t.symbol && searched(t.symbol)) {
        if (limitedNow() || searchFailed === 429) return { symbol: null, reason: 'limited', note: limitNote(limitedNow()) };
        return { symbol: null, reason: 'failed', note: failNote(raw, searchFailed, searchUnreadable) };
      }
      if (t.kind === 'unknown' || t.kind === 'name') {
        if (rows == null && (limitedNow() || searchFailed === 429)) return { symbol: null, reason: 'limited', note: limitNote(limitedNow()) };
        if (rows == null) return { symbol: null, reason: 'failed', note: failNote(raw, searchFailed, searchUnreadable) };
        return none();
      }
      // Typed with its exchange, or a code with none: the listing it names
      // (a pair on CC or FOREX, else the US one), if the search (or, where
      // the search lists nothing, its quote) says it is (listed).
      const want = t.kind === 'listing' ? t.symbol : of(t.code);
      if (!want || !(o.quote || (o.search && searched(want)))) return none();
      // The search just asked was for that very code ("FOO.LSE") and its
      // answer has no row for it: that is the answer, not asked twice.
      if (!Array.isArray(o.rows) && rows && clean(t.search) === want && searched(want)) return none();
      return listed(want, o).then((ok) => {
        // The search's own row, with its name and currency, when the search
        // vouched for it; else a row made from the symbol.
        if (ok === true) return { symbol: want, row: listedRow(want) || rowOf(want, { checked: true }) };
        if (ok === 'limited') return { symbol: null, reason: 'limited', note: limitNote(limitedNow()) };
        if (ok && ok.failed !== undefined) return { symbol: null, reason: 'failed', note: failNote(raw, ok.failed, ok.unreadable) };
        return none();
      });
    });
  }

  // The calls resolve() makes, through an app's client (window.EODHD_API in
  // the terminal and in every open app's shell).
  function apiFor(api, apiKey) {
    const A = api || {};
    return {
      search: (text) => A.searchStocks(apiKey, text, { throwErrors: true }),
      // throwErrors: a failure throws with its status, so a 404 (no such
      // code) is told from a 500 or a dropped connection (nothing known).
      quote: (symbol) => A.getRealTimeData(apiKey, symbol, { throwErrors: true }),
      limited: () => {
        let u = 0;
        try { u = typeof A.rateLimitedUntil === 'function' ? Number(A.rateLimitedUntil()) || 0 : 0; } catch (_) { u = 0; }
        const ms = u - Date.now();
        return ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 0;
      },
    };
  }

  // A picker's Enter with no row that is the text (useComboboxKeys's
  // `resolve`): { item } to pick, or { note } to say. o.indexNote(symbol):
  // the sentence for an index on a screen that takes none (What-If, Add
  // Position: "GSPC.INDX is an index ..."), null where one is taken. o.held:
  // the portfolio's symbols. o.refuse(result): a sentence when the screen
  // cannot take this listing (a currency it cannot tell), else null.
  // o.toItem(result): the screen's row for a listing (default: the search's
  // row, or one made from the symbol).
  // o.failed(query): true when the screen's search for this text failed --
  // its empty list is then no answer, and resolve() asks the search again.
  function forPicker(api, apiKey, o) {
    const opts = o || {};
    return (query, rows) => resolve(query, Object.assign(apiFor(api, apiKey), {
      rows: opts.failed && opts.failed(query) ? undefined : rows,
      held: opts.held,
    }))
      .then((res) => {
        if (!res.symbol) return { note: res.note };
        if (res.index && opts.indexNote) {
          const said = opts.indexNote(res.symbol);
          if (said) return { note: said };
        }
        const refused = opts.refuse ? opts.refuse(res) : null;
        if (refused) return { note: refused };
        return { item: opts.toItem ? opts.toItem(res) : res.row };
      });
  }

  // For tests: forget what the checks said.
  function forgetListed() { listedKept.clear(); listedRows.clear(); }

  window.SymbolCode = { read, of, problem, index, fromRow, bestRow, typedListing, parse, searchText, resolve, listed, listedRow, noteSearch, searched, unlisted, unpriced, strip, apiFor, forPicker, forgetListed, noneNote, limitNote, failNote, searchFailNote, didYouMean, pairVenue, venueOf, FIAT, METALS, CRYPTO_QUOTE, US_VENUES, ONE_LETTER_EXCHANGES, EXCHANGES, YAHOO, UNLISTED, SEARCHED, NO_PRICES };
})();
