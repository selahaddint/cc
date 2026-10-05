(() => {
  'use strict';

  /**
   * Auto3m1m / future C# Windows Service configuration.
   *
   * IMPORTANT:
   * - Do NOT store Binance API Key / Secret in this browser-side file.
   * - In the future C# service, credentials should come from environment variables,
   *   .NET User Secrets, or a secure secret store.
   *
   * C# migration target:
   *   ApiSettings.cs
   */

  const ApiSettings = Object.freeze({
    // How often Auto3m1m evaluates the latest WebSocket-backed market state.
    scanIntervalSeconds: 5,

    // Maximum number of simultaneously open positions.
    maxOpenPositions: 2,

    // Capital allocated per position, expressed in USDT.
    positionUsdtAmount: 100,

    // Futures leverage to use when automatic order execution is introduced.
    leverage: 5,

    // Number of consecutive ENTRY_READY evaluations required before final SELECT.
    // Example: 2 means ENTRY_READY at t=0s and again at t=5s before SELECT.
    entryConfirmationCount: 1,

    // Final live-entry freshness window for the most recent completed 1m confirmation.
    // 75s avoids invalidating a valid 1m confirmation during the second half of the minute.
    maxSignalAgeSeconds: 75,

    // A symbol that already has an open position must not be selected again.
    allowDuplicateSymbolPosition: false,

    // When the open-position limit is reached, Auto3m1m pauses scanning.
    pauseScanWhenPositionLimitReached: true,

    // When Follow exits a position and a slot becomes free, scanning may resume.
    resumeScanAfterPositionExit: true,

    // Temporary browser-validation behavior:
    // when Auto3m1m produces a FINAL SELECT, automatically start Follow for it.

    // Infrastructure only: slow history bootstrap queue. Does not change SELECT rules.
    historyBootstrapIntervalMs: 1500,
    historyBootstrapMinReady: 40,
    historyBootstrapMaxAttempts: 3,
    historyBootstrapWorkers: 4,

    autoFollowOnSelect: true
  });

  // Plain-script compatibility for the current HTML/JS application.
  // Future modules/services should depend on this configuration object,
  // not duplicate these values internally.
  globalThis.ApiSettings = ApiSettings;
})();
