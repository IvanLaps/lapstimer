(() => {
  'use strict';

  /* ================= constants ================= */
  const STATE_KEY = 'lapstimer.state.v1';
  const HIST_KEY = 'lapstimer.history.v1';
  const REASONS_KEY = 'lapstimer.reasons.v1';
  const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
  const RING_C = 2 * Math.PI * 90;

  const DEFAULTS = { periodMin: 480, lapMin: 60, breakMin: 15, graceSec: 10, sound: true, wakeLock: true, silentRing: true, theme: 'auto' };

  // Phases:
  //   setup  – day not started
  //   work   – lap running                     (counts as work)
  //   paused – lap paused                      (counts as waste)
  //   break  – break after a lap               (counts as break)
  //   grace  – short window to start next lap  (counts as break)
  //   waste  – nothing started, wasting time   (counts as waste)
  //   food   – food break, open-ended          (counts as food, not waste;
  //            if started during a lap, the lap is on hold and resumes after)
  //   done   – day period is over
  const ACTIVE = new Set(['work', 'paused', 'break', 'grace', 'waste', 'food']);
  const WASTING = new Set(['paused', 'waste']);
  const KIND = { work: 'work', paused: 'waste', waste: 'waste', break: 'brk', grace: 'brk', food: 'food' };
  const DEFAULT_REASONS = [
    'Phone / social media', 'Unplanned call or meeting', 'Interrupted', 'Lost focus',
    'Tired', 'Food / coffee', 'Personal errand',
  ];
  const NO_REASON = 'No reason given';
  const FOOD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" class="ico"><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 1-3 3.5-3 7h3v11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

  // Option chips. Tap selects; hold edits the option's value (saved as a new preset).
  const FIELDS = [
    { key: 'periodMin', chips: 'periodChips', values: [240, 360, 480, 600], unit: 'h',
      label: fmtDur, toInput: v => +(v / 60).toFixed(2), fromInput: x => Math.round(x * 60), min: 15, max: 960 },
    { key: 'lapMin', chips: 'lapChips', values: [25, 45, 60, 90], unit: 'min',
      label: fmtDur, toInput: v => v, fromInput: Math.round, min: 1, max: 600 },
    { key: 'breakMin', chips: 'breakChips', values: [5, 10, 15, 20], unit: 'min',
      label: fmtDur, toInput: v => v, fromInput: Math.round, min: 0, max: 120 },
    { key: 'graceSec', chips: 'graceChips', values: [5, 10, 30, 60], unit: 'sec',
      label: v => `${v}s`, toInput: v => v, fromInput: Math.round, min: 1, max: 600 },
  ];
  const NEXT_FIELD = { key: 'nextLap', values: [25, 30, 45, 60, 90], unit: 'min',
    label: fmtDur, toInput: v => v, fromInput: Math.round, min: 1, max: 600 };

  /* ================= helpers ================= */
  const el = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = str => String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  /** h:mm:ss or m:ss. Countdowns use ceil so they show 1:00:00 at start and hit 0 exactly at the end. */
  function fmt(ms, round = 'floor') {
    const t = Math[round](Math.max(0, ms) / SEC);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function fmtDur(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h && m ? `${h}h${pad(m)}` : h ? `${h}h` : `${m}m`;
  }
  function short(ms) {
    const m = Math.floor(ms / MIN), h = Math.floor(m / 60);
    return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
  }
  function clock(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  /** 2:13 AM / 11:05 PM */
  function clock12(ts) {
    const d = new Date(ts), h = d.getHours();
    return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function keyToDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function dateLabel(key) {
    return keyToDate(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const focusPct = (work, waste) => (work + waste ? Math.round(work / (work + waste) * 100) : 0);

  /* ================= state ================= */
  function freshState(settings) {
    const st = { ...DEFAULTS, ...(settings || {}) };
    return {
      v: 1,
      date: dayKey(),
      settings: st,
      phase: 'setup',
      dayStart: null, dayEnd: null, endedAt: null,
      phaseStart: null,
      lapStart: null, lapTarget: 0, lapWorked: 0, lapPaused: 0, lapFood: 0,
      nextLapMin: st.lapMin,
      totals: { work: 0, waste: 0, brk: 0, food: 0 },
      segs: [],    // timeline: [{k:'work'|'waste'|'brk', a:start, b:end}]
      laps: [],    // [{n, start, end, target, worked, paused, how}]
      wastes: [],  // waste incidents: [{start, end, kind:'pause'|'idle', lap, reason, note}]
    };
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STATE_KEY));
      if (raw && raw.v === 1) {
        const base = freshState(raw.settings);
        return { ...base, ...raw, settings: base.settings, totals: { ...base.totals, ...raw.totals } };
      }
    } catch { /* ignore */ }
    return freshState();
  }
  function save() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }
  function loadHist() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; }
  }
  function loadReasons() {
    try { return JSON.parse(localStorage.getItem(REASONS_KEY)) || []; } catch { return []; }
  }
  function rememberReason(r) {
    if (DEFAULT_REASONS.includes(r)) return;
    const list = [r, ...loadReasons().filter(x => x !== r)].slice(0, 8);
    try { localStorage.setItem(REASONS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  }

  /** A day record (also used for the live "today" in reports). */
  function snapshot(s, now) {
    const tot = { ...s.totals };
    const active = ACTIVE.has(s.phase);
    if (active) tot[KIND[s.phase]] += now - s.phaseStart;
    const segs = s.segs.slice();
    if (active && now > s.phaseStart) segs.push({ k: KIND[s.phase], a: s.phaseStart, b: now, live: true });
    return {
      date: dayKey(s.dayStart), start: s.dayStart, end: s.endedAt || now, dayEnd: s.dayEnd,
      period: s.dayEnd - s.dayStart, ...tot, laps: s.laps.length,
      wastes: s.wastes.slice(), segs, live: active, lapList: s.laps.slice(),
    };
  }
  function archive(s) {
    if (!s.dayStart) return;
    const hist = loadHist();
    const rec = snapshot(s, s.endedAt || Date.now());
    delete rec.live;
    hist.push(rec);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(-400))); } catch { /* ignore */ }
    viewIdx = null;
  }

  /* ================= time engine ================= */
  function phaseEnd(s) {
    switch (s.phase) {
      case 'work': return s.phaseStart + (s.lapTarget - s.lapWorked);
      case 'break': return s.phaseStart + s.settings.breakMin * MIN;
      case 'grace': return s.phaseStart + s.settings.graceSec * SEC;
      default: return Infinity; // paused / waste run until the user acts or the day ends
    }
  }

  /** Close the running segment at time t and book it to the right bucket. */
  function accrue(s, t) {
    const d = Math.max(0, t - s.phaseStart);
    const k = KIND[s.phase];
    if (!k || d === 0) { s.phaseStart = t; return; }
    s.totals[k] += d;
    if (s.phase === 'work') s.lapWorked += d;
    if (s.phase === 'paused') s.lapPaused += d;
    if (s.phase === 'food' && s.lapStart !== null) s.lapFood += d;
    const last = s.segs[s.segs.length - 1];
    if (last && last.k === k && last.b === s.phaseStart) last.b = t;
    else s.segs.push({ k, a: s.phaseStart, b: t });
    s.phaseStart = t;
  }

  /** If we are in a wasting phase, log it as an incident. Must run before accrue(). */
  function closeWaste(s, t, reason = null, note = '') {
    if (!WASTING.has(s.phase) || t <= s.phaseStart) return;
    s.wastes.push({
      start: s.phaseStart, end: t,
      kind: s.phase === 'paused' ? 'pause' : 'idle',
      lap: s.phase === 'paused' ? s.laps.length + 1 : null,
      reason, note,
    });
  }

  function closeLap(s, t, how) {
    s.laps.push({
      n: s.laps.length + 1, start: s.lapStart, end: t,
      target: s.lapTarget, worked: s.lapWorked, paused: s.lapPaused, food: s.lapFood, how,
    });
    s.lapStart = null;
  }

  function finishDay(s, t, how) {
    if (s.lapStart !== null) closeLap(s, t, how);
    s.phase = 'done';
    s.endedAt = t;
  }

  /**
   * Replay every automatic transition up to `now`. Works no matter how long the
   * app was asleep: lap → break → grace → waste → (day end).
   */
  function advance(s, now) {
    const events = [];
    while (ACTIVE.has(s.phase)) {
      const end = Math.min(phaseEnd(s), s.dayEnd);
      if (now < end) break;
      if (end >= s.dayEnd) {
        closeWaste(s, end);
        accrue(s, end);
        finishDay(s, end, 'day');
        events.push({ name: 'dayDone', t: end });
        break;
      }
      accrue(s, end);
      if (s.phase === 'work') {
        closeLap(s, end, 'done');
        s.phase = 'break';
        events.push({ name: 'lapDone', t: end });
      } else if (s.phase === 'break') {
        s.phase = 'grace';
        events.push({ name: 'breakDone', t: end });
      } else if (s.phase === 'grace') {
        s.phase = 'waste';
        events.push({ name: 'wasteStart', t: end });
      }
    }
    return events;
  }

  function startLap(s, now, min) {
    accrue(s, now);
    s.lapStart = now;
    s.lapTarget = min * MIN;
    s.lapWorked = 0;
    s.lapPaused = 0;
    s.lapFood = 0;
    s.nextLapMin = min;
    s.phase = 'work';
  }

  /* ================= sound / vibration / wake lock ================= */
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let actx = null, audioPrimed = false;
  /** iOS: the 'playback' session makes sounds play even when the silent switch is on. */
  function applyAudioSession() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = state.settings.silentRing ? 'playback' : 'auto';
    } catch { /* ignore */ }
  }
  /** Must run inside a user gesture at least once (browsers block audio until then). */
  function unlockAudio() {
    try {
      applyAudioSession();
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      // iOS can leave the context 'suspended' or 'interrupted' (after a call, lock screen, etc.).
      if (actx.state !== 'running') actx.resume().catch(() => {});
      if (!audioPrimed) {
        // Starting a (silent) sound inside the gesture fully unlocks audio on iOS.
        const src = actx.createBufferSource();
        src.buffer = actx.createBuffer(1, 1, 22050);
        src.connect(actx.destination);
        src.start(0);
        audioPrimed = true;
      }
    } catch { actx = null; }
  }
  function tone(freq, at, dur = 0.18, vol = 0.3) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(actx.destination);
    o.start(at);
    o.stop(at + dur + 0.05);
  }
  const CUES = {
    lapDone:    { notes: [[880, 0, .25, .5], [880, .3, .25, .5], [1320, .6, .5, .5]], vib: [200, 100, 200, 100, 400] },
    breakDone:  { notes: [[660, 0, .25, .5], [990, .25, .4, .5]], vib: [150, 80, 150] },
    wasteStart: { notes: [[330, 0, .3, .5], [220, .3, .7, .5]], vib: [700] },
    dayDone:    { notes: [[523, 0, .2, .45], [659, .18, .2, .45], [784, .36, .2, .45], [1047, .54, .6, .45]], vib: [300, 100, 300, 100, 600] },
    tick:       { notes: [[1200, 0, .05, .15]], vib: [30] },
  };
  function cue(name) {
    const c = CUES[name];
    if (!c) return;
    if (state.settings.sound && actx) {
      const play = () => {
        try {
          const t0 = actx.currentTime + 0.03;
          for (const [f, off, dur, vol] of c.notes) tone(f, t0 + off, dur, vol);
        } catch { /* ignore */ }
      };
      if (actx.state === 'running') play();
      else actx.resume().then(play).catch(() => {});
    }
    try { navigator.vibrate && navigator.vibrate(c.vib); } catch { /* ignore */ }
  }

  /* Keep screen awake: the Wake Lock API when available (needs HTTPS), otherwise
     (and always on iOS, where it is unreliable in home-screen apps) a tiny muted
     looping video, the technique used by NoSleep.js. */
  let wakeLock = null, wakeBusy = false, wakeAgain = false, wakeVideo = null, wakeMode = 'off';
  function getWakeVideo() {
    if (wakeVideo) return wakeVideo;
    const v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.setAttribute('aria-hidden', 'true');
    v.muted = true;
    v.loop = true;
    v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;';
    for (const [src, type] of [['media/keepawake.webm', 'video/webm'], ['media/keepawake.mp4', 'video/mp4']]) {
      const s = document.createElement('source');
      s.src = src; s.type = type;
      v.appendChild(s);
    }
    v.addEventListener('timeupdate', () => { if (v.currentTime > 0.5) v.currentTime = Math.random() * 0.3; });
    document.body.appendChild(v);
    return (wakeVideo = v);
  }
  async function syncWakeLock() {
    if (wakeBusy) { wakeAgain = true; return; } // re-run once the current call finishes
    wakeBusy = true;
    wakeAgain = false;
    const want = state.settings.wakeLock && ACTIVE.has(state.phase) && document.visibilityState === 'visible';
    let native = false, video = false;
    try {
      if (want) {
        if ('wakeLock' in navigator) {
          try {
            if (!wakeLock) {
              wakeLock = await navigator.wakeLock.request('screen');
              wakeLock.addEventListener('release', () => { wakeLock = null; });
            }
            native = true;
          } catch { wakeLock = null; }
        }
        if (!native || IS_IOS) {
          const v = getWakeVideo();
          if (v.paused) await v.play();
          video = !v.paused;
        }
      } else {
        if (wakeLock) { await wakeLock.release().catch(() => {}); wakeLock = null; }
        if (wakeVideo && !wakeVideo.paused) wakeVideo.pause();
      }
    } catch { /* play() blocked until the next tap; retried on every tap */ }
    wakeMode = !want ? 'off' : native ? 'native' : video ? 'video' : 'failed';
    wakeBusy = false;
    renderDiag();
    if (wakeAgain) syncWakeLock();
  }

  function renderDiag() {
    const d = el('diag');
    if (!d) return;
    const wake = {
      off: state.settings.wakeLock ? 'on while a day is running' : 'off',
      native: 'on',
      video: 'on (fallback)',
      failed: window.isSecureContext ? 'blocked, tap the screen once' : 'not working, open the app over HTTPS',
    }[wakeMode];
    const snd = !state.settings.sound ? 'off'
      : !actx ? 'tap anywhere to enable'
      : actx.state === 'running' ? 'ready' : 'paused, tap anywhere';
    d.textContent = `Screen awake: ${wake} · Sound: ${snd}`;
  }

  /* ================= actions ================= */
  /** Actions that end a wasting phase must be explained first. */
  function needsReason(name) {
    const p = state.phase;
    if (p === 'paused') return name === 'resume' || name === 'endLap' || name === 'endDay' || name === 'food';
    if (p === 'waste') return name === 'startLap' || name === 'endDay' || name === 'food';
    return false;
  }

  function request(name) {
    unlockAudio();
    const now = Date.now();
    advance(state, now);
    if (name === 'endLap' && (state.phase === 'work' || state.phase === 'paused')) {
      const worked = state.lapWorked + (state.phase === 'work' ? now - state.phaseStart : 0);
      const msg = `End lap ${state.laps.length + 1} now?\n\n` +
        `Worked ${fmt(worked)} of ${fmtDur(state.lapTarget / MIN)}. Your break starts next.`;
      if (!confirm(msg)) return;
    }
    if (needsReason(name)) openReason(name);
    else perform(name);
  }

  function perform(name, why = { reason: null, note: '' }) {
    const now = Date.now();
    advance(state, now);
    const s = state;
    const leave = () => { closeWaste(s, now, why.reason, why.note); accrue(s, now); };
    switch (name) {
      case 'pause':
        if (s.phase === 'work') { leave(); s.phase = 'paused'; }
        break;
      case 'resume':
        if (s.phase === 'paused' || (s.phase === 'food' && s.lapStart !== null)) { leave(); s.phase = 'work'; }
        break;
      case 'food':
        if (['work', 'paused', 'break', 'grace', 'waste'].includes(s.phase)) { leave(); s.phase = 'food'; }
        break;
      case 'endLap':
        if (s.phase === 'work' || s.phase === 'paused') { leave(); closeLap(s, now, 'early'); s.phase = 'break'; }
        break;
      case 'startLap':
        if (s.phase === 'break' || s.phase === 'grace' || s.phase === 'waste' || (s.phase === 'food' && s.lapStart === null)) {
          leave(); startLap(s, now, s.nextLapMin);
        }
        break;
      case 'endDay':
        if (ACTIVE.has(s.phase)) { leave(); finishDay(s, now, 'stopped'); }
        break;
      case 'newSession':
        archive(s);
        state = freshState(s.settings);
        break;
      case 'report':
        setView('reports');
        return;
    }
    save();
    tick();
  }

  function startDay() {
    unlockAudio();
    // Ask the browser not to evict our data under storage pressure.
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {}); } catch { /* ignore */ }
    const now = Date.now();
    const s = state;
    s.date = dayKey(now);
    s.dayStart = now;
    s.dayEnd = now + s.settings.periodMin * MIN;
    s.phaseStart = now;
    startLap(s, now, s.settings.lapMin);
    save();
    tick();
  }

  /** A finished day rolls over to a fresh one once the calendar date changes. */
  function rollDay(now) {
    if (state.phase === 'setup') {
      if (state.date !== dayKey(now)) { state.date = dayKey(now); save(); }
    } else if (state.phase === 'done' && dayKey(state.endedAt) !== dayKey(now)) {
      archive(state);
      state = freshState(state.settings);
      save();
    }
  }

  /* ================= reason dialog ================= */
  const reasonDlg = el('reasonDlg');
  let pendingAction = null, pickedReason = null;

  function openReason(name) {
    pendingAction = name;
    pickedReason = null;
    el('reasonText').value = '';
    el('reasonNote').value = '';
    const all = [...loadReasons(), ...DEFAULT_REASONS];
    el('reasonChips').innerHTML = all
      .map(r => `<button type="button" class="chip" data-r="${esc(r)}" aria-pressed="false">${esc(r)}</button>`)
      .join('');
    const verb = {
      resume: 'Save & resume',
      endLap: 'Save & end lap',
      startLap: `Save & start ${fmtDur(state.nextLapMin)} lap`,
      endDay: 'Save & end day',
      food: 'Save & start food break',
    }[name];
    el('reasonOk').textContent = verb;
    validateReason();
    updateReasonInfo(Date.now());
    reasonDlg.showModal();
  }
  function currentReason() {
    return el('reasonText').value.trim() || pickedReason;
  }
  function validateReason() {
    el('reasonOk').disabled = !currentReason();
  }
  function updateReasonInfo(now) {
    if (!reasonDlg.open) return;
    const s = state;
    if (WASTING.has(s.phase)) {
      const what = s.phase === 'paused' ? `Paused in lap ${s.laps.length + 1}` : 'Idle';
      el('reasonInfo').textContent = `${what} · ${fmt(now - s.phaseStart)} wasted since ${clock(s.phaseStart)}`;
    } else {
      el('reasonInfo').textContent = 'The day has ended. Your reason will be saved with the last waste entry.';
    }
  }
  el('reasonChips').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    pickedReason = b.dataset.r;
    el('reasonText').value = '';
    for (const c of el('reasonChips').querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c === b));
    validateReason();
  });
  el('reasonText').addEventListener('input', () => {
    if (el('reasonText').value.trim()) {
      pickedReason = null;
      for (const c of el('reasonChips').querySelectorAll('.chip')) c.setAttribute('aria-pressed', 'false');
    }
    validateReason();
  });
  el('reasonCancel').addEventListener('click', () => { pendingAction = null; reasonDlg.close(); });
  el('reasonForm').addEventListener('submit', e => {
    e.preventDefault();
    const reason = currentReason();
    if (!reason) return;
    const note = el('reasonNote').value.trim();
    if (el('reasonText').value.trim()) rememberReason(reason);
    const name = pendingAction;
    pendingAction = null;
    reasonDlg.close();
    advance(state, Date.now());
    if (needsReason(name)) {
      perform(name, { reason, note });
    } else {
      // The waste ended by itself while the form was open (e.g. the day ran out): label that entry.
      const w = state.wastes[state.wastes.length - 1];
      if (w && !w.reason) { w.reason = reason; w.note = note; }
      save();
      tick();
    }
  });

  /* ================= views ================= */
  let view = 'main';
  let range = 'today';
  function setView(v) {
    view = v;
    screen = null;
    el('reportsBtn').setAttribute('aria-pressed', String(v === 'reports'));
    el('reportsIcon').hidden = v === 'reports';
    el('closeIcon').hidden = v !== 'reports';
    el('reportsBtn').setAttribute('aria-label', v === 'reports' ? 'Close reports' : 'Reports');
    tick();
  }

  /* ================= rendering: main ================= */
  let state = load();
  let booted = false;
  let screen = null, controlsKey = null, lapsKey = null, segsKey = null, lastPhase = null, lastGraceSec = null;

  /** The user's (editable) option list for a field, kept in settings so it carries over to new days. */
  function presetsFor(f) {
    const p = state.settings.presets || (state.settings.presets = {});
    if (!Array.isArray(p[f.key]) || p[f.key].length !== f.values.length) p[f.key] = f.values.slice();
    return p[f.key];
  }

  /**
   * Option chips: tap selects, hold (~0.5s) and release turns the chip into a number field.
   * The edit starts on release because iOS only opens the keyboard from a touch/click handler.
   */
  function editableChips(container, f, getCurrent, onPick) {
    const list = presetsFor(f);
    const cur = getCurrent();
    if (!list.includes(cur)) {
      // Make sure the current value is one of the options (replace the closest one).
      let bi = 0;
      list.forEach((v, i) => { if (Math.abs(v - cur) < Math.abs(list[bi] - cur)) bi = i; });
      list[bi] = cur;
      list.sort((a, b) => a - b);
      save();
    }
    const draw = () => {
      const c = getCurrent();
      container.innerHTML = list
        .map((v, i) => `<button type="button" class="chip" data-i="${i}" aria-pressed="${v === c}">${f.label(v)}</button>`)
        .join('');
    };
    draw();

    let timer = null, armed = null, sx = 0, sy = 0, skipClick = false;
    const disarm = () => {
      clearTimeout(timer); timer = null;
      if (armed) { armed.classList.remove('armed'); armed = null; }
    };
    container.onpointerdown = e => {
      const b = e.target.closest('button.chip');
      if (!b) return;
      disarm();
      sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => {
        timer = null;
        armed = b;
        b.classList.add('armed');
        try { navigator.vibrate && navigator.vibrate(15); } catch { /* ignore */ }
      }, 450);
    };
    container.onpointermove = e => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) disarm(); };
    container.onpointercancel = () => { clearTimeout(timer); timer = null; };
    const release = e => {
      clearTimeout(timer); timer = null;
      if (!armed) return;
      const b = armed;
      armed = null;
      b.classList.remove('armed');
      e.preventDefault();
      skipClick = true;
      setTimeout(() => { skipClick = false; }, 400);
      startEdit(b);
    };
    container.ontouchend = release;
    container.onmouseup = release;
    container.oncontextmenu = e => e.preventDefault();
    container.onclick = e => {
      if (skipClick) { skipClick = false; return; }
      const b = e.target.closest('button.chip');
      if (!b) return;
      onPick(list[Number(b.dataset.i)]);
      draw();
    };

    function startEdit(b) {
      const i = Number(b.dataset.i);
      const box = document.createElement('span');
      box.className = 'chip editing';
      box.innerHTML = `<input class="chip-input" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off"
        value="${f.toInput(list[i])}" aria-label="New value in ${f.unit}"><span class="unit">${f.unit}</span>`;
      b.replaceWith(box);
      const inp = box.querySelector('input');
      inp.focus();
      inp.select();
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        const x = parseFloat(String(inp.value).replace(',', '.'));
        if (ok && Number.isFinite(x) && x > 0) {
          const nv = clamp(f.fromInput(x), f.min, f.max);
          if (!list.includes(nv)) { list[i] = nv; list.sort((a, b) => a - b); }
          save();
          onPick(nv);
        }
        draw();
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') finish(false);
      });
      inp.addEventListener('blur', () => finish(true));
    }
  }

  function renderSetup() {
    for (const f of FIELDS) {
      editableChips(el(f.chips), f, () => state.settings[f.key], nv => {
        state.settings[f.key] = nv;
        if (f.key === 'lapMin') state.nextLapMin = nv;
        save();
        renderPlanHint();
      });
    }
    renderPlanHint();
    renderHistory();
  }

  function renderPlanHint() {
    const { periodMin, lapMin, breakMin } = state.settings;
    const now = Date.now(), end = now + periodMin * MIN;
    const laps = Math.max(1, Math.floor((periodMin + breakMin) / (lapMin + breakMin)));
    const when = clock12(end) + (dayKey(end) !== dayKey(now) ? ' tomorrow' : '');
    const html = `<span>ends <b>${when}</b></span>` +
      `<span>${fmtDur(periodMin)} day · ~${laps} lap${laps > 1 ? 's' : ''} of ${fmtDur(lapMin)}</span>`;
    if (el('planHint').innerHTML !== html) el('planHint').innerHTML = html;
  }

  function renderHistory() {
    const all = loadHist();
    const hist = all.map((h, i) => ({ ...h, i })).slice(-7).reverse();
    if (!hist.length) { el('history').innerHTML = ''; return; }
    el('history').innerHTML = '<h2>Recent days · tap to open</h2>' + hist.map(h => {
      const P = h.period || 1;
      const w = x => `${clamp(x / P * 100, 0, 100).toFixed(2)}%`;
      return `<button type="button" class="hist" data-day="${h.i}">
        <div class="hist-top"><span>${dateLabel(h.date)} · ${h.laps} laps</span>
        <span class="num">${short(h.work)} worked · ${short(h.waste)} wasted</span></div>
        <div class="hist-bar"><i class="work" style="width:${w(h.work)}"></i><i class="food" style="width:${w(h.food || 0)}"></i><i class="brk" style="width:${w(h.brk)}"></i><i class="waste" style="width:${w(h.waste)}"></i></div>
      </button>`;
    }).join('');
  }

  function buildControls(group) {
    const c = el('controls');
    if (group === 'work') {
      c.innerHTML = `<div class="row3">
        <button class="btn big" data-act="pause">Pause</button>
        <button class="btn ghost food-btn" data-act="food">${FOOD_ICON}Food</button>
        <button class="btn ghost" data-act="endLap">End lap</button></div>`;
    } else if (group === 'paused') {
      c.innerHTML = `<div class="row3">
        <button class="btn big" data-act="resume" style="background:var(--work)">Resume</button>
        <button class="btn ghost food-btn" data-act="food">${FOOD_ICON}Food</button>
        <button class="btn ghost" data-act="endLap">End lap</button></div>`;
    } else if (group === 'foodLap') {
      c.innerHTML = `<button class="btn big" data-act="resume" style="background:var(--work)">Back to work</button>`;
    } else if (group === 'pick') {
      c.innerHTML = `<div class="picker">
          <div class="field-head">Next lap<span class="hint">hold to edit</span></div>
          <div class="chips" id="nextChips"></div>
        </div>
        <button class="btn big" id="startLapBtn" data-act="startLap"></button>
        <button class="btn ghost food-btn" id="foodBtn" data-act="food">${FOOD_ICON}Food break</button>`;
      editableChips(el('nextChips'), NEXT_FIELD, () => state.nextLapMin, v => {
        state.nextLapMin = v;
        save();
      });
    } else if (group === 'done') {
      c.innerHTML = `<div class="row2">
        <button class="btn big" data-act="report">View report</button>
        <button class="btn big ghost" data-act="newSession">New session</button></div>`;
    }
  }

  function metaText(tot, laps) {
    return `Break ${fmt(tot.brk)}` + (tot.food ? ` · Food ${fmt(tot.food)}` : '') +
      ` · ${laps} lap${laps === 1 ? '' : 's'} done`;
  }

  function lapsHtml(laps) {
    const tag = { done: 'done', early: 'ended early', day: 'day ended', stopped: 'stopped' };
    return `<h2>Laps · ${laps.length}</h2>` + laps.slice().reverse().map(l => `
      <div class="lap num">
        <span class="n">#${l.n}</span>
        <span>${clock(l.start)}–${clock(l.end)}</span>
        <span class="w">${fmt(l.worked)}</span>
        <span class="d">${fmtDur(l.target / MIN)} lap · ${tag[l.how]}${l.paused ? ` · <span class="bad">${fmt(l.paused)} paused</span>` : ''}${l.food ? ` · <span class="food-t">${fmt(l.food)} food</span>` : ''}</span>
      </div>`).join('');
  }

  function renderLaps(s) {
    el('laps').innerHTML = s.laps.length ? lapsHtml(s.laps) : '';
  }

  function render(now) {
    const s = state;
    const scr = view === 'reports' ? 'reports' : viewIdx !== null ? 'past' : s.phase === 'setup' ? 'setup' : 'run';
    document.body.dataset.phase = scr === 'past' ? 'done' : s.phase;
    if (scr !== 'past') {
      const dlab = dateHtml(dayKey(now));
      if (el('dateLabel').innerHTML !== dlab) el('dateLabel').innerHTML = dlab;
    }

    if (scr !== screen) {
      screen = scr;
      for (const id of ['setup', 'run', 'reports', 'past']) el(id).hidden = scr !== id;
      controlsKey = lapsKey = segsKey = null;
      if (scr === 'setup') renderSetup();
      if (scr === 'reports') renderReports(now);
      if (scr === 'past') renderPast();
      updateNav();
      window.scrollTo(0, 0);
      if (slideDir) {
        const sec = el(scr);
        sec.classList.remove('slide-l', 'slide-r');
        void sec.offsetWidth; // restart the animation
        sec.classList.add(slideDir < 0 ? 'slide-l' : 'slide-r');
        slideDir = 0;
      }
    }
    if (s.phase !== lastPhase) {
      lastPhase = s.phase;
      syncWakeLock();
    }
    el('endDayBtn').hidden = !ACTIVE.has(s.phase);
    updateReasonInfo(now);
    if (scr === 'past') { document.title = 'Past day · Lapstimer'; return; }

    const active = ACTIVE.has(s.phase);
    const dl = !s.dayStart ? ''
      : active ? `${fmt(s.dayEnd - now, 'ceil')} left<span class="ends"> · ends ${clock(s.dayEnd)}</span>`
      : `Ended ${clock(s.endedAt)}`;
    if (el('dayLeft').innerHTML !== dl) el('dayLeft').innerHTML = dl;

    if (scr === 'setup') renderPlanHint();
    if (scr !== 'run') {
      document.title = scr === 'reports' ? 'Reports · Lapstimer' : 'Lapstimer';
      return;
    }

    /* ---- live numbers ---- */
    const elapsed = active ? now - s.phaseStart : 0;
    const tot = { ...s.totals };
    if (active) tot[KIND[s.phase]] += elapsed;
    const lapWorked = s.lapWorked + (s.phase === 'work' ? elapsed : 0);
    const lapLeft = s.lapTarget - lapWorked;
    const lapN = s.laps.length + 1;
    const period = s.dayEnd - s.dayStart;

    /* ---- hero ---- */
    let label, big, sub, p;
    switch (s.phase) {
      case 'work':
        label = `Lap ${lapN} · Working`;
        big = fmt(lapLeft, 'ceil');
        sub = `of ${fmtDur(s.lapTarget / MIN)} · ends ${clock(now + lapLeft)}`;
        p = lapWorked / s.lapTarget;
        break;
      case 'paused':
        label = `Lap ${lapN} · Paused`;
        big = fmt(elapsed);
        sub = `wasting · ${fmt(lapLeft, 'ceil')} left in lap`;
        p = lapWorked / s.lapTarget;
        break;
      case 'break': {
        const len = s.settings.breakMin * MIN;
        label = 'Break';
        big = fmt(len - elapsed, 'ceil');
        sub = `then ${s.settings.graceSec}s to start the next lap`;
        p = len ? elapsed / len : 1;
        break;
      }
      case 'grace': {
        const len = s.settings.graceSec * SEC;
        const secLeft = Math.ceil((len - elapsed) / SEC);
        label = 'Start next lap!';
        big = fmt(len - elapsed, 'ceil');
        sub = 'or the waste timer starts';
        p = 1 - elapsed / len;
        if (booted && secLeft !== lastGraceSec && secLeft > 0 && secLeft <= 5) cue('tick');
        lastGraceSec = secLeft;
        break;
      }
      case 'food':
        label = 'Food break';
        big = fmt(elapsed);
        sub = s.lapStart !== null ? `lap ${lapN} on hold · ${fmt(lapLeft, 'ceil')} left` : 'not counted as waste';
        p = s.lapStart !== null ? lapWorked / s.lapTarget : 1;
        break;
      case 'waste':
        label = 'Wasting time';
        big = fmt(elapsed);
        sub = `since ${clock(s.phaseStart)} · start a lap to stop it`;
        p = 1;
        break;
      case 'done':
        label = 'Day complete';
        big = fmt(tot.work);
        sub = `worked · ${focusPct(tot.work, tot.waste)}% focus`;
        p = tot.work / period;
        break;
    }
    el('phaseLabel').textContent = label;
    el('bigTime').textContent = big;
    el('subText').textContent = sub;
    el('ringProg').style.strokeDashoffset = String(RING_C * (1 - clamp(p, 0, 1)));
    document.title = `${big} · ${label}`;

    /* ---- totals ---- */
    el('totWork').textContent = fmt(tot.work);
    el('totWaste').textContent = fmt(tot.waste);
    el('cardWork').classList.toggle('live', s.phase === 'work');
    el('cardWaste').classList.toggle('live', WASTING.has(s.phase));
    el('metaLine').textContent = metaText(tot, s.laps.length);

    /* ---- controls ---- */
    const group = s.phase === 'work' ? 'work' : s.phase === 'paused' ? 'paused' : s.phase === 'done' ? 'done'
      : s.phase === 'food' && s.lapStart !== null ? 'foodLap' : 'pick';
    if (group !== controlsKey) { controlsKey = group; buildControls(group); }
    if (group === 'pick') {
      const btn = el('startLapBtn');
      const txt = s.phase === 'break' ? `Skip break · start ${fmtDur(s.nextLapMin)} lap` : `Start ${fmtDur(s.nextLapMin)} lap`;
      if (btn.textContent !== txt) btn.textContent = txt;
      btn.classList.toggle('pulse', s.phase === 'grace' || s.phase === 'waste');
      el('foodBtn').hidden = s.phase === 'food';
    }

    /* ---- timeline ---- */
    const pct = t => `${clamp((t - s.dayStart) / period * 100, 0, 100)}%`;
    const last = s.segs[s.segs.length - 1];
    const sk = `${s.segs.length}:${last ? last.b : 0}`;
    if (sk !== segsKey) {
      segsKey = sk;
      el('tlSegs').innerHTML = s.segs
        .map(g => `<i class="${g.k}" style="left:${pct(g.a)};width:${(g.b - g.a) / period * 100}%"></i>`)
        .join('');
    }
    const live = el('tlLive'), nowMark = el('tlNow');
    live.hidden = nowMark.hidden = !active;
    if (active) {
      live.className = KIND[s.phase];
      live.style.left = pct(s.phaseStart);
      live.style.width = `${elapsed / period * 100}%`;
      nowMark.style.left = pct(now);
    }
    el('tlStart').textContent = clock(s.dayStart);
    el('tlEnd').textContent = clock(s.dayEnd);

    /* ---- laps ---- */
    if (s.laps.length !== lapsKey) { lapsKey = s.laps.length; renderLaps(s); }
  }

  /* ================= rendering: reports ================= */
  /** Day records (archived + live today), merged per calendar date, for the chosen range. */
  function reportData(now) {
    const records = loadHist();
    if (state.dayStart) records.push(snapshot(state, now));
    let keys;
    if (range === 'today') {
      keys = [dayKey(now)];
    } else {
      keys = [];
      for (let i = Number(range) - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setHours(12, 0, 0, 0);
        d.setDate(d.getDate() - i);
        keys.push(dayKey(d));
      }
    }
    const byDate = new Map(keys.map(k => [k, { date: k, work: 0, waste: 0, brk: 0, food: 0, laps: 0, wastes: [], sessions: [] }]));
    for (const r of records) {
      const d = byDate.get(r.date);
      if (!d) continue;
      d.work += r.work; d.waste += r.waste; d.brk += r.brk; d.food += r.food || 0; d.laps += r.laps;
      d.wastes.push(...(r.wastes || []));
      d.sessions.push(r);
    }
    return [...byDate.values()];
  }

  function renderReports(now) {
    for (const b of el('rangeSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.range === range));
    const days = reportData(now);
    const sum = days.reduce((a, d) => ({
      work: a.work + d.work, waste: a.waste + d.waste, brk: a.brk + d.brk, food: a.food + d.food, laps: a.laps + d.laps,
      incidents: a.incidents + d.wastes.length,
    }), { work: 0, waste: 0, brk: 0, food: 0, laps: 0, incidents: 0 });
    const activeDays = days.filter(d => d.sessions.length).length;
    const multi = range !== 'today';

    /* tiles */
    const tile = (l, v, s) => `<div class="tile"><div class="l">${l}</div><div class="v num">${v}</div><div class="s num">${s}</div></div>`;
    el('repTiles').innerHTML =
      tile('Worked', short(sum.work), multi ? `avg ${short(activeDays ? sum.work / activeDays : 0)} per active day` : `${sum.laps} laps`) +
      tile('Wasted', short(sum.waste), `${sum.incidents} time${sum.incidents === 1 ? '' : 's'}`) +
      tile('Focus', `${focusPct(sum.work, sum.waste)}%`, multi ? `${activeDays}/${days.length} days active · ${sum.laps} laps` : 'worked ÷ (worked + wasted)') +
      tile('Breaks', short(sum.brk + sum.food), `rest ${short(sum.brk)} · food ${short(sum.food)}`);

    /* chart */
    if (multi) {
      el('repChartTitle').textContent = 'Hours per day';
      renderBarChart(days);
    } else {
      el('repChartTitle').textContent = 'Today';
      renderTodayTimelines(days[0], now);
    }

    /* reasons */
    const reasons = new Map();
    for (const d of days) for (const w of d.wastes) {
      const key = w.reason || NO_REASON;
      const r = reasons.get(key) || { ms: 0, n: 0 };
      r.ms += w.end - w.start; r.n++;
      reasons.set(key, r);
    }
    const rows = [...reasons.entries()].sort((a, b) => b[1].ms - a[1].ms);
    const maxMs = rows.length ? rows[0][1].ms : 1;
    el('repReasons').innerHTML = rows.length ? rows.map(([name, r]) => `
      <div class="reason-row">
        <span>${esc(name)}</span><span class="v num">${short(r.ms)} · ${r.n}×</span>
        <i class="reason-bar" style="width:${r.ms / maxMs * 100}%"></i>
      </div>`).join('') : '<div class="empty">No wasted time logged. Nice.</div>';

    /* days table */
    el('repDaysPanel').hidden = !multi;
    if (multi) {
      const withData = days.filter(d => d.sessions.length).reverse();
      el('repTable').innerHTML = withData.length ? `<table class="days num">
        <thead><tr><th>Day</th><th>Worked</th><th>Food</th><th>Break</th><th>Wasted</th><th>Focus</th><th>Laps</th></tr></thead>
        <tbody>${withData.map(d => `<tr><td>${keyToDate(d.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</td><td>${short(d.work)}</td><td>${short(d.food)}</td><td>${short(d.brk)}</td>
          <td>${short(d.waste)}</td><td>${focusPct(d.work, d.waste)}%</td><td>${d.laps}</td></tr>`).join('')}</tbody>
      </table>` : '<div class="empty">No days tracked in this range yet.</div>';
    }

    /* waste log */
    const log = days.flatMap(d => d.wastes).sort((a, b) => b.start - a.start);
    el('repLog').innerHTML = log.length ? wasteRowsHtml(log, multi) : '<div class="empty">Nothing here yet.</div>';
  }

  function wasteRowsHtml(list, withDate) {
    return list.map(w => `
      <div class="log-row">
        <div class="log-top num"><span>${withDate ? dateLabel(dayKey(w.start)) + ' · ' : ''}${clock(w.start)}–${clock(w.end)}</span><b>${fmt(w.end - w.start)}</b></div>
        <div class="log-sub">${w.kind === 'pause' ? `Paused in lap ${w.lap}` : 'Idle, no lap started'} · ${esc(w.reason || NO_REASON)}</div>
        ${w.note ? `<div class="log-note">${esc(w.note)}</div>` : ''}
      </div>`).join('');
  }

  /* ================= past days ================= */
  let viewIdx = null;   // index into history, or null for the live day
  let slideDir = 0;

  function dateHtml(key) {
    const d = keyToDate(key);
    return `<span class="wd">${d.toLocaleDateString(undefined, { weekday: 'short' })} </span>${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  }

  /** dir -1 = back in time (previous day), +1 = forward (towards today). */
  function navDay(dir) {
    if (view === 'reports') return;
    const n = loadHist().length;
    let next = viewIdx;
    if (dir < 0) {
      if (!n) return;
      next = viewIdx === null ? n - 1 : viewIdx > 0 ? viewIdx - 1 : viewIdx;
    } else {
      if (viewIdx === null) return;
      next = viewIdx < n - 1 ? viewIdx + 1 : null;
    }
    if (next === viewIdx) return;
    viewIdx = next;
    slideDir = dir;
    screen = null;
    tick();
  }
  function openPast(i) { viewIdx = i; slideDir = -1; screen = null; tick(); }
  function backToToday() { if (viewIdx !== null) { viewIdx = null; slideDir = 1; screen = null; tick(); } }

  function updateNav() {
    const n = loadHist().length;
    const inReports = view === 'reports';
    el('prevDay').hidden = inReports || !n || viewIdx === 0;
    el('nextDay').hidden = inReports || viewIdx === null;
  }

  function renderPast() {
    const hist = loadHist();
    const r = hist[viewIdx];
    if (!r) { viewIdx = null; return; }
    const period = r.period || 1;
    const sameDay = hist.filter(h => h.date === r.date).length;
    const sessionNo = hist.slice(0, viewIdx + 1).filter(h => h.date === r.date).length;
    const food = r.food || 0;

    el('dateLabel').innerHTML = dateHtml(r.date);
    el('dayLeft').innerHTML = `${clock(r.start)}–${clock(r.end)}`;
    el('pastLabel').textContent = sameDay > 1 ? `Session ${sessionNo} of ${sameDay}` : 'Day summary';
    el('pastBig').textContent = fmt(r.work);
    el('pastSub').textContent = `worked · ${focusPct(r.work, r.waste)}% focus`;
    el('pastRing').style.strokeDashoffset = String(RING_C * (1 - clamp(r.work / period, 0, 1)));
    el('pastWork').textContent = fmt(r.work);
    el('pastWaste').textContent = fmt(r.waste);
    el('pastMeta').textContent = metaText({ brk: r.brk, food }, r.laps);

    const pct = t => clamp((t - r.start) / period * 100, 0, 100);
    el('pastTl').innerHTML = (r.segs || [])
      .map(g => `<i class="${g.k}" style="left:${pct(g.a)}%;width:${(g.b - g.a) / period * 100}%"></i>`).join('');
    el('pastStart').textContent = clock(r.start);
    el('pastEnd').textContent = clock(r.start + period);

    el('pastLaps').innerHTML = r.lapList && r.lapList.length ? lapsHtml(r.lapList)
      : r.laps ? `<h2>Laps · ${r.laps}</h2><div class="empty">Lap details are only saved for days tracked after this update.</div>`
      : '<h2>Laps · 0</h2>';
    const w = (r.wastes || []).slice().sort((a, b) => b.start - a.start);
    el('pastWastes').innerHTML = w.length ? `<h2>Wasted time · ${w.length}</h2>` + wasteRowsHtml(w, false) : '';
  }

  function renderTodayTimelines(day, now) {
    if (!day || !day.sessions.length) {
      el('repChart').innerHTML = '<div class="empty">No day started yet.</div>';
      return;
    }
    el('repChart').innerHTML = day.sessions.map((r, i) => {
      const P = r.period;
      const pct = t => clamp((t - r.start) / P * 100, 0, 100);
      const segs = (r.segs || []).map(g =>
        `<i class="${g.k}" style="left:${pct(g.a)}%;width:${(g.b - g.a) / P * 100}%"></i>`).join('');
      const nowMark = r.live ? `<b style="left:${pct(now)}%"></b>` : '';
      return `<div class="tl-big">
        ${day.sessions.length > 1 ? `<div class="tl-title">Session ${i + 1}</div>` : ''}
        <div class="timeline">${segs}${nowMark}</div>
        <div class="tl-labels num"><span>${clock(r.start)}</span><span>${clock(r.start + P)}</span></div>
      </div>`;
    }).join('');
  }

  function renderBarChart(days) {
    const totalOf = d => d.work + d.brk + d.food + d.waste;
    const maxMs = Math.max(HOUR, ...days.map(totalOf));
    const step = maxMs <= 4 * HOUR ? HOUR : maxMs <= 10 * HOUR ? 2 * HOUR : 4 * HOUR;
    const top = Math.ceil(maxMs / step) * step;
    let grid = '';
    for (let v = 0; v <= top; v += step) grid += `<div class="gl" style="bottom:${v / top * 100}%"><span>${v / HOUR}h</span></div>`;
    const cols = days.map((d, i) => {
      const t = totalOf(d);
      const parts = [['waste', d.waste], ['brk', d.brk], ['food', d.food], ['work', d.work]]
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `<i class="${k}" style="flex-grow:${v}"></i>`).join('');
      return `<div class="col" data-i="${i}"><div class="stack" style="height:${t / top * 100}%">${parts}</div></div>`;
    }).join('');
    const labelEvery = days.length > 10 ? 5 : 1;
    const xl = days.map((d, i) => {
      const dt = keyToDate(d.date);
      const show = (days.length - 1 - i) % labelEvery === 0;
      const txt = days.length > 10 ? String(dt.getDate()) : dt.toLocaleDateString(undefined, { weekday: 'short' });
      return `<span>${show ? txt : ''}</span>`;
    }).join('');
    el('repChart').innerHTML = `<div class="chart">${grid}<div class="cols">${cols}</div><div class="tip" hidden></div></div><div class="xlabels">${xl}</div>`;

    const chart = el('repChart').querySelector('.chart');
    const colsEl = chart.querySelector('.cols');
    const tip = chart.querySelector('.tip');
    const show = col => {
      const d = days[Number(col.dataset.i)];
      for (const c of colsEl.children) c.classList.toggle('on', c === col);
      colsEl.classList.add('hovering');
      tip.innerHTML = `<b>${dateLabel(d.date)}</b>
        <div><span style="--c:var(--work)">Worked</span><span class="num">${short(d.work)}</span></div>
        <div><span style="--c:var(--food)">Food</span><span class="num">${short(d.food)}</span></div>
        <div><span style="--c:var(--brk)">Break</span><span class="num">${short(d.brk)}</span></div>
        <div><span style="--c:var(--waste)">Wasted</span><span class="num">${short(d.waste)}</span></div>
        <div><span style="--c:transparent">Focus</span><span class="num">${focusPct(d.work, d.waste)}%</span></div>`;
      tip.hidden = false;
      const cw = chart.clientWidth, tw = tip.offsetWidth;
      const x = col.offsetLeft + col.offsetWidth / 2;
      tip.style.left = `${clamp(x, tw / 2 - 30, cw - tw / 2)}px`;
      const stack = col.firstElementChild;
      tip.style.top = `${chart.clientHeight - stack.offsetHeight}px`;
    };
    const hide = () => { tip.hidden = true; colsEl.classList.remove('hovering'); for (const c of colsEl.children) c.classList.remove('on'); };
    colsEl.addEventListener('pointerover', e => { const c = e.target.closest('.col'); if (c) show(c); });
    colsEl.addEventListener('pointerdown', e => { const c = e.target.closest('.col'); if (c) show(c); });
    colsEl.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  }

  /* ================= CSV export ================= */
  function csv(rows) {
    return rows.map(r => r.map(v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const mins = ms => (ms / MIN).toFixed(1);
  el('csvDays').addEventListener('click', () => {
    const days = reportData(Date.now()).filter(d => d.sessions.length);
    download(`lapstimer-days-${range}-${dayKey()}.csv`, csv([
      ['date', 'worked_min', 'food_min', 'break_min', 'wasted_min', 'focus_pct', 'laps', 'waste_count'],
      ...days.map(d => [d.date, mins(d.work), mins(d.food), mins(d.brk), mins(d.waste), focusPct(d.work, d.waste), d.laps, d.wastes.length]),
    ]));
  });
  el('csvWaste').addEventListener('click', () => {
    const log = reportData(Date.now()).flatMap(d => d.wastes).sort((a, b) => a.start - b.start);
    download(`lapstimer-waste-${range}-${dayKey()}.csv`, csv([
      ['date', 'start', 'end', 'minutes', 'type', 'lap', 'reason', 'note'],
      ...log.map(w => [dayKey(w.start), clock(w.start), clock(w.end), mins(w.end - w.start),
        w.kind === 'pause' ? 'paused' : 'idle', w.lap ?? '', w.reason || NO_REASON, w.note || '']),
    ]));
  });

  /* ================= loop ================= */
  function tick() {
    const now = Date.now();
    rollDay(now);
    const events = advance(state, now);
    if (events.length) {
      save();
      const e = events[events.length - 1];
      // Only alert for something that just happened, not for events replayed after the phone slept.
      if (booted && now - e.t < 3000) cue(e.name);
      if (view === 'reports') renderReports(now);
    }
    render(now);
    booted = true;
  }

  /* ================= wiring ================= */
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b) request(b.dataset.act);
  });
  el('startDay').addEventListener('click', startDay);
  el('prevDay').addEventListener('click', () => navDay(-1));
  el('nextDay').addEventListener('click', () => navDay(1));
  el('backToday').addEventListener('click', backToToday);
  el('history').addEventListener('click', e => {
    const b = e.target.closest('[data-day]');
    if (b) openPast(Number(b.dataset.day));
  });

  // Swipe right = previous day, swipe left = next day (towards today).
  let sw = null;
  el('app').addEventListener('touchstart', e => {
    const t = e.touches[0];
    sw = null;
    if (e.touches.length !== 1 || view === 'reports' || document.querySelector('dialog[open]')) return;
    if (t.clientX < 24 || t.clientX > window.innerWidth - 24) return; // leave the system edge gestures alone
    if (e.target.closest('input, textarea, .chips, .table-wrap, .chart')) return;
    sw = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  el('app').addEventListener('touchend', e => {
    if (!sw) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sw.x, dy = t.clientY - sw.y, dt = Date.now() - sw.t;
    sw = null;
    if (dt < 800 && Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * 0.6) navDay(dx > 0 ? -1 : 1);
  }, { passive: true });
  el('reportsBtn').addEventListener('click', () => setView(view === 'reports' ? 'main' : 'reports'));

  /* ---- full screen ---- */
  // Android/desktop support the Fullscreen API. iPhone Safari does not: there the
  // way to get full screen is "Add to Home Screen", so we show a hint instead.
  const root = document.documentElement;
  const fsSupported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  function syncFs() {
    const on = isFs();
    el('fsEnterIcon').hidden = on;
    el('fsExitIcon').hidden = !on;
    el('fsBtn').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  }
  el('fsBtn').hidden = !fsSupported;
  el('fsHint').hidden = fsSupported || standalone;
  el('fsBtn').addEventListener('click', async () => {
    try {
      if (isFs()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' });
    } catch { /* ignore */ }
    syncWakeLock();
  });
  document.addEventListener('fullscreenchange', syncFs);
  document.addEventListener('webkitfullscreenchange', syncFs);
  el('rangeSeg').addEventListener('click', e => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    range = b.dataset.range;
    renderReports(Date.now());
  });

  const menu = el('menu');
  /* ---- theme ---- */
  function applyTheme() {
    const t = state.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#0e1014';
    for (const b of el('themeSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.themeOpt === t));
  }
  el('themeSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-theme-opt]');
    if (!b) return;
    state.settings.theme = b.dataset.themeOpt;
    save();
    applyTheme();
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
  applyTheme();

  el('menuBtn').addEventListener('click', () => {
    el('optSound').checked = state.settings.sound;
    el('optWake').checked = state.settings.wakeLock;
    el('optSilent').checked = state.settings.silentRing;
    el('optSilentRow').hidden = !navigator.audioSession;
    renderDiag();
    menu.showModal();
  });
  el('optSilent').addEventListener('change', e => { state.settings.silentRing = e.target.checked; save(); unlockAudio(); });
  el('testSound').addEventListener('click', () => {
    unlockAudio();
    const was = state.settings.sound;
    state.settings.sound = true;
    cue('lapDone');
    state.settings.sound = was;
    setTimeout(renderDiag, 300);
  });
  // Every tap re-arms audio and keep-awake (iOS may suspend them after the screen was off).
  document.addEventListener('pointerdown', () => {
    unlockAudio();
    if (wakeMode === 'failed' || (wakeVideo && wakeVideo.paused && ACTIVE.has(state.phase))) syncWakeLock();
  }, { capture: true, passive: true });
  el('optSound').addEventListener('change', e => { state.settings.sound = e.target.checked; save(); if (e.target.checked) unlockAudio(); });
  el('optWake').addEventListener('change', e => { state.settings.wakeLock = e.target.checked; save(); syncWakeLock(); });
  el('endDayBtn').addEventListener('click', () => {
    if (confirm('End the day now? The remaining time will not be tracked.')) { menu.close(); request('endDay'); }
  });
  el('resetBtn').addEventListener('click', () => {
    if (confirm('Reset today? This discards everything tracked today.')) {
      menu.close();
      state = freshState(state.settings);
      save();
      screen = null;
      tick();
    }
  });
  for (const d of [menu]) d.addEventListener('click', e => { if (e.target === d) d.close(); }); // tap backdrop to close

  document.addEventListener('visibilitychange', () => { tick(); syncWakeLock(); });
  window.addEventListener('storage', e => { if (e.key === STATE_KEY) { state = load(); screen = null; tick(); } });

  tick();
  setInterval(tick, 250);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
