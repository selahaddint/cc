'use strict';

const EXCHANGE_DOMAIN = ['bi','nance.com'].join('');
const SPOT_API_BASES = [
  `https://api.${EXCHANGE_DOMAIN}`,
  `https://api1.${EXCHANGE_DOMAIN}`,
  `https://api2.${EXCHANGE_DOMAIN}`,
  `https://api3.${EXCHANGE_DOMAIN}`
];
const PRODUCT_ENDPOINTS = [
  `https://www.${EXCHANGE_DOMAIN}/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true`,
  `https://www.${EXCHANGE_DOMAIN}/exchange-api/v2/public/asset-service/product/get-products?includeEtf=true`
];
const WEB3_SEARCH_ENDPOINTS = [
  `https://web3.${EXCHANGE_DOMAIN}/bapi/defi/v5/public/wallet-direct/buw/wallet/market/token/search/ai`,
  `https://web3.${EXCHANGE_DOMAIN}/bapi/defi/v5/public/wallet-direct/buw/wallet/market/token/search`
];
const WEB3_DYNAMIC_ENDPOINTS = [
  `https://web3.${EXCHANGE_DOMAIN}/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai`,
  `https://web3.${EXCHANGE_DOMAIN}/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info`
];
const CHAIN_IDS = '1,56,8453,CT_501';
const MAX_CONCURRENCY = 5;
const HISTORY_CONCURRENCY = 4;
const PRICE_RATIO_MIN = 0.95;
const PRICE_RATIO_MAX = 1.05;
const CIRC_RATIO_MIN = 0.90;
const CIRC_RATIO_MAX = 1.10;

const analyzeBtn = document.getElementById('analyzeBtn');
const statusEl = document.getElementById('status');
const resultCountEl = document.getElementById('resultCount');
const supplyModeLabelEl = document.getElementById('supplyModeLabel');
const resultsBody = document.getElementById('resultsBody');

let currentRows = [];
let sortState = { key:null, dir:1 };

document.querySelectorAll('#analysisTable th[data-key]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (sortState.key === key) sortState.dir *= -1;
    else sortState = {key, dir:1};
    renderCurrentRows();
  });
});

document.querySelectorAll('input[name="supplyType"]').forEach(x => x.addEventListener('change', updateModeLabel));
analyzeBtn.addEventListener('click', runAnalysis);
updateModeLabel();

function selectedSupplyType() {
  return document.querySelector('input[name="supplyType"]:checked')?.value || 'total';
}
function updateModeLabel() {
  const t = selectedSupplyType();
  supplyModeLabelEl.textContent = `Filtre: ${t === 'total' ? 'Total Supply' : 'Circulating Supply'}`;
}
function selectedFilters() {
  return [...document.querySelectorAll('.range-filter:checked')].map(el => ({
    id:Number(el.dataset.id), supplyMin:1, supplyMax:Number(el.dataset.supplyMax),
    priceMin:Number(el.dataset.priceMin), priceMax:Number(el.dataset.priceMax),
    exclusive:el.dataset.exclusive === 'true'
  }));
}
function priceMatches(price, f) {
  if (!Number.isFinite(price)) return false;
  return price >= f.priceMin && (f.exclusive ? price < f.priceMax : price <= f.priceMax);
}
function supplyMatches(supply, f) {
  return Number.isFinite(supply) && supply >= f.supplyMin && supply <= f.supplyMax;
}
function rowMatches(row, filters, mode) {
  const supply = mode === 'total' ? row.totalSupply : row.circulatingSupply;
  return filters.some(f => priceMatches(row.price, f) && supplyMatches(supply, f));
}

