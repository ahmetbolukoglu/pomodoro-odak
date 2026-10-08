# Pomodoro Odak

> 25 dakikalık çalışma ve 5 dakikalık mola döngülerini sayan, günlük odak istatistiği tutan sayaç uygulaması

## Features
- 25/5 dakikalık standart Pomodoro döngüleri ve özel süre ayarları
- Görev bazlı oturum kaydı ve takibi
- Günlük ve haftalık odak istatistikleri
- Sesli bildirimler ve uyarılar
- Serisi (streak) takibi ve başarı göstergeleri
- Karanlık ve açık tema desteği
- Veri kalıcılığı ve offline çalışabilme

## Data model
Saatlik oturum kayıtları (tarih, süre, görev, tür), günlük istatistikler (toplam süre, oturum sayısı, seri), görev kayıtları (ad, tamamlanma durumu)

## Screens
- Ana sayaç ekranı (geri sayım, durdur/çalıştır, görev seçimi)
- Görev yönetimi paneli (ekle/düzenle/sil)
- Günlük istatistikler ekranı (çalışma süresi, oturum sayısı)
- Haftalık istatistikler ekranı (haftalık seri, ortalama süre)
- Ayarlar paneli (süre ayarları, ses bildirimleri, tema)
- Seri takibi ekranı (günlük başarı, uzunluk)

## Core logic (`src/logic.js`)
| Function | Signature | Purpose |
|---|---|---|
| `createSession` | `({taskId, duration, type, date}) => Session` | Yeni bir oturum kaydı oluşturur |
| `createTask` | `({name, completed}) => Task` | Yeni bir görev oluşturur |
| `updateTask` | `(taskId, updates) => Task` | Bir görevin bilgilerini günceller |
| `calculateDailyStats` | `(sessions, date) => DailyStats` | Belirli bir gün için istatistikleri hesaplar |
| `calculateWeeklyStats` | `(sessions, startDate) => WeeklyStats` | Belirli bir hafta için istatistikleri hesaplar |
| `calculateStreak` | `(sessions) => number` | En uzun seri süresini hesaplar |
| `getSessionsForDate` | `(sessions, date) => Session[]` | Belirli bir tarih için oturumları filtreler |
| `getSessionsForTask` | `(sessions, taskId) => Session[]` | Belirli bir görev için oturumları filtreler |
| `formatDuration` | `(milliseconds) => string` | Milisaniyeyi dakika:saniye formatına çevirir |
| `validateSession` | `(session) => boolean` | Oturum verisinin geçerliliğini kontrol eder |
| `validateTask` | `(task) => boolean` | Görev verisinin geçerliliğini kontrol eder |
| `getNotificationSettings` | `(settings) => NotificationSettings` | Bildirim ayarlarını döndürür |

## Test plan
- [ ] Yeni bir oturum oluşturulduğunda doğru verilerle oluşturulması
- [ ] Görev adı boşken görev oluşturulamaması
- [ ] Görev güncellendiğinde doğru alanların güncellenmesi
- [ ] Günlük istatistiklerin doğru hesaplanması
- [ ] Haftalık istatistiklerin doğru hesaplanması
- [ ] Seri sayısı doğru şekilde hesaplanmalı
- [ ] Belirli bir tarih için oturum filtreleme işlevi doğru çalışmalı
- [ ] Belirli bir görev için oturum filtreleme işlevi doğru çalışmalı
- [ ] Süre formatlama işlevi doğru dakika:saniye formatında dönmeli
- [ ] Geçersiz oturum verisi için doğrulama işlevi false dönmeli
- [ ] Geçersiz görev verisi için doğrulama işlevi false dönmeli
- [ ] Bildirim ayarları doğru şekilde dönmeli
