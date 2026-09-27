(() => {
  'use strict';

  // ================================================================
  // LOCAL SQLITE REPORT STORE
  // - Start Scan report: one row per completed scan.
  // - Follow report: one row per Follow session when it reaches EXIT
  //   or the user manually presses Stop Follow.
  // - SQLite database bytes are persisted in IndexedDB.
  // ================================================================

  const IDB_NAME = 'Precise15.ReportSQLite.v1';
  const IDB_STORE = 'files';
  const IDB_KEY = 'report.sqlite';
  const WASM_PATH = 'https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/sql-wasm.wasm';

  let db = null;
  let sqlReady = null;

  let reportRows = [];
  let sortState = [
    { key: 'start_scan_date', dir: 'desc' },
    { key: 'binance_time', dir: 'desc' }
  ];

  let followReportRows = [];
  let followSortState = [
    { key: 'follow_date', dir: 'desc' },
    { key: 'follow_time', dir: 'desc' }
  ];

  let pendingSettings = null;
  let lastObservedScanKey = null;
  const saveInFlight = new Set();
  const savedScanKeys = new Set();
  const followSaveInFlight = new Set();
  const savedFollowKeys = new Set();

  const els = {};

  function $(id) { return document.getElementById(id); }
  function finite(v) { return Number.isFinite(Number(v)); }
  function pad2(v) { return String(v).padStart(2, '0'); }

  function localDateFromMs(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '—';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function localTimeFromMs(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '—';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function localIsoFromMs(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function localIsoNow() {
    return localIsoFromMs(Date.now());
  }

  function extractTimeFromRequestTime(value) {
    if (value == null || value === '') return '—';

    if (finite(value)) {
      const n = Number(value);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      if (Number.isFinite(d.getTime())) {
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      }
    }

    const s = String(value).trim();
    const match = s.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|$)/);
    if (match) return `${pad2(match[1])}:${match[2]}:${match[3] || '00'}`;

    const d = new Date(s);
    if (Number.isFinite(d.getTime())) {
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    return '—';
  }

  function readCurrentSettings() {
    return {
      sec: Number($('windowSec')?.value),
      minY: Number($('minIncrease')?.value),
      maxY: Number($('maxIncrease')?.value)
    };
  }

  function currentScanState() {
    return window.CryptoOfferData?.scanState || null;
  }

  function currentScanKey(state) {
    const startedAt = Number(state?.startedAt);
    if (Number.isFinite(startedAt) && startedAt > 0) return String(startedAt);

    const rows = Array.isArray(state?.results) ? state.results : [];
    const rt = rows.find(r => r?.gridMeta?.requestTime)?.gridMeta?.requestTime;
    return `${String(rt || 'unknown')}|${rows.length}|${String(state?.finishedAt || '')}`;
  }

  function isCompletedScan(state) {
    if (!state) return false;
    const progressText = String($('progressText')?.textContent || '').trim();
    const stageText = String($('stageText')?.textContent || '').trim().toLowerCase();
    const progress100 = /^100(?:\.0+)?%?$/.test(progressText);
    const terminalStage = /complete|completed|done|tamam/.test(stageText);
    const controlsIdle = !$('startBtn')?.disabled && !!$('cancelBtn')?.disabled;
    return controlsIdle && (progress100 || terminalStage);
  }

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
  }

  async function idbGet() {
    const idb = await openIdb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
      });
    } finally {
      idb.close();
    }
  }

  async function idbPut(bytes) {
    const idb = await openIdb();
    try {
      await new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
      });
    } finally {
      idb.close();
    }
  }

  async function ensureDb() {
    if (db) return db;
    if (sqlReady) return sqlReady;

    sqlReady = (async () => {
      if (typeof window.initSqlJs !== 'function') {
        throw new Error('SQLite library could not be loaded.');
      }

      const SQL = await window.initSqlJs({ locateFile: () => WASM_PATH });
      const saved = await idbGet();
      db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();

      db.run(`
        CREATE TABLE IF NOT EXISTS scan_report (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scan_key TEXT NOT NULL UNIQUE,
          start_scan_date TEXT NOT NULL,
          binance_time TEXT NOT NULL,
          sec INTEGER NOT NULL,
          min_y REAL NOT NULL,
          max_y REAL NOT NULL,
          select_coins TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_scan_report_date_time ON scan_report(start_scan_date, binance_time);');

      db.run(`
        CREATE TABLE IF NOT EXISTS follow_report (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          follow_key TEXT NOT NULL UNIQUE,
          follow_date TEXT NOT NULL,
          follow_time TEXT NOT NULL,
          coin TEXT NOT NULL,
          entry_price REAL NOT NULL,
          stop_price REAL NOT NULL,
          profit_pct REAL,
          reason TEXT NOT NULL DEFAULT '',
          exit_price REAL,
          close_type TEXT NOT NULL DEFAULT 'EXIT',
          closed_at TEXT NOT NULL
        );
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_follow_report_date_time ON follow_report(follow_date, follow_time);');
      db.run('CREATE INDEX IF NOT EXISTS idx_follow_report_coin ON follow_report(coin);');

      const knownScans = db.exec('SELECT scan_key FROM scan_report');
      if (knownScans[0]?.values) knownScans[0].values.forEach(row => savedScanKeys.add(String(row[0])));

      const knownFollows = db.exec('SELECT follow_key FROM follow_report');
      if (knownFollows[0]?.values) knownFollows[0].values.forEach(row => savedFollowKeys.add(String(row[0])));

      await persistDb();
      return db;
    })();

    try {
      return await sqlReady;
    } catch (err) {
      sqlReady = null;
      throw err;
    }
  }

  async function persistDb() {
    if (!db) return;
    const bytes = db.export();
    await idbPut(bytes);
  }

  // ---------------------------------------------------------------
  // START SCAN REPORT
  // ---------------------------------------------------------------

  function selectedCoins(state) {
    const rows = Array.isArray(state?.results) ? state.results : [];
    const seen = new Set();
    for (const row of rows) {
      if (String(row?.result || '').toUpperCase() === 'SELECT' && row?.symbol) {
        seen.add(String(row.symbol).trim());
      }
    }
    return [...seen].join(', ');
  }

  function binanceTime(state) {
    const rows = Array.isArray(state?.results) ? state.results : [];
    const raw = rows.find(r => r?.gridMeta?.requestTime)?.gridMeta?.requestTime;
    return extractTimeFromRequestTime(raw);
  }

  async function insertCompletedScan(state, settings) {
    const scanKey = currentScanKey(state);
    if (!scanKey || savedScanKeys.has(scanKey) || saveInFlight.has(scanKey)) return;
    saveInFlight.add(scanKey);

    try {
      const database = await ensureDb();
      const startDate = localDateFromMs(state?.startedAt || Date.now());
      const time = binanceTime(state);
      const coins = selectedCoins(state);
      const safeSettings = settings || readCurrentSettings();

      const stmt = database.prepare(`
        INSERT OR IGNORE INTO scan_report
          (scan_key, start_scan_date, binance_time, sec, min_y, max_y, select_coins, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run([
        scanKey,
        startDate,
        time,
        Number.isFinite(safeSettings.sec) ? safeSettings.sec : 0,
        Number.isFinite(safeSettings.minY) ? safeSettings.minY : 0,
        Number.isFinite(safeSettings.maxY) ? safeSettings.maxY : 0,
        coins,
        localIsoNow()
      ]);
      stmt.free();
      const changed = database.getRowsModified();
      savedScanKeys.add(scanKey);
      if (changed > 0) await persistDb();
    } finally {
      saveInFlight.delete(scanKey);
    }
  }

  function queryAllRows() {
    if (!db) return [];
    const stmt = db.prepare(`
      SELECT id, start_scan_date, binance_time, sec, min_y, max_y, select_coins, created_at
      FROM scan_report
    `);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // ---------------------------------------------------------------
  // FOLLOW REPORT
  // ---------------------------------------------------------------

  function makeFollowKey(detail) {
    if (detail?.followKey) return String(detail.followKey);
    return `${String(detail?.symbol || 'UNKNOWN')}|${String(detail?.startedAt || Date.now())}`;
  }

  function calcProfitPct(entryPrice, exitPrice) {
    const entry = Number(entryPrice);
    const exit = Number(exitPrice);
    if (!(Number.isFinite(entry) && entry > 0 && Number.isFinite(exit) && exit > 0)) return null;
    return ((exit - entry) / entry) * 100;
  }

  async function insertFollowReport(detail) {
    const followKey = makeFollowKey(detail);
    if (!followKey || savedFollowKeys.has(followKey) || followSaveInFlight.has(followKey)) return;

    const symbol = String(detail?.symbol || '').trim();
    const entryPrice = Number(detail?.entryPrice);
    const stopPrice = Number(detail?.stopPrice);
    if (!symbol || !(entryPrice > 0) || !(stopPrice > 0)) return;

    followSaveInFlight.add(followKey);
    try {
      const database = await ensureDb();
      const startedAt = Number(detail?.startedAt) || Date.now();
      const closedAt = Number(detail?.closedAt) || Date.now();
      const exitPrice = Number(detail?.exitPrice);
      const safeExitPrice = Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : null;
      const profitPct = calcProfitPct(entryPrice, safeExitPrice);
      const closeType = String(detail?.closeType || 'EXIT').toUpperCase();
      const reason = String(detail?.reason || (closeType === 'MANUAL' ? 'Manual Follow Stop' : 'EXIT'));

      const stmt = database.prepare(`
        INSERT OR IGNORE INTO follow_report
          (follow_key, follow_date, follow_time, coin, entry_price, stop_price, profit_pct, reason, exit_price, close_type, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run([
        followKey,
        localDateFromMs(startedAt),
        localTimeFromMs(startedAt),
        symbol,
        entryPrice,
        stopPrice,
        profitPct,
        reason,
        safeExitPrice,
        closeType,
        localIsoFromMs(closedAt) || localIsoNow()
      ]);
      stmt.free();

      const changed = database.getRowsModified();
      savedFollowKeys.add(followKey);
      if (changed > 0) await persistDb();
    } finally {
      followSaveInFlight.delete(followKey);
    }
  }

  function queryAllFollowRows() {
    if (!db) return [];
    const stmt = db.prepare(`
      SELECT id, follow_date, follow_time, coin, entry_price, stop_price, profit_pct, reason, exit_price, close_type, closed_at
      FROM follow_report
    `);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // ---------------------------------------------------------------
  // SORTING / RENDERING
  // ---------------------------------------------------------------

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function formatNum(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: false });
  }

  function formatPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    const digits = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
    return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  }

  function formatProfit(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const txt = Math.abs(n).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `${n >= 0 ? '+' : '-'}${txt}%`;
  }

  function compareValues(a, b, key) {
    const numeric = ['sec', 'min_y', 'max_y', 'id', 'entry_price', 'stop_price', 'profit_pct', 'exit_price'].includes(key);
    if (numeric) {
      const na = Number(a[key]);
      const nb = Number(b[key]);
      const fa = Number.isFinite(na);
      const fb = Number.isFinite(nb);
      if (!fa && !fb) return 0;
      if (!fa) return -1;
      if (!fb) return 1;
      return na - nb;
    }
    return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'tr', { numeric: true, sensitivity: 'base' });
  }

  function sortedRows(rows, state) {
    const copy = rows.slice();
    copy.sort((a, b) => {
      for (const rule of state) {
        const cmp = compareValues(a, b, rule.key);
        if (cmp !== 0) return rule.dir === 'asc' ? cmp : -cmp;
      }
      return Number(b.id || 0) - Number(a.id || 0);
    });
    return copy;
  }

  function updateSortMarks(tableSelector, state) {
    document.querySelectorAll(`${tableSelector} th[data-sort]`).forEach(th => {
      const mark = th.querySelector('.sortMark');
      if (!mark) return;
      const index = state.findIndex(x => x.key === th.dataset.sort);
      if (index < 0) {
        mark.textContent = '';
      } else {
        const rule = state[index];
        mark.textContent = `${rule.dir === 'asc' ? '▲' : '▼'}${index + 1}`;
      }
    });
  }

  function renderReport() {
    const rows = sortedRows(reportRows, sortState);
    if (els.reportCount) els.reportCount.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;

    if (!els.reportBody) return;
    if (!rows.length) {
      els.reportBody.innerHTML = '<tr><td colspan="6" class="reportEmpty">No records.</td></tr>';
      updateSortMarks('#reportTable', sortState);
      return;
    }

    els.reportBody.innerHTML = rows.map(r => `
      <tr>
        <td>${esc(r.start_scan_date || '—')}</td>
        <td>${esc(r.binance_time || '—')}</td>
        <td class="num">${esc(formatNum(r.sec))}</td>
        <td class="num">${esc(formatNum(r.min_y))}</td>
        <td class="num">${esc(formatNum(r.max_y))}</td>
        <td class="reportCoins">${esc(r.select_coins || '—')}</td>
      </tr>
    `).join('');
    updateSortMarks('#reportTable', sortState);
  }

  function renderFollowReport() {
    const rows = sortedRows(followReportRows, followSortState);
    if (els.followReportCount) els.followReportCount.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;

    if (!els.followReportBody) return;
    if (!rows.length) {
      els.followReportBody.innerHTML = '<tr><td colspan="7" class="reportEmpty">No records.</td></tr>';
      updateSortMarks('#followReportTable', followSortState);
      return;
    }

    els.followReportBody.innerHTML = rows.map(r => `
      <tr>
        <td>${esc(r.follow_date || '—')}</td>
        <td>${esc(r.follow_time || '—')}</td>
        <td class="symbol">${esc(r.coin || '—')}</td>
        <td class="num">${esc(formatPrice(r.entry_price))}</td>
        <td class="num">${esc(formatPrice(r.stop_price))}</td>
        <td class="num ${Number(r.profit_pct) >= 0 ? 'good' : 'bad'}">${esc(formatProfit(r.profit_pct))}</td>
        <td class="followReportReason">${esc(r.reason || '—')}</td>
      </tr>
    `).join('');
    updateSortMarks('#followReportTable', followSortState);
  }

  function nextSortState(event, key, currentState) {
    const state = currentState.slice();
    const existingIndex = state.findIndex(x => x.key === key);

    if (event.shiftKey) {
      if (existingIndex >= 0) {
        const current = state[existingIndex];
        state[existingIndex] = { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        state.push({ key, dir: 'asc' });
      }
      return state;
    }

    if (existingIndex === 0) {
      return [{ key, dir: state[0].dir === 'asc' ? 'desc' : 'asc' }];
    }
    return [{ key, dir: 'asc' }];
  }

  function applyHeaderSort(event, key) {
    sortState = nextSortState(event, key, sortState);
    renderReport();
  }

  function applyFollowHeaderSort(event, key) {
    followSortState = nextSortState(event, key, followSortState);
    renderFollowReport();
  }

  // ---------------------------------------------------------------
  // MODALS
  // ---------------------------------------------------------------

  async function openReport() {
    try {
      await ensureDb();
      reportRows = queryAllRows();
      renderReport();
      els.reportModal.hidden = false;
      els.reportModal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      els.reportClose?.focus();
    } catch (err) {
      console.error('[ReportStore] Start Scan report open failed:', err);
      alert('Report database could not be opened.');
    }
  }

  function closeReport() {
    if (!els.reportModal) return;
    els.reportModal.hidden = true;
    els.reportModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  async function openFollowReport() {
    try {
      await ensureDb();
      followReportRows = queryAllFollowRows();
      renderFollowReport();
      els.followReportModal.hidden = false;
      els.followReportModal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      els.followReportClose?.focus();
    } catch (err) {
      console.error('[ReportStore] Follow report open failed:', err);
      alert('Follow report database could not be opened.');
    }
  }

  function closeFollowReport() {
    if (!els.followReportModal) return;
    els.followReportModal.hidden = true;
    els.followReportModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  // ---------------------------------------------------------------
  // SCAN COMPLETION WATCHER
  // ---------------------------------------------------------------

  function pollForCompletedScan() {
    const state = currentScanState();
    if (!state) return;

    const scanKey = currentScanKey(state);
    if (!scanKey) return;

    if (scanKey !== lastObservedScanKey) {
      lastObservedScanKey = scanKey;
      if (!pendingSettings) pendingSettings = readCurrentSettings();
    }

    if (!isCompletedScan(state) || savedScanKeys.has(scanKey)) return;

    const settingsForScan = pendingSettings || readCurrentSettings();
    insertCompletedScan(state, settingsForScan)
      .then(() => { pendingSettings = null; })
      .catch(err => console.error('[ReportStore] Scan report save failed:', err));
  }

  // ---------------------------------------------------------------
  // UI / EVENTS
  // ---------------------------------------------------------------

  function bindUi() {
    els.reportBtn = $('reportBtn');
    els.reportModal = $('reportModal');
    els.reportClose = $('reportModalClose');
    els.reportBody = $('reportBody');
    els.reportCount = $('reportCount');

    els.followReportBtn = $('followReportBtn');
    els.followReportModal = $('followReportModal');
    els.followReportClose = $('followReportModalClose');
    els.followReportBody = $('followReportBody');
    els.followReportCount = $('followReportCount');

    $('startBtn')?.addEventListener('click', () => {
      pendingSettings = readCurrentSettings();
    }, true);

    els.reportBtn?.addEventListener('click', openReport);
    els.reportClose?.addEventListener('click', closeReport);
    els.reportModal?.addEventListener('click', e => {
      if (e.target === els.reportModal) closeReport();
    });

    els.followReportBtn?.addEventListener('click', openFollowReport);
    els.followReportClose?.addEventListener('click', closeFollowReport);
    els.followReportModal?.addEventListener('click', e => {
      if (e.target === els.followReportModal) closeFollowReport();
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (els.followReportModal && !els.followReportModal.hidden) closeFollowReport();
      else if (els.reportModal && !els.reportModal.hidden) closeReport();
    });

    document.querySelectorAll('#reportTable th[data-sort]').forEach(th => {
      th.addEventListener('click', e => applyHeaderSort(e, th.dataset.sort));
      th.title = 'Click: sort • Shift+Click: add/toggle secondary sort';
    });

    document.querySelectorAll('#followReportTable th[data-sort]').forEach(th => {
      th.addEventListener('click', e => applyFollowHeaderSort(e, th.dataset.sort));
      th.title = 'Click: sort • Shift+Click: add/toggle secondary sort';
    });

    document.addEventListener('cryptooffer:follow-complete', e => {
      insertFollowReport(e.detail)
        .catch(err => console.error('[ReportStore] Follow report save failed:', err));
    });

    ensureDb().catch(err => console.error('[ReportStore] SQLite init failed:', err));
    setInterval(pollForCompletedScan, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUi, { once: true });
  } else {
    bindUi();
  }
})();
