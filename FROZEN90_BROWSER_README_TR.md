# FROZEN90 — HTML/JavaScript çizgi taramaları ve grafiği

Bu paket, önceki `PreciseML_HTML.zip` temel alınarak hazırlanmıştır. Eski JS Scan, Watch ve Follow dosyalarında değişiklik yoktur.

## Kullanım

1. `index.html` açılır. Ana Scan Settings satırındaki **4H–1H Line Scan**, **1H–15m Line Scan** veya **15m–5m Line Scan** seçilir.
2. İşlem AllowedCoins.js listesindeki coinleri yalnızca tarayıcıdan Binance Futures herkese açık REST mum verisiyle kontrol eder. Son tamamlanmış alt zaman dilimi mumu BUY2–BUY1 aralığında kapanmış ve yükseliş yönündeyse, altı seviye onaylıysa ve SELECT fiyatının üstünde en az bir SELL hedefi varsa SELECT üretilir.
3. Herhangi bir scanner'ın SELECT satırındaki **coin adına veya SELECT yazısına** tıklanır. Candidate Response tablosunun altındaki grafik açılır.
4. Grafikte **4H / 1H / 15m** seçilince aynı coin için ilgili altı destek/direnç çizgisi ve alt zaman diliminin kapanmış mum grafiği hesaplanır. Seviye listesi grafiğin altında görünür.
5. **Cancel** yeni FROZEN taramasını iptal eder. Bu işlev Binance emirleri, Watch veya Follow kullanmaz.

## Dosyalar

- `js/FrozenLineCore.js`: üç C# Levels sınıfındaki 6 FROZEN formülü ve yalnız kapanmış mumları kullanan veri erişimi.
- `js/FrozenLineBrowser.js`: SELECT tarama düzenleyicisi, hız sınırı koruması, sonuç tablosu, SVG mum grafiği ve düğmeler.
- `js/Auto4h1hLineScan.js`, `js/Auto1h15mLineScan.js`, `js/Auto15m5mLineScan.js`: bağımsız scanner giriş noktaları.
- `index.html`: 3 Scan düğmesi ve grafiğin altına açıldığı kart; mevcut Result Detail SELECT tıklaması grafiğe yönlendirilmiştir, CAUTION Result Detail hâlâ kullanılabilir.

## Formül uyumu

- Her zaman 90 **kapanmış üst zaman dilimi mumu**: 4H→90×4H, 1H→90×1H, 15m→90×15m.
- Alt zaman dilimi aynı süreyi kapsar: 1H→360 mum, 15m→360 mum, 5m→270 mum.
- Alt zaman diliminde onay 3 sol+3 sağ, üst zaman diliminde onay 5 sol+5 sağ kapanmış mum.
- SELL1 ve BUY2 en küçük mutlak fiyat farkı, SELL2 kronolojik ilk sonraki LH, SELL3/SELL4 en yakın önceki LH, BUY1 en yakın önceki daha yüksek HH. HH ve LH önceki tüm onaylı pivot tepelere göre sınıflandırılır.
- Eski HH/LH noktalarını bulmak için ek geçmiş yüklenir: alt periyot 1500, üst periyot 500 mum. Sadece kapanmış mumlar değerlendirilir; yeterli/geçerli geçmiş yoksa seviyeler **uydurulmaz**.
- Hedef en yakın giriş üstü SELL seviyesidir. Kullanılabiliyorsa Binance best ask alınır; yoksa son kapanmış mum fiyatı kullanılır.

## Performans ve uyarılar

- Tarama yaklaşık 500+ coin için REST istekleri oluşturabilir. Önce son iki mumla yükseliş taranır; uzun geçmiş yalnız uygun mumlara yüklenir. Üç işçi, aralıklı istekler ve kapanışa kadar önbellek tekrar çağrıları azaltır. Binance HTTP 418/429 alınırsa tarama kısmi sonuçla durur ve uyarı gösterir. Scan düğmelerine art arda basmak yerine bir taramanın bitmesini bekleyin.
- Diğer scanner'ların ürettiği SELECT listeleri geçerli kalır, ancak grafik **açıldığı andaki piyasa verisiyle yeniden hesaplanır**, tarihsel SELECT anı sabit görüntüsü değildir.
- JavaScript Number (IEEE-754) kullanır; C# decimal hesaplamalarından çok küçük farklar olabilir. Eski BTCUSDT 6/6 eşleşmesi yeni zaman pencerelerine ve gerçek piyasa anına otomatik uygulanamaz. Canlı veriyle eşleşme testi gerekir.
- Sadece görselleştirme ve tarayıcı SELECT taraması yapılır; e-posta, emir, Watch veya Follow yoktur. Mevcut JS Watch/Follow kaynakları değiştirilmedi.
- Bağımsız Binance Futures REST uç noktalarına internet erişimi ve CORS gerekir; tarayıcı/veri sağlayıcı erişimi sınırlanırsa çizgiler hesaplanmaz.

## Yapılan kontroller

- Yeni JS modülleri `node --check`: geçti.
- index.html içindeki 11 çalıştırılabilir inline script `node --check`: geçti.
- FROZEN90 çekirdek sentetik veri testi: 3/3 strategy hesaplama ve giriş koşulu geçti, 3+3 pivotun kapanış onayı kontrol edildi.
- Tarayıcıyla gerçek görsel test bu ortamda Chromium navigasyon engeline takıldı (ERR_BLOCKED_BY_ADMINISTRATOR). Canlı Binance API testi yapılmadı; kullanıcı ortamında smoke test gerekir.
