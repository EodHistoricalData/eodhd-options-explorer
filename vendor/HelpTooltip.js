// HelpTooltip — question mark icon with popup explanation
// Usage: React.createElement(HelpTooltip, { title: 'Screener', text: '...', isDark: true })
//
// Why the popup is portaled (the dropdown used to shift on mobile):
// - Popup is portaled to document.body via ReactDOM.createPortal so a
//   backdrop-filter / transform / will-change ancestor cannot establish a
//   containing block for the fixed popup. Without the portal, WebKit anchors
//   the popup to the filtered ancestor instead of the viewport, and on
//   scrolled glass cards the popup visibly drifts away from the trigger.
// - Position recompute now also subscribes to window.visualViewport (catches
//   keyboard show/hide and pinch-zoom that don't fire window resize on iOS)
//   and to Telegram.WebApp 'viewportChanged' (fires when the TG keyboard
//   pushes the WebApp viewport but window.innerHeight stays the same).
// - Recompute is wrapped in requestAnimationFrame so the rect we read is the
//   one rendered after the viewport change, not the one before.
// One "?" open at a time: two could be open at once,
// overlapping, both with the id help-tooltip-popup, and a click elsewhere
// closed them only on mousedown. Opening one now tells the others to close,
// and each popup has its own id.
let helpTooltipSeq = 0;
window.HelpTooltip = ({ title, text, isDark }) => {
  const [open, setOpen] = React.useState(false);
  const popupIdRef = React.useRef(null);
  if (popupIdRef.current === null) popupIdRef.current = 'help-tooltip-popup-' + (++helpTooltipSeq);
  const popupId = popupIdRef.current;
  React.useEffect(() => {
    if (!open) return;
    try { document.dispatchEvent(new CustomEvent('helptooltip:open', { detail: popupId })); } catch (_) {}
    const onOther = (e) => { if (e.detail !== popupId) setOpen(false); };
    document.addEventListener('helptooltip:open', onOther);
    return () => document.removeEventListener('helptooltip:open', onOther);
  }, [open, popupId]);
  const ref = React.useRef(null);
  const btnRef = React.useRef(null);
  // Escape puts the focus back on the "?". WebKit does not focus a button
  // that is clicked, so a "?" opened with the mouse left the focus on
  // <body> after Escape; Chromium had it on the button.
  const closeByEsc = () => {
    setOpen(false);
    const b = btnRef.current;
    const a = document.activeElement;
    if (!b || !b.isConnected) return;
    if (!a || a === document.body || a === document.documentElement || a === b) {
      try { b.focus({ preventScroll: true }); } catch (_) {}
    }
  };
  (window.useEscLayer || (() => {}))(open, closeByEsc);
  const [pos, setPos] = React.useState(null); // { top, left, arrowOffset }
  const Icon = window.Icon;

  const POPUP_W = 280;
  const MARGIN = 10;

  const computePos = React.useCallback(() => {
    const b = btnRef.current;
    if (!b) return null;
    const r = b.getBoundingClientRect();
    // Prefer visualViewport on mobile — accounts for the on-screen keyboard
    // and pinch-zoom in a way that window.innerWidth/innerHeight don't.
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const offsetTop = vv ? vv.offsetTop : 0;
    const offsetLeft = vv ? vv.offsetLeft : 0;
    const iconCenter = r.left + r.width / 2;
    // The width it really takes (border-box below), never more than the
    // screen less the margins: 280 px of text plus padding was 314 px, placed
    // as 280, and ran off the right edge of a phone.
    const w = Math.min(POPUP_W, vw - 2 * MARGIN);
    let left = iconCenter - w / 2;
    if (left < MARGIN + offsetLeft) left = MARGIN + offsetLeft;
    else if (left + w > vw + offsetLeft - MARGIN) left = vw + offsetLeft - MARGIN - w;
    const arrowOffset = Math.max(12, Math.min(w - 12, iconCenter - left));
    // r.bottom is in layout-viewport coordinates; on iOS Safari position:fixed
    // also anchors to the layout viewport (not the visual viewport), so we
    // don't subtract offsetTop here. Visual-viewport offsets only matter for
    // clamping the popup against the user-visible width above.
    return { top: r.bottom + 8, left, arrowOffset, width: w };
  }, []);

  // Recompute on open + on every viewport change while open
  React.useEffect(() => {
    if (!open) { setPos(null); return; }
    let raf = null;
    const recompute = () => {
      if (raf) cancelAnimationFrame(raf);
      // Wait one frame so the rect we read is post-keyboard-transition.
      raf = requestAnimationFrame(() => { setPos(computePos()); raf = null; });
    };
    recompute();
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
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', recompute, true);
      window.removeEventListener('resize', recompute);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', recompute);
        window.visualViewport.removeEventListener('scroll', recompute);
      }
      if (tgUnsub) tgUnsub();
    };
  }, [open, computePos]);

  // Close on click outside (the trigger is local, the popup is portaled —
  // we explicitly check both subtrees so a click inside the popup doesn't close it).
  React.useEffect(() => {
    if (!open) return;
    const popupEl = () => document.getElementById(popupId);
    const handler = (e) => {
      const inTrigger = ref.current && ref.current.contains(e.target);
      const p = popupEl();
      const inPopup = p && p.contains(e.target);
      if (!inTrigger && !inPopup) setOpen(false);
    };
    // The focus leaving it closes it too: Tab on to "Templates & Funds" and
    // Enter left the "?" over the window that opened (z 9999 against 50),
    // and the first Escape closed the window under it.
    // Only a mouse or a finger closed it before.
    const onFocusIn = (e) => {
      const t = e.target;
      if (!t || t === document.body || t === document) return;
      const inTrigger = ref.current && ref.current.contains(t);
      const p = popupEl();
      const inPopup = p && p.contains(t);
      if (!inTrigger && !inPopup) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [open, popupId]);

  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') closeByEsc(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const border = isDark ? '#303640' : '#e2e4e9';
  const bg = isDark ? '#1E222D' : '#ffffff';
  const textMuted = isDark ? '#878B93' : '#6b7280';

  // Popup is rendered as a portal child of document.body so no transformed /
  // filtered / backdrop-filtered ancestor in the trigger's React subtree can
  // form a containing block for it.
  const popup = open && pos && React.createElement('div', {
    id: popupId,
    // The shared name stays as a class: styles and tests that looked the
    // popup up by it still find it.
    className: 'help-tooltip-popup',
    role: 'tooltip',
    style: {
      position: 'fixed', top: pos.top, left: pos.left,
      width: pos.width, boxSizing: 'border-box', padding: '14px 16px',
      background: bg, border: `1px solid ${border}`,
      borderRadius: 10, boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.4)' : '0 8px 24px rgba(0,0,0,0.12)',
      zIndex: 9999, fontFamily: 'Inter, sans-serif',
    },
  },
    React.createElement('div', {
      style: {
        position: 'absolute', top: -6, left: pos.arrowOffset - 5,
        transform: 'rotate(45deg)',
        width: 10, height: 10, background: bg, border: `1px solid ${border}`,
        borderRight: 'none', borderBottom: 'none',
      },
    }),
    title && React.createElement('div', {
      style: { fontSize: 13, fontWeight: 700, marginBottom: 6, color: isDark ? '#E0E3EB' : '#1e1b4b' },
    }, title),
    React.createElement('div', {
      style: { fontSize: 12, lineHeight: 1.6, color: textMuted },
    }, text),
  );

  const coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse), (max-width: 1024px)').matches);

  return React.createElement('div', {
    ref,
    style: { display: 'inline-flex', alignItems: 'center' },
  },
    React.createElement('button', {
      ref: btnRef,
      // With a mouse the icon is 19 x 19: an invisible 24 px hit area.
      'data-hit': '',
      onClick: (e) => { e.stopPropagation(); setOpen(!open); },
      // Touch: a 40x40 hit area around the 15 px icon, with the extra taken
      // back by a negative margin so the header layout does not move (it was
      // a 19x19 target). Opacity raised for contrast.
      // It takes 23 px of its row's height, not 19: between a
      // label and the field under it (the screener's filters, 37 px from
      // field to field) the 40 px reached 3-4 px into both fields, and a tap
      // at a field's edge opened the help. It reaches
      // 11 px above its row and 6 below, where a field follows closest.
      style: {
        background: 'none', border: 'none', cursor: 'pointer',
        padding: coarsePointer ? 12.5 : 2, margin: coarsePointer ? '-11px -10.5px -6px' : 0,
        // Full opacity: at 0.75 the icon read 2.65-3.0:1 in light; the grey itself is the muted tone, hover darkens it.
        display: 'flex', alignItems: 'center',
        transition: 'filter 0.15s',
      },
      onMouseEnter: (e) => { e.currentTarget.style.filter = isDark ? 'brightness(1.3)' : 'brightness(0.7)'; },
      onMouseLeave: (e) => { e.currentTarget.style.filter = ''; },
      title: 'What is this?',
      'aria-label': title ? 'What is ' + title + '?' : 'What is this?',
      'aria-expanded': open,
      'aria-controls': open ? popupId : undefined,
    },
      React.createElement(Icon, { name: 'helpCircle', size: 15, color: isDark ? '#878B93' : '#6b7280' })
    ),
    // Portal the popup out of the trigger's subtree so glass/transform
    // ancestors don't capture it as a containing block.
    popup && (window.ReactDOM?.createPortal
      ? window.ReactDOM.createPortal(popup, document.body)
      : popup),
  );
};

// PageHeader — title with help tooltip, reusable across all feature pages
// Usage: React.createElement(PageHeader, { title: 'Screener', help: '...', isDark })
window.PageHeader = ({ title, help, isDark, children }) => {
  return React.createElement('div', {
    style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 },
  },
    React.createElement('h2', {
      style: { fontSize: 20, fontWeight: 700, margin: 0 },
    }, title),
    help && React.createElement(window.HelpTooltip, { title, text: help, isDark }),
    children,
  );
};
