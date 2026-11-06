/**
 * Every link out of the app, built in one place.
 *
 * Two reasons for a file this small. The links that existed -- register,
 * pricing, the key settings page -- went out bare, so a visit from one of
 * these apps was indistinguishable from somebody typing the address.
 * And the views were written for a host that opens a symbol's own page when a
 * row is clicked; standalone nothing did, and the click threw
 * "onSelectAsset is not a function" out of a button.
 *
 * The campaign is the app's name, which boot.js sets before anything else
 * runs. Nothing here is sent anywhere by this code: the tags ride on links the
 * reader chooses to follow.
 */
(function () {
  var BASE = 'https://eodhd.com';

  function campaign() {
    return (window.APP_META && window.APP_META.app) || 'app';
  }

  /** https://eodhd.com<path> with the UTM tags; `content` says which link. */
  function url(path, content) {
    var p = String(path || '/');
    if (p.charAt(0) !== '/') p = '/' + p;
    var sep = p.indexOf('?') === -1 ? '?' : '&';
    return BASE + p + sep
      + 'utm_source=eodhd_oss&utm_medium=app&utm_campaign=' + encodeURIComponent(campaign())
      + (content ? '&utm_content=' + encodeURIComponent(content) : '');
  }

  /**
   * A symbol's page on eodhd.com. CODE.EXCHANGE, with .US added to a bare
   * ticker the way the API's own rule has it.
   */
  function assetUrl(symbol) {
    var s = String(symbol || '').trim().toUpperCase();
    if (!s) return url('/', 'asset');
    if (s.indexOf('.') === -1) s += '.US';
    return url('/financial-summary/' + encodeURIComponent(s), 'asset');
  }

  /**
   * The eodhd.com path a symbol should open, from the local server, which
   * checks the page is there (server/proxy.js, pageFor). The symbol's own
   * summary when it exists, else its exchange's page, else the list of
   * exchanges -- never a 404.
   */
  function pageFor(symbol) {
    var fallback = '/list-of-stock-markets';
    if (typeof fetch !== 'function') return Promise.resolve(fallback);
    return fetch('/api/_asset-page?symbol=' + encodeURIComponent(symbol))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        var p = body && typeof body.path === 'string' ? body.path : '';
        // A path on eodhd.com and nothing else: url() puts it after the host.
        return /^\/[A-Za-z0-9._\-/]*$/.test(p) && p.indexOf('//') === -1 ? p : fallback;
      })
      .catch(function () { return fallback; });
  }

  /**
   * What a view's onSelectAsset does here: the symbol's page on eodhd.com, in
   * a new tab. In the terminal the same callback opens the asset screen; this
   * app is one screen, and a new tab keeps it where the reader left it.
   *
   * The tab is opened at once and pointed at the page when the server has
   * said which one. Opened only after the answer, it would no longer count
   * as the click's doing and a popup blocker would eat it. It used to go
   * straight to /financial-summary/<SYMBOL>, which is a 404 for every LSE,
   * HK, NSE, TSE and .INDX symbol.
   */
  function openAsset(asset) {
    var symbol = asset && (asset.symbol || asset.code || asset);
    if (!symbol || typeof window.open !== 'function') return;
    var s = String(symbol).trim().toUpperCase();
    if (s.indexOf('.') === -1) s += '.US';
    // No 'noopener' in the features: with it, open() returns null and there
    // is no tab to point anywhere. The opener is cut by hand straight after,
    // which is the same protection, and the document's no-referrer policy
    // still applies to the navigation.
    var tab = window.open('', '_blank');
    if (!tab) return;
    try { tab.opener = null; } catch (e) { /* already cut */ }
    try {
      tab.document.title = s;
      tab.document.body.textContent = 'Opening ' + s + ' on eodhd.com…';
    } catch (e) { /* a placeholder, nothing more */ }
    pageFor(s).then(function (p) {
      try { tab.location.href = url(p, 'asset'); } catch (e) { /* closed meanwhile */ }
    });
  }

  window.EODHDLinks = {
    url: url,
    assetUrl: assetUrl,
    pageFor: pageFor,
    openAsset: openAsset,
    // The fill behind white text on the shell's own buttons. The brand
    // orange (#f97316) gives white text 2.8:1, below what a 13px label needs;
    // this darker step of the same orange gives 5.2:1.
    CTA_BG: '#c2410c',
  };
})();
