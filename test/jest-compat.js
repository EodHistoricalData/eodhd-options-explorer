/**
 * The part of Jest these tests use, on Node's own test runner.
 *
 * The tests in this folder are the ones the server is checked with before
 * every release, as they are written there: for Jest. Installing Jest here
 * would add a few hundred packages to a repository whose one dependency is
 * esbuild, so `npm test` runs them with `node --test` instead, and this file
 * supplies the dozen pieces of Jest they reach for -- describe, test,
 * test.each, expect with its matchers, and jest.fn -- on node:test and
 * node:assert. Nothing to install; Node 20 or later.
 */
'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert');
const { inspect } = require('node:util');

const show = (v) => inspect(v, { depth: 4, breakLength: Infinity });

// expect.stringMatching(pattern): inside toEqual, any string it matches.
class StringMatching {
  constructor(pattern) { this.pattern = pattern; }
  matches(v) { return typeof v === 'string' && (this.pattern instanceof RegExp ? this.pattern.test(v) : v.includes(this.pattern)); }
  [inspect.custom]() { return 'StringMatching ' + show(this.pattern); }
}

// Jest's equality for toEqual: own enumerable keys, recursively, with a key
// whose value is undefined counted as absent.
function equal(a, b) {
  if (b instanceof StringMatching) return b.matches(a);
  if (a instanceof StringMatching) return a.matches(b);
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b);
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const keys = (o) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
}

function calls(fn) {
  if (!fn || !fn.mock) throw new TypeError(show(fn) + ' is not a jest.fn()');
  return fn.mock.calls.length;
}

// Each matcher answers whether it passed and what to say when it did not.
const MATCHERS = {
  toBe: (got, want) => [Object.is(got, want), 'to be ' + show(want)],
  toEqual: (got, want) => [equal(got, want), 'to equal ' + show(want)],
  toBeNull: (got) => [got === null, 'to be null'],
  toBeUndefined: (got) => [got === undefined, 'to be undefined'],
  toContain: (got, item) => [got != null && typeof got.includes === 'function' && got.includes(item), 'to contain ' + show(item)],
  toMatch: (got, re) => [typeof got === 'string' && (re instanceof RegExp ? re.test(got) : got.includes(re)), 'to match ' + show(re)],
  toHaveLength: (got, n) => [got != null && got.length === n, 'to have length ' + n],
  toBeGreaterThan: (got, n) => [got > n, 'to be greater than ' + n],
  toBeLessThan: (got, n) => [got < n, 'to be less than ' + n],
  toBeLessThanOrEqual: (got, n) => [got <= n, 'to be at most ' + n],
  toHaveBeenCalled: (fn) => [calls(fn) > 0, 'to have been called'],
  toHaveBeenCalledTimes: (fn, n) => [calls(fn) === n, 'to have been called ' + n + ' time(s), not ' + calls(fn)],
};

function expect(got) {
  const build = (negate) => {
    const out = {};
    for (const [name, check] of Object.entries(MATCHERS)) {
      out[name] = (...args) => {
        const [ok, says] = check(got, ...args);
        if (ok === negate) assert.fail('expected ' + show(got) + (negate ? ' not ' : ' ') + says);
      };
    }
    return out;
  };
  const matchers = build(false);
  matchers.not = build(true);
  // expect(promise).rejects.toThrow(message): the promise fails, with that
  // message (a string it contains, or a pattern it matches).
  matchers.rejects = {
    toThrow: async (message) => {
      let error = null;
      try { await got; } catch (e) { error = e || new Error(String(e)); }
      if (!error) assert.fail('expected the promise to reject');
      if (message === undefined) return;
      const text = String(error && error.message !== undefined ? error.message : error);
      const ok = message instanceof RegExp ? message.test(text) : text.includes(message);
      if (!ok) assert.fail('expected the rejection ' + show(text) + ' to say ' + show(message));
    },
  };
  return matchers;
}
expect.stringMatching = (pattern) => new StringMatching(pattern);

// jest.fn(impl): a function that records its calls, with a queue of
// one-time implementations in front of the default one.
function fn(impl) {
  const once = [];
  const mock = function (...args) {
    mock.mock.calls.push(args);
    const run = once.length ? once.shift() : impl;
    return run ? run.apply(this, args) : undefined;
  };
  mock.mock = { calls: [] };
  mock.mockImplementationOnce = (f) => { once.push(f); return mock; };
  return mock;
}

// Jest's printf for test.each names: %s, %p, %d, %i, %j, %o and %%.
function title(name, row) {
  const args = row.slice();
  return String(name).replace(/%([spdijo%])/g, (whole, k) => {
    if (k === '%') return '%';
    if (!args.length) return whole;
    const v = args.shift();
    if (k === 'd' || k === 'i') return String(Math.trunc(Number(v)));
    if (k === 's') return String(v);
    return show(v);
  });
}

function withEach(run) {
  const wrapped = (name, f, timeout) => (typeof timeout === 'number' ? run(name, { timeout }, f) : run(name, f));
  wrapped.each = (table) => (name, f, timeout) => {
    for (const entry of table) {
      const row = Array.isArray(entry) ? entry : [entry];
      wrapped(title(name, row), () => f(...row), timeout);
    }
  };
  return wrapped;
}

global.describe = (name, f) => nodeTest.describe(name, f);
global.test = withEach(nodeTest.test);
global.it = global.test;
global.expect = expect;
global.jest = { fn };
global.beforeAll = nodeTest.before;
global.afterAll = nodeTest.after;
global.beforeEach = nodeTest.beforeEach;
global.afterEach = nodeTest.afterEach;
