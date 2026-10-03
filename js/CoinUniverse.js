/**
 * CoinUniverse.js
 *
 * Local-file friendly coin universe manager.
 * Source: window.ALLOWED_COINS from js/AllowedCoins.js
 *
 * Required load order:
 *   <script src="js/AllowedCoins.js"></script>
 *   <script src="js/CoinUniverse.js"></script>
 *   <script src="js/StartScan.js"></script>
 *
 * Existing scanner usage remains unchanged:
 *   const allowedCoins = await CoinUniverse.getAllowedCoins();
 *
 * Design:
 * - No fetch() is used, so file:///.../index.html works.
 * - Coin list is normalized and cached as a Set.
 * - Duplicate/blank values are removed.
 * - Fail-closed: if AllowedCoins.js is missing or invalid, scan throws an error.
 */
(function (global) {
    'use strict';

    let allowedSet = null;
    let lastLoadedAt = null;

    function normalizeSymbol(symbol) {
        if (typeof symbol !== 'string') return '';
        return symbol.trim().toUpperCase();
    }

    function readSourceArray() {
        const source = global.ALLOWED_COINS;

        if (!Array.isArray(source)) {
            throw new Error(
                'AllowedCoins.js yüklenmedi veya ALLOWED_COINS listesi bulunamadı. ' +
                'index.html içinde AllowedCoins.js, CoinUniverse.js dosyasından önce yüklenmelidir.'
            );
        }

        return source;
    }

    function buildSet() {
        const source = readSourceArray();
        const nextSet = new Set();

        for (const item of source) {
            const symbol = normalizeSymbol(item);
            if (symbol) nextSet.add(symbol);
        }

        if (nextSet.size === 0) {
            throw new Error('AllowedCoins.js içinde kullanılabilir coin bulunamadı.');
        }

        allowedSet = nextSet;
        lastLoadedAt = Date.now();
        return allowedSet;
    }

    async function getAllowedCoins() {
        return allowedSet || buildSet();
    }

    async function getAllowedCoinsArray() {
        const set = await getAllowedCoins();
        return Array.from(set);
    }

    async function isAllowed(symbol) {
        const normalized = normalizeSymbol(symbol);
        if (!normalized) return false;
        const set = await getAllowedCoins();
        return set.has(normalized);
    }

    async function filterSymbols(symbols) {
        if (!Array.isArray(symbols)) {
            throw new TypeError('CoinUniverse.filterSymbols(symbols): symbols bir Array olmalı.');
        }

        const set = await getAllowedCoins();

        return symbols.filter(item => {
            if (typeof item === 'string') {
                return set.has(normalizeSymbol(item));
            }

            if (item && typeof item.symbol === 'string') {
                return set.has(normalizeSymbol(item.symbol));
            }

            return false;
        });
    }

    async function reload() {
        allowedSet = null;
        lastLoadedAt = null;
        return buildSet();
    }

    function clearCache() {
        allowedSet = null;
        lastLoadedAt = null;
    }

    function getStatus() {
        return {
            source: 'window.ALLOWED_COINS',
            loaded: allowedSet !== null,
            count: allowedSet ? allowedSet.size : 0,
            sourceCount: Array.isArray(global.ALLOWED_COINS) ? global.ALLOWED_COINS.length : 0,
            lastLoadedAt
        };
    }

    global.CoinUniverse = Object.freeze({
        getAllowedCoins,
        getAllowedCoinsArray,
        isAllowed,
        filterSymbols,
        reload,
        clearCache,
        getStatus
    });

})(window);
