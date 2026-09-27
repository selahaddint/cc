(() => {
  'use strict';

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
  let pendingSettings = null;
  let lastObservedScanKey = null;
  const saveInFlight = new Set();
  const savedScanKeys = new Set();

  const els = {};

  function $(id) { return document.getElementById(id); }
  function finite(v) { return Number.isFinite(Number(v)); }
  function pad2(v) { return String(v).padStart(2, '0'); }

  function localDateFromMs(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '—';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function localIsoNow() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
      const known = db.exec('SELECT scan_key FROM scan_report');
      if (known[0]?.values) known[0].values.forEach(row => savedScanKeys.add(String(row[0])));
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

  function compareValues(a, b, key) {
    const numeric = key === 'sec' || key === 'min_y' || key === 'max_y' || key === 'id';
    if (numeric) {
      const na = Number(a[key]);
      const nb = Number(b[key]);
      return (Number.isFinite(na) ? na : 0) - (Number.isFinite(nb) ? nb : 0);
    }
    return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'tr', { numeric: true, sensitivity: 'base' });
  }

  function sortedRows(rows) {
    const copy = rows.slice();
    copy.sort((a, b) => {
      for (const rule of sortState) {
        const cmp = compareValues(a, b, rule.key);
        if (cmp !== 0) return rule.dir === 'asc' ? cmp : -cmp;
      }
      return Number(b.id || 0) - Number(a.id || 0);
    });
    return copy;
  }

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

  function updateSortMarks() {
    document.querySelectorAll('#reportTable th[data-sort]').forEach(th => {
      const mark = th.querySelector('.sortMark');
      if (!mark) return;
      const index = sortState.findIndex(x => x.key === th.dataset.sort);
      if (index < 0) {
        mark.textContent = '';
      } else {
        const rule = sortState[index];
        mark.textContent = `${rule.dir === 'asc' ? '▲' : '▼'}${index + 1}`;
      }
    });
  }

  function renderReport() {
    const rows = sortedRows(reportRows);
    if (els.reportCount) els.reportCount.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;

    if (!els.reportBody) return;
    if (!rows.length) {
      els.reportBody.innerHTML = '<tr><td colspan="6" class="reportEmpty">No records.</td></tr>';
      updateSortMarks();
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
    updateSortMarks();
  }

  function applyHeaderSort(event, key) {
    const existingIndex = sortState.findIndex(x => x.key === key);

    if (event.shiftKey) {
      if (existingIndex >= 0) {
        const current = sortState[existingIndex];
        sortState[existingIndex] = { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        sortState.push({ key, dir: 'asc' });
      }
    } else {
      if (existingIndex === 0) {
        sortState = [{ key, dir: sortState[0].dir === 'asc' ? 'desc' : 'asc' }];
      } else {
        sortState = [{ key, dir: 'asc' }];
      }
    }
    renderReport();
  }

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
      console.error('[ReportStore] Report open failed:', err);
      alert('Report database could not be opened.');
    }
  }

  function closeReport() {
    if (!els.reportModal) return;
    els.reportModal.hidden = true;
    els.reportModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

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

  function bindUi() {
    els.reportBtn = $('reportBtn');
    els.reportModal = $('reportModal');
    els.reportClose = $('reportModalClose');
    els.reportBody = $('reportBody');
    els.reportCount = $('reportCount');

    $('startBtn')?.addEventListener('click', () => {
      pendingSettings = readCurrentSettings();
    }, true);

    els.reportBtn?.addEventListener('click', openReport);
    els.reportClose?.addEventListener('click', closeReport);
    els.reportModal?.addEventListener('click', e => {
      if (e.target === els.reportModal) closeReport();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && els.reportModal && !els.reportModal.hidden) closeReport();
    });

    document.querySelectorAll('#reportTable th[data-sort]').forEach(th => {
      th.addEventListener('click', e => applyHeaderSort(e, th.dataset.sort));
      th.title = 'Click: sort • Shift+Click: add/toggle secondary sort';
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
