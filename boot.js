/**
 * Generated. The app's identity -- used for link tags, the key screen and the
 * footer -- and the check that React loaded before anything reads it.
 */
window.APP_META = {
  "app": "options-explorer",
  "repo": "eodhd-options-explorer",
  "title": "EODHD Options Explorer",
  "description": "Options chain, Greeks, gamma exposure, IV surface and unusual activity — on your own EODHD key.",
  "keyNote": "The options chain needs the Options Data Feed, a paid add-on. On a key without it the app opens and says, in EODHD's own words, that the chain is not in your plan.",
  "storage": [
    "eodhd_oss_chain:"
  ]
};

if (!window.React || !window.ReactDOM) {
  var bootError = document.getElementById('boot-error');
  if (bootError) bootError.style.display = 'block';
  throw new Error('React did not load from unpkg.com, so the app cannot start. See the message on the page.');
}