async function runAnalysis() {
  const filters = selectedFilters();
  if (!filters.length) return setStatus('En az bir filtre seçmelisin.', true);

  const requestTime = formatTime(new Date());
  const mode = selectedSupplyType();
  analyzeBtn.disabled = true;
  resultsBody.innerHTML = '';
  resultCountEl.textContent = '0 coin';
  setStatus('Piyasa verileri alınıyor…');

  try {
    const [exchangeInfo, tickers24h, products] = await Promise.all([
      fetchSpotExchangeInfo(),
      fetchSpot24hTickers(),
      fetchProducts()
    ]);
    let rows = normalizeOfficialSpotData(exchangeInfo, tickers24h, products, requestTime)
      .filter(r => filters.some(f => priceMatches(r.price, f)));

    if (!rows.length) {
      renderRows([]); setStatus('Seçilen fiyat aralıklarında coin bulunamadı.'); return;
    }

    // Total Supply sadece gerekebilecek satırlarda aranır. Response'ta da gösterileceği için
    // fiyat filtresine uyan tüm adayları doğruluyoruz. Yanlış eşleşmeyi kabul etmiyoruz.
    setStatus(`${rows.length} fiyat adayı bulundu. Total Supply doğrulanıyor…`);
    await enrichVerifiedTotalSupply(rows, p => setStatus(`Supply doğrulama: ${p.done}/${p.total}`));

    const filtered = rows
      .filter(r => rowMatches(r, filters, mode))
      .sort((a,b) => a.price - b.price || a.symbol.localeCompare(b.symbol));

    if (filtered.length) {
      setStatus(`${filtered.length} coin filtreyi geçti. Age ve tüm-zaman Max/Min alınıyor…`);
      await enrichHistory(filtered, p => setStatus(`Geçmiş verisi: ${p.done}/${p.total}`));
    }

    renderRows(filtered);
    const missing = filtered.filter(r => !Number.isFinite(r.totalSupply)).length;
    if (mode === 'total') {
      setStatus(`${filtered.length} coin bulundu. Doğrulanamayan Total Supply değerleri filtreye alınmadı.`);
    } else if (missing) {
      setStatus(`${filtered.length} coin bulundu. ${missing} coin için güvenilir Total Supply eşleşmesi yok; “—” gösterildi.`);
    } else {
      setStatus(`${filtered.length} coin bulundu.`);
    }
  } catch (e) {
    console.error(e);
    setStatus(`Hata: ${e?.message || 'Piyasa verisi alınamadı.'}`, true);
  } finally {
    analyzeBtn.disabled = false;
  }
}

async function fetchSpotExchangeInfo() {
  return fetchSpotRestJson('/api/v3/exchangeInfo');
}

async function fetchSpot24hTickers() {
  const data = await fetchSpotRestJson('/api/v3/ticker/24hr?type=MINI');
  if (!Array.isArray(data)) throw new Error('24h ticker formatı değişmiş.');
  return data;
}

async function fetchSpotRestJson(path) {
  let last;
  for (const base of SPOT_API_BASES) {
    try {
      const r = await fetchWithTimeout(`${base}${path}`, 15000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last || new Error('Spot REST API verisi alınamadı.');
}

async function fetchProducts() {
  let last;
  for (const url of PRODUCT_ENDPOINTS) {
    try {
      const r = await fetchWithTimeout(url, 15000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j?.data)) throw new Error('Ürün listesi formatı değişmiş.');
      return j.data;
    } catch (e) { last = e; }
  }
  throw last || new Error('Ürün listesi alınamadı.');
}

function normalizeOfficialSpotData(exchangeInfo, tickers24h, products, requestTime) {
  const productBySymbol = new Map();
  for (const p of products) {
    const symbol = String(p?.s || '').toUpperCase();
    if (symbol) productBySymbol.set(symbol, p);
  }

  const tickerBySymbol = new Map();
  for (const t of tickers24h) {
    const symbol = String(t?.symbol || '').toUpperCase();
    if (symbol) tickerBySymbol.set(symbol, t);
  }

  const rows = [];
  for (const s of (exchangeInfo?.symbols || [])) {
    const symbol = String(s?.symbol || '').toUpperCase();
    const base = String(s?.baseAsset || '').toUpperCase();
    const quote = String(s?.quoteAsset || '').toUpperCase();
    const status = String(s?.status || '').toUpperCase();
    if (!symbol || !base || quote !== 'USDT' || base === 'USDT') continue;
    if (status !== 'TRADING') continue;
    if (s?.isSpotTradingAllowed === false) continue;

    const t = tickerBySymbol.get(symbol);
    const p = productBySymbol.get(symbol);
    const price = toNumber(t?.lastPrice);
    const volume24hQuote = toNumber(t?.quoteVolume);
    const circulatingSupply = toNumber(p?.cs);
    const name = String(p?.an || base).trim();

    if (!(price > 0) || !(circulatingSupply > 0)) continue;

    rows.push({
      symbol, base, name, price,
      volume24hQuote: Number.isFinite(volume24hQuote) ? volume24hQuote : NaN,
      circulatingSupply,
      totalSupply: NaN,
      listingTime: NaN,
      allTimeHigh: NaN,
      allTimeLow: NaN,
      requestTime
    });
  }
  return rows;
}

async function enrichVerifiedTotalSupply(rows, onProgress) {
  let next = 0, done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= rows.length) return;
      const row = rows[i];
      try {
        const data = await findVerifiedWeb3Supply(row);
        if (data) row.totalSupply = data.totalSupply;
      } catch (e) {
        console.debug('Supply doğrulanamadı:', row.base, e);
      } finally {
        done++; onProgress?.({done,total:rows.length});
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(MAX_CONCURRENCY, rows.length)}, worker));
}

