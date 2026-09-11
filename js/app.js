/* =====================================================================
   TremorSense — App Logic
   Guided flow: welcome -> mode select -> instructions -> capture -> results
   Data source: MQTT over WebSocket (EMQX) topic "smart", OR Demo Mode
   (client-side synthetic data) when no hardware is available.

   DISCLAIMER: All risk scoring in computeAssessment() is a rule-based
   heuristic for screening / educational demonstration only. It is NOT
   a medical diagnosis and the thresholds are NOT clinically validated.
   ===================================================================== */

(() => {
  'use strict';

  // ----------------------- CONFIG -----------------------
  const MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
  const MQTT_TOPIC = 'smart';
  const CAPTURE_DURATION_S = 15;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in SVG

  // Matches the firmware's reporting cadence (WINDOW_MS=2000 in
  // parkinson_detect.ino) — the accelerometer window closes and a new
  // freq/amp reading is published roughly every 2 seconds, not every
  // sample. Used to size the expected sample count during a capture.
  const REPORT_INTERVAL_S = 2;

  // Calibration reference from real handheld testing (see README.md):
  // amp (p-p) < 0.03g at rest; handheld amp (p-p) typically 0.05g-5g.
  // TREMOR_ALERT_AMP_G matches the firmware's alert-band threshold.
  const AMP_QUIET_G = 0.03;
  const TREMOR_ALERT_AMP_G = 0.10;

  const MODE_INFO = {
    rest: {
      name: 'Rest',
      icon: '🖐️',
      title: 'Rest Position',
      text: 'Sit comfortably. Rest your forearm on your lap or a table. Hold the device loosely in an open palm — do not grip it tightly, as active gripping engages forearm muscles and can mask a true resting tremor. Stay relaxed for the full duration.',
      pathologicalBand: [3, 6],
      pathologicalLabel: 'Parkinsonian rest tremor'
    },
    postural: {
      name: 'Postural',
      icon: '🤲',
      title: 'Postural Position',
      text: 'Sit or stand upright. Extend your arm straight out in front of you, parallel to the floor, hand unsupported. Hold the device naturally and keep your arm as steady as possible for the full duration.',
      pathologicalBand: [4, 12],
      pathologicalLabel: 'essential tremor'
    },
    action: {
      name: 'Action',
      icon: '✋',
      title: 'Action Position',
      text: 'Hold the device and slowly move your hand toward a fixed target (e.g. touching your nose, then reaching back out) in a smooth, repeated motion for the full duration.',
      pathologicalBand: [0, 4],
      pathologicalLabel: 'cerebellar / intention tremor'
    }
  };

  // ----------------------- STATE -----------------------
  const state = {
    mode: null,
    mqttClient: null,
    connected: false,
    demoMode: false,
    demoTimer: null,
    latest: { freq: 0, amp: 0, state: 'STANDBY' },
    captureSamples: [],
    captureTimer: null,
    captureRemaining: CAPTURE_DURATION_S,
    liveChart: null,
    resultChart: null
  };

  // ----------------------- DOM ELEMENTS -----------------------
  const $ = (id) => document.getElementById(id);
  const screens = {
    welcome: $('screen-welcome'),
    mode: $('screen-mode'),
    instructions: $('screen-instructions'),
    capture: $('screen-capture'),
    results: $('screen-results'),
    history: $('screen-history')
  };

  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
  }

  // ----------------------- CONNECTION STATUS UI -----------------------
  function setConnStatus(kind, label) {
    const el = $('connStatus');
    el.classList.remove('connected', 'disconnected', 'demo');
    if (kind) el.classList.add(kind);
    el.querySelector('.status-label').textContent = label;
  }

  // ----------------------- MQTT -----------------------
  function connectMqtt() {
    if (typeof mqtt === 'undefined') {
      setConnStatus('disconnected', 'MQTT lib unavailable');
      return;
    }
    setConnStatus(null, 'Connecting…');
    const clientId = 'web_' + Math.random().toString(16).slice(2);
    try {
      state.mqttClient = mqtt.connect(MQTT_URL, {
        clientId,
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 4000
      });
    } catch (e) {
      setConnStatus('disconnected', 'Connection failed');
      return;
    }

    state.mqttClient.on('connect', () => {
      state.connected = true;
      if (!state.demoMode) setConnStatus('connected', 'Device Connected');
      state.mqttClient.subscribe(MQTT_TOPIC);
    });

    state.mqttClient.on('reconnect', () => {
      if (!state.demoMode) setConnStatus(null, 'Reconnecting…');
    });

    state.mqttClient.on('close', () => {
      state.connected = false;
      if (!state.demoMode) setConnStatus('disconnected', 'Disconnected');
    });

    state.mqttClient.on('error', () => {
      state.connected = false;
      if (!state.demoMode) setConnStatus('disconnected', 'Connection error');
    });

    state.mqttClient.on('message', (topic, payload) => {
      if (state.demoMode) return; // ignore live data while demo mode is on
      try {
        const data = JSON.parse(payload.toString());
        handleTelemetry(data);
      } catch (e) { /* ignore malformed payloads */ }
    });
  }

  // ----------------------- DEMO MODE -----------------------
  function startDemoMode() {
    state.demoMode = true;
    setConnStatus('demo', 'Demo Mode (Simulated)');
    let t = 0;
    if (state.demoTimer) clearInterval(state.demoTimer);
    state.demoTimer = setInterval(() => {
      t += 1;
      // Simulate a plausible tremor signal that drifts, with occasional
      // excursions into the alert band, so the guided flow is fully
      // demonstrable without hardware. Fires every 2s to match the real
      // firmware's reporting cadence (see REPORT_INTERVAL_S above).
      const baseFreq = 6 + 3 * Math.sin(t / 8) + (Math.random() - 0.5) * 1.2;
      const baseAmp = AMP_QUIET_G + 0.12 * Math.max(0, Math.sin(t / 10)) + Math.random() * 0.02;
      const inBand = baseFreq >= 3 && baseFreq <= 7 && baseAmp >= TREMOR_ALERT_AMP_G;
      handleTelemetry({
        device_id: 'demo_simulator',
        ts: Date.now(),
        state: inBand ? 'ALERT' : 'NORMAL',
        tremor: { freq_hz: baseFreq, amp_g: baseAmp, in_alert_band: inBand }
      });
    }, REPORT_INTERVAL_S * 1000);
  }

  function stopDemoMode() {
    state.demoMode = false;
    if (state.demoTimer) { clearInterval(state.demoTimer); state.demoTimer = null; }
    setConnStatus(state.connected ? 'connected' : 'disconnected', state.connected ? 'Device Connected' : 'Disconnected');
  }

  $('demoModeToggle').addEventListener('change', (e) => {
    if (e.target.checked) startDemoMode(); else stopDemoMode();
  });

  // ----------------------- TELEMETRY HANDLING -----------------------
  function handleTelemetry(data) {
    const freq = data?.tremor?.freq_hz ?? 0;
    const amp = data?.tremor?.amp_g ?? 0;

    state.latest = {
      freq, amp,
      state: data?.state || 'NORMAL'
    };

    updateLiveReadouts();

    if (screens.capture.classList.contains('hidden')) return; // only buffer while capturing
    state.captureSamples.push({ t: Date.now(), freq, amp });
    pushLiveChartPoint(freq, amp);
  }

  function updateLiveReadouts() {
    const f = state.latest;
    setValueText('liveFreq', f.freq ? f.freq.toFixed(2) : '–', 'Hz');
    setValueText('liveAmp', f.freq ? f.amp.toFixed(3) : '–', 'g');
  }

  function setValueText(elId, value, unit) {
    const el = $(elId);
    el.innerHTML = `${value}<span class="unit">${unit}</span>`;
  }

  // ----------------------- MODE SELECT -----------------------
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      state.mode = card.dataset.mode;
      $('btnToInstructions').disabled = false;
    });
  });

  $('btnStart').addEventListener('click', () => showScreen('mode'));
  $('btnBackToWelcome').addEventListener('click', () => showScreen('welcome'));
  $('btnHistory').addEventListener('click', () => { renderHistory(); showScreen('history'); });
  $('btnBackToWelcomeFromHistory').addEventListener('click', () => showScreen('welcome'));
  $('btnBackToWelcomeFromResults').addEventListener('click', () => showScreen('welcome'));

  $('btnToInstructions').addEventListener('click', () => {
    if (!state.mode) return;
    const info = MODE_INFO[state.mode];
    $('instructionTitle').textContent = info.title;
    $('instructionText').textContent = info.text;
    $('captureDurationLabel').textContent = CAPTURE_DURATION_S;
    document.querySelectorAll('.pose-svg').forEach(svg => {
      svg.classList.toggle('active', svg.id === 'pose-' + state.mode);
    });
    showScreen('instructions');
  });
  $('btnBackToMode').addEventListener('click', () => showScreen('mode'));

  // ----------------------- CAPTURE -----------------------
  $('btnBeginCapture').addEventListener('click', beginCapture);

  function beginCapture() {
    state.captureSamples = [];
    state.captureRemaining = CAPTURE_DURATION_S;
    $('countdownNumber').textContent = state.captureRemaining;
    $('captureStatusText').textContent = 'Recording… hold steady';
    $('ringFg').style.strokeDasharray = RING_CIRCUMFERENCE;
    $('ringFg').style.strokeDashoffset = 0;

    // Show the capture screen and start the countdown FIRST — the chart is
    // a nice-to-have. If Chart.js failed to load (blocked/offline CDN),
    // initLiveChart() must never be allowed to stop the recording flow.
    showScreen('capture');
    try { initLiveChart(); } catch (e) { console.warn('[TremorSense] live chart init failed, continuing without it:', e); }

    if (state.captureTimer) clearInterval(state.captureTimer);
    state.captureTimer = setInterval(() => {
      state.captureRemaining -= 1;
      $('countdownNumber').textContent = Math.max(0, state.captureRemaining);
      const frac = 1 - state.captureRemaining / CAPTURE_DURATION_S;
      $('ringFg').style.strokeDashoffset = RING_CIRCUMFERENCE * frac;
      if (state.captureRemaining <= 0) {
        clearInterval(state.captureTimer);
        finishCapture();
      }
    }, 1000);
  }

  function finishCapture() {
    $('captureStatusText').textContent = 'Analyzing…';
    setTimeout(() => {
      let assessment;
      try {
        assessment = computeAssessment(state.captureSamples, state.mode);
      } catch (e) {
        console.error('[TremorSense] assessment computation failed:', e);
        assessment = computeAssessment([], state.mode); // falls back to the "No Data" path
      }
      try {
        renderResults(assessment);
      } catch (e) {
        console.error('[TremorSense] render results failed:', e);
      }
      showScreen('results'); // always advance, even if a sub-step above failed
    }, 400);
  }

  function isChartAvailable() {
    return typeof Chart !== 'undefined';
  }

  function initLiveChart() {
    const canvas = $('liveChart');
    const fallback = $('liveChartFallback');
    if (!isChartAvailable()) {
      canvas.classList.add('hidden');
      if (fallback) fallback.classList.remove('hidden');
      state.liveChart = null;
      return;
    }
    canvas.classList.remove('hidden');
    if (fallback) fallback.classList.add('hidden');
    const ctx = canvas.getContext('2d');
    if (state.liveChart) state.liveChart.destroy();
    state.liveChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Freq (Hz)', data: [], borderColor: '#0b63d6', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, yAxisID: 'y' },
          { label: 'Amp (g)', data: [], borderColor: '#22d3ee', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, yAxisID: 'y1' }
        ]
      },
      options: {
        animation: false,
        responsive: true,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { display: false },
          y: { position: 'left', title: { display: true, text: 'Hz' }, suggestedMin: 0, suggestedMax: 15 },
          y1: { position: 'right', title: { display: true, text: 'g' }, suggestedMin: 0, suggestedMax: 0.3, grid: { drawOnChartArea: false } }
        },
        plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } }
      }
    });
  }

  function pushLiveChartPoint(freq, amp) {
    if (!state.liveChart) return;
    const ds = state.liveChart.data;
    ds.labels.push('');
    ds.datasets[0].data.push(freq);
    ds.datasets[1].data.push(amp);
    if (ds.labels.length > 60) { ds.labels.shift(); ds.datasets[0].data.shift(); ds.datasets[1].data.shift(); }
    state.liveChart.update('none');
  }

  // ----------------------- ASSESSMENT ENGINE (rule-based) -----------------------
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(mean(arr.map(v => (v - m) ** 2)));
  }

  function computeAssessment(samples, mode) {
    const info = MODE_INFO[mode] || MODE_INFO.rest;
    if (!samples.length) {
      return {
        mode, info, freq: 0, amp: 0,
        severity: 0, confidence: 0, risk: 'low',
        quality: 'No Data', assessmentText: 'No telemetry was received during the recording window. Check the device connection and try again.',
        samples
      };
    }

    const freqs = samples.map(s => s.freq).filter(f => f > 0);
    const amps = samples.map(s => s.amp);

    const freqMedian = median(freqs);
    const ampMean = mean(amps);
    const freqStd = stdev(freqs);
    const ampStd = stdev(amps);

    // --- Severity: amplitude-driven, piecewise scale calibrated against
    // real handheld measurements (see README.md): amp(p-p) < 0.03g at
    // rest; handheld amp(p-p) spans roughly 0.05g-5g. The breakpoints
    // below match the firmware's AMP_QUIET_G (0.03g) and
    // TREMOR_ALERT_AMP_G (0.10g) thresholds, then compress the long tail
    // up to 5g so a rare large excursion doesn't single-handedly saturate
    // the score.
    let severity;
    if (ampMean <= AMP_QUIET_G) {
      severity = (ampMean / AMP_QUIET_G) * 10;
    } else if (ampMean <= TREMOR_ALERT_AMP_G) {
      severity = 10 + (ampMean - AMP_QUIET_G) / (TREMOR_ALERT_AMP_G - AMP_QUIET_G) * 30;
    } else if (ampMean <= 0.5) {
      severity = 40 + (ampMean - TREMOR_ALERT_AMP_G) / (0.5 - TREMOR_ALERT_AMP_G) * 35;
    } else {
      severity = 75 + Math.min(25, (ampMean - 0.5) / (5.0 - 0.5) * 25);
    }
    severity = Math.round(Math.min(100, Math.max(0, severity)));

    // --- Confidence: frequency stability + amplitude stability + sample
    // count, all derived purely from the accelerometer signal now that
    // there is no PPG validity/motion-artifact flag to lean on. ---
    const freqStabilityScore = Math.max(0, 1 - freqStd / 4) * 100;      // low std -> high score
    const ampCV = ampMean > 0 ? (ampStd / ampMean) : 1;                 // coefficient of variation
    const ampStabilityScore = Math.max(0, 1 - ampCV) * 100;
    const expectedSamples = CAPTURE_DURATION_S / REPORT_INTERVAL_S;     // firmware reports every ~2s
    const sampleCountScore = Math.min(100, (samples.length / expectedSamples) * 100);
    let confidence = Math.round(
      freqStabilityScore * 0.40 + ampStabilityScore * 0.35 + sampleCountScore * 0.25
    );
    confidence = Math.min(100, Math.max(0, confidence));

    // --- Band match against this mode's pathological range ---
    const [bandLo, bandHi] = info.pathologicalBand;
    const inBandStrict = mode === 'action' ? freqMedian < 4 : (freqMedian >= bandLo && freqMedian <= bandHi);

    // --- Risk level ---
    let risk;
    if (severity >= 65 && inBandStrict) risk = 'high';
    else if (severity >= 35 || (inBandStrict && severity >= 20)) risk = 'moderate';
    else risk = 'low';

    // --- Narrative text ---
    let assessmentText;
    if (risk === 'high') {
      assessmentText = `The dominant tremor frequency (${freqMedian.toFixed(1)} Hz) and amplitude (${ampMean.toFixed(3)} g peak-to-peak) measured in the ${info.name} position fall within a range whose characteristics overlap with ${info.pathologicalLabel}. This pattern warrants follow-up with a qualified neurologist for clinical evaluation — this result alone is not sufficient for diagnosis.`;
    } else if (risk === 'moderate') {
      assessmentText = `The measured tremor (${freqMedian.toFixed(1)} Hz, ${ampMean.toFixed(3)} g peak-to-peak) shows some characteristics that partially overlap with ${info.pathologicalLabel}, but the signal is not strongly conclusive. Consider repeating the measurement or trying the other test positions for a fuller picture.`;
    } else {
      assessmentText = `The measured tremor (${freqMedian.toFixed(1)} Hz, ${ampMean.toFixed(3)} g peak-to-peak) is consistent with normal physiologic tremor — low amplitude, within a typical range for this position. No significant pathological pattern was detected in this session.`;
    }
    if (confidence < 50) {
      assessmentText += ` Note: confidence in this result is limited (${confidence}%) — the frequency/amplitude reading was unstable or the recording was short. Consider re-testing under steadier conditions.`;
    }

    let quality = 'Good';
    if (samples.length < expectedSamples * 0.5 || freqStd > 3) quality = 'Poor (insufficient/unstable signal)';
    else if (samples.length < expectedSamples * 0.8 || freqStd > 1.5) quality = 'Fair';

    return {
      mode, info, freq: freqMedian, amp: ampMean,
      severity, confidence, risk, quality, assessmentText, samples
    };
  }

  // ----------------------- RENDER RESULTS -----------------------
  function renderResults(a) {
    $('riskValue').textContent = a.risk === 'high' ? 'High' : a.risk === 'moderate' ? 'Moderate' : 'Low';
    $('riskBadge').className = 'risk-badge risk-' + a.risk;
    $('severityValue').textContent = a.severity + ' / 100';
    $('confidenceValue').textContent = a.confidence + '%';

    setResCard('resFreq', a.freq ? a.freq.toFixed(2) : '–', 'Hz');
    setResCard('resAmp', a.freq ? a.amp.toFixed(3) : '–', 'g');
    $('resMode').textContent = a.info.name;
    $('resQuality').textContent = a.quality;

    $('assessmentText').textContent = a.assessmentText;

    renderResultChart(a.samples);
  }

  function setResCard(id, value, unit) {
    $(id).innerHTML = `${value} <span class="unit">${unit}</span>`;
  }

  function renderResultChart(samples) {
    const canvas = $('resultChart');
    const fallback = $('resultChartFallback');
    if (!isChartAvailable()) {
      canvas.classList.add('hidden');
      if (fallback) fallback.classList.remove('hidden');
      state.resultChart = null;
      return;
    }
    canvas.classList.remove('hidden');
    if (fallback) fallback.classList.add('hidden');
    const ctx = canvas.getContext('2d');
    if (state.resultChart) state.resultChart.destroy();
    const labels = samples.map((s, i) => i);
    state.resultChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Freq (Hz)', data: samples.map(s => s.freq), borderColor: '#0b63d6', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, yAxisID: 'y' },
          { label: 'Amp (g)', data: samples.map(s => s.amp), borderColor: '#22d3ee', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, yAxisID: 'y1' }
        ]
      },
      options: {
        responsive: true,
        scales: {
          x: { display: false },
          y: { position: 'left', title: { display: true, text: 'Hz' } },
          y1: { position: 'right', title: { display: true, text: 'g' }, grid: { drawOnChartArea: false } }
        },
        plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } }
      }
    });
  }

  // ----------------------- SESSION HISTORY (localStorage) -----------------------
  function safeStorage() {
    try {
      const k = '__ts_test__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return localStorage;
    } catch (e) { return null; }
  }

  function loadHistory() {
    const ls = safeStorage();
    if (!ls) return [];
    try { return JSON.parse(ls.getItem('tremorsense_history') || '[]'); }
    catch (e) { return []; }
  }

  function saveHistoryEntry(entry) {
    const ls = safeStorage();
    if (!ls) return false;
    const list = loadHistory();
    list.unshift(entry);
    try { ls.setItem('tremorsense_history', JSON.stringify(list.slice(0, 50))); return true; }
    catch (e) { return false; }
  }

  let lastAssessment = null;
  $('btnSaveSession').addEventListener('click', () => {
    if (!lastAssessment) return;
    const ok = saveHistoryEntry({
      ts: Date.now(),
      mode: lastAssessment.info.name,
      freq: lastAssessment.freq,
      amp: lastAssessment.amp,
      risk: lastAssessment.risk,
      severity: lastAssessment.severity,
      confidence: lastAssessment.confidence
    });
    $('btnSaveSession').textContent = ok ? 'Saved ✓' : 'Save Unavailable';
    setTimeout(() => { $('btnSaveSession').textContent = 'Save Session'; }, 1800);
  });

  $('btnNewMeasurement').addEventListener('click', () => showScreen('mode'));

  function renderHistory() {
    const list = loadHistory();
    const container = $('historyList');
    if (!list.length) {
      container.innerHTML = '<p class="muted">No saved sessions yet.</p>';
      return;
    }
    container.innerHTML = list.map(item => `
      <div class="history-item">
        <div>
          <div class="h-mode">${item.mode}</div>
          <div class="h-meta">${new Date(item.ts).toLocaleString()} · ${item.freq.toFixed(1)} Hz · ${item.amp.toFixed(3)} g</div>
        </div>
        <div class="h-risk risk-${item.risk}">${item.risk.toUpperCase()}</div>
      </div>
    `).join('');
  }

  // Wrap renderResults to remember last assessment for saving
  const _renderResults = renderResults;
  renderResults = function (a) { lastAssessment = a; _renderResults(a); };

  // ----------------------- PULSE STRIP PATH -----------------------
  function buildPulsePath() {
    // A repeating ECG-like waveform (single unit, tiled via CSS scroll animation).
    const unit = [
      [0, 20], [20, 20], [26, 8], [32, 32], [38, 14], [44, 20], [60, 20],
      [66, 20], [72, 10], [78, 30], [84, 16], [90, 20], [106, 20]
    ];
    const points = [];
    for (let rep = 0; rep < 6; rep++) {
      unit.forEach(([x, y]) => points.push([x + rep * 106, y]));
    }
    const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
    $('pulsePath').setAttribute('d', d);
  }

  // ----------------------- SERVICE WORKER -----------------------
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => { /* non-fatal */ });
    }
  }

  // ----------------------- INIT -----------------------
  function init() {
    buildPulsePath();
    updateLiveReadouts();
    connectMqtt();
    registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
