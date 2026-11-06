/**
 * A loader for views that do not load anything.
 *
 * Most of the vendored views fetch their own data, which is why mounting one
 * is enough. The heatmap does not: it takes its rows as a prop, along with a
 * `loading` flag and an `onLoadData` callback, because in the terminal the
 * parent owns that state and shares it with the dashboard. Lifted out on its
 * own, the view renders its whole chrome and then says "No data available"
 * next to a button that calls a function nobody passed it.
 *
 * So this stands in for that parent. It is declared per app rather than
 * written per app -- meta.json names the method and the prop, and nothing
 * app-specific ends up in the shell.
 */
(function () {
  window.AppFeed = function (props) {
    var method = props.method;
    var args = props.args || [];
    var as = props.as || 'data';
    // State the view expects its parent to hold. The heatmap fetches live
    // quotes itself and hands them up through onRtOverlayUpdate, then reads
    // them back from rtOverlay; with no parent holding that state the quotes
    // were fetched, handed to nobody and thrown away, so the tiles showed
    // yesterday's move and the Regular/Pre-Market switch changed only a
    // caption. Each entry is { value, setter, time?, meta? }.
    var lifted = props.lift || [];

    var dataState = React.useState(null);
    var loadingState = React.useState(false);
    var liftedState = React.useState({});
    var inFlight = React.useRef ? React.useRef(false) : { current: false };

    var load = React.useCallback(function () {
      var api = window.EODHD_API;
      if (!api || typeof api[method] !== 'function') return;
      // The view calls onLoadData when it has no rows, and the effect below
      // calls it on mount: without this guard the same screener request went
      // out twice, byte for byte, on every load.
      if (inFlight.current) return;
      inFlight.current = true;
      loadingState[1](true);
      Promise.resolve(api[method].apply(api, ['proxy'].concat(args)))
        .then(function (d) { dataState[1](d); })
        // The view is told to stop waiting either way. A spinner that never
        // ends is a worse answer than an empty state next to a Retry button.
        .finally(function () { inFlight.current = false; loadingState[1](false); });
    }, [method]);

    React.useEffect(function () { load(); }, [load]);

    var extra = { loading: loadingState[0], onLoadData: load, apiKey: 'proxy', theme: props.theme || 'dark' };
    // Passed through: what a clicked tile does. The heatmap's tiles and top
    // movers are buttons that call it, and without it they threw.
    if (props.onSelectAsset) extra.onSelectAsset = props.onSelectAsset;
    extra[as] = dataState[0];

    lifted.forEach(function (spec) {
      var held = liftedState[0][spec.value];
      extra[spec.value] = held && held.value;
      if (spec.time) extra[spec.time] = held && held.time;
      if (spec.meta) extra[spec.meta] = held && held.meta;
      extra[spec.setter] = function (value, meta) {
        liftedState[1](function (prev) {
          var next = {};
          for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
          next[spec.value] = { value: value, meta: meta, time: Date.now() };
          return next;
        });
      };
    });

    return React.createElement(props.view, extra);
  };
})();
