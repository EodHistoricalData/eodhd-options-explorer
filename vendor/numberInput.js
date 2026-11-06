// Numbers typed into a form field, read the same way in every app.
//
// <input type="number"> could not be trusted with a comma: Chrome with an
// English interface reads "250,5" as 2505 and "1,5" shares as 15, and the
// page only ever sees the corrupted value. The
// fields are plain text now (inputMode "decimal" keeps the number keyboard on
// phones) and this module reads what was actually typed:
//
//   "250.5"  "250,5"  " 250.50 "        -> 250.5
//   "1,234.5"  "1.234,5"  "1 234,5"     -> 1234.5
//   "1,234,567"  "1.234.567"            -> 1234567
//   "1,234" / "12,500"                  -> not guessed: a comma before exactly
//                                          three digits is a thousands comma
//                                          to some and a decimal one to others
//
// check(raw, { integer }) says why a value can't be read, for the line under
// the field, with a whole-number example for a whole-number field;
// parse(raw) is the number or NaN. An empty field is NaN with no error -- the
// form decides whether the field is required.
//
// Plain JS, no dependencies; loads before every view with a number field.
window.NumberInput = (() => {
  const AMBIGUOUS = 'Is that a thousands comma or a decimal one? Write it without the comma (1234) or with a dot (1.234).';
  const NOT_A_NUMBER = 'Enter a number, e.g. 250.5';
  // A field that takes whole numbers only (a contract quantity, days before
  // an event) is not advised to type 250.5.
  const NOT_A_WHOLE_NUMBER = 'Enter a whole number, e.g. 5';

  // opts.integer: the field takes whole numbers; only the advice differs.
  const check = (raw, opts) => {
    const r = checkText(raw);
    return r.error === NOT_A_NUMBER && opts && opts.integer ? { ...r, error: NOT_A_WHOLE_NUMBER } : r;
  };
  const checkText = (raw) => {
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? { value: raw, error: null, empty: false } : { value: NaN, error: NOT_A_NUMBER, empty: false };
    }
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return { value: NaN, error: null, empty: true };
    // Spaces, apostrophes and the usual currency signs group or decorate.
    s = s.replace(/[\s  '’$€£¥₽₹]/g, '').replace(/^\+/, '');
    let neg = false;
    if (/^[-−]/.test(s)) { neg = true; s = s.slice(1); }
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return { value: NaN, error: NOT_A_NUMBER, empty: false };

    const commas = (s.match(/,/g) || []).length;
    const dots = (s.match(/\./g) || []).length;
    let plain;
    if (commas && dots) {
      // Both: the last one is the decimal separator, and it appears once.
      const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      const grp = dec === ',' ? '.' : ',';
      if (s.split(dec).length - 1 !== 1) return { value: NaN, error: NOT_A_NUMBER, empty: false };
      const [intPart, frac] = s.split(dec);
      if (!groupedOk(intPart, grp)) return { value: NaN, error: NOT_A_NUMBER, empty: false };
      plain = intPart.split(grp).join('') + '.' + frac;
    } else if (commas || dots) {
      const sep = commas ? ',' : '.';
      const n = commas || dots;
      if (n > 1) {
        // 1,234,567 or 1.234.567: grouping only.
        if (!groupedOk(s, sep)) return { value: NaN, error: NOT_A_NUMBER, empty: false };
        plain = s.split(sep).join('');
      } else {
        const [a, b] = s.split(sep);
        if (sep === ',' && a !== '' && a !== '0' && b.length === 3) {
          return { value: NaN, error: AMBIGUOUS, empty: false };
        }
        // A single dot is a decimal point (the interface is English); a single
        // comma not followed by exactly three digits is a decimal comma.
        plain = (a || '0') + '.' + b;
      }
    } else {
      plain = s;
    }
    if (!/^\d*\.?\d+$/.test(plain) && !/^\d+\.?$/.test(plain)) return { value: NaN, error: NOT_A_NUMBER, empty: false };
    const v = parseFloat(plain);
    if (!Number.isFinite(v)) return { value: NaN, error: NOT_A_NUMBER, empty: false };
    return { value: neg ? -v : v, error: null, empty: false };
  };

  // "1,234,567": every group after the first is three digits.
  function groupedOk(s, sep) {
    const parts = s.split(sep);
    if (parts.length === 1) return /^\d+$/.test(parts[0]);
    if (!/^\d{1,3}$/.test(parts[0])) return false;
    return parts.slice(1).every((p) => /^\d{3}$/.test(p));
  }

  const parse = (raw) => check(raw).value;

  // Props for a number field: text, with the number keyboard on phones. The
  // value stays whatever the user typed; read it with parse().
  const fieldProps = { type: 'text', inputMode: 'decimal', autoComplete: 'off', spellCheck: false };

  return { check, parse, fieldProps, AMBIGUOUS, NOT_A_NUMBER, NOT_A_WHOLE_NUMBER };
})();
