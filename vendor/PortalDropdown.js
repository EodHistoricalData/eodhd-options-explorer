// PortalDropdown — replacement for native <select> on mobile.
//
// Why this exists:
// - Native <select> on Android Chrome / Telegram in-app browser opens an
//   OS-level picker whose position is OS-controlled and looks detached from
//   the trigger ("My Portfolio" floating mid-page over stat cards). CSS does
//   not influence it.
// - 13 sites in this app used native <select>. Some are inside transformed /
//   backdrop-filtered ancestors that already break position:fixed children.
// - We need one shared positioning primitive: trigger + portaled popup
//   anchored via getBoundingClientRect, viewport-aware for keyboard / pinch /
//   Telegram WebApp viewportChanged.
//
// API:
//   React.createElement(PortalDropdown, {
//     value, options, onChange,
//     isDark,
//     placeholder, minWidth, maxWidth, disabled,
//     style,            // extra style merged into trigger button
//     popupMaxHeight,   // default 280
//   })
//   options = [{ value, label }] or [{ value, label, sub, disabled }]
//
// Also exports PortalSearchPopup — for input-driven search dropdowns
// (alerts, backtester, optionsExplorer, etc.) that previously used
// position:absolute; top:100% inside a relative parent and got clipped /
// captured by glass / overflow ancestors.
//
//   React.createElement(PortalSearchPopup, {
//     anchorRef,        // ref to the input the popup anchors to
//     open, onClose,
//     children,         // raw popup content (e.g. result rows)
//     isDark,
//     maxHeight,        // default 240
//     id,               // optional popup DOM id (default auto-generated)
//   })

