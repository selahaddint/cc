# AGENTS.md — Precise15 / Codex Project Memory

> Last consolidated: 2026-09-28  
> Purpose: This file is the durable project memory and operating contract for Codex.  
> Language with the user: Turkish.  
> Code/comments: English is acceptable unless the user asks otherwise.

---

## 1. MOST IMPORTANT OPERATING RULE

This is a production project with many previously agreed trading/monitoring rules.

**Never "improve", simplify, refactor, loosen, tighten, rename, merge, or reinterpret an existing rule unless the user explicitly asks for that exact change.**

When the user says "düzelt", "yap", "ekle", or gives a concrete change request:
1. Inspect the current active source files first.
2. Identify the smallest affected functions/files.
3. Change only those parts.
4. Preserve all unrelated behavior.
5. Run syntax/tests.
6. Inspect the diff for accidental changes.
7. Report exactly what changed and what was intentionally left unchanged.

Do not ask the user to repeat project history that is already written here.

If this file and the active code disagree on a trading rule, **do not silently choose one**. State the exact conflict. The latest explicit user instruction has priority.

---

## 2. PROJECT IDENTITY

Project name: **Precise15**

Current implementation style:
- Plain HTML + JavaScript.
- No framework unless explicitly requested.
- Public market-data REST APIs.
- Browser-based UI.
- Browser-local SQLite reporting is used through `sql.js`.
- The project may later be ported to C#, but **do not start that conversion unless explicitly requested**.

The user prefers:
- Turkish explanations.
- Concrete operational rules, formulas, and code-level answers.
- Minimal unrelated commentary.
- No silent rule changes.
- Production-safe incremental changes.
- Performance and request-count discipline.

---

## 3. CURRENT MODULE ARCHITECTURE — KEEP SEPARATE

There are three main business operations. They must remain isolated.

### A. `StartScan.js`
Owns:
- Start Scan
- candidate discovery
- Fast Event
- base filters
- 1h / 15m / 5m Entry Ready analysis
- SELECT / CAUTION result
- scan caches
- market context
- grid candidate rendering/enrichment
- preservation/merge of active Follow rows during a new scan

Must NOT:
- call Follow business logic
- call RiskManagement business logic
- change Follow state/rules
- compute expensive lazy RiskManagement metrics during normal scan unless already part of the accepted scan implementation

### B. `RiskManagement.js`
Triggered by clicking a coin name.

Owns lazy, coin-specific decision-support fields such as:
- PriceLevel
- RiskLevel
- other expensive coin-specific support metrics already present in the active project

Rules:
- It is informational/decision support.
- It must not silently alter StartScan SELECT/CAUTION.
- It must not alter Follow EXIT logic.
- Heavy requests should remain lazy and cached.
- Non-clicked coins should not pay the cost of these calculations.

### C. `Follow.js`
Owns:
- Entry/Stop interaction
- Follow start/stop
- live monitoring
- HOLD / PROTECT / EXIT
- live OI/flow analysis
- Follow reporting event emission
- persistence of active Follow rows across a new Start Scan

Must NOT:
- call StartScan business logic
- change SELECT rules
- change RiskManagement

### Experimental `OneMScan.js`
- OneMScan was only an experiment.
- It is **not** the production StartScan.
- Never copy OneMScan rules into StartScan unless explicitly requested.
- Never use OneMScan as the source of truth for selection logic.

---

## 4. CURRENT BASELINE FILES

The last confirmed logic snapshots from the current work are:

- StartScan baseline: `StartScan(20260927-223600).js`
- Follow baseline with corrected HL logic: `Follow(20260927-HLFix).js`

The deployed project may rename these to:
- `js/StartScan.js`
- `js/Follow.js`

When working inside the actual project:
1. Check `index.html` script references.
2. Check `git status`.
3. Identify which files are active.
4. Treat archived/versioned copies as backups unless explicitly requested.

Do not accidentally edit an old backup instead of the active file.

---

## 5. MARKET / PRODUCT CONSTRAINTS

These are fixed unless the user explicitly changes them:

- LONG only.
- USDT quote.
- USDⓈ-M Futures data/eligibility.
- Isolated margin is the user's operating mode.
- Maximum holding/follow horizon: 4 hours.
- Primary structure/management timeframe: **15m**.
- Confirmation timeframe: **5m**.
- 1m: execution/live observation.
- 3m: early/secondary live confirmation only where the current Follow/entry logic already uses it.
- 1h: higher-timeframe regime/context.
- Do not add SHORT logic.
- Do not introduce stock-token instruments.
- Stablecoin bases are excluded where the active StartScan does so.
- Internal exchange contract fields/endpoints may use their official names, but do not introduce new user-facing terminology unnecessarily.

