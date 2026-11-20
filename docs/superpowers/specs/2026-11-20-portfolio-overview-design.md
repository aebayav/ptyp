# Portföy Genel Bakış — Tasarım Belgesi

**Tarih:** 2026-11-20 · **Durum:** Onaylandı (konuşma üzerinden)

## Amaç ve Neden

Firmanın tüm projelerini tek ekranda gösteren üst seviye portföy görünümü. İş sahibi
hiçbir projenin detay sayfasına girmeden hangi projede ne durumda olduğunu ve uyarının
nerede biriktiğini görmeli.

**Neden:** Mevcut Genel Bakış (`/`) proje bağımsız global sayılardır (toplam malzeme,
teklif...); çok projeyle çalışırken "hangi proje nerede takıldı" sorusu cevapsız
kalıyor. Uyarılar bugün her modülün kendi sayfasında mahsur (İSG sertifikaları İSG'de,
geciken görevler İş Takibi'nde, izinsiz parseller Kamulaştırma'da) — portföy bunları tek
bakışta toplar.

## Hedefler

- Her proje için tek satırda:
  - ağırlıklı fiziki ilerleme (`SUM(progress×weight)/SUM(weight)`, `work_groups`)
  - saha ilerlemesi (mevcut aşama ağırlıklarıyla: kazı 15 → temel 30 → montaj 50 →
    aksesuar 70 → çekim 85 → tamam 100)
  - hakediş durumu: taslak / onayda / onaylı adetleri + toplam tutar
  - uyarı sayıları: geciken görev, izinsiz parsel, 30 gün içinde bitecek sertifika,
    açık saha malzeme talebi
- Satırlar uyarı sayısına göre sıralanır, eşitlikte ilerlemeye göre
- Hücreler ilgili sayfaya **o proje seçilmiş olarak** gider (localStorage'daki proje
  seçimi `useProjects` üzerinden ayarlanır)
- Yalnızca `owner` rolü erişebilir

## Hedef Olmayanlar (Non-goals)

- E-posta/bildirim gönderimi (ileri aşama adayı)
- "Aktif / Tamamlandı" proje etiketi — `projects` tablosunda durum sütunu yok,
  uydurulmayacak; ilerleme çubuğu + bitiş tarihi gösterilir
- Yeni veritabanı tablosu/kolonu — yalnız mevcut verinin agregasyonu
- Otomatik yenileme — elle "Yenile" düğmesi

## Yaklaşımlar

1. **(Seçilen)** Tek agregat endpoint + tek yeni sayfa: sunucuda `GROUP BY project_id`
   ile paralel SQL sorguları, tek ağ gidiş-dönüşü.
2. *(Reddedilen)* İstemcinin proje başına ayrı çağrı yapması — N ağ turu; mevcut
   `/api/overview` zaten proje bazlı veri döndürmüyor.
3. *(Reddedilen)* Genel Bakış'ı portföye dönüştürmek — satın alma özet kartlarını
   kaybettirir; ayrı sayfa var olanı korur.

## Verilen Kararlar

- `/portfoy` ayrı sayfa; Genel Bakış (`/`) owner'ın açılış sayfası olarak kalır.
  Kenar çubuğuna "Portföy" eklenir (`App.jsx` owner menüsü), Dashboard'a bağlantı kartı.
- Sıralama: toplam uyarı (azalan) → ilerleme (azanan). Sabit, kullanıcı sıralaması yok.
- Ağırlıklı ilerleme fallback'i: weight toplamı 0 olan projede `AVG(progress)`.
- Hakediş tutarı: `SUM(current_qty × unit_price)` (`progress_payment_items`), tüm
  durumlar üzerinden; adetler durum bazında ayrı.
- Uyarı tanımı: geciken görev (`late-filter.ts` koşulu, `tasks t JOIN work_groups w`)
  + izinsiz parsel + 30 gün sertifika + açık saha talebi.
- Sayfa `stat-card` / `table-wrap` mevcut stilleriyle kurulur; yeni CSS minimal.

## Yapımcıya Kalan

- SQL sorgularının kesin yazımı (indeks: tüm ilgili tablolarda `project_id` indeksi
  zaten var), boş-portföy ve tek-proje durumlarının görsel davranışı, hücre bağlantı
  hedefleri (ilerleme → `/is-takibi`, saha → `/saha`, hakediş → `/hakedisler`,
  uyarılar → ilgili modül sayfası).
