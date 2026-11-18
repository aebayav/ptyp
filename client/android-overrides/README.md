# Android Geçersiz Kılmaları (Native Overrides)

`client/android/` klasörü `.gitignore`'dadır (`npx cap add android` ile yerel olarak üretilir).
Bu klasördeki dosyalar, Android projesi yeniden üretildikten sonra elle kopyalanması gereken
izlenen referans kopyalardır.

## Ne zaman gerekli?

Saha GPS özellikleri (En Yakın Direk, mesafe doğrulaması, yanlış-direk uyarısı) APK'da
çalışsın istiyorsanız.

## Kurulum

`npm run mobile:init` çalıştırdıktan sonra (yani `npx cap add android` projeyi oluşturduktan sonra):

```bash
cp client/android-overrides/AndroidManifest.xml client/android/app/src/main/AndroidManifest.xml
cp client/android-overrides/MainActivity.java    client/android/app/src/main/java/app/turguz/ptyp/MainActivity.java
npx cap sync
```

## İçerik

| Dosya | Değişiklik |
|---|---|
| `AndroidManifest.xml` | `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` izinleri ve opsiyonel GPS feature tanımı |
| `MainActivity.java` | Android 6+ için açılışta çalışma zamanı konum izni isteme; reddedilirse uygulama GPS'siz devam eder |
