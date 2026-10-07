# Pomodoro Odak

> 25 dakikalık çalışma ve 5 dakikalık mola döngülerini sayan, günlük odak istatistiği tutan sayaç uygulaması

## Features
- 25/5 dakikalık standart Pomodoro döngüsü ve özel süre ayarları
- Görev bazlı oturum kaydı ve takibi
- Günlük ve haftalık odak istatistikleri
- Sesli bildirimler ve uyarılar
- Seri (streak) takibi ve başarı göstergeleri
- Veri senkronizasyonu ve yerel depolama
- Karanlık/ışık modu desteği

## Data model
Oturum kayıtları (session): id, taskId, startTime, endTime, duration, type (work/break), completed. Görev kayıtları (task): id, name, description, createdAt. İstatistik kayıtları (stats): date, workMinutes, breakMinutes, sessionsCompleted, streakDays.

## Screens
- Ana sayaç ekranı (çalışma/mola durumu)
- Görev yönetimi paneli
- Günlük ve haftalık istatistikler
- Ayarlar ve süre yapılandırması
- Sesli bildirim ayarları
- Seri (streak) takibi ve başarı ekranı

## Core logic (`src/logic.js`)
| Function | Signature | Purpose |
|---|---|---|
| `createSession` | `(sessions, task, startTime, type) => updatedSessions` | Yeni bir oturum kaydı oluşturur |
| `completeSession` | `(sessions, sessionId, endTime) => updatedSessions` | Bir oturumu tamamlar ve bitiş zamanını kaydeder |
| `calculateDailyStats` | `(sessions, date) => stats` | Belirli bir gün için odak istatistiklerini hesaplar |
| `calculateWeeklyStats` | `(sessions, startDate) => stats` | Belirli bir hafta için odak istatistiklerini hesaplar |
| `calculateStreak` | `(sessions) => streakDays` | En uzun ardışık gün sayısını hesaplar |
| `validateDuration` | `(minutes) => isValid` | Süre değerinin geçerli olup olmadığını kontrol eder |
| `formatTime` | `(seconds) => formattedTime` | Saniye cinsinden süreyi dakika:saniye formatına çevirir |
| `getActiveSession` | `(sessions) => activeSession` | Aktif oturumu döndürür |
| `getSessionsByTask` | `(sessions, taskId) => taskSessions` | Belirli bir görevle ilişkili tüm oturumları döndürür |
| `getSessionsByDate` | `(sessions, date) => dateSessions` | Belirli bir tarih için oturumları döndürür |
| `calculateTotalWorkTime` | `(sessions) => totalMinutes` | Tüm oturumların toplam çalışma süresini hesaplar |
| `generateNotification` | `(type, timeRemaining) => notification` | Bildirim metni üretir (work/break bitim) |

## Test plan
- [ ] Yeni bir oturum oluşturulduğunda doğru alanlarla oluşturulması
- [ ] Bir oturumun tamamlanmasının doğru şekilde işaretlenmesi
- [ ] Günlük istatistiklerin doğru hesaplanması
- [ ] Haftalık istatistiklerin doğru hesaplanması
- [ ] Seri (streak) sayısının doğru hesaplanması
- [ ] Geçersiz süre değerlerinin doğru validate edilmesi
- [ ] Saniye cinsinden sürenin doğru formatlanması
- [ ] Aktif oturumun doğru bulunması
- [ ] Görev bazlı oturumların doğru filtrelenmesi
- [ ] Tarih bazlı oturumların doğru filtrelenmesi
- [ ] Toplam çalışma süresinin doğru hesaplanması
- [ ] Bildirim metninin doğru üretimi
