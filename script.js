(() => {
  'use strict';

  // ===== State =====
  const state = {
    fileName: '',
    columns: [],
    selectedColIndex: 1,
    steps: [], // { stepIndex, stepTotal, rawInfo, paramName, paramRaw, paramValue, times, valuesByCol }
    results: [], // analyzed rows in original step order
    tMinGlobal: 0,
    tMaxGlobal: 0,
    windowPreset: 'last20',
    tStart: 0,
    tEnd: 0,
    rippleFormula: 'pp_avg',
    precision: 4,
    trendMode: 'voltage', // 'voltage' | 'ripple'
    logXAxis: true,
    zoomSteady: true,
    selectedStepIdx: 0, // index in state.steps
    sortKey: 'stepIndex',
    sortDir: 'asc',
    searchQuery: '',
    trendPoints: [], // cached screen coordinates for hover/click
    wavePlotMeta: null,
  };

  // ===== DOM Elements =====
  const el = {
    globalDropOverlay: document.getElementById('globalDropOverlay'),
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    btnLoadSample: document.getElementById('btnLoadSample'),
    statusBanner: document.getElementById('statusBanner'),
    dashboard: document.getElementById('dashboard'),
    fileMetaBadges: document.getElementById('fileMetaBadges'),
    signalSelect: document.getElementById('signalSelect'),
    windowPreset: document.getElementById('windowPreset'),
    customTimeGroup: document.getElementById('customTimeGroup'),
    timeStartMs: document.getElementById('timeStartMs'),
    timeEndMs: document.getElementById('timeEndMs'),
    rippleFormula: document.getElementById('rippleFormula'),
    precisionSelect: document.getElementById('precisionSelect'),
    formulaNote: document.getElementById('formulaNote'),
    kpiGrid: document.getElementById('kpiGrid'),
    trendCanvas: document.getElementById('trendCanvas'),
    trendTooltip: document.getElementById('trendTooltip'),
    trendChartSub: document.getElementById('trendChartSub'),
    logXAxis: document.getElementById('logXAxis'),
    waveCanvas: document.getElementById('waveCanvas'),
    waveTooltip: document.getElementById('waveTooltip'),
    waveChartSub: document.getElementById('waveChartSub'),
    btnPrevStep: document.getElementById('btnPrevStep'),
    btnNextStep: document.getElementById('btnNextStep'),
    stepSelect: document.getElementById('stepSelect'),
    zoomSteady: document.getElementById('zoomSteady'),
    tableSearch: document.getElementById('tableSearch'),
    tableCountSub: document.getElementById('tableCountSub'),
    btnCopyTsv: document.getElementById('btnCopyTsv'),
    btnDownloadCsv: document.getElementById('btnDownloadCsv'),
    resultsTable: document.getElementById('resultsTable'),
    resultsTbody: document.getElementById('resultsTbody'),
  };

  // ===== Utilities =====
  function showStatus(message, type = 'info') {
    el.statusBanner.textContent = message;
    el.statusBanner.className = `status-banner ${type}`;
    el.statusBanner.classList.remove('hidden');
  }

  function hideStatus() {
    el.statusBanner.classList.add('hidden');
  }

  function decodeTextBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    // Heuristic for BOM-less UTF-16LE
    if (bytes.length >= 8 && bytes[1] === 0 && bytes[3] === 0 && bytes[0] !== 0) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  const SPICE_SUFFIXES = {
    f: 1e-15,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    'µ': 1e-6,
    'μ': 1e-6,
    m: 1e-3,
    k: 1e3,
    meg: 1e6,
    g: 1e9,
    t: 1e12,
  };

  function parseSpiceValue(str) {
    if (typeof str !== 'string') return NaN;
    const cleaned = str.trim();
    const m = cleaned.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(meg|[fpnuµμmkgt])?/i);
    if (!m) return NaN;
    const base = parseFloat(m[1]);
    if (!Number.isFinite(base)) return NaN;
    const suffix = m[2] ? m[2].toLowerCase() : '';
    const mult = suffix ? (SPICE_SUFFIXES[suffix] || 1) : 1;
    return base * mult;
  }

  function formatResistanceOrValue(paramName, paramRaw, numVal) {
    if (!Number.isFinite(numVal)) {
      return paramName ? `${paramName}=${paramRaw}` : paramRaw;
    }
    const isResistance = /^r/i.test(paramName || '');
    const unit = isResistance ? ' Ω' : '';
    const abs = Math.abs(numVal);

    let scaled = numVal;
    let prefix = '';
    if (abs >= 1e9) {
      scaled = numVal / 1e9;
      prefix = 'G';
    } else if (abs >= 1e6) {
      scaled = numVal / 1e6;
      prefix = 'M';
    } else if (abs >= 1e3) {
      scaled = numVal / 1e3;
      prefix = 'k';
    } else if (abs > 0 && abs < 1e-6) {
      scaled = numVal * 1e9;
      prefix = 'n';
    } else if (abs > 0 && abs < 1e-3) {
      scaled = numVal * 1e6;
      prefix = 'µ';
    } else if (abs > 0 && abs < 1) {
      scaled = numVal * 1e3;
      prefix = 'm';
    }

    const numStr = Number(scaled.toPrecision(5)).toString();
    const labelPrefix = paramName ? `${paramName} = ` : '';
    return `${labelPrefix}${numStr} ${prefix}${unit}`.replace(/\s+/g, ' ').trim();
  }

  function fmtNum(val, digits = state.precision) {
    if (!Number.isFinite(val)) return '—';
    return val.toFixed(digits);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== LTspice File Parser =====
  function parseLtspiceText(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) {
      throw new Error('ファイルの行数が不足しています。LTspice の波形テキストファイルか確認してください。');
    }

    // Find header line (first non-empty line)
    let startIdx = 0;
    while (startIdx < lines.length && !lines[startIdx].trim()) {
      startIdx++;
    }
    if (startIdx >= lines.length) {
      throw new Error('ファイルが空です。');
    }

    const headerLine = lines[startIdx].trim();
    const columns = headerLine.split(/\t+|\s{2,}|\s+/).filter(Boolean);
    if (columns.length < 2 || !/time/i.test(columns[0])) {
      throw new Error(`ヘッダー行を認識できませんでした: "${headerLine}"（先頭列が time の LTspice テキストファイルが必要です）`);
    }

    const colCount = columns.length;
    const steps = [];
    let currentStep = null;
    let tMinGlobal = Infinity;
    let tMaxGlobal = -Infinity;

    function createStep(infoLine) {
      let stepIndex = steps.length + 1;
      let stepTotal = 0;
      let paramName = '';
      let paramRaw = '';
      let paramValue = NaN;
      let conditionDetail = '';

      if (infoLine) {
        const stepMatch = infoLine.match(/\(Step:\s*(\d+)\s*\/\s*(\d+)\)/i);
        if (stepMatch) {
          stepIndex = parseInt(stepMatch[1], 10);
          stepTotal = parseInt(stepMatch[2], 10);
        }
        const body = infoLine
          .replace(/^Step Information:\s*/i, '')
          .replace(/\(Step:\s*\d+\s*\/\s*\d+\)/i, '')
          .trim();
        conditionDetail = body;

        // Extract first key=value pair if present
        const kvMatch = body.match(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s,]+)/);
        if (kvMatch) {
          paramName = kvMatch[1];
          paramRaw = kvMatch[2];
          paramValue = parseSpiceValue(paramRaw);
        } else {
          paramRaw = body || `Step ${stepIndex}`;
        }
      } else {
        paramRaw = '単一実行';
        conditionDetail = 'Step なし (単一波形)';
      }

      const valuesByCol = [];
      for (let c = 1; c < colCount; c++) {
        valuesByCol.push([]);
      }

      const condDisplay = infoLine
        ? (Number.isFinite(paramValue) ? formatResistanceOrValue(paramName, paramRaw, paramValue) : conditionDetail)
        : '単一波形';

      return {
        stepIndex,
        stepTotal,
        rawInfo: infoLine || '',
        conditionDetail,
        condDisplay,
        paramName,
        paramRaw,
        paramValue,
        times: [],
        valuesByCol,
      };
    }

    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('Step Information:')) {
        currentStep = createStep(line);
        steps.push(currentStep);
        continue;
      }

      const parts = line.split(/\t+|\s+/);
      if (parts.length < 2) continue;

      const t = Number(parts[0]);
      if (!Number.isFinite(t)) continue;

      if (!currentStep) {
        currentStep = createStep(null);
        steps.push(currentStep);
      }

      currentStep.times.push(t);
      if (t < tMinGlobal) tMinGlobal = t;
      if (t > tMaxGlobal) tMaxGlobal = t;

      for (let c = 1; c < colCount; c++) {
        const v = Number(parts[c]);
        currentStep.valuesByCol[c - 1].push(Number.isFinite(v) ? v : NaN);
      }
    }

    const validSteps = steps.filter((s) => s.times.length >= 2);
    if (validSteps.length === 0) {
      throw new Error('有効な数値データが見つかりませんでした。');
    }

    // Fill stepTotal if omitted
    const total = validSteps.length;
    for (const s of validSteps) {
      if (!s.stepTotal) s.stepTotal = total;
    }

    return {
      columns,
      steps: validSteps,
      tMinGlobal,
      tMaxGlobal,
    };
  }

  // ===== Waveform Analysis (Exact Trapezoidal Time-Weighted Integral) =====
  function sliceWithBoundaryInterpolation(times, values, tStart, tEnd) {
    const n = times.length;
    const outT = [];
    const outV = [];

    if (n === 0 || tEnd <= tStart) return { outT, outV };

    // Clamp window to available range
    const start = Math.max(tStart, times[0]);
    const end = Math.min(tEnd, times[n - 1]);
    if (end <= start) return { outT, outV };

    for (let i = 0; i < n; i++) {
      const ti = times[i];
      const vi = values[i];

      if (outT.length === 0) {
        if (ti === start) {
          outT.push(ti);
          outV.push(vi);
        } else if (ti > start) {
          if (i > 0) {
            const tPrev = times[i - 1];
            const vPrev = values[i - 1];
            const ratio = (start - tPrev) / (ti - tPrev);
            outT.push(start);
            outV.push(vPrev + ratio * (vi - vPrev));
          }
          if (ti <= end) {
            outT.push(ti);
            outV.push(vi);
          } else if (i > 0) {
            const tPrev = times[i - 1];
            const vPrev = values[i - 1];
            const ratio = (end - tPrev) / (ti - tPrev);
            outT.push(end);
            outV.push(vPrev + ratio * (vi - vPrev));
            break;
          }
        }
        continue;
      }

      if (ti < end) {
        outT.push(ti);
        outV.push(vi);
      } else if (ti === end) {
        outT.push(ti);
        outV.push(vi);
        break;
      } else {
        const tPrev = times[i - 1];
        const vPrev = values[i - 1];
        const ratio = (end - tPrev) / (ti - tPrev);
        outT.push(end);
        outV.push(vPrev + ratio * (vi - vPrev));
        break;
      }
    }

    return { outT, outV };
  }

  function analyzeStep(step, colOffset, tStart, tEnd, rippleFormula) {
    const times = step.times;
    const values = step.valuesByCol[colOffset];
    const { outT, outV } = sliceWithBoundaryInterpolation(times, values, tStart, tEnd);

    if (outT.length < 2) {
      return {
        stepIndex: step.stepIndex,
        stepTotal: step.stepTotal,
        condDisplay: step.condDisplay,
        paramRaw: step.paramRaw,
        paramName: step.paramName,
        paramValue: step.paramValue,
        rawInfo: step.rawInfo,
        sampleCount: outT.length,
        vmax: NaN,
        vmin: NaN,
        vavg: NaN,
        ripplePP: NaN,
        rippleRMS: NaN,
        rippleFactor: NaN,
      };
    }

    let vmax = -Infinity;
    let vmin = Infinity;
    for (let i = 0; i < outV.length; i++) {
      const v = outV[i];
      if (v > vmax) vmax = v;
      if (v < vmin) vmin = v;
    }

    const duration = outT[outT.length - 1] - outT[0];
    let area = 0;
    for (let i = 0; i < outT.length - 1; i++) {
      const dt = outT[i + 1] - outT[i];
      area += 0.5 * (outV[i] + outV[i + 1]) * dt;
    }
    const vavg = duration > 0 ? area / duration : NaN;

    // Exact integral of piecewise-linear (V(t) - Vavg)^2
    let areaSq = 0;
    for (let i = 0; i < outT.length - 1; i++) {
      const dt = outT[i + 1] - outT[i];
      const a = outV[i] - vavg;
      const b = outV[i + 1] - vavg;
      areaSq += ((a * a + a * b + b * b) / 3) * dt;
    }
    const rippleRMS = duration > 0 ? Math.sqrt(Math.max(0, areaSq / duration)) : NaN;
    const ripplePP = vmax - vmin;

    let rippleFactor = NaN;
    if (Number.isFinite(vavg) && Math.abs(vavg) > 1e-12) {
      if (rippleFormula === 'rms_avg') {
        rippleFactor = (rippleRMS / Math.abs(vavg)) * 100;
      } else if (rippleFormula === 'half_pp_avg') {
        rippleFactor = ((ripplePP / 2) / Math.abs(vavg)) * 100;
      } else {
        rippleFactor = (ripplePP / Math.abs(vavg)) * 100;
      }
    }

    return {
      stepIndex: step.stepIndex,
      stepTotal: step.stepTotal,
      condDisplay: step.condDisplay,
      paramRaw: step.paramRaw,
      paramName: step.paramName,
      paramValue: step.paramValue,
      rawInfo: step.rawInfo,
      sampleCount: outT.length,
      vmax,
      vmin,
      vavg,
      ripplePP,
      rippleRMS,
      rippleFactor,
    };
  }

  function computeWindowBounds() {
    const tMin = state.tMinGlobal;
    const tMax = state.tMaxGlobal;
    const span = tMax - tMin;

    let tStart = tMin;
    let tEnd = tMax;

    switch (state.windowPreset) {
      case 'last20':
        tStart = tMin + span * 0.8;
        break;
      case 'last50':
        tStart = tMin + span * 0.5;
        break;
      case 'last10ms':
        tStart = Math.max(tMin, tMax - 0.01);
        break;
      case 'last5ms':
        tStart = Math.max(tMin, tMax - 0.005);
        break;
      case 'full':
        tStart = tMin;
        break;
      case 'custom': {
        const sMs = parseFloat(el.timeStartMs.value);
        const eMs = parseFloat(el.timeEndMs.value);
        tStart = Number.isFinite(sMs) ? Math.max(tMin, sMs / 1000) : tMin;
        tEnd = Number.isFinite(eMs) ? Math.min(tMax, eMs / 1000) : tMax;
        if (tEnd <= tStart) {
          tStart = tMin;
          tEnd = tMax;
        }
        break;
      }
      default:
        tStart = tMin + span * 0.8;
    }

    state.tStart = tStart;
    state.tEnd = tEnd;

    if (state.windowPreset !== 'custom') {
      el.timeStartMs.value = (tStart * 1000).toFixed(2);
      el.timeEndMs.value = (tEnd * 1000).toFixed(2);
    }

    const isCustom = state.windowPreset === 'custom';
    el.timeStartMs.disabled = !isCustom;
    el.timeEndMs.disabled = !isCustom;
    el.customTimeGroup.classList.toggle('disabled', !isCustom);
  }

  function runAnalysis() {
    if (!state.steps.length) return;
    computeWindowBounds();

    const colOffset = state.selectedColIndex - 1;
    state.results = state.steps.map((s) =>
      analyzeStep(s, colOffset, state.tStart, state.tEnd, state.rippleFormula)
    );

    renderFormulaNote();
    renderKpis();
    renderTable();
    renderTrendChart();
    renderWaveChart();
  }

  // ===== UI Rendering =====
  function populateControlsAfterLoad() {
    // Signal selector
    el.signalSelect.innerHTML = '';
    for (let c = 1; c < state.columns.length; c++) {
      const opt = document.createElement('option');
      opt.value = String(c);
      opt.textContent = state.columns[c];
      el.signalSelect.appendChild(opt);
    }
    state.selectedColIndex = 1;
    el.signalSelect.value = '1';

    // Step selector
    el.stepSelect.innerHTML = '';
    state.steps.forEach((s, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = `#${s.stepIndex}: ${s.condDisplay}`;
      el.stepSelect.appendChild(opt);
    });
    state.selectedStepIdx = 0;
    el.stepSelect.value = '0';

    // Determine sensible default for log X-axis
    const numericVals = state.steps.map((s) => s.paramValue).filter((v) => Number.isFinite(v) && v > 0);
    const canLog = numericVals.length === state.steps.length && state.steps.length > 2 &&
      Math.max(...numericVals) / Math.min(...numericVals) >= 5;
    state.logXAxis = canLog;
    el.logXAxis.checked = canLog;
    el.logXAxis.disabled = numericVals.length !== state.steps.length;

    // Meta badges
    const totalPoints = state.steps.reduce((acc, s) => acc + s.times.length, 0);
    el.fileMetaBadges.innerHTML = [
      `<span class="meta-badge">${escapeHtml(state.fileName)}</span>`,
      `<span class="meta-badge">Step数: ${state.steps.length}</span>`,
      `<span class="meta-badge">総データ点: ${totalPoints.toLocaleString()}</span>`,
      `<span class="meta-badge">時間: ${(state.tMinGlobal * 1000).toFixed(2)}〜${(state.tMaxGlobal * 1000).toFixed(2)} ms</span>`,
    ].join('');
  }

  function renderFormulaNote() {
    const startMs = (state.tStart * 1000).toFixed(2);
    const endMs = (state.tEnd * 1000).toFixed(2);
    const formulaMap = {
      pp_avg: '脈動率 = (Vmax − Vmin) / Vavg × 100 [%]',
      rms_avg: '脈動率 = Vr(rms) / Vavg × 100 [%]',
      half_pp_avg: '脈動率 = ((Vmax − Vmin) / 2) / Vavg × 100 [%]',
    };
    el.formulaNote.innerHTML = `
      <span>解析区間: <code>${startMs} ms 〜 ${endMs} ms</code></span>
      <span>リップル: <code>ΔV = Vmax − Vmin</code></span>
      <span>平均電圧: <code>Vavg = (1/ΔT)∫V(t)dt</code></span>
      <span><code>${formulaMap[state.rippleFormula]}</code></span>
    `;
  }

  function renderKpis() {
    const valid = state.results.filter((r) => Number.isFinite(r.vavg));
    if (!valid.length) {
      el.kpiGrid.innerHTML = '';
      return;
    }

    const vmaxAll = Math.max(...valid.map((r) => r.vmax));
    const vminAll = Math.min(...valid.map((r) => r.vmin));
    const vavgMin = Math.min(...valid.map((r) => r.vavg));
    const vavgMax = Math.max(...valid.map((r) => r.vavg));
    const ripMin = Math.min(...valid.map((r) => r.ripplePP));
    const ripMax = Math.max(...valid.map((r) => r.ripplePP));
    const gamMin = Math.min(...valid.map((r) => r.rippleFactor));
    const gamMax = Math.max(...valid.map((r) => r.rippleFactor));

    const first = valid[0];
    const last = valid[valid.length - 1];

    el.kpiGrid.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">条件範囲 (${escapeHtml(first.paramName || 'Step')})</div>
        <div class="kpi-value">${valid.length === 1 ? escapeHtml(first.condDisplay) : `${escapeHtml(first.condDisplay)} 〜 ${escapeHtml(last.condDisplay)}`}</div>
        <div class="kpi-sub">Step数: ${valid.length} 条件 / 信号: ${escapeHtml(state.columns[state.selectedColIndex])}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">最大値 / 最小値 (全条件)</div>
        <div class="kpi-value">${fmtNum(vmaxAll)} V / ${fmtNum(vminAll)} V</div>
        <div class="kpi-sub">定常区間 ${((state.tStart) * 1000).toFixed(1)}〜${((state.tEnd) * 1000).toFixed(1)} ms</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">出力平均電圧 Vavg の範囲</div>
        <div class="kpi-value">${valid.length === 1 ? `${fmtNum(vavgMin)} V` : `${fmtNum(vavgMin)} 〜 ${fmtNum(vavgMax)} V`}</div>
        <div class="kpi-sub">台形積分による時間平均</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">リップル ΔV の範囲</div>
        <div class="kpi-value">${valid.length === 1 ? `${fmtNum(ripMin)} V` : `${fmtNum(ripMin)} 〜 ${fmtNum(ripMax)} V`}</div>
        <div class="kpi-sub">最小 ${(ripMin * 1000).toFixed(2)} mV 〜 最大 ${(ripMax * 1000).toFixed(2)} mV</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">脈動率の範囲</div>
        <div class="kpi-value">${valid.length === 1 ? `${fmtNum(gamMin, 3)} %` : `${fmtNum(gamMin, 3)} 〜 ${fmtNum(gamMax, 3)} %`}</div>
        <div class="kpi-sub">選択した定義式で算出</div>
      </div>
    `;
  }

  function getFilteredSortedResults() {
    const q = state.searchQuery.trim().toLowerCase();
    let list = state.results.slice();

    if (q) {
      list = list.filter(
        (r) =>
          r.condDisplay.toLowerCase().includes(q) ||
          r.paramRaw.toLowerCase().includes(q) ||
          String(r.stepIndex).includes(q)
      );
    }

    const key = state.sortKey;
    const dir = state.sortDir === 'asc' ? 1 : -1;

    list.sort((a, b) => {
      let va = a[key];
      let vb = b[key];
      if (key === 'paramValue' && (!Number.isFinite(va) || !Number.isFinite(vb))) {
        va = a.condDisplay;
        vb = b.condDisplay;
        return va.localeCompare(vb, 'ja') * dir;
      }
      if (!Number.isFinite(va) && !Number.isFinite(vb)) return 0;
      if (!Number.isFinite(va)) return 1;
      if (!Number.isFinite(vb)) return -1;
      return (va - vb) * dir;
    });

    return list;
  }

  function renderTable() {
    const rows = getFilteredSortedResults();
    const p = state.precision;
    const pPct = Math.max(2, p - 1);

    el.tableCountSub.textContent = `表示中: ${rows.length} / ${state.results.length} 件（行クリックで波形プレビューを表示）`;

    // Update sort indicators
    el.resultsTable.querySelectorAll('th.sortable').forEach((th) => {
      const ind = th.querySelector('.sort-ind');
      if (th.dataset.sort === state.sortKey) {
        ind.textContent = state.sortDir === 'asc' ? '▲' : '▼';
      } else {
        ind.textContent = '';
      }
    });

    const selectedStepNumber = state.steps[state.selectedStepIdx]?.stepIndex;
    const frag = document.createDocumentFragment();

    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.stepIndex === selectedStepNumber) {
        tr.classList.add('selected-row');
      }
      tr.dataset.stepIndex = String(r.stepIndex);

      let badgeClass = 'ripple-low';
      if (r.rippleFactor >= 10) badgeClass = 'ripple-high';
      else if (r.rippleFactor >= 2) badgeClass = 'ripple-mid';

      const rawSub = r.paramRaw && r.condDisplay !== r.paramRaw
        ? `<span class="cond-raw">(${escapeHtml(r.paramRaw)})</span>`
        : '';

      tr.innerHTML = `
        <td class="num">${r.stepIndex}</td>
        <td class="cond-cell">${escapeHtml(r.condDisplay)}${rawSub}</td>
        <td class="num">${fmtNum(r.vmax, p)}</td>
        <td class="num">${fmtNum(r.vmin, p)}</td>
        <td class="num">${fmtNum(r.vavg, p)}</td>
        <td class="num">${fmtNum(r.ripplePP, p)}</td>
        <td class="num"><span class="ripple-badge ${badgeClass}">${fmtNum(r.rippleFactor, pPct)}%</span></td>
      `;
      frag.appendChild(tr);
    }

    el.resultsTbody.innerHTML = '';
    el.resultsTbody.appendChild(frag);
  }

  // ===== Canvas Chart Helpers =====
  function setupHiDpiCanvas(canvas) {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(300, Math.floor(rect.width));
    const height = Math.max(240, Math.floor(rect.height));
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function niceTicks(minVal, maxVal, targetCount = 5) {
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return [0, 1];
    if (minVal === maxVal) {
      const d = Math.abs(minVal) * 0.1 || 1;
      return [minVal - d, minVal, minVal + d];
    }
    const span = maxVal - minVal;
    const rawStep = span / targetCount;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    let step;
    if (norm <= 1.5) step = 1 * mag;
    else if (norm <= 3) step = 2 * mag;
    else if (norm <= 7) step = 5 * mag;
    else step = 10 * mag;

    const start = Math.floor(minVal / step) * step;
    const end = Math.ceil(maxVal / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step * 1e-6; v += step) {
      ticks.push(Number(v.toPrecision(10)));
    }
    return ticks;
  }

  function tickDecimals(ticks, minDecimals = 2, maxDecimals = 5) {
    if (!ticks || ticks.length < 2) return minDecimals;
    const step = Math.abs(ticks[1] - ticks[0]);
    if (step <= 0) return minDecimals;
    const needed = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    return Math.min(maxDecimals, Math.max(minDecimals, needed));
  }

  function formatCompactAxisNum(v) {
    const abs = Math.abs(v);
    if (abs >= 1e6) return `${Number((v / 1e6).toPrecision(3))}M`;
    if (abs >= 1e3) return `${Number((v / 1e3).toPrecision(3))}k`;
    if (abs === 0) return '0';
    if (abs < 0.01) return v.toExponential(1);
    return Number(v.toPrecision(4)).toString();
  }

  // ===== Trend Chart =====
  function renderTrendChart() {
    if (!state.results.length) return;
    const { ctx, width, height } = setupHiDpiCanvas(el.trendCanvas);
    ctx.clearRect(0, 0, width, height);

    const pad = { top: 26, right: state.trendMode === 'ripple' ? 62 : 24, bottom: 44, left: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const valid = state.results.filter((r) => Number.isFinite(r.vavg));
    if (!valid.length) return;

    const useParamX = valid.every((r) => Number.isFinite(r.paramValue) && r.paramValue > 0);
    const useLog = useParamX && state.logXAxis;

    const xRaw = valid.map((r) => (useParamX ? r.paramValue : r.stepIndex));
    const xMapped = xRaw.map((v) => (useLog ? Math.log10(v) : v));
    let xMin = Math.min(...xMapped);
    let xMax = Math.max(...xMapped);
    if (xMin === xMax) {
      xMin -= 1;
      xMax += 1;
    }

    const mapX = (val) => pad.left + ((val - xMin) / (xMax - xMin)) * plotW;

    // Grid & X-axis
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#64748b';

    let xTicks = [];
    if (useLog) {
      const pMin = Math.floor(xMin);
      const pMax = Math.ceil(xMax);
      for (let p = pMin; p <= pMax; p++) {
        if (p >= xMin - 1e-6 && p <= xMax + 1e-6) {
          xTicks.push({ mapped: p, label: formatCompactAxisNum(Math.pow(10, p)) });
        }
      }
      if (xTicks.length < 2) {
        xTicks = niceTicks(xMin, xMax, 4).map((m) => ({ mapped: m, label: formatCompactAxisNum(Math.pow(10, m)) }));
      }
    } else {
      xTicks = niceTicks(xMin, xMax, 5).map((m) => ({ mapped: m, label: formatCompactAxisNum(m) }));
    }

    xTicks.forEach((tk) => {
      const px = mapX(tk.mapped);
      ctx.beginPath();
      ctx.moveTo(px, pad.top);
      ctx.lineTo(px, pad.top + plotH);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(tk.label, px, pad.top + plotH + 8);
    });

    // X label
    const xAxisTitle = useParamX ? `${valid[0].paramName || '条件'}${/^r/i.test(valid[0].paramName || '') ? ' [Ω]' : ''}${useLog ? ' (対数)' : ''}` : 'Step';
    ctx.fillStyle = '#475569';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xAxisTitle, pad.left + plotW / 2, height - 16);

    state.trendPoints = [];
    const selectedStepNum = state.steps[state.selectedStepIdx]?.stepIndex;

    if (state.trendMode === 'voltage') {
      const allY = valid.flatMap((r) => [r.vmax, r.vavg, r.vmin]);
      let yMin = Math.min(...allY);
      let yMax = Math.max(...allY);
      const yPad = (yMax - yMin) * 0.08 || 0.5;
      const ticks = niceTicks(yMin - yPad, yMax + yPad, 5);
      yMin = ticks[0];
      yMax = ticks[ticks.length - 1];
      const mapY = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

      // Y grid
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ticks.forEach((tv) => {
        const py = mapY(tv);
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(pad.left, py);
        ctx.lineTo(pad.left + plotW, py);
        ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(tv.toFixed(2), pad.left - 8, py);
      });

      const series = [
        { key: 'vmax', label: 'Vmax', color: '#ef4444' },
        { key: 'vavg', label: 'Vavg', color: '#2563eb' },
        { key: 'vmin', label: 'Vmin', color: '#10b981' },
      ];

      series.forEach((s) => {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        valid.forEach((r, idx) => {
          const px = mapX(xMapped[idx]);
          const py = mapY(r[s.key]);
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });

      // Points & cache
      valid.forEach((r, idx) => {
        const px = mapX(xMapped[idx]);
        const pyAvg = mapY(r.vavg);
        const isSel = r.stepIndex === selectedStepNum;

        if (isSel) {
          ctx.strokeStyle = 'rgba(37, 99, 235, 0.35)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(px, pad.top);
          ctx.lineTo(px, pad.top + plotH);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        if (valid.length <= 45 || isSel) {
          for (const s of series) {
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(px, mapY(r[s.key]), isSel ? 4.5 : 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        state.trendPoints.push({ px, py: pyAvg, result: r });
      });

      // Legend
      let lx = pad.left + 8;
      ctx.font = '12px sans-serif';
      series.forEach((s) => {
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, 7, 12, 4);
        ctx.fillStyle = '#334155';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(s.label, lx + 16, 10);
        lx += 64;
      });

      ctx.fillStyle = '#475569';
      ctx.textAlign = 'left';
      ctx.fillText('[V]', 8, pad.top - 10);
    } else {
      // Ripple (left axis) & Ripple Factor % (right axis)
      let rMin = 0;
      let rMax = Math.max(...valid.map((r) => r.ripplePP)) * 1.08 || 1;
      const rTicks = niceTicks(rMin, rMax, 5);
      rMin = rTicks[0];
      rMax = rTicks[rTicks.length - 1];

      let gMin = 0;
      let gMax = Math.max(...valid.map((r) => r.rippleFactor)) * 1.08 || 1;
      const gTicks = niceTicks(gMin, gMax, 5);
      gMin = gTicks[0];
      gMax = gTicks[gTicks.length - 1];

      const mapYR = (v) => pad.top + plotH - ((v - rMin) / (rMax - rMin)) * plotH;
      const mapYG = (v) => pad.top + plotH - ((v - gMin) / (gMax - gMin)) * plotH;

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      rTicks.forEach((tv) => {
        const py = mapYR(tv);
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(pad.left, py);
        ctx.lineTo(pad.left + plotW, py);
        ctx.stroke();
        ctx.fillStyle = '#0284c7';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(tv.toFixed(2), pad.left - 8, py);
      });

      gTicks.forEach((tv) => {
        const py = mapYG(tv);
        ctx.fillStyle = '#d97706';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${tv.toFixed(1)}%`, pad.left + plotW + 6, py);
      });

      // Ripple line
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      valid.forEach((r, idx) => {
        const px = mapX(xMapped[idx]);
        const py = mapYR(r.ripplePP);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Ripple factor dashed line
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      valid.forEach((r, idx) => {
        const px = mapX(xMapped[idx]);
        const py = mapYG(r.rippleFactor);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      valid.forEach((r, idx) => {
        const px = mapX(xMapped[idx]);
        const py = mapYR(r.ripplePP);
        const isSel = r.stepIndex === selectedStepNum;
        if (isSel) {
          ctx.fillStyle = '#0284c7';
          ctx.beginPath();
          ctx.arc(px, py, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#d97706';
          ctx.beginPath();
          ctx.arc(px, mapYG(r.rippleFactor), 4.5, 0, Math.PI * 2);
          ctx.fill();
        }
        state.trendPoints.push({ px, py, result: r });
      });

      // Legend
      ctx.font = '12px sans-serif';
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(pad.left + 8, 7, 12, 4);
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('リップル ΔV [V] (左軸)', pad.left + 24, 10);

      ctx.fillStyle = '#d97706';
      ctx.fillRect(pad.left + 175, 7, 12, 4);
      ctx.fillStyle = '#334155';
      ctx.fillText('脈動率 [%] (右軸)', pad.left + 191, 10);
    }

    // Plot border
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  }

  // ===== Waveform Preview Chart =====
  function renderWaveChart() {
    const step = state.steps[state.selectedStepIdx];
    const res = state.results[state.selectedStepIdx];
    if (!step || !res) return;

    const { ctx, width, height } = setupHiDpiCanvas(el.waveCanvas);
    ctx.clearRect(0, 0, width, height);

    el.waveChartSub.textContent =
      `Step ${step.stepIndex}/${step.stepTotal} — ${step.condDisplay} | ` +
      `Vmax=${fmtNum(res.vmax)}V, Vmin=${fmtNum(res.vmin)}V, Vavg=${fmtNum(res.vavg)}V, ΔV=${fmtNum(res.ripplePP)}V`;

    const colOffset = state.selectedColIndex - 1;
    const times = step.times;
    const values = step.valuesByCol[colOffset];

    let dispT = times;
    let dispV = values;
    let xMin = state.tMinGlobal;
    let xMax = state.tMaxGlobal;

    if (state.zoomSteady) {
      const sliced = sliceWithBoundaryInterpolation(times, values, state.tStart, state.tEnd);
      if (sliced.outT.length >= 2) {
        dispT = sliced.outT;
        dispV = sliced.outV;
        xMin = dispT[0];
        xMax = dispT[dispT.length - 1];
      }
    }

    let yMin = Math.min(...dispV);
    let yMax = Math.max(...dispV);
    const ySpan = yMax - yMin;
    const yPad = ySpan > 0 ? ySpan * 0.14 : 0.5;
    const yTicks = niceTicks(yMin - yPad, yMax + yPad, 5);
    yMin = yTicks[0];
    yMax = yTicks[yTicks.length - 1];

    const yDec = tickDecimals(yTicks, 2, 5);
    const pad = { top: 22, right: 24, bottom: 42, left: yDec >= 4 ? 68 : 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const mapX = (t) => pad.left + ((t - xMin) / (xMax - xMin || 1)) * plotW;
    const mapY = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    // Highlight steady-state region if showing full trace
    if (!state.zoomSteady) {
      const sx1 = mapX(state.tStart);
      const sx2 = mapX(state.tEnd);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
      ctx.fillRect(sx1, pad.top, Math.max(1, sx2 - sx1), plotH);
    }

    // Grid
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

    yTicks.forEach((tv) => {
      const py = mapY(tv);
      ctx.beginPath();
      ctx.moveTo(pad.left, py);
      ctx.lineTo(pad.left + plotW, py);
      ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(tv.toFixed(yDec), pad.left - 8, py);
    });

    const xTicksMs = niceTicks(xMin * 1000, xMax * 1000, 5);
    xTicksMs.forEach((ms) => {
      const t = ms / 1000;
      if (t < xMin - 1e-9 || t > xMax + 1e-9) return;
      const px = mapX(t);
      ctx.beginPath();
      ctx.moveTo(px, pad.top);
      ctx.lineTo(px, pad.top + plotH);
      ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(Number(ms.toPrecision(4)).toString(), px, pad.top + plotH + 8);
    });

    ctx.fillStyle = '#475569';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('時間 [ms]', pad.left + plotW / 2, height - 15);

    // Reference lines: Vmax, Vavg, Vmin
    const refs = [
      { v: res.vmax, color: '#ef4444', label: `Vmax ${fmtNum(res.vmax, 3)}V` },
      { v: res.vavg, color: '#059669', label: `Vavg ${fmtNum(res.vavg, 3)}V` },
      { v: res.vmin, color: '#f59e0b', label: `Vmin ${fmtNum(res.vmin, 3)}V` },
    ];

    refs.forEach((rf) => {
      if (!Number.isFinite(rf.v) || rf.v < yMin || rf.v > yMax) return;
      const py = mapY(rf.v);
      ctx.strokeStyle = rf.color;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, py);
      ctx.lineTo(pad.left + plotW, py);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Waveform path
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < dispT.length; i++) {
      const px = mapX(dispT[i]);
      const py = mapY(dispV[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Border
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    // Legend top
    let lx = pad.left + 6;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    refs.forEach((rf) => {
      ctx.fillStyle = rf.color;
      ctx.fillRect(lx, 7, 10, 3);
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(rf.label, lx + 14, 9);
      lx += 112;
    });

    state.wavePlotMeta = { pad, plotW, plotH, xMin, xMax, yMin, yMax, dispT, dispV, mapX, mapY };
  }

  function selectStepByIndex(idx) {
    if (idx < 0 || idx >= state.steps.length) return;
    state.selectedStepIdx = idx;
    el.stepSelect.value = String(idx);
    renderTable();
    renderTrendChart();
    renderWaveChart();
  }

  // ===== Export Helpers =====
  function buildDelimitedText(delimiter) {
    const p = state.precision;
    const pPct = Math.max(2, p - 1);
    const headers = [
      'Step',
      '条件',
      '元の条件表記',
      '最大値 Vmax [V]',
      '最小値 Vmin [V]',
      '出力平均電圧 Vavg [V]',
      'リップル ΔV [V]',
      '脈動率 [%]',
    ];
    const rows = getFilteredSortedResults();
    const lines = [headers.join(delimiter)];

    for (const r of rows) {
      const cells = [
        r.stepIndex,
        r.condDisplay,
        r.rawInfo || r.paramRaw,
        fmtNum(r.vmax, p),
        fmtNum(r.vmin, p),
        fmtNum(r.vavg, p),
        fmtNum(r.ripplePP, p),
        fmtNum(r.rippleFactor, pPct),
      ];
      if (delimiter === ',') {
        lines.push(cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
      } else {
        lines.push(cells.join(delimiter));
      }
    }
    return lines.join('\r\n');
  }

  function downloadCsv() {
    const csv = '\uFEFF' + buildDelimitedText(',');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = state.fileName ? state.fileName.replace(/\.[^.]+$/, '') : 'ltspice';
    a.href = url;
    a.download = `${base}_analysis.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function copyTsvToClipboard() {
    const tsv = buildDelimitedText('\t');
    try {
      await navigator.clipboard.writeText(tsv);
      const orig = el.btnCopyTsv.textContent;
      el.btnCopyTsv.textContent = 'コピーしました ✓';
      setTimeout(() => {
        el.btnCopyTsv.textContent = orig;
      }, 1800);
    } catch {
      showStatus('クリップボードへのコピーに失敗しました。CSVダウンロードをご利用ください。', 'warning');
    }
  }

  // ===== File Loading =====
  function handleTextContent(text, fileName) {
    try {
      const parsed = parseLtspiceText(text);
      state.fileName = fileName;
      state.columns = parsed.columns;
      state.steps = parsed.steps;
      state.tMinGlobal = parsed.tMinGlobal;
      state.tMaxGlobal = parsed.tMaxGlobal;

      populateControlsAfterLoad();
      el.dashboard.classList.remove('hidden');
      el.dropZone.classList.add('compact');
      runAnalysis();
      showStatus(
        `${fileName} を読み込みました（${parsed.steps.length} Step・定常区間 ${((state.tStart) * 1000).toFixed(2)}〜${((state.tEnd) * 1000).toFixed(2)} ms で解析）。`,
        'success'
      );
    } catch (err) {
      showStatus(err.message || 'ファイルの解析中にエラーが発生しました。', 'error');
    }
  }

  async function loadFileObject(file) {
    if (!file) return;
    showStatus(`${file.name} を読み込み中...`, 'info');
    try {
      const buffer = await file.arrayBuffer();
      const text = decodeTextBuffer(buffer);
      handleTextContent(text, file.name);
    } catch (err) {
      showStatus(`ファイルの読み込みに失敗しました: ${err.message}`, 'error');
    }
  }

  async function loadBundledDraft() {
    showStatus('Draft.txt を読み込み中...', 'info');
    try {
      const res = await fetch('./Draft.txt');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      const text = decodeTextBuffer(buffer);
      handleTextContent(text, 'Draft.txt');
    } catch {
      showStatus(
        '直接開く (file://) 環境ではブラウザのセキュリティ制限により自動読込できません。フォルダ内の Draft.txt をこの画面にドラッグ＆ドロップしてください。',
        'warning'
      );
    }
  }

  // ===== Event Wiring =====
  el.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadFileObject(file);
    el.fileInput.value = '';
  });

  el.btnLoadSample.addEventListener('click', loadBundledDraft);

  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.fileInput.click();
    }
  });

  // Global & Zone Drag and Drop
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    el.globalDropOverlay.classList.remove('hidden');
    el.dropZone.classList.add('drag-over');
  });

  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      el.globalDropOverlay.classList.add('hidden');
      el.dropZone.classList.remove('drag-over');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.globalDropOverlay.classList.add('hidden');
    el.dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFileObject(file);
  });

  // Analysis parameter controls
  el.signalSelect.addEventListener('change', () => {
    state.selectedColIndex = parseInt(el.signalSelect.value, 10) || 1;
    runAnalysis();
  });

  el.windowPreset.addEventListener('change', () => {
    state.windowPreset = el.windowPreset.value;
    runAnalysis();
  });

  el.timeStartMs.addEventListener('change', () => {
    if (state.windowPreset === 'custom') runAnalysis();
  });

  el.timeEndMs.addEventListener('change', () => {
    if (state.windowPreset === 'custom') runAnalysis();
  });

  el.rippleFormula.addEventListener('change', () => {
    state.rippleFormula = el.rippleFormula.value;
    runAnalysis();
  });

  el.precisionSelect.addEventListener('change', () => {
    state.precision = parseInt(el.precisionSelect.value, 10) || 4;
    renderKpis();
    renderTable();
    renderWaveChart();
  });

  // Chart controls
  document.querySelectorAll('[data-trend-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-trend-mode]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.trendMode = btn.dataset.trendMode;
      renderTrendChart();
    });
  });

  el.logXAxis.addEventListener('change', () => {
    state.logXAxis = el.logXAxis.checked;
    renderTrendChart();
  });

  el.zoomSteady.addEventListener('change', () => {
    state.zoomSteady = el.zoomSteady.checked;
    renderWaveChart();
  });

  el.stepSelect.addEventListener('change', () => {
    selectStepByIndex(parseInt(el.stepSelect.value, 10) || 0);
  });

  el.btnPrevStep.addEventListener('click', () => {
    selectStepByIndex(Math.max(0, state.selectedStepIdx - 1));
  });

  el.btnNextStep.addEventListener('click', () => {
    selectStepByIndex(Math.min(state.steps.length - 1, state.selectedStepIdx + 1));
  });

  // Canvas interactions: Trend tooltip + click to select
  el.trendCanvas.addEventListener('mousemove', (e) => {
    if (!state.trendPoints.length) return;
    const rect = el.trendCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let nearest = null;
    let bestDist = Infinity;
    for (const pt of state.trendPoints) {
      const dx = Math.abs(pt.px - mx);
      if (dx < bestDist) {
        bestDist = dx;
        nearest = pt;
      }
    }

    if (nearest && bestDist <= 24) {
      const r = nearest.result;
      const p = state.precision;
      el.trendTooltip.innerHTML = [
        `<strong>Step ${r.stepIndex}: ${escapeHtml(r.condDisplay)}</strong>`,
        `Vmax : ${fmtNum(r.vmax, p)} V`,
        `Vmin : ${fmtNum(r.vmin, p)} V`,
        `Vavg : ${fmtNum(r.vavg, p)} V`,
        `リップル: ${fmtNum(r.ripplePP, p)} V (${(r.ripplePP * 1000).toFixed(2)} mV)`,
        `脈動率 : ${fmtNum(r.rippleFactor, Math.max(2, p - 1))} %`,
      ].join('<br>');
      el.trendTooltip.classList.remove('hidden');

      const tipX = Math.min(rect.width - 210, Math.max(8, mx + 14));
      const tipY = Math.min(rect.height - 120, Math.max(8, my - 10));
      el.trendTooltip.style.left = `${tipX}px`;
      el.trendTooltip.style.top = `${tipY}px`;
    } else {
      el.trendTooltip.classList.add('hidden');
    }
  });

  el.trendCanvas.addEventListener('mouseleave', () => {
    el.trendTooltip.classList.add('hidden');
  });

  el.trendCanvas.addEventListener('click', (e) => {
    if (!state.trendPoints.length) return;
    const rect = el.trendCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let nearest = null;
    let bestDist = Infinity;
    for (const pt of state.trendPoints) {
      const dx = Math.abs(pt.px - mx);
      if (dx < bestDist) {
        bestDist = dx;
        nearest = pt;
      }
    }
    if (nearest && bestDist <= 28) {
      const idx = state.steps.findIndex((s) => s.stepIndex === nearest.result.stepIndex);
      if (idx >= 0) selectStepByIndex(idx);
    }
  });

  // Canvas interactions: Wave tooltip
  el.waveCanvas.addEventListener('mousemove', (e) => {
    const meta = state.wavePlotMeta;
    if (!meta || !meta.dispT.length) return;
    const rect = el.waveCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (
      mx < meta.pad.left ||
      mx > meta.pad.left + meta.plotW ||
      my < meta.pad.top ||
      my > meta.pad.top + meta.plotH
    ) {
      el.waveTooltip.classList.add('hidden');
      return;
    }

    const tTarget = meta.xMin + ((mx - meta.pad.left) / meta.plotW) * (meta.xMax - meta.xMin);
    // Binary search nearest time
    let lo = 0;
    let hi = meta.dispT.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (meta.dispT[mid] < tTarget) lo = mid + 1;
      else hi = mid;
    }
    let idx = lo;
    if (idx > 0 && Math.abs(meta.dispT[idx - 1] - tTarget) < Math.abs(meta.dispT[idx] - tTarget)) {
      idx--;
    }

    const tVal = meta.dispT[idx];
    const vVal = meta.dispV[idx];
    el.waveTooltip.innerHTML = `t = ${(tVal * 1000).toFixed(4)} ms<br>V = ${vVal.toFixed(state.precision)} V`;
    el.waveTooltip.classList.remove('hidden');

    const tipX = Math.min(rect.width - 150, Math.max(8, mx + 14));
    const tipY = Math.min(rect.height - 55, Math.max(8, my - 12));
    el.waveTooltip.style.left = `${tipX}px`;
    el.waveTooltip.style.top = `${tipY}px`;
  });

  el.waveCanvas.addEventListener('mouseleave', () => {
    el.waveTooltip.classList.add('hidden');
  });

  // Table search, sort, row click, export
  el.tableSearch.addEventListener('input', () => {
    state.searchQuery = el.tableSearch.value;
    renderTable();
  });

  el.resultsTable.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = 'asc';
      }
      renderTable();
    });
  });

  el.resultsTbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const stepNumber = parseInt(tr.dataset.stepIndex, 10);
    const idx = state.steps.findIndex((s) => s.stepIndex === stepNumber);
    if (idx >= 0) selectStepByIndex(idx);
  });

  el.btnDownloadCsv.addEventListener('click', downloadCsv);
  el.btnCopyTsv.addEventListener('click', copyTsvToClipboard);

  // Resize charts responsively
  const resizeObserver = new ResizeObserver(() => {
    if (!state.results.length) return;
    renderTrendChart();
    renderWaveChart();
  });
  resizeObserver.observe(el.trendCanvas.parentElement);
  resizeObserver.observe(el.waveCanvas.parentElement);

  // Auto-hide sample button error gracefully if on HTTP, or auto-load if served via HTTP?
  // Keep manual button + drag-and-drop so user explicitly drops or clicks.
})();