async function findVerifiedWeb3Supply(row) {
  const candidates = await searchWeb3(row.base);
  const exactSymbol = candidates.filter(c => String(c?.symbol || '').toUpperCase() === row.base);
  if (!exactSymbol.length) return null;

  const cexName = normalizeName(row.name);
  const candidatesByName = exactSymbol.filter(c => {
    if (!cexName) return true;
    const web3Name = normalizeName(c?.name);
    if (!web3Name) return false;
    return namesCompatible(cexName, web3Name);
  });
  if (!candidatesByName.length) return null;

  const priceMatched = candidatesByName
    .map(c => ({ c, p:toNumber(c?.price), mc:toNumber(c?.marketCap) || 0, vol:toNumber(c?.volume24h) || 0 }))
    .filter(x => x.p > 0 && ratioInRange(x.p, row.price, PRICE_RATIO_MIN, PRICE_RATIO_MAX))
    .sort((a,b) => b.mc - a.mc || b.vol - a.vol);

  // Aynı isim/symbol/fiyatta birden fazla contract varsa tahmin etmiyoruz.
  if (!priceMatched.length) return null;
  const best = priceMatched[0].c;
  if (!best?.chainId || !best?.contractAddress) return null;

  const d = await fetchDynamic(best.chainId, best.contractAddress);
  const dynPrice = toNumber(d?.price);
  const dynCirc = toNumber(d?.circulatingSupply);
  const total = toNumber(d?.totalSupply);

  if (!(dynPrice > 0) || !ratioInRange(dynPrice, row.price, PRICE_RATIO_MIN, PRICE_RATIO_MAX)) return null;
  if (!(dynCirc > 0) || !ratioInRange(dynCirc, row.circulatingSupply, CIRC_RATIO_MIN, CIRC_RATIO_MAX)) return null;
  if (!(total > 0) || total + 1e-9 < dynCirc) return null;

  return { totalSupply:total };
}

async function searchWeb3(keyword) {
  let last;
  for (const endpoint of WEB3_SEARCH_ENDPOINTS) {
    try {
      const qs = new URLSearchParams({keyword, chainIds:CHAIN_IDS, orderBy:'volume24h'});
      const r = await fetchWithTimeout(`${endpoint}?${qs}`, 12000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j?.code && String(j.code) !== '000000') throw new Error(`Web3 ${j.code}`);
      return Array.isArray(j?.data) ? j.data : [];
    } catch (e) { last = e; }
  }
  if (last) console.debug(last);
  return [];
}