(function () {
  // Anchored popup positioning — ALWAYS BELOW trigger.
  //
  // We deliberately do NOT flip above when space below is short. Earlier
  // version did, and on the Backtester rules row (trigger sits low because
  // it's in a long form), the popup rendered upward and visually covered
  // the "Describe Strategy" textarea above — looked like it was "flying
  // out". The web's mental model for select-style controls is "options
  // hang below the trigger, like a native <select>". Keep that mental
  // model and let the popup shrink + scroll instead.
  //
  // If there's truly almost no room below (< MIN_BELOW), we ask the caller
  // to scrollIntoView() the trigger so the popup gets enough room. The
  // popup itself never flips above.
  const MIN_BELOW = 96;

  const computeAnchoredPos = (rect, popupWidth, requestedHeight, margin) => {
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const offsetTop = vv ? vv.offsetTop : 0;
    const offsetLeft = vv ? vv.offsetLeft : 0;

    // Never wider than the screen: the
    // notifications popup asks for 360 px, and on a 320-360 px phone the
    // left clamp below pinned it at 8 px while its right third ran off the
    // edge — "Mark all read" and the timestamps were unreachable.
    const width = Math.min(popupWidth, Math.max(0, vw - 2 * margin));

    let left = rect.left;
    if (left + width > vw + offsetLeft - margin) {
      left = vw + offsetLeft - margin - width;
    }
    if (left < margin + offsetLeft) left = margin + offsetLeft;

    // r.bottom / r.top are in layout-viewport coordinates; iOS Safari
    // position:fixed anchors to layout viewport too, so we don't subtract
    // visual-viewport offsets here. Visual-viewport is only used for
    // clamping width / available-height above.
    const top = rect.bottom + 4;
    const spaceBelow = (vh + offsetTop) - top - margin;
    const fitsBelow = spaceBelow >= MIN_BELOW;

    // Cap the popup's actual height to whichever is smaller — what the
    // caller asked for, or what fits without spilling off-screen. The
    // popup's own scrollY handles overflow.
    const maxHeight = Math.max(MIN_BELOW, Math.min(requestedHeight, spaceBelow));
    return {
      top,
      left,
      width,
      placement: 'below',
      maxHeight,
      needsScrollIntoView: !fitsBelow,
    };
  };

  // Exposed for the tests.
  window.PortalAnchoredPos = computeAnchoredPos;

  const subscribeViewport = (recompute) => {
    window.addEventListener('scroll', recompute, true);
    window.addEventListener('resize', recompute);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', recompute);
      window.visualViewport.addEventListener('scroll', recompute);
    }
    let tgUnsub = null;
    const tg = null; // standalone: there is no Telegram WebApp object here
    if (tg && typeof tg.onEvent === 'function') {
      tg.onEvent('viewportChanged', recompute);
      tgUnsub = () => { try { tg.offEvent('viewportChanged', recompute); } catch (_) {} };
    }
    return () => {
      window.removeEventListener('scroll', recompute, true);
      window.removeEventListener('resize', recompute);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', recompute);
        window.visualViewport.removeEventListener('scroll', recompute);
      }
      if (tgUnsub) tgUnsub();
    };
  };

  // A popup belongs to the page it was opened on. Back/Forward, a typed
  // address or a menu tap (app:tab-change) closes it; the Notifications
  // panel, anchored to the header, stayed over the next pages.
  const subscribeRouteChange = (onChange) => {
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    window.addEventListener('app:tab-change', onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('app:tab-change', onChange);
    };
  };
  window.subscribeRouteChange = subscribeRouteChange;

  // Keyboard for a search field and the list under it (a combobox): Down/Up
  // move through the rows, Enter takes the highlighted row, or -- with none
  // highlighted -- the row whose code is what was typed, else the first.
  // The rows were <div onClick> only: an alert could not be made without a
  // mouse.
  //   const kb = useComboboxKeys({ items, open, onPick, listId, query, codeOf, isDark, answered, resolve })
  //   <input {...kb.inputProps} />   rows: {...kb.optionProps(i)}, kb.active
  //   {kb.noteEl} next to the field: "No listing found for X" when Enter
  //   found no row to take (kb.sayNone(query) for a caller's own Enter).
  //   answered: the query `items` are the search's answer to (null while
  //   it is out), so an empty answer is told from no answer yet.
  //   resolve(query, items) -> Promise<{ item } | { note } | null>: what
  //   Enter does when no row is it (window.SymbolCode.resolve through the
  //   screen's rules); null when the screen said its own word.
  //   kb.note: the sentence on screen. A list anchored under the field
  //   stays closed while it shows: it opened over the line and hid it.
  //   kb.active: the row to paint (the arrows' row, else the one under the
  //   mouse); kb.target: the row Enter takes, the arrows' only (-1: none).
  const useComboboxKeys = ({ items, open, onPick, listId, query, codeOf, isDark, answered, resolve }) => {
    // The row the arrow keys are on: the only row Enter takes. The mouse
    // only paints (hover). onMouseEnter made the row under a resting pointer
    // the Enter target: "FOO.L" + Enter with the list opening under the
    // pointer took FOO.F, Frankfurt, instead of "No listing found for FOO.L"
    // (What-If and Add Position).
    const [active, setActive] = React.useState(-1);
    const [hover, setHover] = React.useState(-1);
    const list = items || [];
    // Enter that found no row for the text. It did nothing and said
    // nothing: "VOD.L" or "^GSPC" with rows for other listings left the
    // list open with no word. The sentence itself, so a
    // screen can say why ("GSPC.INDX is an index ...").
    const [noListing, setNoListing] = React.useState(null);
    React.useEffect(() => { setNoListing(null); }, [query]);
    const sayNone = (q) => { const t = String(q == null ? '' : q).trim(); if (t) setNoListing('No listing found for ' + t); };
    const queryRef = React.useRef(query);
    queryRef.current = query;
    // Enter with no row that is the text: the screen's resolve() answers --
    // a listing the search did not list (VOD.L as VOD.LSE, 7203.T checked
    // by its quote), or a sentence. An answer for text typed since is
    // dropped.
    const resolveSeq = React.useRef(0);
    const runResolve = (q, rows) => {
      const seq = ++resolveSeq.current;
      Promise.resolve().then(() => resolve(q, rows)).then((res) => {
        if (seq !== resolveSeq.current || queryRef.current !== q) return;
        if (res && res.item) { resolveSeq.current++; onPick(res.item); }
        else if (res && res.note) setNoListing(res.note);
      }, () => { if (seq === resolveSeq.current && queryRef.current === q) sayNone(q); });
    };
    // Enter typed before any row arrived (the search waits for typing to
    // stop): kept for this query and served when its rows come.
    const pendingRef = React.useRef(null);
    // Every selection, and the unmount, end what is still out for an Enter:
    // Add Position's VOD.L answered (VOD.LSE, after a slow quote) once the
    // VOD.US row had been clicked, and replaced it -- the text in the field
    // had not changed. A row clicked or tapped goes through
    // the screen's own handler, which calls kb.cancel() first.
    const cancel = () => { resolveSeq.current++; pendingRef.current = null; };
    React.useEffect(() => () => { resolveSeq.current++; pendingRef.current = null; }, []);
    const pickNow = (item) => { cancel(); onPick(item); };
    React.useEffect(() => { setActive(-1); setHover(-1); }, [list.length, query]);
    // With `answered`, an empty answer is an answer: the Enter kept for it
    // ends in a listing or a sentence. Without it, an Enter waited for rows
    // that never came, and "No listing found" was never said
    // (PortalDropdown.js:162).
    const told = answered !== undefined;
    React.useEffect(() => {
      if (pendingRef.current == null) return;
      if (pendingRef.current !== query) { pendingRef.current = null; return; }
      if (told ? answered !== query : !list.length) return;
      pendingRef.current = null;
      const pick = best();
      if (pick) pickNow(pick);
      else if (resolve) runResolve(query, list);
      else sayNone(query);
    }, [list, query, answered]);
    const best = () => {
      if (active >= 0 && list[active]) return list[active];
      // The shared reader: a code typed with its exchange, class or "^"
      // takes that listing's row or none -- "BRK.B" took BRK.TO, "^GSPC"
      // GSPCX.US.
      // A caller's codeOf names the code; the row's Exchange, else its
      // symbol, the listing.
      if (window.SymbolCode && window.SymbolCode.bestRow) {
        return window.SymbolCode.bestRow(list, query, codeOf
          ? (it) => (it.Exchange ? codeOf(it) + '.' + it.Exchange : (it.symbol || codeOf(it)))
          : undefined);
      }
      const q = String(query || '').trim().toUpperCase().split('.')[0];
      const code = codeOf || ((it) => String(it.symbol || it.code || '').split('.')[0]);
      const exact = list.filter(it => String(code(it) || '').toUpperCase() === q);
      // Of the same code on several exchanges, the US listing first.
      const us = exact.find(it => /\.US$/i.test(String(it.symbol || '')) || String(it.Exchange || '').toUpperCase() === 'US');
      return us || exact[0] || list[0] || null;
    };
    const onKeyDown = (e) => {
      const typed = String(query || '').trim();
      // One letter: nothing searches for it, and F, V, T, C are US codes.
      // The screen's resolve() checks it by its quote; Enter did nothing at
      // all.
      if (e.key === 'Enter' && active < 0 && typed.length === 1 && resolve) { e.preventDefault(); runResolve(query, []); return; }
      if (e.key === 'Enter' && active < 0 && typed.length >= 2 && (told ? answered !== query : !list.length)) { e.preventDefault(); pendingRef.current = query; return; }
      // The answer is here and has no rows: the screen's resolve() says.
      if (e.key === 'Enter' && !list.length && typed && resolve && told && answered === query) { e.preventDefault(); runResolve(query, list); return; }
      if (!open || !list.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % list.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i <= 0 ? list.length - 1 : i - 1)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = best();
        if (pick) pickNow(pick);
        else if (resolve) runResolve(query, list);
        else sayNone(query);
      }
    };
    const shown = !!(open && list.length);
    // Painted: the arrows' row, else the one under the mouse.
    const painted = active >= 0 ? active : hover;
    const C3 = window.C3 || {};
    // A polite live region that is always there, so a reader hears the
    // line when it appears.
    const noteEl = React.createElement('div', {
      role: 'status', 'aria-live': 'polite', 'data-no-listing': noListing ? 'true' : undefined,
      style: noListing ? { marginTop: 6, fontSize: 12, lineHeight: 1.4, overflowWrap: 'anywhere', color: isDark ? (C3.textMutedDark || 'rgba(255,255,255,0.7)') : (C3.textMutedLight || 'rgba(0,0,0,0.7)') } : undefined,
    }, noListing || '');
    return {
      active: painted,
      target: active,
      note: noListing || null,
      noteEl,
      sayNone,
      // A screen's own Enter: the same answer as the hook's (resolve), or
      // a sentence of its own.
      say: (text) => setNoListing(text || null),
      enterNone: (q, rows) => { if (resolve) runResolve(q, rows || []); else sayNone(q); },
      // A selection made outside the hook (a row clicked, a chip): ends
      // what an Enter left out, so its late answer cannot replace it.
      cancel,
      inputProps: {
        // A code is no word: no capitals, corrections or saved form text (iOS).
        ...(window.TickerFieldProps || {}),
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': shown,
        'aria-controls': listId,
        'aria-activedescendant': shown && active >= 0 ? listId + '-opt-' + active : undefined,
        onKeyDown,
      },
      optionProps: (i) => ({
        id: listId + '-opt-' + i,
        role: 'option',
        'aria-selected': i === active,
        // Paints the row, never makes it Enter's (see `active`).
        onMouseEnter: () => setHover(i),
        onMouseLeave: () => setHover((h) => (h === i ? -1 : h)),
      }),
    };
  };
  window.useComboboxKeys = useComboboxKeys;

  // Focus a control that the current update puts on the page -- the field
  // after a picked symbol, the button that replaced a search field. A bare
  // setTimeout(0) raced React's render: on a slow machine (CI) it ran before
  // the control existed, found nothing, and the focus stayed on <body>
  // A ~2 s cap on the wait failed the same way on a
  // slower runner (picker-focus-slow, Alerts #4): no clock here. The wait
  // watches the page (MutationObserver) until the control is there and takes
  // the focus, and ends only when
  //   - the person moves the focus themselves,
  //   - the page changes (Back/Forward, an address, a menu tap),
  //   - a newer request takes over (one wait at a time), or
  //   - the component that asked unmounts (useFocusWhenReady, or call the
  //     cancel function this returns).
  //   focusWhenReady(() => document.getElementById('next-field'))
  //   const focusNext = useFocusWhenReady();  focusNext(() => ...)
  let focusWait = null;
  // opts.reveal: scroll the control into view once it has the focus. The
  // focus never scrolls (preventScroll), so a control left above the top by
  // a page that just got shorter had an invisible ring (screener Reset at
  // 320).
  const focusWhenReady = (find, opts) => {
    if (focusWait) focusWait();
    let done = false;
    let mine = false;
    let mo = null;
    let unsubRoute = null;
    let timer = null;
    const onFocusIn = () => { if (!mine) cancel(); };
    const cancel = () => {
      if (done) return;
      done = true;
      if (mo) mo.disconnect();
      if (timer) clearTimeout(timer);
      document.removeEventListener('focusin', onFocusIn, true);
      if (unsubRoute) unsubRoute();
      if (focusWait === cancel) focusWait = null;
    };
    const attempt = () => {
      if (done) return;
      let el = null;
      try { el = find(); } catch (_) {}
      if (!el || !el.isConnected || el.disabled || (el.closest && el.closest('[hidden],[inert]'))) return;
      mine = true;
      try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }
      mine = false;
      // Not focusable yet (display:none, mid-render): keep watching.
      if (document.activeElement === el) {
        if (opts && opts.reveal) { try { el.scrollIntoView({ block: 'center' }); } catch (_) {} }
        cancel();
      }
    };
    focusWait = cancel;
    document.addEventListener('focusin', onFocusIn, true);
    unsubRoute = subscribeRouteChange(cancel);
    if (typeof MutationObserver === 'function') {
      mo = new MutationObserver(attempt);
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert', 'style', 'class'] });
    }
    timer = setTimeout(() => { timer = null; attempt(); }, 0);
    return cancel;
  };
  window.focusWhenReady = focusWhenReady;
  const useFocusWhenReady = () => {
    const pending = React.useRef(null);
    React.useEffect(() => () => { if (pending.current) pending.current(); }, []);
    return React.useCallback((find, opts) => { pending.current = focusWhenReady(find, opts); return pending.current; }, []);
  };
  window.useFocusWhenReady = useFocusWhenReady;

  // One Escape, one layer. Windows and popups that close
  // on Escape register while open; the last one opened is on top.
  //   useEscLayer(active, onEscape)
  //
  // Web: a single listener, in the capture phase on window (ahead of every
  // other key handler), gives Escape to the top layer only and stops it there.
  // It steps aside for a field that handles Escape itself, marked
  // [data-esc-own] (and only when it has something to close):
  // Esc in the header search closed an alert edit and left the suggestions
  // open.
  //
  // Telegram: the BackButton is the one way back. While it is shown, Escape
  // belongs to Telegram -- Telegram Desktop delivers the same press as a
  // backButtonClicked too -- so the key does nothing here and reaches no
  // component's own Esc handler; the BackButton closes the top layer, once.
  // A timing window (150 ms) could not tell one press from two. Layers registered here go on the Telegram Back stack there.
  const escStack = [];
  let escSeq = 0;
  const inTelegram = () => false; // standalone: no Telegram client
  if (typeof window !== 'undefined' && !window.__escLayersWired) {
    window.__escLayersWired = true;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (inTelegram()) {
        const depth = window.TGNav.backDepth ? window.TGNav.backDepth() : 0;
        if (!depth) return;
        // Telegram Desktop turns the same press into a BackButton click: the
        // key is Telegram's there, and doing it here too closed two layers.
        // Telegram Web and the other clients do not:
        // there the key closes the top layer of the same Back stack itself.
        // telegram-web-app.js has no Escape handling; the client does it.
        const platform = '' /* standalone: no Telegram client */;
        if (platform === 'tdesktop') { e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (t && t.closest && t.closest('[data-esc-own]')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (window.TGNav.pressBack) window.TGNav.pressBack();
        return;
      }
      if (!escStack.length) return;
      // Only a field that says it handles Escape itself (data-esc-own) is
      // passed over. An open list alone is no such promise: Backtester and
      // What-If fields are aria-expanded with no Esc of their own, and their
      // lists stayed open however many times Esc was pressed.
      // Their lists are PortalSearchPopup layers and close as such.
      if (t && t.closest && t.closest('[data-esc-own]')) return;
      const top = escStack[escStack.length - 1];
      e.preventDefault();
      e.stopImmediatePropagation();
      try { if (typeof top.ref.current === 'function') top.ref.current(e); } catch (err) { console.warn('Escape layer:', err); }
    }, true);
  }
  const useEscLayer = (active, onEscape) => {
    const ref = React.useRef(onEscape);
    ref.current = onEscape;
    // useLayoutEffect, not useEffect: the layer is on the stack before the
    // window is first painted. With useEffect a slow machine showed the
    // shortcuts window while Escape still went to the layer under it (CI on
    // PR #195). Layout effects run in commit order, so open order is kept.
    const useSyncEffect = React.useLayoutEffect || React.useEffect;
    useSyncEffect(() => {
      if (!active) return undefined;
      if (inTelegram()) {
        const id = window.TGNav.pushBack(() => { if (typeof ref.current === 'function') ref.current(); });
        return () => window.TGNav.popBack(id);
      }
      const entry = { id: ++escSeq, ref };
      escStack.push(entry);
      return () => { const i = escStack.indexOf(entry); if (i !== -1) escStack.splice(i, 1); };
    }, [!!active]);
  };
  window.useEscLayer = useEscLayer;
  window.escLayerCount = () => escStack.length;

  // One canvas for measuring option labels, made on first use.
  let measureCanvas = null;

  // A dropdown trigger's name: the field and what is chosen ("Exchange: United
  // States"), or whichever of the two there is. When the chosen text is the
  // field's own placeholder, the field alone.
  window.PortalDropdownName = (field, value) => {
    const f = String(field || '').trim();
    const v = String(value || '').trim();
    if (!v || v === f) return f;
    return f ? f + ': ' + v : v;
  };

  // ── PortalDropdown — drop-in replacement for native <select> ──────────
  window.PortalDropdown = ({
    value,
    options,
    onChange,
    isDark,
    placeholder,
    minWidth = 140,
    maxWidth,
    disabled,
    style,
    popupMaxHeight = 280,
    ariaLabel,
    popupMinWidth,    // the list may be wider than a narrow trigger
  }) => {
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState(null);
    const btnRef = React.useRef(null);
    const popupId = React.useMemo(() => 'pd-popup-' + Math.random().toString(36).slice(2, 9), []);

    const safeOptions = Array.isArray(options) ? options : [];
    const selected = safeOptions.find(o => String(o.value) === String(value));
    const label = selected ? selected.label : (placeholder || '');
    // The chosen value as text, for the trigger's name and tooltip: at 320 px
    // the trigger cut "🇺🇸 United States" to "🇺🇸 U…", with no title, and its
    // name was the field alone.
    const valueText = selected && (typeof selected.label === 'string' || typeof selected.label === 'number')
      ? String(selected.label)
      : (selected && (selected.title || selected.text)) || '';
    const triggerName = window.PortalDropdownName(ariaLabel || placeholder || '', valueText);

    const border = isDark ? '#303640' : '#e2e4e9';
    const bg = isDark ? '#1a1a2e' : '#ffffff';
    const text = isDark ? '#E0E3EB' : '#1e1b4b';
    const muted = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
    const itemHover = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
    const itemActive = isDark ? 'rgba(249,115,22,0.18)' : 'rgba(249,115,22,0.10)';
    // The widest option label at the list's 13 px (bold, as the selected one
    // is), plus its padding and the check mark. The web draws the list in
    // Geist at 14 px / 600 (the terminal's stylesheet, design stage 2): measured as drawn.
    const optionsWidth = () => {
      try {
        const c = measureCanvas || (measureCanvas = document.createElement('canvas'));
        const ctx = c.getContext && c.getContext('2d');
        if (!ctx) return 0;
        ctx.font = window.APP_PLATFORM === 'WEB' ? "600 14px 'Geist', 'Geist Fallback', sans-serif" : "700 13px 'Sora', sans-serif";
        return Math.ceil(safeOptions.reduce((m, o) => Math.max(m, ctx.measureText(String(o.label == null ? '' : o.label)).width), 0)) + 14 * 2 + 24;
      } catch (_) { return 0; }
    };

    React.useEffect(() => {
      if (!open) { setPos(null); return; }
      let raf = null;
      let scrolled = false;
      const recompute = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const b = btnRef.current;
          if (!b) { setPos(null); raf = null; return; }
          const r = b.getBoundingClientRect();
          // As wide as the longest option needs (the screen's margins still
          // cap it): the list matched its trigger, and on a phone the
          // screener's Exchange and Sector read "Londo…", "Germ…".
          const popupWidth = Math.max(r.width, minWidth, popupMinWidth || 0, optionsWidth());
          const requestedHeight = Math.min(popupMaxHeight, Math.max(48, safeOptions.length * 40 + 8));
          const next = computeAnchoredPos(r, popupWidth, requestedHeight, 8);
          // If popup would be tightly cramped below the trigger, scroll the
          // trigger up once so the popup gets full breathing room. Done at
          // most once per open to avoid scroll loops.
          if (next.needsScrollIntoView && !scrolled) {
            scrolled = true;
            try { b.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
            // Re-read rect after the scroll lands.
            requestAnimationFrame(() => recompute());
            return;
          }
          setPos(next);
          raf = null;
        });
      };
      recompute();
      const unsub = subscribeViewport(recompute);
      return () => { if (raf) cancelAnimationFrame(raf); unsub(); };
    }, [open, minWidth, popupMinWidth, popupMaxHeight, safeOptions.length]);

    React.useEffect(() => {
      if (!open) return;
      const handler = (e) => {
        const b = btnRef.current;
        const popup = document.getElementById(popupId);
        const inTrigger = b && b.contains(e.target);
        const inPopup = popup && popup.contains(e.target);
        if (!inTrigger && !inPopup) closeNow();
      };
      document.addEventListener('mousedown', handler);
      document.addEventListener('touchstart', handler);
      return () => {
        document.removeEventListener('mousedown', handler);
        document.removeEventListener('touchstart', handler);
      };
    }, [open, popupId]);

    // Closing drops the position in the same update. It used to be dropped a
    // render later, by the effect above; reopening inside that gap (Escape,
    // then ArrowDown) showed the list at the old position, took it away and
    // put it back, and the keys pressed meanwhile went nowhere.
    // Whether the list is open right now, not as of the last render: an
    // effect from the render that opened it can run after it was closed.
    const openNowRef = React.useRef(false);
    openNowRef.current = open;
    const closeNow = () => { openNowRef.current = false; setOpen(false); setPos(null); };

    // Keyboard. The list is portaled to the end of
    // <body>, so by Tab order it sat after everything else on the page -- on
    // the heatmap its options were stops 54-57 of 58 -- and the arrow keys did
    // nothing. Now it behaves like the <select> it replaces: opening moves
    // focus into the list, arrows / Home / End move, Enter or Space choose
    // (the options are buttons), Escape and Tab close, and focus goes back to
    // the trigger. The options leave the Tab order (tabIndex -1).
    const closeToTrigger = () => {
      closeNow();
      const b = btnRef.current;
      if (b) { try { b.focus({ preventScroll: true }); } catch (_) { b.focus(); } }
    };
    const optionEls = () => {
      const popup = document.getElementById(popupId);
      return popup ? Array.prototype.slice.call(popup.querySelectorAll('[role="option"]:not([disabled])')) : [];
    };
    // The ring on the option in focus is for the keyboard only. Focus moves
    // into the list however it was opened, and after a click or a tap that
    // put an orange outline on the current value in every dropdown, where
    // there had been none. A browser's own :focus-visible is not to be relied
    // on for focus moved from script after a click, so the modality is kept
    // here: the last thing done to the trigger or the list, a key or a pointer.
    const byKeyboard = React.useRef(false);
    // #f97316 on the light hover tint read 2.53:1; a focus
    // ring needs 3:1, the darker brand orange gives it.
    const RING = isDark ? '2px solid #f97316' : '2px solid #c2410c';
    const paintOption = (el) => {
      if (!el || el.getAttribute('role') !== 'option') return;
      const sel = el.getAttribute('aria-selected') === 'true';
      if (byKeyboard.current) {
        el.style.background = sel ? itemActive : itemHover;
        // "important", because a host stylesheet may draw its own ring with it.
        el.style.setProperty('outline', RING, 'important');
        el.style.setProperty('outline-offset', '-2px', 'important');
      } else {
        el.style.background = sel ? itemActive : 'transparent';
        el.style.setProperty('outline', 'none', 'important');
      }
    };
    const unpaintOption = (el) => {
      el.style.background = el.getAttribute('aria-selected') === 'true' ? itemActive : 'transparent';
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
    };
    const hasPos = !!pos;
    // A layout effect, and only while the list is still open. As a passive
    // effect it could run late on a slow machine: after an Escape had closed
    // the list and put the focus back on the trigger, it moved the focus into
    // the list being removed, and the focus fell to <body> (accepted on prod too, 6 in 20 at 8x CPU).
    const useSyncEffect = React.useLayoutEffect || React.useEffect;
    useSyncEffect(() => {
      if (!open || !hasPos || !openNowRef.current) return;
      const els = optionEls();
      const target = els.find(el => el.getAttribute('aria-selected') === 'true') || els[0];
      if (!target) return;
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
      // In a long list the current value may be below the fold of the list
      // ("$240" among the payoff builder's strikes): bring it to the middle.
      // Only the list scrolls -- it is position: fixed, and its own offset
      // parent -- so the page stays where it is.
      const popup = document.getElementById(popupId);
      if (popup && popup.scrollHeight > popup.clientHeight) {
        popup.scrollTop = Math.max(0, target.offsetTop - (popup.clientHeight - target.offsetHeight) / 2);
      }
    }, [open, hasPos]);
    const onListKeyDown = (e) => {
      const k = e.key;
      if (k !== 'Shift' && k !== 'Control' && k !== 'Alt' && k !== 'Meta' && !byKeyboard.current) {
        byKeyboard.current = true;
        paintOption(document.activeElement);
      }
      if (k === 'Tab') {
        // Focus returns to the trigger and the browser's own Tab step then
        // continues from there, as it does on leaving a native <select>.
        closeToTrigger();
        return;
      }
      if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
      const els = optionEls();
      if (!els.length) return;
      e.preventDefault();
      const i = els.indexOf(document.activeElement);
      const next = k === 'Home' ? 0
        : k === 'End' ? els.length - 1
        : k === 'ArrowDown' ? Math.min(els.length - 1, i + 1)
        : Math.max(0, i < 0 ? 0 : i - 1);
      els[next].focus();
    };

    useEscLayer(open, () => closeToTrigger());

    React.useEffect(() => {
      if (!open) return;
      return subscribeRouteChange(() => setOpen(false));
    }, [open]);

    const triggerStyle = {
      background: bg, color: text,
      border: `1px solid ${border}`, borderRadius: 4,
      padding: '8px 30px 8px 12px', fontSize: 13, fontWeight: 600,
      fontFamily: "'Sora', sans-serif",
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      minWidth, maxWidth: maxWidth || undefined,
      textAlign: 'left', position: 'relative',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      ...(style || {}),
    };

    const trigger = React.createElement('button', {
      ref: btnRef,
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      'aria-label': triggerName,
      title: valueText || undefined,
      disabled,
      onClick: (e) => { e.stopPropagation(); if (disabled) return; if (open) closeNow(); else setOpen(true); },
      onPointerDown: () => { byKeyboard.current = false; },
      onTouchStart: () => { byKeyboard.current = false; },
      onKeyDown: (e) => {
        byKeyboard.current = true;
        if (disabled || open) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
      },
      style: triggerStyle,
    },
      React.createElement('span', { style: { color: selected ? text : muted } }, label || (placeholder || '')),
      React.createElement('span', { 'aria-hidden': true, style: {
        position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', color: muted, display: 'flex', alignItems: 'center',
      }},
        React.createElement('svg', { width: 10, height: 6, viewBox: '0 0 10 6', fill: 'none' },
          React.createElement('path', { d: 'M1 1L5 5L9 1', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
        )
      )
    );

    const popup = open && pos && React.createElement('div', {
      id: popupId,
      role: 'listbox',
      'aria-label': ariaLabel || placeholder || undefined,
      onKeyDown: onListKeyDown,
      style: {
        position: 'fixed', top: pos.top, left: pos.left, width: pos.width,
        maxHeight: pos.maxHeight || popupMaxHeight,
        overflowY: 'auto', WebkitOverflowScrolling: 'touch',
        background: bg, border: `1px solid ${border}`, borderRadius: 8,
        boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.4)' : '0 8px 24px rgba(0,0,0,0.12)',
        zIndex: 10000, fontFamily: 'Inter, sans-serif',
      },
    },
      safeOptions.length === 0
        ? React.createElement('div', { style: { padding: '10px 14px', fontSize: 12, color: muted } }, 'No options')
        : safeOptions.map((opt, i) => {
          const isSel = String(opt.value) === String(value);
          return React.createElement('button', {
            key: opt.value != null ? opt.value : i,
            type: 'button',
            role: 'option',
            'aria-selected': isSel,
            disabled: !!opt.disabled,
            tabIndex: -1,
            onMouseDown: (e) => e.preventDefault(),
            onPointerDown: () => { byKeyboard.current = false; },
            onClick: (e) => {
              e.stopPropagation();
              if (opt.disabled) return;
              onChange && onChange(opt.value);
              closeToTrigger();
            },
            onMouseEnter: (e) => { if (!opt.disabled) e.currentTarget.style.background = itemHover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = isSel ? itemActive : 'transparent'; },
            // The option the arrows are on reads like the one under the mouse.
            onFocus: (e) => paintOption(e.currentTarget),
            onBlur: (e) => unpaintOption(e.currentTarget),
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', textAlign: 'left',
              padding: '9px 14px', fontSize: 13,
              fontFamily: "'Sora', sans-serif", fontWeight: isSel ? 700 : 500,
              background: isSel ? itemActive : 'transparent',
              color: opt.disabled ? muted : text,
              border: 'none', cursor: opt.disabled ? 'not-allowed' : 'pointer',
              borderBottom: i < safeOptions.length - 1 ? `1px solid ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'}` : 'none',
            },
          },
            React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
              // Wraps rather than cutting off, where the screen is narrower
              // than the longest option.
              React.createElement('span', { style: { whiteSpace: 'normal', overflowWrap: 'anywhere' } }, opt.label),
              opt.sub && React.createElement('span', { style: { fontSize: 11, color: muted, fontWeight: 400 } }, opt.sub),
            ),
            isSel && React.createElement('span', { style: { color: '#f97316', fontSize: 14, fontWeight: 700 } }, '✓'),
          );
        })
    );

    const portalRoot = (typeof document !== 'undefined') ? document.body : null;
    const portaledPopup = popup && window.ReactDOM && window.ReactDOM.createPortal && portalRoot
      ? window.ReactDOM.createPortal(popup, portalRoot)
      : popup;

    return React.createElement(React.Fragment, null, trigger, portaledPopup);
  };

  // ── PortalSearchPopup — for input-driven search results dropdowns ──────
  // Pattern: input is rendered inline as before; results popup is portaled
  // and anchored to the input via getBoundingClientRect.
  //
  //   <input ref={inputRef} ... />
  //   <PortalSearchPopup anchorRef={inputRef} open={results.length > 0}
  //     onClose={() => clearResults()} isDark={isDark}>
  //      {results.map(r => <button onClick={() => pick(r)}>...</button>)}
  //   </PortalSearchPopup>
  window.PortalSearchPopup = ({ anchorRef, open, onClose, onEscape, children, isDark, maxHeight = 240, id, width, role, ariaLabel }) => {
    const [pos, setPos] = React.useState(null);
    const popupId = React.useMemo(() => id || ('psp-popup-' + Math.random().toString(36).slice(2, 9)), [id]);

    React.useEffect(() => {
      if (!open) { setPos(null); return; }
      let raf = null;
      let scrolled = false;
      const recompute = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const a = anchorRef && anchorRef.current;
          if (!a) { setPos(null); raf = null; return; }
          const r = a.getBoundingClientRect();
          const next = computeAnchoredPos(r, width || r.width, maxHeight, 8);
          if (next.needsScrollIntoView && !scrolled) {
            scrolled = true;
            try { a.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
            requestAnimationFrame(() => recompute());
            return;
          }
          setPos(next);
          raf = null;
        });
      };
      recompute();
      const unsub = subscribeViewport(recompute);
      return () => { if (raf) cancelAnimationFrame(raf); unsub(); };
    }, [open, anchorRef, maxHeight, width]);

    React.useEffect(() => {
      if (!open || !onClose) return;
      const handler = (e) => {
        const a = anchorRef && anchorRef.current;
        const popup = document.getElementById(popupId);
        const inAnchor = a && a.contains(e.target);
        const inPopup = popup && popup.contains(e.target);
        if (!inAnchor && !inPopup) onClose();
      };
      document.addEventListener('mousedown', handler);
      document.addEventListener('touchstart', handler);
      return () => {
        document.removeEventListener('mousedown', handler);
        document.removeEventListener('touchstart', handler);
      };
    }, [open, anchorRef, popupId, onClose]);

    // Escape closes it as a layer; onEscape (if given) can also put the focus back.
    useEscLayer(!!(open && (onEscape || onClose)), () => (onEscape || onClose)());

    React.useEffect(() => {
      if (!open || !onClose) return;
      return subscribeRouteChange(() => onClose());
    }, [open, onClose]);

    if (!open || !pos) return null;

    const border = isDark ? '#303640' : '#e2e4e9';
    const bg = isDark ? '#1E222D' : '#ffffff';

    const popup = React.createElement('div', {
      id: popupId,
      role,
      'aria-label': ariaLabel,
      style: {
        position: 'fixed', top: pos.top, left: pos.left, width: pos.width,
        maxHeight: pos.maxHeight || maxHeight,
        overflowY: 'auto', WebkitOverflowScrolling: 'touch',
        background: bg, border: `1px solid ${border}`, borderRadius: 8,
        boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.5)' : '0 8px 24px rgba(0,0,0,0.15)',
        zIndex: 10000,
      },
    }, children);

    const portalRoot = (typeof document !== 'undefined') ? document.body : null;
    return window.ReactDOM && window.ReactDOM.createPortal && portalRoot
      ? window.ReactDOM.createPortal(popup, portalRoot)
      : popup;
  };
})();