---

## 6. BOOK / RESEARCH-DERIVED DESIGN PRINCIPLES

These are the principles distilled into the project from the project's blueprint/education material. They are not a license to change current numeric thresholds.

Primary references previously used:
- Alexander Elder — *The New Trading for a Living*
- Nicolas Darvas — *How I Made $2,000,000 in the Stock Market*
- Edwin Lefèvre — *Reminiscences of a Stock Operator*
- Robert J. Shiller — *Irrational Exuberance*
- project blueprint/education documents
- academic/market-microstructure cross-checks
- official exchange market-data documentation

Project interpretation:

### Price first
Indicators do not replace price behavior or structure.

### Decision hierarchy
Use the hierarchy:

**Price Structure → Location → Volume → Secondary Indicators → Volatility**

Do not turn the system into simple "indicator voting".

### Structure/regime
- HH + HL = bullish/uptrend structure.
- LH + LL = bearish/downtrend structure.
- unclear/mixed structure = range/transition, not invented trend.

### Timeframe hierarchy
Higher TF → Main TF → Execution/confirmation TF.

For this project:
- 1h = regime/context
- 15m = main setup/structure
- 5m = confirmation
- 1m/3m = live timing/execution support as already defined by code

### Volume
Volume is participation/conviction confirmation.
Volume alone must not create direction.

### EMA
EMA slope/stack supports trend/value interpretation.
EMA does not replace price structure.

### RSI
RSI is momentum confirmation/deterioration context.
Overbought is not an automatic sell.
Oversold is not an automatic buy.
Divergence is a warning, not a standalone entry/exit.

### MACD
MACD is momentum expansion/deceleration/divergence context.
Do not count RSI and MACD as completely independent evidence.

### ATR
ATR measures volatility / normal market noise.
ATR is not a direction signal.
Use ATR to normalize thresholds, structure noise, trailing logic, and entry extension.

### No chase
A correct direction does not imply a good entry price.
If the valid entry has already run away, do not chase.

### Valid bias != entry
A structurally favorable coin is not automatically Entry Ready.
Setup, timing, confirmation, location and no-chase still matter.

### Expected behavior
If a coin that should be strong stops behaving strongly, treat that as meaningful deterioration.

---

## 7. STARTSCAN — CURRENT PRODUCTION INTENT

### 7.1 Fast Event: current scan only
StartScan uses two live price snapshots:

`Snapshot #1 → wait windowSec → Snapshot #2`

Fast change:

`(Snapshot2 / Snapshot1 - 1) × 100`

Candidate must pass the configured:
- minimum increase
- maximum increase

Current baseline defaults:
- `windowSec = 60`
- `minIncrease = 0.5`
- `maxIncrease = 4`

These are user-configurable settings. Do not silently change defaults or force fixed values.

### 7.2 Fast Event Watch is NOT a candidate source
Persistent Fast Event Watch/history may exist for telemetry/history.

**Old Fast Event Watch entries must never be injected into the current scan candidate set.**

StartScan decisions must come from the current scan's two snapshots only.

### 7.3 Fast Event start time
Current corrected logic stores:

`fastEventStartTime = Snapshot #1 time`

and:

`fastEventTime = Snapshot #2 time`

This is important for entry freshness.

Do not remove `fastEventStartTime`.

---

## 8. STARTSCAN — CLOSED VS LIVE CANDLES

For structural/indicator/setup logic:
- use fully CLOSED candles.

Current/open candles:
- may be used only for live entry-timing direction checks already implemented.

Do not feed an unfinished candle into:
- EMA structural calculations
- MACD structural calculations
- RSI structural calculations
- ATR structural calculations
- swing structure
- 15m setup discovery

unless the user explicitly changes this design.

---

## 9. STARTSCAN — 1H / 15M / 5M ENTRY-READY FLOW

The current high-level order is:

`Fast Event`
→ base eligibility/liquidity/data filters
→ operational recheck
→ 1h regime
→ freshness / Elder-style impulse
→ 15m setup
→ 5m confirmation
→ current entry timing / no-chase
→ structural R/R/location
→ SELECT or CAUTION

