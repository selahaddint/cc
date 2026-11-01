# FROZEN90 Grafik Gösterimi Düzeltmesi

Bu sürüm yalnızca mevcut tarayıcı grafiğinin yorumlama/gösterim katmanını düzeltir. C# kodu, FROZEN HH/LH formülleri, SELECT kuralları ve Watch/Follow değişmez.

- Altı FROZEN fiyat yeniden hesaplanmaz veya birbirine göre yeniden sıralanmaz.
- SELL1..SELL4 fiyatları BUY1 üzerinde değilse ham FROZEN değer olarak seviyeler tablosunda kalır ama geçerli üst direnç olarak sarı yatay çizgiye dönüştürülmez.
- SELL değeri BUY2-BUY1 aralığındaysa `BUY bölgesi içinde · direnç değil`, BUY2 altındaysa `BUY2 altında · direnç değil` gösterilir.
- BUY1 üstünde SELL yoksa açık uyarı gösterilir.
- SELECT satırı bir FROZEN Scan tarafından geldiyse açılış sekmesi ilgili stratejiye ayarlanır; butonlar diğerlerini bağımsız karşılaştırır.
- Eski SELECT kaynakları için önceki elle seçili sekme davranışı korunur.

Bu, kaynak formüllerin hatalı olduğunun veya SELL fiyatlarının yanlış hesaplandığının ispatı değildir: FROZEN seçme kuralları SELL > BUY1 sıralamasını garanti etmez. Görsel yatırım hedefiyle ham formül sonucunu ayrı tutar.

Not: Tarayıcıdaki SELECT filtreleri ve C# stratejilerinin emir/stop mantığı değiştirilmemiştir. SELL hedefi BUY bölgesi içinde kalan bir SELECT yine üretilebilir; işlem kriterlerinin değiştirilmesi ayrıca değerlendirilmelidir.
