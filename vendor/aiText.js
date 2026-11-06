// What an AI answer, or an AI failure, looks like on screen. One place for
// every view that asks a model something:
//
//  - error(e): a failure as one readable sentence. A provider error used to
//    reach the page as the proxy's raw body -- {"content":"AI provider: ..."}
//    -- and options and the index printed it inside the answer card, under
//    "AI GEX Interpretation" and over "Powered by AI", so a failure read as
//    an answer.
//  - markdown(text): the safe subset the terminal's answers use -- headings,
//    bullet and numbered lines, **bold**, *italic* -- as React elements.
//    Never HTML: the model's text is only ever a text node. Options and the
//    index rendered **bold** alone, and "## Risks" and "- item" showed as
//    typed.
//  - errorBox(message, isDark): the error state those cards show instead.
//
// Plain JS (no JSX), loaded before the views; the views fall back to their
// old behaviour if it is missing.
window.AIText = (() => {
  const strip = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  const fromBody = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      try {
        const j = JSON.parse(s);
        if (j && typeof j === 'object') {
          const inner = j.content || j.error || j.message || j.detail;
          if (typeof inner === 'string' && inner.trim()) return fromBody(inner) || strip(inner);
          if (inner && typeof inner === 'object' && typeof inner.message === 'string') return strip(inner.message);
          if (j.errors && typeof j.errors === 'object') {
            const fields = Object.keys(j.errors).slice(0, 3).join(', ');
            return `The request was rejected${fields ? ` (${fields})` : ''}.`;
          }
        }
      } catch (_) { /* not JSON after all; fall through */ }
    }
    if (s.charAt(0) === '<') return 'The AI service answered with an error page instead of a reply.';
    return strip(s);
  };

  // The one sentence for "no tokens left", on every AI surface (chat and Macro
  // Briefing said it two different ways).
  const OUT_OF_TOKENS = 'AI analysis is off. Add OPENAI_API_KEY to .env and restart to enable it.';

  const error = (e) => {
    let msg = e && typeof e === 'object' && 'message' in e ? e.message : e;
    // A prefix some callers glued on before this existed.
    msg = String(msg == null ? '' : msg).replace(/^\s*(AI (analysis failed|error):\s*)+/i, '');
    msg = fromBody(msg) || 'The AI request failed.';
    if (msg === 'AI_TOKENS_REQUIRED' || msg === 'insufficient_tokens') return OUT_OF_TOKENS;
    if (msg.length > 280) msg = msg.slice(0, 277) + '…';
    return msg;
  };

  const markdown = (text) => {
    if (!text) return null;
    const h = React.createElement;
    const elements = [];
    let key = 0;
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

    // [label](https://…) is a link; anything but http(s) stays text, so a
    // model's javascript: or data: link never becomes one. It showed as the
    // raw brackets.
    const safeHref = (raw) => {
      try {
        const u = new URL(String(raw).trim());
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
      } catch (_) { return null; }
    };
    const parseInline = (str) => {
      const parts = [];
      const regex = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|`([^`]+)`/g;
      let lastIdx = 0;
      let m;
      while ((m = regex.exec(str)) !== null) {
        if (m.index > lastIdx) parts.push(str.substring(lastIdx, m.index));
        if (m[1]) {
          const href = safeHref(m[2]);
          parts.push(href
            ? h('a', { key: `md-${key++}`, href, target: '_blank', rel: 'noopener noreferrer nofollow', style: { color: 'inherit', textDecoration: 'underline' } }, m[1])
            : m[1]);
        }
        else if (m[3]) parts.push(h('strong', { key: `md-${key++}` }, m[3]));
        else if (m[4]) parts.push(h('em', { key: `md-${key++}` }, m[4]));
        else if (m[5]) parts.push(h('code', { key: `md-${key++}` }, m[5]));
        lastIdx = regex.lastIndex;
      }
      if (lastIdx < str.length) parts.push(str.substring(lastIdx));
      return parts.length > 0 ? parts : [str];
    };

    lines.forEach((line, li) => {
      if (!line.trim()) {
        if (li > 0) elements.push(h('div', { key: `sp-${key++}`, style: { height: 8 } }));
        return;
      }
      const hm = line.match(/^\s*(#{1,6})\s+(.+)/);
      if (hm) {
        const sz = { 1: 17, 2: 15 }[hm[1].length] || 14;
        elements.push(h('div', { key: `h-${key++}`, role: 'heading', 'aria-level': Math.min(hm[1].length + 2, 6), style: { fontSize: sz, fontWeight: 700, marginTop: li > 0 ? 6 : 0, marginBottom: 2 } }, ...parseInline(hm[2])));
        return;
      }
      const bm = line.match(/^\s*[-•*]\s+(.+)/);
      if (bm) {
        elements.push(h('div', { key: `li-${key++}`, style: { display: 'flex', gap: 6, paddingLeft: 4, marginTop: 2 } },
          h('span', { style: { flexShrink: 0 }, 'aria-hidden': true }, '•'),
          h('span', null, ...parseInline(bm[1]))));
        return;
      }
      const nm = line.match(/^\s*(\d+)[.)]\s+(.+)/);
      if (nm) {
        elements.push(h('div', { key: `ol-${key++}`, style: { display: 'flex', gap: 6, paddingLeft: 4, marginTop: 2 } },
          h('span', { style: { flexShrink: 0, minWidth: 18 } }, `${nm[1]}.`),
          h('span', null, ...parseInline(nm[2]))));
        return;
      }
      elements.push(h('span', { key: `t-${key++}` }, ...parseInline(line)));
      if (li < lines.length - 1) elements.push(h('br', { key: `br-${key++}` }));
    });
    return elements;
  };

  const errorBox = (message, isDark) => React.createElement('div', {
    role: 'alert',
    style: {
      marginTop: 12, padding: '12px 14px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
      background: isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)',
      border: '1px solid ' + (isDark ? 'rgba(239,68,68,0.35)' : 'rgba(185,28,28,0.3)'),
      color: isDark ? '#fca5a5' : '#b91c1c',
    },
  }, React.createElement('strong', null, 'AI analysis unavailable. '), message);

  return { error, markdown, errorBox, OUT_OF_TOKENS };
})();

// The terminal's views call window.renderMarkdown; same renderer.
window.renderMarkdown = window.AIText.markdown;