General market context is informational unless the active code explicitly uses a hard operational filter. Do not turn market context UP/DOWN/MIXED into an unrequested SELECT veto.

---

## 10. STARTSCAN — 1H RULE

Current intent:
- `DOWNTREND` blocks LONG/SELECT.
- `UPTREND` continues into the pullback/value setup family.
- `RANGE` continues into the breakout/retest setup family.
- `TRANSITION` is not automatically a hard block; the current code can evaluate supported setup families.

Do not convert `TRANSITION` into a hard DROP unless explicitly requested.

---

## 11. STARTSCAN — 15M SETUP FAMILIES

### UPTREND
Primary setup family:
- Pullback into EMA7–EMA25 value area.
- Reject invalid/deep pullback according to current ATR-normalized implementation.

### RANGE
Primary setup family:
- Breakout
- volume support as implemented
- retest
- retest must remain valid

### TRANSITION
Current code may evaluate both setup families and use the valid/recent one.

Do not merge the setup families into one generic pattern.

---

## 12. STARTSCAN — CRITICAL ENTRY-TIMING FIX (2026-09-27)

This is a key production rule added to fix late entries.

### 12.1 Setup must pre-exist the Fast Event
A valid 15m setup must already exist when the Fast Event starts:

`SetupTime <= FastEventStartTime`

If the setup formed after the Fast Event started:
- it is not the setup that caused/preceded the move
- it must not produce SELECT

### 12.2 Setup age limit
Current:
- `triggerValidBars = 2`
- main setup timeframe = 15m

Therefore maximum accepted setup age at Fast Event start:

`2 × 15m = 30 minutes`

If:

`FastEventStartTime - SetupTime > 30 minutes`

the setup is stale and must not be Entry Ready.

Do not remove this timing relationship.

---

## 13. STARTSCAN — 5M CONFIRMATION (LATEST ACCEPTED)

The latest accepted baseline intentionally uses a light confirmation because Fast Event itself is the live expansion trigger.

Use the latest fully closed 5m candle.

It must belong to the setup lifecycle:

`5m confirmation close time >= 15m setup time`

Do NOT wait for a new post-Fast-Event 5m close; that would recreate late-entry behavior.

Current quality components:
- RSI
- MACD
- ATR

Current confirmation threshold:

**at least 1 of 3 must PASS**

Closed-5m volume is informational/supportive in this latest baseline, not a mandatory component.

Do not silently restore older 4/5, 5/5, mandatory EMA/MACD, or other historical versions.

---

## 14. STARTSCAN — HARD NO-CHASE GATE

This is another key late-entry fix.

Current value extension is normalized to 15m ATR.

Current hard limit:

`ValueExtension <= 0.50 × ATR15`

If:

`ValueExtension > 0.50 × ATR15`

then:
- Step10 = TOO_LATE / not Entry Ready
- result cannot be SELECT
- it remains CAUTION if not otherwise hard-dropped

Historical analog/freshness models may remain diagnostic, but **they cannot override this current no-chase gate**.

Do not revert to the older behavior where a very extended entry was only a soft warning.

---

## 15. STARTSCAN — LIVE ENTRY-DIRECTION GATES

Closed candles own the actual indicator/setup analysis.

Current live timing behavior:

### Live 15m
- only a sufficiently strong downside live body blocks SELECT
- current threshold is approximately `-0.25 ATR15`
- mild DOWN is only informational/soft warning

### Live 5m
- clear DOWN blocks SELECT / demotes to CAUTION
- current neutral/body threshold is approximately `0.10 ATR`

### Live 3m
- independent early timing layer
- DOWN can demote SELECT to CAUTION
- it must not rewrite 15m/5m closed-candle structure

Do not use live candles to redefine the closed-candle setup.

---

## 16. STARTSCAN — STRUCTURAL R/R

Current structural asymmetry behavior:

- `< 0.75` → hard fail / DROP
- `0.75–0.99` → CAUTION
- `>= 1.00` → acceptable for SELECT

Historical R/R may be shown as diagnostic/soft warning.

Do not silently change these thresholds.

---

## 17. STARTSCAN — FINAL GRID CONTRACT

Current response-grid contract:

1. Show **all SELECT** rows.
2. Show at most the first **3 CAUTION** rows.
3. Do not show hard-failed/internal DROP rows.
4. Current response is effectively SELECT + CAUTION; do not reintroduce WAIT/REJECT rows without explicit instruction.

SELECT means Entry Ready in the current project.

---

