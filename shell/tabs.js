/**
 * A tab strip, for the apps that pair two views.
 *
 * The first attempt stacked them. It looked reasonable in the generator and
 * was wrong in the browser: each of these views is designed as a whole page,
 * with its own header and its own idea of the top of the screen, so two of
 * them in one document collide -- one header printed over another and a "No
 * News Available" bleeding up through the sentiment gauge.
 *
 * So they take turns. Only the visible one is rendered, which also means the
 * hidden one is not quietly fetching in the background and spending somebody's
 * daily allowance on a screen they are not looking at.
 *
 * The strip scrolls sideways rather than being clipped: the page column hides
 * horizontal overflow, and a strip that did not scroll on its own lost its
 * last tabs on a phone. It is announced as a tablist, so a
 * screen reader hears "tab, 1 of 2, selected" rather than two buttons.
 */
(function () {
  window.AppTabs = function (props) {
    var tabs = props.tabs || [];
    var state = React.useState(0);
    var active = state[0];
    var setActive = state[1];
    var C = window.C3 || {};
    var light = props.theme === 'light';

    if (tabs.length < 2) return tabs.length ? tabs[0].render() : null;

    // The tablist pattern in full: the panel is labelled by its tab, only the
    // selected tab is in the Tab order, and the arrow keys (plus Home and End)
    // move between tabs. It had the roles and none of the behaviour.
    var ids = tabs.map(function (tab, i) { return 'app-tab-' + i; });
    var focusTab = function (i) {
      setActive(i);
      if (typeof document !== 'undefined') {
        var el = document.getElementById(ids[i]);
        if (el && el.focus) el.focus();
      }
    };
    var onKeyDown = function (e) {
      var n = tabs.length;
      var next = null;
      if (e.key === 'ArrowRight') next = (active + 1) % n;
      else if (e.key === 'ArrowLeft') next = (active - 1 + n) % n;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = n - 1;
      if (next === null) return;
      e.preventDefault();
      focusTab(next);
    };

    var strip = {
      display: 'flex', gap: 6, marginBottom: 20,
      flexWrap: 'nowrap', overflowX: 'auto',
      borderBottom: '1px solid ' + (light ? '#e2e4e9' : (C.glassDark ? C.glassDark.border.split(' ').pop() : '#2B2820')),
      paddingBottom: 0,
    };

    return React.createElement('div', null,
      React.createElement('div', { style: strip, role: 'tablist', onKeyDown: onKeyDown },
        tabs.map(function (tab, i) {
          var on = i === active;
          return React.createElement('button', {
            key: tab.label,
            id: ids[i],
            role: 'tab',
            'aria-selected': on,
            'aria-controls': 'app-tabpanel',
            tabIndex: on ? 0 : -1,
            onClick: function () { setActive(i); },
            style: {
              padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
              fontFamily: "'Sora', system-ui, sans-serif", fontSize: 13,
              fontWeight: on ? 700 : 500,
              color: on
                ? (light ? (C.textLightTheme || '#1e1b4b') : (C.textDark || '#E9E6DF'))
                : (light ? (C.textMutedLight || '#4b5563') : (C.textMutedDark || '#A39B89')),
              borderBottom: '2px solid ' + (on ? (C.glowOrange || '#f97316') : 'transparent'),
              marginBottom: -1,
            },
          }, tab.label);
        })
      ),
      // Only the active one. Rendering both and hiding one would leave the
      // hidden view fetching against the visitor's key for nothing.
      React.createElement('div', { id: 'app-tabpanel', role: 'tabpanel', 'aria-labelledby': ids[active] },
        tabs[active].render())
    );
  };
})();
