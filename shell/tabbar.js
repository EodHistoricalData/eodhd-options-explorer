/**
 * Tab bars that say when there are more tabs than fit.
 *
 * The views draw their tab bars with the terminal's classes (.mi-tabbar; the
 * rules are in index.html): one row that scrolls sideways with no scrollbar,
 * as on a phone. On a desktop that hid the last tabs without a trace -- News
 * at 768 px showed most of Earnings and nothing of IPO or M&A, the calendar
 * at 390 px four of its seven -- and with a mouse only Shift and the wheel
 * reached them.
 *
 * So, for every such bar on the page, whichever view drew it:
 *  - the side that has more is named on the bar (data-mi-more="start end"),
 *    and the stylesheet fades that side out;
 *  - a plain turn of the wheel that begins over the bar scrolls it sideways
 *    until it reaches its end, and from there the page scrolls as before;
 *    one that was already moving the page goes on moving it;
 *  - Left and Right move the focus to the next tab, Home and End to the
 *    first and the last, on every bar alike;
 *  - the open tab is brought wholly into view, clear of the fade, when it
 *    is chosen -- a click, the arrow keys, Tab -- and when a bar appears
 *    with it out of sight; so is the tab in focus.
 *
 * The bars are React's, so nothing here adds or moves an element: one
 * attribute on the bar, and listeners on the document.
 */