## 18. FOLLOW ROWS DURING A NEW STARTSCAN

This behavior is mandatory.

When a new Start Scan starts:
- active Follow rows must remain in the grid
- active Follow rows must stay at the top
- new scan results appear below
- same-symbol duplicate from the new scan must be omitted
- active Follow rows do not consume the CAUTION display quota
- EXITed/stopped Follow rows must not survive as stale preserved rows
- Follow monitoring must continue independently

Do not regress this behavior.

---

## 19. FOLLOW — GENERAL

Refresh interval:
- 60 seconds

Main management timeframe:
- 15m

5m:
- warning/structure support

3m:
- secondary confirmation only when triggered by the accepted logic

1m:
- execution/high-low observation and live-flow context

Maximum Follow duration:
- 4 hours

Follow can emit:
- GREEN = HOLD
- YELLOW = PROTECT
- RED = EXIT

---

## 20. FOLLOW — FIRST CHECK SAFETY

On the very first Follow refresh, a fetched 1m candle may contain high/low movement from before the user clicked Follow.

Therefore:

**First Follow check must use current price only for observedHigh/observedLow.**

Do not let pre-Follow 1m wick data trigger an instant false stop/exit.

After the first check, 1m high/low since the previous check may be used.

---

## 21. FOLLOW — CURRENT EXIT RULES

The current project has a small number of actual EXIT mechanisms. Keep warnings separate from EXIT.

### EXIT 1 — Hard Stop
For LONG:

`observed 1m low <= StopPrice`

→ EXIT immediately.

Default auto Stop when Entry is typed:

`StopPrice = Entry × 0.98`

Do not widen Stop automatically.

### EXIT 2 — Confirmed 15m HL breakdown
Active structural HL is evaluated using CLOSED 15m candle close.

If:

`15m Close < activeHL`

calculate:

`BreakRatio = (HL - Close) / ATR15`

Current thresholds:
- `< 0.25 ATR` → HOLD/info
- `0.25–0.50 ATR` → PROTECT
- `>= 0.50 ATR` → EXIT

If only the wick goes below HL but the 15m candle closes back above:
- info only
- no HL-break EXIT

### EXIT 3 — ATR trailing / Break-Even protection

Track:

`Highest = highest observed price since Follow started`

Trailing:

`TrailingLevel = Highest - 2 × ATR15`

Break-even arms after:

`Highest >= Entry + 1 × ATR15`

Once armed, it remains armed for the Follow session.

Effective floor:

`EffectiveExitLevel = max(Entry, TrailingLevel)` when break-even is armed.

If current price <= effective exit level:
- EXIT immediately
- do not wait for a 15m close

### EXIT 4 — Maximum holding time
If:

`serverTime - FollowStartedAt >= 4 hours`

→ EXIT.

### Experimental OI line exit
`OICizgiAnalysis` is isolated/experimental.

Current baseline:
- `oiCizgiEnabled = false`

Do not enable it silently.
If explicitly enabled, its own existing exit rule may act independently.

---

## 22. FOLLOW — HL LOGIC: CRITICAL FIX (2026-09-27)

This section is extremely important because previous Follow reports repeatedly exited on suspicious `15m HL breakdown`.

### 22.1 Initial historical HL is not blindly accepted
At Follow start, a historical HL can become active only if all are true:

1. It is a genuinely confirmed structural HL.
2. It passes ATR noise filtering.
3. `HL < EntryPrice`
4. latest closed 15m close is still above/equal to that HL.
5. the higher low was subsequently confirmed by a later structural high breaking the relevant prior swing high.

Otherwise:
- do not assign it as active `lastHL`
- wait for valid post-entry structure

### 22.2 ATR noise filter for a new higher low
A new swing low is not a HL merely because it is microscopically higher.

Current requirement:

`NewLow > PreviousLow + 0.10 × ATR15`

The `0.10 ATR` comes from current structural tolerance.

### 22.3 Candidate first, active HL later
A new qualifying swing low becomes:

`pendingHL`

It must NOT immediately replace `lastHL`.

### 22.4 Candidate confirmation
The pending HL becomes active only after a later confirmed swing high breaks above the swing high that preceded the candidate low, including the current ATR structural tolerance.

Conceptually:

`prior swing high`
→ pullback
→ higher swing low candidate
→ price resumes upward
→ later swing high > prior swing high + ATR tolerance
→ candidate becomes confirmed active HL

