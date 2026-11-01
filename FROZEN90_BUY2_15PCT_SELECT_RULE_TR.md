# FROZEN90 HTML / JS – BUY2 ±%15 SELECT kuralı

## Kapsam

Bu sürüm sadece HTML projesindeki üç yeni çizgi taramasını etkiler:

- `Auto4h1hLineScan.js`: 90 adet 4H referans mumu, 1H giriş mumu
- `Auto1h15mLineScan.js`: 90 adet 1H referans mumu, 15m giriş mumu
- `Auto15m5mLineScan.js`: 90 adet 15m referans mumu, 5m giriş mumu

Üç küçük Scan dosyası aynı ortak tarama ve hesaplama altyapısını (`FrozenLineBrowser.js` ve `FrozenLineCore.js`) kullanır. Seviye hesaplayan altı FROZEN formül, 90 mum referansı, 1H/15m/5m için 3+3 pivot onayı ve 4H/1H/15m için 5+5 pivot onayı değiştirilmemiştir. Eski Scan/Watch/Follow dosyaları, C# kodu ve emir yönetimi değiştirilmemiştir.

## SELECT modları

*BUY2* her zaman daha alttaki yeşil alım çizgisidir (`BUY2 < BUY1`). Her iki modda da geçerli, BUY1 üzerindeki SELL hedefi zorunludur. Güncel Binance Futures `bookTicker.askPrice` olmadan SELECT üretilmez.

**BUY_ZONE (BUY2 üzerinde):**
- Kapanmış son alt zaman dilimi mumu yükselmiş olmalı (`lastClose > lastOpen`).
- Hem son kapanış hem güncel ASK, `BUY2 ≤ fiyat ≤ min(BUY1, BUY2 × 1,15)` koşulunu sağlamalı.
- BUY2'ye göre tam +%15 üst sınır dahildir.

**RECOVERY_BELOW_BUY2 (BUY2 altında):**
- Hem son kapanış hem güncel ASK `BUY2 × 0,85 ≤ fiyat < BUY2` aralığında olmalı.
- Bir önceki kapanmış mum düşüş mumu olmalı (`previousClose < previousOpen`).
- Son kapanmış mum yükseliş mumu olmalı (`lastClose > lastOpen` ve `lastClose > previousClose`).
- Güncel ASK, son kapanmış mumun kapanış fiyatının altına düşmemiş olmalı (`ASK ≥ lastClose`).
- BUY2'ye göre tam -%15 alt sınır dahildir.

Kapanış ile canlı ASK farklı taraflarda kalıyorsa SELECT üretilmez. %15, mum fitillerinin tarihsel ekstremine değil son kapanış ve **güncel ASK fiyatına** uygulanır. BUY1'in üzerindeki fiyatlar, BUY2'ye göre +%15 içinde kalsa bile BUY_ZONE olarak seçilmez.

## UI

SELECT gridindeki neden sütunu `BUY Zone • BUY2 +x.xx%` veya `BUY2 Recovery • BUY2 -x.xx%` gösterir. Coin üzerine tıklanınca aynı üç zaman dilimi ve altı FROZEN çizgi görüntülenir. Grafik hesaplaması değişmez.

## Testler

`node tests/test_frozen_scan_gates.js`

`node tests/test_frozen_scan_browser.js`

`node tests/test_frozen_core_invariants.js`

Tarayıcıda gerçek Binance verisiyle SELECT frekansını ve fiyat eşleşmesini ayrıca kontrol edin. Bu kaynak ve sentetik testler, piyasa sonuç sayısının belirli bir seviyeye düşeceğini garanti etmez.
