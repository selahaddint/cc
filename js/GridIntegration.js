(() => {
  'use strict';

  // ================================================================
  // GRID INTEGRATION
  // UI/state glue only. It does NOT change any scanner's selection rules.
  // - normalizes the shared grid controls across independent scanners
  // - adds/fixes Scan Source
  // - keeps Entry/Stop ready for Follow
  // - provides one shared Cancel path for every scanner
  // ================================================================

  const body = document.getElementById('candidateBody');
  const cancelButton = document.getElementById('cancelBtn');
  if (!body) return;

  const SOURCE_BY_BUTTON = Object.freeze({
    startBtn: 'Start Scan',
    startShortBtn: 'StartScanForShort',
    lowestScanBtn: 'LowerScan',
    highestScanBtn: 'Highest Scan',
    oneMScanBtn: 'OneM Scan',
    bookScanBtn: 'Book Scan',
    coinScanBtn: 'CoinScan',
    coinScanForShortBtn: 'CoinScanForShort',
    rangeBreakoutScanBtn: 'Range Scan',
    squeezeLongScanBtn: 'Squeeze Long',
    longEntryConfirmBtn: 'Long Confirm'
  });

  let currentSource = '';
  let decorating = false;

  const finite = v => Number.isFinite(Number(v));
  const priceValue = text => {
    const n = Number(String(text ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 0 ? n : NaN;
  };

  function normalizeSource(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    if (/start.*short/i.test(s)) return 'StartScanForShort';
    if (/start.*scan/i.test(s)) return 'Start Scan';
    if (/lowest|lower/i.test(s)) return 'LowerScan';
    if (/highest/i.test(s)) return 'Highest Scan';
    if (/onem/i.test(s)) return 'OneM Scan';
    if (/book/i.test(s)) return 'Book Scan';
    if (/coinscanforshort|coin scan for short/i.test(s)) return 'CoinScanForShort';
    if (/coinscan|coin scan/i.test(s)) return 'CoinScan';
    if (/range/i.test(s)) return 'Range Scan';
    if (/squeeze/i.test(s)) return 'Squeeze Long';
    if (/long.*confirm/i.test(s)) return 'Long Confirm';
    return s;
  }

  function rememberSource(source) {
    const normalized = normalizeSource(source);
    if (!normalized) return;
    currentSource = normalized;
    window.CryptoOfferData = window.CryptoOfferData || {};
    window.CryptoOfferData.activeScanSource = normalized;
  }

  for (const [id, source] of Object.entries(SOURCE_BY_BUTTON)) {
    document.getElementById(id)?.addEventListener('click', () => rememberSource(source), true);
  }

  document.addEventListener('cryptooffer:scan-start', event => {
    rememberSource(event.detail?.source || event.detail?.reason || '');
  });

  function ensureWatchCell(tr) {
    let cell = tr.querySelector(':scope > td[data-role="watch-status"]');
    if (cell) return cell;
    const cells = Array.from(tr.children).filter(el => el.tagName === 'TD');
    if (cells.length < 3) return null;
    cell = document.createElement('td');
    cell.className = 'watchCell';
    cell.dataset.role = 'watch-status';
    cell.innerHTML = '<span class="watchSignal off"><span class="watchSignalDot"></span><span>—</span></span>';
    const afterYs = cells[3] || null;
    if (afterYs) tr.insertBefore(cell, afterYs);
    else tr.appendChild(cell);
    return cell;
  }

  function directCells(tr) {
    return Array.from(tr.children).filter(el => el.tagName === 'TD');
  }

  function ensureCoinButton(tr) {
    const cells = directCells(tr);
    const cell = cells[1];
    if (!cell) return;
    const existing = cell.querySelector('.symbolBtn[data-action="decision-support"]');
    if (existing) return;
    const symbol = String(tr.dataset.symbol || cell.textContent || '').trim();
    if (!symbol) return;
    cell.textContent = '';
    cell.classList.add('symbol');
    const btn = document.createElement('button');
    btn.className = 'symbolBtn';
    btn.type = 'button';
    btn.dataset.action = 'decision-support';
    btn.dataset.symbol = symbol;
    btn.title = 'PriceLevel ve RiskLevel hesaplamak için tıkla';
    btn.textContent = symbol;
    cell.appendChild(btn);
  }

  function resultText(tr) {
    return String(tr.querySelector('.pill')?.textContent || '').trim().toUpperCase();
  }

  function ensureCoinScanControls(tr, source) {
    // CoinScan/CoinScanForShort render their analysis cells but historically
    // omitted the common Follow controls. Fill only those shared UI cells.
    if (source !== 'CoinScan' && source !== 'CoinScanForShort') return;
    ensureWatchCell(tr);
    const cells = directCells(tr);
    if (cells.length < 15) return;

    const symbol = String(tr.dataset.symbol || '').trim();
    const entryCell = cells[7];
    const stopCell = cells[8];
    const priceCell = cells[9];
    const followCell = cells[10];
    const monitorCell = cells[11];
    const reasonCell = cells[12];

    if (priceCell && !priceCell.dataset.role) priceCell.dataset.role = 'current-price';

    if (entryCell && !entryCell.querySelector('[data-role="entry"]')) {
      entryCell.innerHTML = '<input class="monitorInput entryPriceInput" data-role="entry" type="number" min="0" step="any" placeholder="Entry Price" inputmode="decimal">';
    }
    if (stopCell && !stopCell.querySelector('[data-role="stop"]')) {
      stopCell.innerHTML = '<input class="monitorInput stopPriceInput" data-role="stop" type="number" min="0" step="any" placeholder="Stop Price" inputmode="decimal">';
    }
    if (followCell && !followCell.querySelector('[data-action="follow"]')) {
      followCell.innerHTML = `<button class="followBtn" data-action="follow" data-symbol="${symbol.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" type="button">Follow</button>`;
    }
    if (monitorCell && !monitorCell.classList.contains('monitorCell')) {
      monitorCell.className = 'monitorCell';
      monitorCell.innerHTML = '<span class="monitorDot off" title="OFF" aria-label="OFF"></span>';
    }
    if (reasonCell) {
      reasonCell.classList.add('monitorReason');
      let reason = reasonCell.querySelector('.reasonText');
      if (!reason) {
        const text = reasonCell.textContent.trim();
        reasonCell.textContent = '';
        reason = document.createElement('span');
        reason.className = 'reasonText';
        reason.textContent = text || '—';
        reason.title = text || '—';
        reasonCell.appendChild(reason);
      }
      if (!reasonCell.querySelector('.monitorTime')) {
        const t = document.createElement('div');
        t.className = 'monitorTime';
        reasonCell.appendChild(t);
      }
    }
  }

  function autofillEntryStop(tr) {
    const entry = tr.querySelector('[data-role="entry"]');
    const stop = tr.querySelector('[data-role="stop"]');
    if (!(entry instanceof HTMLInputElement) || !(stop instanceof HTMLInputElement)) return;
    if (entry.disabled || stop.disabled) return;

    let entryPrice = priceValue(entry.value);
    if (!(entryPrice > 0)) {
      entryPrice = priceValue(tr.querySelector('[data-role="current-price"]')?.textContent);
      if (entryPrice > 0) entry.value = Number(entryPrice.toPrecision(12)).toString();
    }
    if (!(priceValue(stop.value) > 0) && entryPrice > 0) {
      stop.value = Number((entryPrice * 0.98).toPrecision(12)).toString();
    }
  }

  function ensureSourceCell(tr) {
    const existing = tr.querySelector(':scope > td[data-role="scan-source"]');
    const source = String(tr.dataset.scanSource || currentSource || window.CryptoOfferData?.activeScanSource || '').trim() || '—';
    if (tr.dataset.scanSource !== source) tr.dataset.scanSource = source;
    if (existing) {
      // IMPORTANT: writing textContent unconditionally creates a childList
      // mutation even when the visible value is unchanged.
      if (existing.textContent !== source) existing.textContent = source;
      if (existing.title !== source) existing.title = source;
      return existing;
    }

    const liveResult = tr.querySelector(':scope > td[data-role="live-result"]');
    const cell = document.createElement('td');
    cell.dataset.role = 'scan-source';
    cell.className = 'scanSourceCell';
    cell.textContent = source;
    cell.title = source;
    if (liveResult?.nextSibling) tr.insertBefore(cell, liveResult.nextSibling);
    else if (liveResult) tr.appendChild(cell);
    else tr.appendChild(cell);
    return cell;
  }

  // Grid normalization is event-driven only. Every scanner renders/replaces
  // candidateBody and then dispatches cryptooffer:candidates-rendered. Keeping
  // a permanent MutationObserver here caused GridIntegration, Follow and the
  // existing UI observers to trigger each other after successive scans.
  function decorateRows() {
    if (decorating) return;
    decorating = true;
    try {
      body.querySelectorAll('td.empty').forEach(td => {
        if (td.colSpan !== 16) td.colSpan = 16;
      });
      body.querySelectorAll('tr[data-symbol]').forEach(tr => {
        ensureWatchCell(tr);
        const source = String(tr.dataset.scanSource || currentSource || window.CryptoOfferData?.activeScanSource || '').trim();
        ensureCoinButton(tr);
        ensureCoinScanControls(tr, source);
        autofillEntryStop(tr);
        ensureSourceCell(tr);
      });
    } finally {
      decorating = false;
    }
  }

  let decorateQueued = false;
  function scheduleDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    const run = () => {
      decorateQueued = false;
      decorateRows();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  document.addEventListener('cryptooffer:candidates-rendered', scheduleDecorate);

  function cancelAllScans() {
    // Call every known public cancellation endpoint. Each implementation is
    // idempotent when idle, so this remains safe with the shared Cancel button.
    const calls = [
      () => window.CryptoFlowScanner?.modules?.startScan?.state?.controller?.abort?.(),
      () => window.CryptoFlowScanner?.modules?.startScanForShort?.cancel?.(),
      () => window.CryptoFlowScanner?.modules?.oneMScan?.cancel?.(),
      () => window.CryptoFlowScanner?.modules?.bookScan?.cancel?.(),
      () => window.LowestScan?.cancel?.(),
      () => window.HighestScan?.cancel?.(),
      () => window.CoinScan?.cancel?.(),
      () => window.CoinScanForShort?.cancel?.(),
      () => window.RangeBreakoutScan?.stop?.(),
      () => window.LongEntryConfirm?.stop?.(),
      () => window.Ema200SqueezeLongScan?.stop?.()
    ];
    for (const call of calls) {
      try { call(); } catch (_) {}
    }
  }

  cancelButton?.addEventListener('click', cancelAllScans, true);

  window.CryptoFlowScanner = window.CryptoFlowScanner || { modules: {} };
  window.CryptoFlowScanner.modules = window.CryptoFlowScanner.modules || {};
  window.CryptoFlowScanner.modules.gridIntegration = {
    rememberSource,
    decorateRows,
    cancelAllScans,
    getCurrentSource: () => currentSource
  };

  decorateRows();
})();