### 22.5 HL protection ratchets upward only
A newly confirmed HL may replace current `lastHL` only when it is structurally higher.

The structural protection level must not ratchet downward.

Do not revert to the older logic:

`any new swing low > previous swing low => lastHL immediately`

That old behavior caused suspicious/overly aggressive HL exits.

---

## 23. FOLLOW — PROTECT / WARNING LOGIC

These are warnings/PROTECT evidence unless a separate explicit EXIT rule is hit.

### 5m / 3m structure
- 5m LL/LH → PROTECT warning
- 3m LL/LH may confirm the warning

These do not automatically become EXIT.

### 15m EMA / MACD
- EMA25 slope DOWN → PROTECT warning
- EMA down + MACD histogram down → stronger bearish warning

Do not convert this pair into an EXIT unless the user explicitly changes the system.

### Failed HH
A new confirmed swing-high failing to exceed prior HH:
- PROTECT warning

### Bearish divergence
New higher price high with weaker RSI and/or MACD histogram:
- PROTECT warning

Divergence alone is not EXIT.

### Selling volume expansion
Confirmation only.

### Price down + OI up
Confirmation only.

### Live flow analysis
Live analysis may output PROTECT.
Normal Live Analysis must not create EXIT on its own.

---

## 24. FOLLOW — LIVE DATA

Current live context includes combinations of:
- price change
- Open Interest change
- 1m taker buy/sell pressure
- 1m volume/spike
- basis/premium
- funding
- Top Long/Short Account ratio
- Top Long/Short Position ratio
- Global Long/Short ratio
- 5m taker B/S

Interpretation must remain contextual.
Do not turn a single live metric into a standalone EXIT unless explicitly requested.

---

## 25. REPORTING / SQLITE

The browser-local report system is important and must not be broken.

### StartScan report
A completed scan can be stored once with fields including:
- Date
- Hour/time
- scan parameters such as Sec / MinY% / MaxY%
- SELECT coin list

Avoid duplicate records for the same completed scan.

### Follow report
Current logical columns/order:
- Date
- Hour
- Coin
- EntryPrice
- StopPrice
- Profit
- Reason

Create a record when:
- automatic EXIT occurs
- user manually stops Follow

Profit is based on Entry versus final/exit price and stored as percentage.

Manual close reason:
- `Manual Follow Stop`

Do not add an extra API request only to produce the manual report if a valid last-known/displayed price already exists.

Report popup/grid sorting must remain functional.

---

## 26. NOTIFICATIONS / PERMISSIONS

Do not request browser Notification permission merely because Follow starts.

A previous implementation caused repeated permission prompts and instant Follow issues.

Unless the user explicitly requests notification functionality:
- no Notification permission prompt
- no service worker requirement
- no notification dependency in core Follow logic

Core Follow must keep working even if optional sound/notification features are unavailable.

---

## 27. REQUEST / PERFORMANCE RULES

Request count and scan speed are high-priority constraints.

Preserve:
- bulk endpoints where possible
- cached data reuse
- lazy expensive requests
- no duplicate fetches for the same data in the same stage
- Activity Rank cache (current baseline uses ~30 minute TTL)
- coin-specific RiskManagement only on click
- no expensive decision-support requests for every row if they are not required for selection

Do not trade correctness for fewer requests, but do not add per-coin requests when bulk/cache can provide the same data.

For rate-limit handling:
- preserve the existing backoff/stop behavior
- never create tight retry loops
- HTTP 418/429 handling must not freeze the UI or cause request storms

---

## 28. UI CONTRACT

General UI intent:
- mobile-friendly
- compact rows
- sortable columns where already supported
- hamburger menu
- Main / History / Analysis links
- small footer disclaimer: not investment advice

User-facing terminology constraints:
- avoid displaying the word `Binance` in UI text, hints, titles, explanations, and labels unless the user explicitly requests it
- internal API URLs/domain strings may naturally still contain the provider domain
- where the UI previously used `Crypto`, the user's chosen compact product wording is `Cr`

Do not rename DOM IDs/classes/data attributes casually. JS modules depend on them.

---

## 29. GRID / STATE CONTRACTS

Common invariants:
- Coin rows are keyed by `symbol`.
- Follow must be able to find the corresponding row after rescans.
- Active Follow row model must survive a new scan.
- New scan duplicate for an actively-followed symbol is omitted.
- Entry/Stop state for active Follow must be restored after grid rerender.
- Current Price cell continues updating during Follow.
- Live Change and Live Result are empty before Follow and populated during Follow.

