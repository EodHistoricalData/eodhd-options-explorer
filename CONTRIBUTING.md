# Contributing

Thanks for looking. This is a small app and we would like it to stay one, so
the bar for a change is "does a stranger with their own EODHD key get more out
of it afterwards".

## Reporting a bug

Open an issue with the template. The three things that decide whether we can
reproduce it are your Node version (`node --version`), your operating system,
and which EODHD plan the key is on — the free tier and a paid plan see
different responses from the same request, and most of what goes wrong here is
about that difference. Never paste your key; paste what the page or the
server console said instead.

## Sending a change

Pull requests are welcome. Two things to know before you start:

- **Every file in this repository is generated.** `vendor/` is copied from our
  terminal's source; `shell/`, `server/`, `boot.js`, `app.js`, `build.js`,
  `index.html`, this file and the README come from the private generator the
  seven sample apps share. The next sync overwrites any edit made here
  directly. Send the change anyway — we port it upstream, and it lands here on
  the following sync with you credited in the commit. Say in the PR which
  files it touches, so we know where to carry it.
- **Keep the one promise the whole thing is built on:** the key stays in
  `.env` on the developer's machine and is never sent to the browser.
  `server/proxy.js` is where that promise lives; read its header before
  touching it.

Keep a PR to one thing. No dependencies unless the change cannot be made
without one — installing a sample app should not pull down a tree a
stranger has to audit before running it.

## Running it

```
npm ci                   # exactly what package-lock.json pins; use npm install only to change a dependency
cp .env.example .env     # Windows cmd: copy .env.example .env — then put your EODHD key in
npm start                # http://localhost:5173 (PORT=5174 in .env for another port)
npm test                 # the server's tests, on Node's own test runner
```

Node 20 or newer. `npm test` runs the tests of `server/proxy.js` that are kept
in `test/`; they need no key and no network. They are generated too, like
everything else here: on our side they run with the rest of the generator's
suite on every sync, and a change to them is carried upstream the same way.