async function fetchDynamic(chainId, contractAddress) {
  let last;
  for (const endpoint of WEB3_DYNAMIC_ENDPOINTS) {
    try {
      const qs = new URLSearchParams({chainId:String(chainId), contractAddress:String(contractAddress)});
      const r = await fetchWithTimeout(`${endpoint}?${qs}`, 12000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j?.code && String(j.code) !== '000000') throw new Error(`Web3 ${j.code}`);
      return j?.data || null;
    } catch (e) { last = e; }
  }
  throw last || new Error('Web3 dynamic alınamadı.');
}

function normalizeName(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\b(token|coin|protocol|network|finance|chain)\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .trim().replace(/\s+/g,' ');
}
function namesCompatible(a,b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  return false;
}
function ratioInRange(a,b,min,max) {
  if (!(a > 0) || !(b > 0)) return false;
  const r = a / b;
  return r >= min && r <= max;
}


async function enrichHistory(rows, onProgress) {
  let next = 0, done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= rows.length) return;
      const row = rows[i];
      try {
        const [firstDaily, monthly] = await Promise.all([
          fetchSpotKlines(row.symbol, '1d', 0, 1),
          fetchSpotKlines(row.symbol, '1M', 0, 1000)
        ]);

        if (Array.isArray(firstDaily) && firstDaily.length) {
          const t = toNumber(firstDaily[0]?.[0]);
          if (Number.isFinite(t)) row.listingTime = t;
        }

        if (Array.isArray(monthly) && monthly.length) {
          let hi = -Infinity, lo = Infinity;
          for (const k of monthly) {
            const h = toNumber(k?.[2]);
            const l = toNumber(k?.[3]);
            if (h > 0 && h > hi) hi = h;
            if (l > 0 && l < lo) lo = l;
          }
          if (Number.isFinite(hi)) row.allTimeHigh = hi;
          if (Number.isFinite(lo)) row.allTimeLow = lo;
        }
      } catch (e) {
        console.debug('Geçmiş veri alınamadı:', row.symbol, e);
      } finally {
        done++; onProgress?.({done,total:rows.length});
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(HISTORY_CONCURRENCY, rows.length)}, worker));
}

async function fetchSpotKlines(symbol, interval, startTime, limit) {
  const qs = new URLSearchParams({
    symbol,
    interval,
    startTime:String(startTime),
    limit:String(limit)
  });
  const data = await fetchSpotRestJson(`/api/v3/klines?${qs}`);
  if (!Array.isArray(data)) throw new Error(`${symbol} kline formatı değişmiş.`);
  return data;
}

function twoYearCutoff(now = new Date()) {
  const d = new Date(now.getTime());
  d.setFullYear(d.getFullYear() - 2);
  return d;
}

function isRecentListing(listingTime) {
  if (!Number.isFinite(listingTime)) return false;
  return new Date(listingTime) >= twoYearCutoff(new Date());
}

function formatAge(listingTime) {
  if (!Number.isFinite(listingTime)) return '—';
  const start = new Date(listingTime);
  const now = new Date();
  if (start > now) return '—';

  let years = now.getUTCFullYear() - start.getUTCFullYear();
  let months = now.getUTCMonth() - start.getUTCMonth();
  let days = now.getUTCDate() - start.getUTCDate();
  if (days < 0) {
    months--;
    const prevMonthDays = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
    days += prevMonthDays;
  }
  if (months < 0) { years--; months += 12; }

  if (years > 0) return `${years} yıl ${months} ay`;
  if (months > 0) return `${months} ay ${days} gün`;
  return `${Math.max(0,days)} gün`;
}

function formatDate(listingTime) {
  if (!Number.isFinite(listingTime)) return '—';
  return new Intl.DateTimeFormat('tr-TR',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(new Date(listingTime));
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {method:'GET', mode:'cors', cache:'no-store', credentials:'omit', headers:{Accept:'application/json'}, signal:ctrl.signal});
  } finally { clearTimeout(timer); }
}

function compareSortValues(a,b,key,dir) {
  const A = a?.[key], B = b?.[key];
  if (key === 'symbol' || key === 'requestTime') {
    return dir * String(A ?? '').localeCompare(String(B ?? ''), 'tr', {numeric:true, sensitivity:'base'});
  }
  const an = Number(A), bn = Number(B);
  if (!Number.isFinite(an) && !Number.isFinite(bn)) return 0;
  if (!Number.isFinite(an)) return 1;
  if (!Number.isFinite(bn)) return -1;
  return dir * (an - bn);
}

