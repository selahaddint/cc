/* Browser FROZEN90 scan — independent of C# and Watch/Follow.
 * SELECT uses FrozenLineCore.entryMode: BUY2 +0..15% (within BUY1),
 * or BUY2 -0..15% with a confirmed red-to-green closed-candle reversal.
 */
(function(global){'use strict';global.Auto1h15mLineScan=Object.freeze({id:'1h15m',name:'Auto1h15mLineScan',scan:(signal,progress)=>global.FrozenLineBrowser.scan('1h15m',signal,progress)});})(window);