Do not break these cross-module DOM/data contracts.

---

## 30. RISKMANAGEMENT / COIN CLICK

RiskManagement is intentionally lazy.

Rules:
- clicking coin name may perform expensive calculations
- normal StartScan must not eagerly compute those expensive fields
- repeated click can use the existing cache
- PriceLevel/RiskLevel are decision support, not StartScan selection inputs unless explicitly redesigned

Do not move these heavy calculations back into the scan loop.

---

## 31. AUTO SCAN

Current StartScan baseline contains an auto-scan mechanism.

Baseline interval:
- approximately 2 minutes

It must not overlap a currently running scan.

If a scan is still running:
- do not start another in parallel
- reschedule according to the existing logic

Do not let auto scan stop active Follow monitors.

---

## 32. DEVELOPMENT / CODEX WORKFLOW

For every non-trivial code change:

### Before
- Read this `AGENTS.md`.
- Identify active files from `index.html`.
- Run `git status`.
- Read the relevant function(s), not just snippets.
- Search for all call sites before changing a function signature.
- Check whether the same rule is duplicated elsewhere.

### During
- Minimum diff.
- No unrelated formatting.
- No broad refactor unless requested.
- No renaming public functions / DOM IDs / events / module exports unless requested.
- No dependency/framework addition unless requested.
- Preserve comments that document important historical fixes.

### After
For JavaScript files:
- run `node --check <changed-file.js>`

Then:
- inspect `git diff -- <changed files>`
- verify no unrelated module changed
- verify thresholds not accidentally changed
- verify active Follow row preservation if StartScan/grid code changed
- verify First Follow Check behavior if Follow fetch logic changed
- verify Follow reporting if EXIT/manual-stop flow changed

If a relevant automated test does not exist:
- do not claim full behavioral proof
- state what was syntax-checked and what logic was manually traced

---

## 33. GIT RULE

Use Git as the safety net.

Before a risky change, prefer a clean commit/checkpoint.

Never destroy user work with:
- `git reset --hard`
- destructive checkout
- force-clean
- force-push

unless the user explicitly requests and understands it.

Do not overwrite unrelated uncommitted changes.

---

## 34. HOW TO HANDLE "FIX THIS" FROM THE USER

When the user reports a behavior such as:
- SELECT is late
- no SELECT appears
- Follow exits too early
- HL looks wrong
- request count increased
- grid row disappears
- report duplicates
- Follow immediately EXITs

Do NOT immediately loosen random thresholds.

Use this sequence:
1. Reproduce/trace the exact code path.
2. Identify which gate/state generated the behavior.
3. Compare with this project's agreed rule.
4. Fix the root cause only.
5. Preserve all unrelated rules.
6. Add a diagnostic only if needed.
7. Remove temporary diagnostics if the user wants production clean-up.

---

## 35. CURRENT KNOWN ROOT-CAUSE HISTORY — DO NOT REINTRODUCE

### Late StartScan Entry
Root problems previously identified and fixed:
- Fast Event start time was not tied to setup timing.
- old 15m setup could qualify a later move.
- No-Chase existed diagnostically but did not actually block SELECT.
- Step10 allowed very extended prices.

Current fix:
- FastEventStartTime = Snapshot1
- setup must predate event start
- setup max age = 30m
- 5m confirmation must be after setup
- no-chase >0.50 ATR15 = TOO_LATE / not SELECT

Do not revert.

### Suspicious Follow HL exits
Root problems previously identified and fixed:
- historical HL could be blindly assigned on Follow start
- any microscopically higher swing low could become HL
- new swing low could become active HL too early

Current fix:
- initial HL validation
- +0.10 ATR15 structural tolerance
- pendingHL candidate
- later higher-high confirmation
- upward-only structural ratchet

Do not revert.

### First-check instant EXIT
Root problem:
- first fetched 1m candle contained pre-Follow high/low

Current fix:
- first check uses current price only

Do not revert.

### Old Fast Event candidates reappearing
Root problem:
- persistent watch entries could re-enter later scans

Current fix:
- candidate set is current scan FastPass only

Do not revert.

---

## 36. SOURCE-OF-TRUTH PRINCIPLE

This `AGENTS.md` stores the intended system behavior and historical reasons.

The active source code stores the actual implementation.

Before changing production behavior:
- verify both
- preserve intent
- do not assume an archived version is newer because its filename looks newer
- use current script wiring + Git state + explicit user instruction