function updateSortHeaders() {
  document.querySelectorAll('#analysisTable th[data-key]').forEach(th => {
    const active = sortState.key === th.dataset.key;
    th.classList.toggle('sortActive', active);
    let mark = th.querySelector('.sortMark');
    if (!mark) {
      mark = document.createElement('span');
      mark.className = 'sortMark';
      th.appendChild(mark);
    }
    mark.textContent = active ? (sortState.dir > 0 ? '▲' : '▼') : '';
  });
}

function renderRows(rows) {
  currentRows = Array.isArray(rows) ? rows.slice() : [];
  renderCurrentRows();
}

function renderCurrentRows() {
  const rows = currentRows.slice();
  if (sortState.key) rows.sort((a,b) => compareSortValues(a,b,sortState.key,sortState.dir));

  resultsBody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (isRecentListing(row.listingTime)) tr.classList.add('recent-coin');
    const ageTd = cell(formatAge(row.listingTime),'age-cell');
    if (Number.isFinite(row.listingTime)) {
      const small = document.createElement('small');
      small.textContent = formatDate(row.listingTime);
      ageTd.appendChild(small);
    }
    tr.append(
      cell(row.symbol,'coin'),
      cell(formatPrice(row.price),'num'),
      cell(formatVolume(row.volume24hQuote),'num'),
      cell(formatSupply(row.totalSupply),'num'),
      cell(formatSupply(row.circulatingSupply),'num'),
      ageTd,
      cell(formatPrice(row.allTimeHigh),'num'),
      cell(formatPrice(row.allTimeLow),'num'),
      cell(row.requestTime,'time')
    );
    frag.appendChild(tr);
  }
  resultsBody.appendChild(frag);
  resultCountEl.textContent = `${rows.length} coin`;
  updateSortHeaders();
}
function cell(text, cls='') { const td=document.createElement('td'); td.textContent=text; if(cls) td.className=cls; return td; }
function formatPrice(v) {
  if (!Number.isFinite(v)) return '—';
  let d=2; if(v<1)d=6; if(v<0.01)d=8;
  return `${new Intl.NumberFormat('tr-TR',{maximumFractionDigits:d}).format(v)} USDT`;
}
function formatVolume(v) {
  if (!Number.isFinite(v)) return '—';
  return `${new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2}).format(v)} USDT`;
}
function formatSupply(v) {
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2}).format(v);
}
function formatTime(d) { return new Intl.DateTimeFormat('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d); }
function toNumber(v) { if(v===null||v===undefined||v==='') return NaN; const n=Number(v); return Number.isFinite(n)?n:NaN; }
function setStatus(msg, error=false) { statusEl.textContent=msg; statusEl.className=`status${error?' error':''}`; }

(() => {
  'use strict';
  const section = document.getElementById('analysisTableSection');
  const button = document.getElementById('analysisFullscreenBtn');
  if (!section || !button) return;

  function isActive(){
    return document.fullscreenElement === section || section.classList.contains('fullscreenFallback');
  }
  function sync(){
    const active = isActive();
    button.textContent = active ? '×' : '⛶';
    button.title = active ? 'Tam ekrandan çık' : 'Gridi tam ekran yap';
    button.setAttribute('aria-label', active ? 'Tam ekrandan çık' : 'Gridi tam ekran yap');
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  button.addEventListener('click', async () => {
    try {
      if (section.classList.contains('fullscreenFallback')) {
        section.classList.remove('fullscreenFallback');
      } else if (document.fullscreenElement === section) {
        await document.exitFullscreen();
      } else if (!document.fullscreenElement && section.requestFullscreen) {
        await section.requestFullscreen();
      } else {
        section.classList.add('fullscreenFallback');
      }
    } catch (_) {
      section.classList.toggle('fullscreenFallback');
    }
    sync();
  });
  document.addEventListener('fullscreenchange', sync);
  sync();
})();
