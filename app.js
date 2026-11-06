/**
 * Mounts OptionsExplorerView, but only once the local
 * server confirms a key is configured. Without one the key gate renders
 * instead and this never runs -- these apps show nothing at all without an
 * EODHD key, which is the point of them.
 */
function App() {
  // Dark by default, light on request, remembered in localStorage. The views
  // carry both themes; the switch is the frame's.
  var themeState = React.useState(window.AppFrame.savedTheme());
  var theme = themeState[0];
  var toggleTheme = function () {
    var next = theme === 'light' ? 'dark' : 'light';
    window.AppFrame.saveTheme(next);
    themeState[1](next);
  };
  // The views read the address once, when they mount, and write it back with
  // history.replaceState -- which fires no event. So a hashchange is somebody
  // else: an edited address bar, a link followed into this open tab. The view
  // is mounted afresh and reads the new address, instead of the screen
  // staying on AAPL while the bar says TSLA.
  var routeState = React.useState(0);
  React.useEffect(function () {
    var onHash = function () { routeState[1](function (n) { return n + 1; }); };
    window.addEventListener('hashchange', onHash);
    return function () { window.removeEventListener('hashchange', onHash); };
  }, []);
  return (
    // AppFrame watches every feed the view touches and puts the explanation
    // above the view when a refusal or a failed request arrives. The view
    // fetches its own data, so that answer only exists after the first render.
    React.createElement(window.AppFrame, {
      capability: 'options',
      otherFeaturesWork: true,
      hasAIFeatures: true,
      // What still works when one of the app's secondary feeds is refused.
      refusalNotes: {},
      silentRefusals: ["eod"],
      // The view's own inner padding, so the shell's panels line up with its
      // heading instead of sitting a step to the left of it.
      contentInset: 0,
      theme: theme,
      onToggleTheme: toggleTheme,
    },
      React.createElement(React.Fragment, { key: routeState[0] },
      React.createElement(window.OptionsExplorerView, { apiKey: 'proxy', theme: theme, onSelectAsset: window.EODHDLinks.openAsset })
      )
    )
  );
}

// Whether the first screen waits for the key's plan (meta.json askPlan).
window.EODHD_ASK_PLAN = false;

// Whether React arrived is decided in boot.js, the first file of the bundle;
// nothing reaches this line without it.
window.KeyGate.guard(function () {
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
});