// What every open window (dialog, sheet, drawer, full-screen overlay) does
// to the page behind it, in one place:
//
// - Tab and Shift+Tab stay in the top window. The focus is moved here, from
//   the window's own list of stops, on every press: Safari by default skips
//   buttons and links when tabbing, so a trap that only caught Tab on its
//   first and last control let the press out of the Transactions and
//   Settings windows -- to <body>, or to the row behind.
// - The page behind does not scroll, on a phone either: a swipe in Add
//   Position scrolled the page up to ~1100 px and the user was somewhere
//   else after closing it. overflow:hidden on <body> does not hold
//   on iOS Safari, so the body is pinned (position:fixed at the current
//   offset) and put back exactly there; the window's own content scrolls.
//
//   ModalLayer.open(node, { popups }) -> close()   the low level
//   ModalLayer.useLayer(ref, active)               the hook
//   React.createElement(ModalLayer.Hold)           inside an overlay that
//                                                  cannot call a hook
//   ModalLayer.tab(e, roots)                       a trap of its own (plain DOM)
//   ModalLayer.lock() -> unlock()                  the scroll lock alone
window.ModalLayer = window.ModalLayer || (() => {
  const TABBABLE = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,iframe,[contenteditable=""],[contenteditable="true"],[tabindex]';
  const shown = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden || n.hasAttribute('inert')) return false;
      const cs = window.getComputedStyle ? window.getComputedStyle(n) : null;
      if (cs && (cs.display === 'none' || (n === el && cs.visibility === 'hidden'))) return false;
    }
    return true;
  };
  // The stops Tab visits, in order: what the browser would visit with every
  // control in the tab order (as with Safari's Option+Tab), radios one per group.
  const tabbables = (root) => {
    if (!root || !root.querySelectorAll) return [];
    const all = [...root.querySelectorAll(TABBABLE)].filter(el => {
      const ti = el.getAttribute('tabindex');
      if (ti != null && ti !== '' && Number(ti) < 0) return false;
      if (el.closest('fieldset[disabled]') || el.hasAttribute('data-tab-guard')) return false;
      return shown(el);
    });
    const active = document.activeElement;
    return all.filter(el => {
      if (el.tagName !== 'INPUT' || el.type !== 'radio' || !el.name) return true;
      const group = all.filter(x => x.tagName === 'INPUT' && x.type === 'radio' && x.name === el.name && x.form === el.form);
      const pick = group.find(x => x === active) || group.find(x => x.checked) || group[0];
      return pick === el;
    });
  };
  // The stop after `from` in `items` (before it with `back`), round the end.
  const step = (items, roots, from, back) => {
    const n = items.length;
    const i = items.indexOf(from);
    if (i !== -1) return items[(i + (back ? n - 1 : 1)) % n];
    if (from && roots.some(r => r.contains(from))) {
      // On the window itself, or on a control out of the tab order: the
      // next stop after it in the page, or the one before.
      const after = (el) => !!(from.compareDocumentPosition(el) & 4);
      if (back) { const before = items.filter(el => !after(el) && !el.contains(from)); return before[before.length - 1] || items[n - 1]; }
      return items.find(after) || items[0];
    }
    return back ? items[n - 1] : items[0];
  };
  // A field whose parts the browser walks with Tab: mm / dd / yyyy and the
  // calendar button of a date. Taking every Tab over in it stopped that walk:
  // "1 Tab 5 Tab 2025" in Add Transaction's date went on into Shares and
  // Price (Shares 105, Price 1502025). Where the browser has no such field it
  // reports type "text", and the trap moves on from it as from any field.
  const PARTS = /^(date|time|month|week|datetime-local)$/;
  const walksParts = (el) => !!el && el.nodeType === 1 && el.tagName === 'INPUT' && PARTS.test(el.type);
  // The browser's own Tab, from `from`, checked where it lands: on `from`
  // again (the next part of the same field) or on `want` (the window's next
  // stop) it stays; anywhere else the focus goes to `want`. With `guarded`,
  // a focusable guard is put right next to `from` on the side the press
  // goes, so that leaving the field lands on the guard and never on the page
  // behind or the browser's toolbar, whatever the browser skips. The guard
  // goes with the next focus move, the key's release, or half a second.
  // Only the move this Tab makes is watched: a press of the pointer, another
  // key, or a window opening or closing ends it at once. A click on Price
  // with the key still down in Add Transaction's date was sent to Shares,
  // and a question opened over the window lost its focus to the one below.
  // Tab into a field with text selects that text in every browser, so what
  // is typed next replaces it. focus() alone leaves the caret at the end:
  // in Safari, whose Tab leaves a date at once, "1 Tab 5 Tab 2025" in Add
  // Transaction made Shares 105 and Price 1502025. Every move this trap
  // makes for a Tab lands the way the browser's own Tab does.
  const TEXTY = /^(text|search|url|tel|password|email|number)$/;
  const land = (el) => {
    try { el.focus(); } catch (_) { return; /* gone */ }
    if (el.tagName === 'INPUT' && TEXTY.test(el.type) && document.activeElement === el) {
      try { el.select(); } catch (_) { /* a type without a selection */ }
    }
  };
  let pending = null;
  const POINTER = ['pointerdown', 'mousedown', 'touchstart'];
  const MODIFIER = /^(Shift|Control|Alt|Meta|CapsLock|AltGraph|OS)$/;
  const release = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    document.removeEventListener('focusin', p.onIn, true);
    document.removeEventListener('keyup', p.onUp, true);
    document.removeEventListener('keydown', p.onKey, true);
    for (const t of POINTER) document.removeEventListener(t, release, true);
    if (p.guard && p.guard.parentNode) p.guard.parentNode.removeChild(p.guard);
  };
  const native = (e, from, want, guarded) => {
    release();
    let guard = null;
    if (guarded) {
      guard = document.createElement('span');
      guard.tabIndex = 0;
      guard.setAttribute('data-tab-guard', '');
      // Out of the layout, where the field is: focusing it scrolls nothing.
      guard.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      from.parentNode.insertBefore(guard, e.shiftKey ? from : from.nextSibling);
    }
    const onIn = (ev) => {
      if (ev.target === from) return;
      release();
      if (ev.target !== want) land(want);
    };
    const onUp = (ev) => { if (ev.key === 'Tab') setTimeout(release, 0); };
    // A held Tab repeats its keydown: that is this trap's again, not another key.
    const onKey = (ev) => { if (ev.key !== 'Tab' && !MODIFIER.test(ev.key || '')) release(); };
    pending = { guard, onIn, onUp, onKey, timer: setTimeout(release, 500) };
    document.addEventListener('focusin', onIn, true);
    document.addEventListener('keyup', onUp, true);
    document.addEventListener('keydown', onKey, true);
    for (const t of POINTER) document.addEventListener(t, release, true);
  };
  // Tab inside `roots` (the window, then the popups it owns): the focus goes
  // to the window's next (previous) stop, and the browser's own Tab never
  // runs -- Safari skips buttons with it -- except in a field
  // whose parts the browser walks, and back onto one, where the browser's
  // Shift+Tab lands on its last part (focus() would land on its first).
  const tab = (e, roots) => {
    const list = (roots || []).filter(Boolean);
    if (!list.length) return;
    const items = [].concat(...list.map(tabbables));
    if (!items.length) { e.preventDefault(); try { list[0].focus(); } catch (_) {} return; }
    const active = document.activeElement;
    const want = step(items, list, active, e.shiftKey);
    const inField = walksParts(active) && !!active.parentNode && list.some(r => r.contains(active));
    const backOnto = e.shiftKey && walksParts(want) && !!active && active !== want && list.some(r => r.contains(active)) && !!(active.compareDocumentPosition(want) & 2);
    if (inField || backOnto) { native(e, active, want, !backOnto); return; }
    e.preventDefault();
    land(want);
  };

  // The page pinned where it is, once however many windows are open.
  let locks = 0;
  let saved = null;
  const lock = () => {
    if (typeof document === 'undefined' || !document.body) return () => {};
    if (locks++ === 0) {
      const b = document.body;
      const de = document.documentElement;
      const x = window.scrollX || window.pageXOffset || 0;
      const y = window.scrollY || window.pageYOffset || 0;
      const bar = Math.max(0, (window.innerWidth || 0) - (de.clientWidth || window.innerWidth || 0));
      const keep = (el, props) => props.reduce((o, p) => { o[p] = el.style[p]; return o; }, {});
      saved = { x, y, body: keep(b, ['position', 'top', 'left', 'right', 'width', 'overflow', 'paddingRight']), html: keep(de, ['overscrollBehavior', 'scrollBehavior']) };
      const pad = parseFloat((window.getComputedStyle ? window.getComputedStyle(b).paddingRight : '') || '0') || 0;
      b.style.position = 'fixed';
      b.style.top = (-y) + 'px';
      b.style.left = (-x) + 'px';
      b.style.right = '0';
      b.style.width = '100%';
      b.style.overflow = 'hidden';
      // The scrollbar that went: its width as padding, so nothing shifts.
      if (bar > 0) b.style.paddingRight = (pad + bar) + 'px';
      de.style.overscrollBehavior = 'none';
      b.setAttribute('data-modal-locked', '');
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--locks > 0 || !saved) return;
      const b = document.body;
      const de = document.documentElement;
      Object.keys(saved.body).forEach(p => { b.style[p] = saved.body[p]; });
      b.removeAttribute('data-modal-locked');
      // Back to the same place, at once (a smooth scroll-behavior animated it).
      de.style.scrollBehavior = 'auto';
      try { window.scrollTo(saved.x, saved.y); } catch (_) { /* jsdom */ }
      Object.keys(saved.html).forEach(p => { de.style[p] = saved.html[p]; });
      saved = null;
    };
  };

  // A window whose overlay asks to be fixed and is not: on the web,
  // the terminal's stylesheet turns an inline "position: fixed; inset: 0" inside
  // .web-content into absolute (its rule for the mobile full-screen views),
  // so the portfolio windows drew at the top of the page. With the page
  // pinned at its offset, one opened from a row deep in the page stayed
  // above the screen, out of reach. The nearest such element
  // from the window up is fixed to the screen while the window is open, in
  // the box it has with the page at its top: the column it is drawn in (the
  // sidebar and the top bar stay as they were), from that column's top to
  // the bottom of the screen; its own scroll takes what is taller. Placed
  // again when the screen turns or is resized.
  const BOX = ['position', 'top', 'left', 'right', 'bottom', 'width', 'height'];
  const toScreen = (node) => {
    if (typeof document === 'undefined' || !window.getComputedStyle) return () => {};
    let el = node;
    for (; el && el.nodeType === 1 && el !== document.body; el = el.parentElement) {
      if (el.style && el.style.position === 'fixed') break;
    }
    if (!el || el === document.body || el.nodeType !== 1) return () => {};
    if (window.getComputedStyle(el).position === 'fixed') return () => {};
    // What it is drawn in as absolute: the nearest positioned ancestor.
    let box = el.parentElement;
    while (box && box !== document.body && window.getComputedStyle(box).position === 'static') box = box.parentElement;
    // The page's offset now: scrolled, or pinned at -y by lock().
    const offset = () => {
      const b = document.body;
      return b.hasAttribute('data-modal-locked') ? -(parseFloat(b.style.top) || 0) : (window.scrollY || window.pageYOffset || 0);
    };
    const rectOf = () => (box && box !== document.body ? box.getBoundingClientRect() : { top: 0, left: 0, width: document.documentElement.clientWidth });
    // Only a column of the page (the web's content column, from the top of
    // the page): one drawn inside a box further down (a card) stays over
    // that box, where the pinned page keeps it.
    if (rectOf().top + offset() > (window.innerHeight || 0) / 2) return () => {};
    const was = BOX.map(p => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
    const place = () => {
      const r = rectOf();
      const off = offset();
      const set = (p, v) => el.style.setProperty(p, v, 'important');
      set('position', 'fixed');
      set('top', Math.max(0, Math.round(r.top + off)) + 'px');
      set('left', Math.round(r.left) + 'px');
      set('width', Math.round(r.width) + 'px');
      set('right', 'auto');
      set('bottom', '0px');
      set('height', 'auto');
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      // Unless the view has set a position of its own since.
      if (el.style.getPropertyPriority('position') !== 'important') return;
      was.forEach(([p, v, pr]) => { if (v) el.style.setProperty(p, v, pr); else el.style.removeProperty(p); });
    };
  };

  // Open windows, last on top. Each: { node, popups(node) -> [els], unlock }.
  const stack = [];
  const onKey = (e) => {
    if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const top = stack[stack.length - 1];
    if (!top || !top.node || !document.contains(top.node)) return;
    tab(e, [top.node].concat(top.popups ? top.popups(top.node) : []));
  };
  const open = (node, opts) => {
    const pinned = !(opts && opts.scroll === false);
    // A Tab still watched belongs to the window below: the new one's focus is its own.
    release();
    const entry = { node, popups: opts && opts.popups, unfix: pinned ? toScreen(node) : () => {}, unlock: pinned ? lock() : () => {} };
    stack.push(entry);
    if (stack.length === 1) document.addEventListener('keydown', onKey);
    return () => {
      release();
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      if (!stack.length) document.removeEventListener('keydown', onKey);
      entry.unlock();
      entry.unfix();
    };
  };
  // Popups a control portals to <body> (PortalDropdown's listbox): part of
  // the window while open.
  const portaled = (node) => [...document.body.children].filter(el =>
    el !== node && !el.contains(node) && /^(listbox|menu)$/.test(el.getAttribute('role') || ''));
  const useLayer = (ref, active) => {
    const useSync = React.useLayoutEffect || React.useEffect;
    useSync(() => {
      if (active === false || !ref.current) return undefined;
      return open(ref.current, { popups: portaled });
    }, [active !== false]);
  };
  // For an overlay written inline: rendered anywhere inside it, holds the
  // element it sits in (or the nearest [data-modal-root] above it).
  // `off`: the same markup is not a window here (a page section on the web).
  const Hold = ({ off } = {}) => {
    const ref = React.useRef(null);
    const useSync = React.useLayoutEffect || React.useEffect;
    useSync(() => {
      const el = ref.current;
      const node = !off && el && ((el.parentElement && el.parentElement.closest('[data-modal-root]')) || el.parentElement);
      return node ? open(node, { popups: portaled }) : undefined;
    }, [!!off]);
    return React.createElement('span', { ref, hidden: true, 'data-modal-hold': '' });
  };
  return { open, lock, tab, tabbables, useLayer, Hold, portaled, depth: () => stack.length };
})();