(function () {
  if (typeof document === 'undefined' || !document.addEventListener) return;

  var BAR = 'mi-tabbar';
  var OPEN = '[aria-selected="true"], [aria-pressed="true"]';
  var MORE = 'data-mi-more';
  // The stylesheet's --mi-tab-fade: a chosen tab stops this far from the
  // edge, so it is never the one under the fade.
  var FADE = 28;

  function barOf(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return el && el.closest ? el.closest('.' + BAR) : null;
  }

  function room(bar) { return bar.scrollWidth - bar.clientWidth; }

  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }

  function frame(fn) {
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  }

  // Which sides have more tabs, in the attribute's words.
  function mark(bar) {
    var max = room(bar);
    var x = Math.abs(bar.scrollLeft);
    var words = [];
    if (max > 1) {
      if (x > 1) words.push('start');
      if (x < max - 1) words.push('end');
    }
    var now = words.join(' ');
    if (now) {
      if (bar.getAttribute(MORE) !== now) bar.setAttribute(MORE, now);
    } else if (bar.hasAttribute(MORE)) {
      bar.removeAttribute(MORE);
    }
  }

  // The bar scrolled just far enough that the tab is whole and clear of the
  // fade; at either end the bar stops there, and that side has no fade.
  function reveal(bar, tab, smooth) {
    var max = room(bar);
    if (max <= 1 || !tab || !tab.getBoundingClientRect) return;
    var b = bar.getBoundingClientRect();
    var t = tab.getBoundingClientRect();
    var x = bar.scrollLeft;
    var to = x;
    if (t.left < b.left + FADE) to = x - (b.left + FADE - t.left);
    else if (t.right > b.right - FADE) to = x + (t.right - (b.right - FADE));
    to = Math.max(0, Math.min(max, Math.round(to)));
    if (Math.abs(to - x) < 1) return;
    if (smooth && !reduced() && typeof bar.scrollTo === 'function') bar.scrollTo({ left: to, behavior: 'smooth' });
    else bar.scrollLeft = to;
    // The scroll events say the rest; a jump may arrive with none.
    settle(bar);
  }

  // Whether the open tab is wholly inside the bar.
  function inView(bar) {
    var tab = bar.querySelector(OPEN);
    if (!tab) return false;
    var b = bar.getBoundingClientRect();
    var t = tab.getBoundingClientRect();
    return t.left >= b.left - 1 && t.right <= b.right + 1;
  }
  var whole = typeof WeakMap === 'function' ? new WeakMap() : null;
  function settle(bar) {
    mark(bar);
    if (whole) whole.set(bar, inView(bar));
  }

  // The bars on the page, a live list; the ones already seen.
  var live = document.getElementsByClassName(BAR);
  var seen = [];
  // A bar that narrows -- the page's own scrollbar arriving with the data
  // the tab asked for -- keeps its open tab in view if it was.
  var sizes = typeof window.ResizeObserver === 'function'
    ? new window.ResizeObserver(function (entries) {
      entries.forEach(function (e) {
        var bar = e.target;
        if (whole && whole.get(bar) && !inView(bar)) reveal(bar, bar.querySelector(OPEN), false);
        settle(bar);
      });
    })
    : null;
  // A tab just chosen stays in view while the screen it opened is drawn. The
  // page's own scrollbar can go and come back with the new data: the bar
  // widens for a moment, the browser pulls a bar at its end back to fit,
  // and narrowed again it hid the edge of the tab just chosen. The tab in
  // focus first, so a Tab onward is not pulled back to the open one.
  var HOLD = 2000;
  var held = whole ? new WeakMap() : null;
  function choose(bar, tab) {
    if (held) held.set(bar, Date.now() + HOLD);
    reveal(bar, tab, true);
  }
  function letGo(bar) {
    if (held) held.delete(bar);
  }
  function keep(bar) {
    if (!held || !(held.get(bar) > Date.now())) return;
    var a = document.activeElement;
    reveal(bar, a && a !== bar && bar.contains(a) ? a : bar.querySelector(OPEN), true);
  }

  // The wheel gesture under way: the bar it began over (null: the page)
  // and when its last event came. A bar drawn again while the gesture is
  // under way hands it to whatever is under the pointer now.
  var GESTURE_GAP = 250;
  var gesture = null;
  function gestureOf(bar) {
    var now = Date.now();
    var going = gesture && now - gesture.last < GESTURE_GAP && !(gesture.bar && !gesture.bar.isConnected);
    if (going) gesture.last = now;
    else gesture = { bar: bar, last: now };
    return gesture.bar;
  }

  // The tabs of a bar the arrow keys move between: its buttons that can be
  // pressed and are drawn, in order.
  function tabsOf(bar) {
    var out = [];
    var all = bar.querySelectorAll('button, [role="tab"]');
    for (var i = 0; i < all.length; i++) {
      var t = all[i];
      if (barOf(t) !== bar || t.disabled || t.getAttribute('aria-disabled') === 'true') continue;
      if (t.closest && t.closest('[hidden]')) continue;
      out.push(t);
    }
    return out;
  }

  var chosen = [];
  var queued = false;

  function scan() {
    queued = false;
    seen = seen.filter(function (bar) {
      if (bar.isConnected) return true;
      if (sizes) sizes.unobserve(bar);
      return false;
    });
    for (var i = 0; i < live.length; i++) {
      var bar = live[i];
      if (seen.indexOf(bar) === -1) {
        seen.push(bar);
        if (sizes) sizes.observe(bar);
        settle(bar);
        // A bar drawn with its open tab out of sight (a saved choice, a
        // link) shows it at once.
        reveal(bar, bar.querySelector(OPEN), false);
      } else {
        keep(bar);
        settle(bar);
      }
    }
    var list = chosen;
    chosen = [];
    list.forEach(function (tab) {
      var bar = barOf(tab);
      if (bar && tab.isConnected) choose(bar, tab);
    });
  }

  function soon() {
    if (queued) return;
    queued = true;
    frame(scan);
  }

  function start() {
    // A bar's tabs added or renamed, a bar mounted, a tab opened. Read in
    // the next frame, once, however many changes came in this one.
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'attributes' && r.target.getAttribute(r.attributeName) === 'true' && barOf(r.target) && !r.target.classList.contains(BAR)) {
          chosen.push(r.target);
        }
      }
      soon();
    }).observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['aria-selected', 'aria-pressed'],
    });

    // Scrolling does not bubble; caught on the way down.
    document.addEventListener('scroll', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains(BAR)) settle(e.target);
    }, true);

    // Tab, or a click that focuses: the tab in focus is shown whole. A click
    // in Safari does not focus a button, so the click is read as well.
    document.addEventListener('focusin', function (e) {
      var bar = barOf(e.target);
      if (bar && e.target !== bar) reveal(bar, e.target, true);
    });
    document.addEventListener('click', function (e) {
      var bar = barOf(e.target);
      if (!bar) return;
      frame(function () { choose(bar, bar.querySelector(OPEN)); });
    }, true);
    // The reader taking the bar (a swipe, the scrollbar) ends the hold; a
    // click on a tab starts a new one.
    document.addEventListener('pointerdown', function (e) {
      var bar = barOf(e.target);
      if (bar) letGo(bar);
    }, true);

    // A mouse wheel turns vertically. Over a bar with more tabs it moves the
    // tabs; at the bar's end, or for a sideways gesture (a trackpad, Shift
    // and the wheel), the browser does what it always did.
    //
    // Only a turn that begins over the bar, though. Every turn over a bar
    // that could still scroll was taken, and so a page being scrolled
    // stopped dead when a bar slid under a pointer that had not moved: the
    // calendar at 390 px took seven notches and the News bar four, the bar
    // moving 210 px sideways and the open tab off its edge. A gesture -- the
    // notches of one spin, a trackpad's swipe and the momentum after it --
    // is the run of wheel events less than GESTURE_GAP apart, and it stays
    // with what it began over: the page, or one bar. After a pause the next
    // turn begins anew wherever the pointer is.
    document.addEventListener('wheel', function (e) {
      var bar = barOf(e.target);
      var over = gestureOf(bar);
      if (e.defaultPrevented || e.ctrlKey) return;
      if (!bar || over !== bar) return;
      letGo(bar);
      if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      var max = room(bar);
      if (max <= 1) return;
      var step = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? bar.clientWidth : 1);
      var x = bar.scrollLeft;
      if ((step < 0 && x <= 0) || (step > 0 && x >= max - 1)) return;
      e.preventDefault();
      bar.scrollLeft = Math.max(0, Math.min(max, x + step));
      settle(bar);
    }, { passive: false });

    // Left and Right: the next tab, round from either end; Home and End: the
    // first and the last. The focus moves and the tab is shown whole
    // (focusin, above); what the tab does is still Enter's or Space's. The
    // bars of toggles -- the heatmap's indexes, the calendar's event types,
    // the News categories -- had no keys of their own, so the arrows
    // scrolled the strip and the tab in focus went off its edge. The
    // tablists that move between tabs themselves (and choose them as they
    // go) have done so by the time the key gets here, and are left to it.
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      var bar = barOf(e.target);
      if (!bar || e.target === bar) return;
      var tabs = tabsOf(bar);
      var at = -1;
      for (var i = 0; i < tabs.length; i++) if (tabs[i] === e.target || tabs[i].contains(e.target)) at = i;
      if (at === -1) return;
      var n = tabs.length;
      var to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1
        : (at + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
      e.preventDefault();
      if (to === at) return;
      var next = tabs[to];
      try { next.focus({ preventScroll: true }); } catch (_) { next.focus(); }
    });

    // A web font arriving widens the labels without resizing the bar.
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', soon);
    window.addEventListener('resize', soon);
    soon();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
