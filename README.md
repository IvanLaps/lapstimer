# Lapstimer

A phone-first work-lap timer with a **waste-time timer**. Plain HTML/CSS/JS, no build step, installable as a PWA, works offline.

## How it works

1. **Plan your day:** pick the work period (e.g. 8h), lap length (e.g. 1h), break length (e.g. 15m) and the time you get to start the next lap (e.g. 10s).
2. **Start day:** the first lap starts. When it ends, the break starts, then the start window counts down.
3. If you don't start a new lap in time, the **waste timer** starts automatically. **Pausing** a lap also counts as waste.
4. To stop waste time (Start lap, Resume, End lap, End day), you must give a **reason**: pick one or type your own, with an optional note. *Keep wasting* cancels.
5. The day ends when the period runs out. A new calendar day starts fresh, and finished days go into history.

**Reports** (bar-chart icon): Today / 7 days / 30 days, showing worked/wasted/focus totals, hours per day, waste by reason, a per-day table and the waste log. Both can be exported as CSV.

Every time is calculated from saved timestamps, so closing the tab or locking the phone doesn't lose time. When you come back, the app catches up on everything that happened.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Use it on your phone

Wake Lock and offline mode need **HTTPS**, so host the folder on any static host, such as GitHub Pages, Netlify or Cloudflare Pages. Then open the URL on your phone and use **Add to Home Screen**.

Data is stored in the browser (`localStorage`) on that device only.

## Limitations

- Phones pause web pages when the screen is off, so a sound may only play once you look at the screen again. That's why *Keep screen awake* (⋯ menu, on by default) matters.
- *Keep screen awake* uses the Wake Lock API when the browser offers it (HTTPS only). Otherwise, and always on iPhone, it plays a tiny muted looping video (`media/`, taken from [NoSleep.js](https://github.com/richtr/NoSleep.js), MIT license).
- *Ring in silent mode* (iPhone, iOS 17+) makes sounds play even with the silent switch on. While it's on, opening the app may pause music playing in another app. Turn it off if you listen to music while working.
- The ⋯ menu shows whether the screen-awake and sound features are working, and has a *Test sound* button.
- iPhones don't support vibration from web pages.

## Files

- `index.html`: markup
- `styles.css`: styles (portrait + landscape)
- `app.js`: timer engine, UI, reports
- `sw.js`: offline cache (bump `CACHE` when you change files)
- `manifest.webmanifest`, `icons/`: install metadata
- `media/`: keep-awake fallback video
