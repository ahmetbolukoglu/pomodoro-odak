# Pomodoro Odak

> 25 dakikalık çalışma ve 5 dakikalık mola döngülerini sayan, günlük odak istatistiği tutan sayaç.

## Features
- 25/5 dakikalık standart Pomodoro döngüleri
- Özel süre ayarlaması ile özelleştirilmiş döngüler
- Görev bazlı oturum kaydı ve takibi
- Günlük ve haftalık odak istatistikleri
- Sesli bildirimler ile döngü sonu uyarıları
- Seri (streak) takibi ile motivasyonu artırma

## Data model
Saatlik kayıtlar (session) ve görev kayıtları (task) tutulur. Her session 3 alan içerir: startTime, endTime, taskId. Her task 2 alan içerir: name, color. Günlük istatistikler (dailyStats) her gün için çalışılan toplam süre ve tamamlanan döngü sayısı bilgilerini içerir.

## Screens
- Ana sayaç ekranı (döngü sayacı, kontrol butonları)
- Görev yönetimi paneli (ekle/düzenle/sil)
- Günlük istatistik tablosu
- Haftalık istatistik grafikleri
- Ayarlar paneli (süre ayarları, ses bildirimleri, tema)
- Seri (streak) takibi paneli

## Core logic (`src/logic.js`)
| Function | Signature | Purpose |
|---|---|---|
| `createSession` | `({startTime, endTime, taskId}) => session` | Yeni bir çalışma oturumu oluşturur |
| `createTask` | `({name, color}) => task` | Yeni bir görev oluşturur |
| `updateTask` | `({id, name, color}) => task` | Bir görevi günceller |
| `deleteTask` | `({id}) => boolean` | Bir görevi siler |
| `calculateDailyStats` | `({sessions, date}) => dailyStats` | Belirli bir gün için istatistikleri hesaplar |
| `calculateWeeklyStats` | `({sessions, startDate}) => weeklyStats` | Belirli bir hafta için istatistikleri hesaplar |
| `calculateStreak` | `({dailyStats}) => streak` | Günlük çalışılan gün sayısını hesaplar |
| `getSessionsForDate` | `({sessions, date}) => sessions` | Belirli bir tarih için oturumları filtreler |
| `getSessionsForTask` | `({sessions, taskId}) => sessions` | Belirli bir görev için oturumları filtreler |
| `formatTime` | `({seconds}) => string` | Saniyeyi dakika:saniye formatına çevirir |
| `validateSession` | `({startTime, endTime}) => boolean` | Oturumun geçerliliğini kontrol eder |
| `getTaskById` | `({tasks, id}) => task` | ID'ye göre görev bulur |

## Test plan
- [ ] Yeni bir oturum oluşturulduğunda doğru alanlar doldurulur
- [ ] Geçersiz zaman aralıklarında oturum oluşturulamaz
- [ ] Görev silindiğinde ilişkili oturumlar da silinir
- [ ] Günlük istatistikler doğru şekilde hesaplanır
- [ ] Haftalık istatistikler doğru zaman dilimlerinde filtrelenir
- [ ] Seri (streak) hesaplaması連續 günler için doğru çalışır
- [ ] Sesli bildirimler belirtilen zamanlarda çalar
- [ ] Görev adı ve rengi güncellenebilir
- [ ] 25/5 döngü süresi doğru şekilde uygulanır
- [ ] Özel süre ayarlaması doğru şekilde işlenir
- [ ] Tüm veriler localStorage'da doğru şekilde saklanır
- [ ] Karanlık ve açık tema modları doğru şekilde işlenir