// Dialog behaviour shared by the portfolio modals (Add Position, Add
// Transaction, Edit Position, Import CSV, Transaction History). They were
// plain fixed overlays: Escape did nothing, Tab walked out to the page behind
// the overlay, nothing told a screen reader a dialog had opened, and the
// close icon was an unnamed button. Defined in this
// file because every host of the portfolio modals loads it; the others call
// it at render time.
window.PTDialog = window.PTDialog || (() => {
  const stack = [];
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  // Popups a control inside the dialog portals to <body> (PortalDropdown's
  // listbox): they belong to the dialog while open. Without this the trap
  // pulled focus out of the options and a keyboard user could not pick one,
  // and Escape closed the whole dialog along with the dropdown.
  // Only what can actually take focus: a display:none file input matched the
  // selector, so Import CSV "focused" it (nothing happened, the focus stayed on
  // the page) and the Tab trap counted it as the last stop.
  const visible = (el) => {
    if (!el || el.type === 'hidden') return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return false;
      const cs = window.getComputedStyle ? window.getComputedStyle(n) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    }
    return true;
  };
  const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(visible);
  // The opener, again if React replaced its node while the dialog was open:
  // focus went to <body> after Escape in Add Position.
  const findAgain = (el) => {
    if (!el || el === document.body) return null;
    if (document.contains(el)) return el;
    const label = el.getAttribute && el.getAttribute('aria-label');
    const text = (el.textContent || '').trim();
    const same = [...document.querySelectorAll(el.tagName || 'button')].filter(c =>
      (label ? c.getAttribute('aria-label') === label : (c.textContent || '').trim() === text) && visible(c));
    return same.length === 1 ? same[0] : null;
  };
  // The control a window was opened from. Safari (WebKit) does not focus a
  // button that is clicked, so document.activeElement was <body> -- or a
  // field focused earlier -- and after Escape the focus went to <body>, the
  // next Tab to the top of the page. The control last
  // pressed is recorded here (a click is also what Enter and Space on a
  // button make); a key that is not one of those forgets it.
  const OPENER = 'button,a[href],[role="button"],[role="tab"],[role="menuitem"],[role="option"],summary,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  let pressed = null;
  const notePress = (e) => {
    const t = e && e.target && e.target.nodeType === 1 && e.target.closest ? e.target.closest(OPENER) : null;
    // A hidden control a button clicks for the user (Restore from Backup's
    // file input) is no opener: the focus cannot go back to it, and it went
    // to <body> after Cancel on the restore question.
    // The button pressed before it stays the opener.
    if (t && !visible(t)) return;
    pressed = t ? { el: t, at: Date.now() } : null;
  };
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('pointerdown', notePress, true);
    document.addEventListener('click', notePress, true);
    document.addEventListener('keydown', (e) => { if (e.key !== 'Enter' && e.key !== ' ') pressed = null; }, true);
  }
  const openerNow = () => {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    const p = pressed && Date.now() - pressed.at < 1500 && document.contains(pressed.el) ? pressed.el : null;
    if (p && (!a || a === document.body || !p.contains(a))) return p;
    return a;
  };
  const portaledPopups = (node) => [...document.body.children].filter(el =>
    el !== node && !el.contains(node) && /^(listbox|menu)$/.test(el.getAttribute('role') || ''));
  const onKey = (e) => {
    const top = stack[stack.length - 1];
    if (!top || !top.ref.current) return;
    const node = top.ref.current;
    const popups = portaledPopups(node);
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return; // a dropdown inside took it
      if (popups.length) return;      // the open dropdown closes itself first
      e.preventDefault();
      if (typeof top.onClose.current === 'function') top.onClose.current();
      return;
    }
    // Tab: window.ModalLayer, where the dialog is registered (below). It
    // moves the focus on every press; catching only the first and last
    // control let Safari's Tab, which skips buttons, out.
  };
  // A press on the dimmed page around the top dialog:
  // the browser's default for a mousedown on something that cannot take the
  // focus is to drop it to <body>. Windows that close on it (Modal) put the
  // focus back on their opener first and the default then took it away;
  // windows that stay open lost it from inside. Outside the top dialog and
  // its portaled popups, on nothing focusable, that default is cancelled:
  // the focus stays where it was (in the dialog, or back on the opener).
  const INTERACTIVE = FOCUSABLE + ',[tabindex],label,[contenteditable="true"],[contenteditable=""]';
  const onPress = (e) => {
    const top = stack[stack.length - 1];
    if (!top || !top.ref.current) return;
    const node = top.ref.current;
    const t = e.target;
    if (!t || t.nodeType !== 1 || node.contains(t)) return;
    if (portaledPopups(node).some(p => p.contains(t))) return;
    if (t.closest && (t.closest(INTERACTIVE) || t.closest('[role="tooltip"]'))) return;
    e.preventDefault();
  };
  // Props for the dialog's outer element: role, aria-modal, name, and a ref
  // that Escape / the Tab trap / initial focus / focus restore work from.
  // opts.restoreFocus(opener) -> element | null: where the focus goes when
  // the dialog closes, when that is not simply its opener -- the opener is
  // gone with what the dialog deleted, or a better place exists (the next
  // position, the portfolio picker). null falls back to the opener.
  const use = (onClose, label, opts) => {
    const ref = React.useRef(null);
    const closeRef = React.useRef(onClose);
    closeRef.current = onClose;
    const restoreRef = React.useRef(opts && opts.restoreFocus);
    restoreRef.current = opts && opts.restoreFocus;
    // An open dialog is an Escape layer (a dropdown inside opens above it).
    (window.useEscLayer || (() => {}))(true, () => { if (typeof closeRef.current === 'function') closeRef.current(); });
    // Read on the first render, before the dialog's own autoFocus field takes
    // focus at commit: read in the effect it was that field, gone on close,
    // so Add Position's Escape left focus on <body>.
    const openerRef = React.useRef(undefined);
    if (openerRef.current === undefined) openerRef.current = typeof document !== 'undefined' ? openerNow() : null;
    React.useEffect(() => {
      const entry = { ref, onClose: closeRef };
      const previous = openerRef.current;
      stack.push(entry);
      // Tab stays in it and the page behind does not scroll (ModalLayer).
      const leave = window.ModalLayer && ref.current ? window.ModalLayer.open(ref.current, { popups: portaledPopups }) : () => {};
      if (stack.length === 1) {
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onPress, true);
      }
      const node = ref.current;
      if (node && !node.contains(document.activeElement)) {
        // opts.initialFocus(node) -> element: where the focus starts, when the
        // first field is not the top of the window (Edit Position opened in
        // Notes, half-way down, under Close and two sections:
        //).
        let first = null;
        try { first = opts && typeof opts.initialFocus === 'function' ? opts.initialFocus(node) : null; } catch (_) { first = null; }
        if (!first || !visible(first)) {
          const fields = [...node.querySelectorAll('input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter(visible);
          first = fields[0] || focusables(node)[0] || node;
        }
        first.focus();
      }
      return () => {
        const i = stack.indexOf(entry);
        if (i !== -1) stack.splice(i, 1);
        if (!stack.length) {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onPress, true);
        }
        // The page back where it was before the focus goes back to the opener.
        leave();
        let back = null;
        try { back = typeof restoreRef.current === 'function' ? restoreRef.current(previous) : null; } catch (_) { back = null; }
        if (!back || !document.contains(back)) back = findAgain(previous);
        if (back && typeof back.focus === 'function') {
          try { back.focus(); } catch (_) { /* gone */ }
        }
      };
    }, []);
    return { ref, role: 'dialog', 'aria-modal': true, 'aria-label': label, tabIndex: -1 };
  };
  // The same, as an element, for a dialog written inline in a view where a
  // hook can't be called conditionally (Portfolio Settings: Escape did not
  // close it).
  const Frame = ({ onClose, label, style, children, restoreFocus }) => {
    const props = use(onClose, label, { restoreFocus });
    return React.createElement('div', { ...props, style }, children);
  };
  // A whole modal: the dimmed overlay and the dialog, put on <body>. Inside
  // the page an overlay is only as "fixed" as its ancestors allow -- a
  // transformed or contained parent, or a host that rewrites the overlay
  // (the open screener's Guide drew at the end of the page). A click on the overlay closes it.
  const Modal = ({ onClose, label, style, overlayStyle, children, restoreFocus }) => {
    const overlay = React.createElement('div', {
      onMouseDown: (e) => { if (e.target === e.currentTarget && typeof onClose === 'function') onClose(); },
      style: {
        position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '5vh 16px', overflowY: 'auto', boxSizing: 'border-box',
        // Its own scroll ends at its own edge; the page behind is pinned.
        overscrollBehavior: 'contain',
        ...(overlayStyle || {}),
      },
    }, React.createElement(Frame, { onClose, label, style: { outline: 'none', ...(style || {}) }, restoreFocus }, children));
    return window.ReactDOM && window.ReactDOM.createPortal && document.body
      ? window.ReactDOM.createPortal(overlay, document.body)
      : overlay;
  };
  // A question asked in the page, where the browser's confirm() was: it
  // stopped the page, took the focus away and broke the Mini App (the tests keep confirm() out of js/).
  // Cancel comes first and has the focus; the focus goes back to the button
  // that asked when it closes.
  const themeIsDark = () => { try { return localStorage.getItem('eodhd_theme') === 'dark'; } catch (_) { return false; } };
  const Confirm = ({ title, text, confirmLabel, cancelLabel, danger, isDark, onConfirm, onCancel, restoreFocus }) => {
    const dark = isDark == null ? themeIsDark() : isDark;
    const btn = { padding: '10px 18px', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
    return React.createElement(Modal, {
      onClose: onCancel, label: title, restoreFocus,
      overlayStyle: { alignItems: 'center' },
      style: {
        background: dark ? '#1E222D' : '#ffffff', color: dark ? '#e5e7eb' : '#111827',
        border: '1px solid ' + (dark ? '#303640' : '#e2e4e9'), borderRadius: 16, padding: 22,
        width: '100%', maxWidth: 420, boxSizing: 'border-box',
      },
    },
      React.createElement('h2', { style: { margin: '0 0 10px', fontSize: 18, fontWeight: 700 } }, title),
      text ? React.createElement('p', { style: { margin: '0 0 20px', fontSize: 14, lineHeight: 1.55, color: dark ? '#b8bec9' : '#4b5563' } }, text) : null,
      React.createElement('div', { style: { display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' } },
        React.createElement('button', { type: 'button', onClick: onCancel, style: { ...btn, background: 'transparent', color: 'inherit', border: '1px solid ' + (dark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)') } }, cancelLabel || 'Cancel'),
        React.createElement('button', { type: 'button', onClick: onConfirm, style: { ...btn, border: 'none', color: '#ffffff', background: danger ? '#dc2626' : '#c2410c' } }, confirmLabel || 'OK')));
  };
  //   const [ask, askElement] = window.PTDialog.useAsk();
  //   if (!(await ask({ title, text, confirmLabel, danger }))) return;
  //   ... and {askElement} somewhere in what the component renders.
  // restoreFocus(opener, answered) gets the answer as well: after a "yes"
  // that deletes the opener's row, the focus belongs on a neighbour -- and the
  // focus is put back when the question closes, before the asker's code after
  // `await ask()` has removed anything.
  const useAsk = () => {
    const [q, setQ] = React.useState(null);
    const answerRef = React.useRef(false);
    const ask = React.useCallback((opts) => new Promise((resolve) => { answerRef.current = false; setQ({ ...(opts || {}), resolve }); }), []);
    const done = (v) => { answerRef.current = v; setQ(null); if (q) q.resolve(v); };
    const restore = q && typeof q.restoreFocus === 'function' ? (opener) => q.restoreFocus(opener, answerRef.current) : undefined;
    const element = q ? React.createElement(Confirm, { ...q, restoreFocus: restore, onConfirm: () => done(true), onCancel: () => done(false) }) : null;
    return [ask, element];
  };
  return { use, Frame, Modal, Confirm, useAsk, openerNow, _focusables: focusables, _findAgain: findAgain };
})();

// A field a ticker, symbol or search text is typed into. iOS capitalised and
// "corrected" codes as words (aapl -> Aapl, BRK.B -> BRK. B) and offered
// saved form text over the search's own list. Spread into every such field:
//   <input {...window.TickerFieldProps} ... />
window.TickerFieldProps = window.TickerFieldProps || Object.freeze({ autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, autoComplete: 'off' });

// Touch screens, the whole app and the open apps, in one sheet:
// - iOS Safari zooms the page into a field whose text is under 16 px when it
//   takes the focus, and stays zoomed. Text fields, selects and text areas
//   are 16 px on a touch screen ((hover: none) and (pointer: coarse));
//   desktop unchanged. [data-keep-font] keeps a larger size of its own.
// - WCAG 2.5.8: a control drawn under 24 x 24 px gets an invisible hit area
//   of at least 24 x 24 around it ([data-hit], a transparent ::after), the
//   drawn control unchanged; a field's frame focuses its field on a tap
//   ([data-field-frame], a label around it).
(function () {
  if (typeof document === 'undefined' || document.getElementById('mi-touch-sheet')) return;
  const css = [
    '@media (hover: none) and (pointer: coarse) {',
    '  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="color"]):not([type="file"]):not([type="image"]):not([data-keep-font]),',
    '  select:not([data-keep-font]), textarea:not([data-keep-font]) { font-size: 16px !important; }',
    '  /* Fields and dropdown triggers at least 24 px tall. :where() weighs',
    '     nothing: a screen floor of its own (the terminal 40 px one) still wins. */',
    '  :where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), select, textarea, button[aria-haspopup]) { min-height: 24px; }',
    '  /* A field at 16 px is wider by itself (wider still in Linux fonts), and',
    '     in a flex or grid row its automatic minimum is that width: it',
    '     squeezed the Send button beside it to 37 px and pushed the AI',
    '     Builder row off the screen. A field takes what its row leaves; a',
    '     min-width of its own still wins (:where() weighs nothing). */',
    '  :where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="color"]):not([type="file"]):not([type="image"]):not([type="hidden"]), select, textarea) { min-width: 0; }',
    '  /* ...but a field beside its buttons was then left 46-66 px on a phone',
    '     (the options AI Advisor, the alert line, the AI Builder). Such a row',
    '     ([data-field-row]) wraps when it is too narrow: its field',
    '     ([data-field-floor]) keeps a line of its own at full width and the',
    '     buttons go under it; a wide row does not wrap. The floor is 12em, or',
    '     the field\'s --field-floor. */',
    '  [data-field-row] { flex-wrap: wrap; }',
    '  [data-field-row] > [data-field-floor] { flex-basis: var(--field-floor, 12em) !important; }',
    '}',
    '/* A field that has its line to itself and still cuts its hint at 16 px',
    '   on the narrowest phones ("Ticker, e.g. AAPL, GOOG" in the open',
    '   Sentiment app, "Search ticker, e.g. AAPL" in the options explorer, at',
    '   320): the card around it ([data-field-card]) and a field with wide',
    '   padding of its own ([data-field-snug]) give up some of their side',
    '   padding there, so the hint keeps its words. Wider screens and desktop',
    '   unchanged. */',
    '@media (hover: none) and (pointer: coarse) and (max-width: 360px) {',
    '  [data-field-snug] { padding-left: 8px !important; padding-right: 8px !important; }',
    '  [data-field-card] { padding-left: 8px !important; padding-right: 8px !important; }',
    '}',
    '[data-hit] { position: relative; }',
    '[data-hit]::after { content: ""; position: absolute; left: 50%; top: 50%; width: 100%; height: 100%; min-width: 24px; min-height: 24px; transform: translate(-50%, -50%); }',
    '[data-hit="44"]::after { min-width: 44px; min-height: 44px; }',
    '/* Grown to one side only, where a centred area would reach over the text',
    '   of something else: "end" for a control after its label (a chip\'s',
    '   Remove x took the ticker\'s last letter), "start" for one before it,',
    '   "up" for one above a line of text (a watchlist row\'s ticker over its',
    '   company name), "down" for one below it. */',
    '[data-hit~="end"]::after { left: 0; transform: translateY(-50%); }',
    '[data-hit~="start"]::after { left: auto; right: 0; transform: translateY(-50%); }',
    '[data-hit~="up"]::after { top: auto; bottom: 0; transform: translateX(-50%); }',
    '[data-hit~="down"]::after { top: 0; transform: translateX(-50%); }',
    '[data-field-frame] { cursor: text; }',
  ].join('\n');
  const put = () => {
    if (document.getElementById('mi-touch-sheet')) return;
    const el = document.createElement('style');
    el.id = 'mi-touch-sheet';
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  };
  if (document.head) put(); else document.addEventListener('DOMContentLoaded', put);
})();