If the user explicitly changes a rule, update this `AGENTS.md` in the same change so Codex memory stays current.

---

## 37. SHORT CHECKLIST FOR EVERY FUTURE SESSION

Before editing, Codex should mentally confirm:

- [ ] Am I editing the active file?
- [ ] Is this StartScan, RiskManagement, or Follow?
- [ ] Am I accidentally changing another module?
- [ ] Am I changing a trading threshold the user did not ask to change?
- [ ] Am I using only closed candles where structure/indicators require them?
- [ ] Am I preserving the FastEventStart/setup-age/no-chase fixes?
- [ ] Am I preserving the corrected Follow HL candidate/confirmation logic?
- [ ] Am I preserving active Follow rows across scans?
- [ ] Am I adding avoidable requests?
- [ ] Did I run syntax checks?
- [ ] Did I inspect the diff?
- [ ] If the user changed a durable rule, did I update AGENTS.md?

---

## 38. FINAL PRINCIPLE

The goal is not to make the code "more clever."

The goal is:

**Preserve the agreed trading model, detect the correct opportunity earlier without chasing, manage the position with confirmed structure and volatility-aware protection, minimize unnecessary requests, and make only explicit, testable, reversible changes.**


---

## 39. Trading Source Policy

`docs/` is the project's primary trading reference source. This policy supplements all existing rules; it does not replace them or authorize changes to production behavior.

### Required source review

Before any analysis or change proposal concerning Entry, EXIT, HL/HH/LL/LH, ATR, EMA, MACD, RSI, volume, breakout, pullback, no-chase, risk management, or position management:

1. Consult the Project Trading Source Index below and read the relevant passages in the actual `docs/` sources. The index, a remembered summary, and general model knowledge are not substitutes for checking the source.
2. Identify the source's market, timeframe, setup, and assumptions before applying it to this project's LONG-only futures model and intraday horizon.
3. For implementation-related work, compare those passages with the applicable existing project rules and active code, using the established active-file workflow.
4. Wherever possible, name the exact `docs/` file and chapter/section or page supporting each claim. Distinguish PDF page numbers from printed page numbers. Attribute editorial commentary separately from the original author.
5. If a relevant passage cannot be read or no support is found, state that limitation explicitly. Do not invent a citation or claim to have read an entire book after inspecting selected passages.

### Required proposal labels

Separate recommendations and their supporting claims using these exact labels:

- **Source/book-supported**: the checked source explicitly supports the stated principle in its stated context. Cite the file and relevant passage location; this label is not evidence that the project's exact implementation or performance is validated.
- **Inference from sources**: a derived interpretation, synthesis, or adaptation. Cite the underlying sources and explain what was inferred, including any market/timeframe adaptation.
- **Model suggestion not explicitly supported by sources**: an idea without explicit support in the checked sources. State the absence of source support clearly and do not attribute general model knowledge to a book.

Separate a supported principle from an inferred implementation or unsupported numerical choice, even when all occur in one proposal. If sources were checked without finding support, identify what was checked rather than asserting that no source anywhere could support the idea.

### Numeric thresholds are project parameters unless specifically sourced

Do not call `0.10 ATR`, `0.25 ATR`, `0.50 ATR`, `1 ATR`, `2 ATR`, any time limit, or any percentage threshold a book rule unless the source explicitly gives that value for the same rule and context. Otherwise identify it as a **project parameter**.

A matching number elsewhere in a book is insufficient evidence. For example, an ATR band around an EMA does not establish the project's break-even activation or highest-price trailing formula; an account-equity risk percentage does not establish an entry-price stop percentage. Existing setup ages, timeframes, holding limits, structural tolerances, no-chase thresholds, and stop/trailing parameters remain the agreed project parameters unless their precise attribution is verified. Source support alone never authorizes changing them.

### Production changes and disagreements

- Production trading logic must not be changed solely on general model knowledge. Source review and the existing requirement for the user's explicit authorization of the exact behavior change both apply.
- If a source conflicts with active code or the agreed project rules, report the precise source passage and the conflicting code/rule to the user before any related behavior change. Do not silently reconcile them or change code to match the book.
- If relevant sources give different views, present all identified views with attribution and context. Do not independently choose one, merge them into an invented consensus, or silently discard a source.
- Apparent source errors or ambiguous passages must be disclosed and checked in context; do not silently correct them while presenting the corrected claim as the source's statement.
- External references and general model knowledge may supplement the review when needed, but must be identified separately and must not bypass the primary `docs/` review.

