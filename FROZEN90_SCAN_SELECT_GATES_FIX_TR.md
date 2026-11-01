# FROZEN90 – SELECT giriş doğrulama düzeltmesi

Bu paket yalnızca `js/FrozenLineCore.js`, `js/FrozenLineBrowser.js` ve script sürümü için `index.html` dosyalarını değiştirir. Mevcut Scan/Watch/Follow JS dosyaları ve C# kaynakları değişmez. Altı FROZEN HH/LH hesaplama formülü, 90 mum referans ve pivot onayları korunur.

## SELECT için zorunlu koşullar

1. Son kapanmış alt zaman dilimi mumunun `Close` değeri `BUY2 <= Close <= BUY1` olmalı.
2. Aynı kapanmış mum yükseliş yönünde olmalı: `Close > Open`.
3. Güncel gerçek Binance Futures `bookTicker.askPrice` mevcut ve geçerli olmalı. Geçerli ASK alınamazsa SELECT **üretilmez**.
4. Güncel ASK da `BUY2 <= ASK <= BUY1` aralığında olmalı (yalnızca kapanış değil, gerçek giriş fiyatı).
5. SELL1–SELL4'ten en az biri `SELL > BUY1` olmalı. En yakın geçerli SELL hedefi, BUY1'in ve giriş fiyatının üzerindeki ilk çizgidir. BUY bölgesindeki/altındaki ham SELL değerleri değiştirilmez.

Bu kurallar 4H→1H, 1H→15m ve 15m→5m Scan'lerinin hepsine uygulanır. Grafik herhangi bir SELECT'e tıklandığında altı ham fiyatı görmeye devam eder; yalnızca BUY1 üzerindeki SELL çizgileri üst direnç olarak sarı çizilir.

## Önemli sınırlamalar

FROZEN formülleri tarihsel seviyeler üretebilir, bu nedenle BUY1–BUY2 aralığı bazı coinlerde geniş olabilir. Bu sürüm keyfî maksimum BUY bölgesi yüzdesi eklemez ve tarama sonuç sayısını garanti etmez. Özellikle canlı ASK alınamayan coinler artık SELECT sayılmaz. C# tarafındaki Scan sınıflarına aynı mantık istenirse ayrıca uygulanmalıdır; bu ZIP yalnızca HTML/JS içindir.

## Test

`tests/test_frozen_scan_gates.js` ile üç strateji için kapalı mum, anlık fiyat, bölge dışı ASK, SELL bölge çakışması ve ASK yok durumları kontrol edilir. `tests/test_frozen_scan_browser.js` Scan'in GET sonucu beklerken eski kapanışı fallback kullanmadığını doğrular. Gerçek Binance piyasa verisiyle karşılaştırma ayrı yapılmalıdır.