---

## 40. Project Trading Source Index

Reviewed 2026-09-28: six local PDFs. Text extraction was possible for all six; contents and selected relevant passages were inspected, not every page or chart. Some extracted text contains broken ligatures/characters, especially in Shiller. Verify the PDF visually whenever a formula, chart, annotation boundary, or damaged text matters. This index maps topics to sources; it is not blanket support for existing project rules.

| Local source file | Use for / reading entry points | Attribution and scope |
| --- | --- | --- |
| `docs/1. The New Trading for a Living.pdf` | Alexander Elder: support/resistance and HH/HL/LL/LH trend/range structure (sections 18-19); EMA/value-zone pullbacks (22); MACD (23), ATR (24), RSI (27); volume and OI (28-31); timeframes, Triple Screen and Impulse (33, 39-40); risk, position sizing, targets, stops, and journals (49-54, 58-59). Starting PDF pages: 76-77 structure, 94-96 value zone, 109-110 ATR, 178-179 Impulse, 220 account risk. | Primary technical and management reference within this library. Distinguish its principles and examples from the project's precise thresholds, EMA periods, no-chase gate, and confirmed-HL algorithm. |
| `docs/2. How I Made $2,000,000 in the Stock Market.pdf` | Nicolas Darvas: box structure, breakout entries, price/volume participation, expected price behavior, protective stops, raising protection, and allowing winners to develop. Start with chapter 4, Developing the Box Theory (PDF pages 60-74), then chapters 6-10 for applications. | This edition includes Steve Burns commentary. Attribute Burns's interpretations separately from Darvas's narrative. Stock-market boxes are not automatically the project's 15m swing-confirmation or mandatory retest rules. |
| `docs/3.Reminiscences of a Stock Operato.pdf` | Edwin Lefevre: price behavior, patience, holding through a trend, losses, speculation psychology, and the line of least resistance. Start with chapters VI and X (including PDF pages 97 and 169-170). | Annotated edition by Jon D. Markman, with additional commentary. Separate narrative, annotations, and foreword. Use for qualitative trading/position-management reasoning, not as an explicit ATR/EMA/RSI/MACD specification. |
| `docs/4. Irrational Exuberance -- Robert J_ Shiller.pdf` | Robert J. Shiller, revised/expanded third edition: speculative bubbles, feedback loops, media influence, psychological anchors, herd behavior, and market-risk context. Start with chapters 5-10; feedback discussion begins at PDF page 137. | Behavioral and broader market context. It does not by itself specify this project's intraday Entry/EXIT, structural confirmation, or numeric no-chase gate. |
| `docs/AI-Powered Bitcoin.pdf` | Eoghan Leahy, AI-Powered Bitcoin Trading: price analysis and AI prediction (chapters 4-5), MA/RSI/MACD/ATR (6), advanced methods and signal automation (7-8), backtesting and parameter optimization (9), and a strategy/risk case study (11). Starting PDF pages: 80-83 indicators, 113-115 backtesting. | Use for automation and research methodology with context-specific examples. Chapter 6's divergence labels and ATR reversal interpretation require explicit comparison with the other sources and project rules before use; do not silently adopt or repair them. Case-study outcomes do not validate Precise15. |
| `docs/Zero to Hero in Cryptocurrency2.pdf` | Bogdan Vaida, Zero to Hero in Cryptocurrency Trading: candles, support/resistance, breakout/retest/fakeout (chapter 3); moving averages, RSI, ATR, volume and divergence (4); orders, liquidity, slippage and leverage (5); money management/position sizing (6); filter/setup/entry/stop/exit distinctions and testing (7); automation (8). Starting PDF pages: 91-93 breakout/retest, 116 ATR formula, 169-172 position sizing, 180-181 setup/trigger/stop. | Crypto-specific educational examples, not automatic production rules. Check divergence labels in context (including PDF page 125) against the other sources and report discrepancies rather than silently choosing a definition. |

For no-chase and entry location, consult Elder's value-zone/ATR discussion alongside Darvas's breakout approach and Vaida's setup/trigger discussion. Report differences in entry style; do not claim they jointly prescribe the project's `0.50 ATR15` gate. For HL/HH/LL/LH, begin with Elder's trend/range structure, then check relevant pattern/divergence passages; the project's pending-HL, later-HH confirmation, and ATR tolerance still require their own explicit attribution as project rules.
