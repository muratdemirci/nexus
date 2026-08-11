# Nexus

Nexus, hub ve agent yapısına sahip bir cihaz yönetim ve uzaktan terminal sistemidir. Ana sunucu (hub), bağlı cihazları listeler, durum bilgilerini gösterir; terminal erişimi, dosya gezgini, proses yönetimi, toplu komut, alarm bildirimi ve otomatik güncelleme sağlar.

## Özellikler

- **Gerçek zamanlı izleme** — CPU, RAM, disk, ağ, çalışma süresi (her agent `systeminformation` ile)
- **Uzaktan terminal** — her cihazda gerçek PTY (`node-pty`); oturum kaydı tutulur
- **Dosya gezgini** — klasör gezme, dosya yükleme/indirme
- **Proses yöneticisi** — canlı liste + kill
- **Toplu komut** — seçilen/ağdaki tüm cihazlarda aynı anda komut çalıştırma
- **Komut whitelist** — `config.json` ile izin verilen komutlar dışındakiler engellenir
- **Alarm / eşik bildirimleri** — CPU/RAM/disk eşikleri + çevrimdışı algılama (Telegram + Discord)
- **Mobil erişim** — PWA + QR kod
- **Servis kurulumu** — systemd / launchd / Windows başlangıç (tek komut)
- **Tek komut kurulum** — `install.sh` / `install.ps1`
- **Otomatik güncelleme** — git push ile hub + tüm agent'lar güncellenir
- **LAN keşif** — aynı subnet'teki tüm hub/agent'ları otomatik bulur (UDP 8889)

## Gereksinimler

- Node.js 18+ (18.20 veya 20+ önerilir)
- npm
- Git

## Tek Komutla Kurulum

**Linux / macOS:**

```bash
curl -sSL https://raw.githubusercontent.com/muratdemirci/nexus/main/install.sh | bash
```

**Windows (yönetici PowerShell):**

```powershell
Invoke-Expression (Invoke-RestMethod https://raw.githubusercontent.com/muratdemirci/nexus/main/install.ps1)
```

Kurulum scriptleri: node/npm/git kontrolü, repoyu klonlar, bağımlılıkları kurar ve (istenirse) sisteme servis olarak kaydeder.

## Manüel Kurulum

```bash
cd nexus
npm install
npm run gen-icons   # PWA ikonları (ilk kurulumda)
```

## Çalıştırma

### Aynı yerel ağdaki birden çok bilgisayarı bağlama (LAN keşfi)

Nexus, aynı subnet üzerindeki bilgisayarları UDP broadcast ile otomatik keşfeder
(`discovery.js`, UDP port `8889`). Her makine hub beacon yayınlar, her agent
LAN'daki **tüm** hub'ları bulup **hepsine** bağlanır. Yeni IP girmeye gerek
yoktur; sadece `npm start` çalıştırın. Arayüzdeki **"AĞDAKİ CİHAZLAR"** paneli
keşfedilen cihazları listeler.

> **Güvenlik duvarı (Windows):** Keşif (`UDP 8889`) ve web arayüzü (`TCP 8888`)
> için gelen bağlantılara izin verin. `npm run install:service` firewall
> kurallarını da eklemeye çalışır; yetki yoksa aşağıdakileri elle çalıştırın:
>
> ```bat
> netsh advfirewall firewall add rule name="Nexus Hub 8888" dir=in action=allow protocol=TCP localport=8888
> netsh advfirewall firewall add rule name="Nexus Discovery 8889" dir=in action=allow protocol=UDP localport=8889
> ```

### Hub (web arayüzü)

```bash
npm run hub        # veya: node index.js --mode hub
# http://localhost:8888
```

### Agent

```bash
npm run agent      # veya: node index.js --mode agent --hub http://localhost:8888
```

### Hub + Agent birlikte

```bash
npm start
```

### Servis olarak kurma / kaldırma

- Linux : `npm run install:service` (sudo ile) → systemd `nexus` servisi
- macOS : `npm run install:service` → launchd `com.nexus` agent'ı
- Windows: `npm run install:service` → başlangıç klasörüne kısayol

Her üç platformda da kaldırma için: `npm run uninstall:service`

## Özel ayarlar (`config.json`)

```jsonc
{
  // Komut whitelist: Boş = her şey serbest. Dolu = sadece bu öneklerle
  // başlayan komutlar (toplu komut özelliğinde) çalıştırılabilir.
  "whitelist": ["ls", "df", "ps", "free", "uptime", "ping", "ipconfig"],
  "thresholds": {
    "cpu": 90,        // CPU % eşiği (aşılınca alarm)
    "ram": 90,        // RAM %
    "disk": 90,       // Disk %
    "offline": 60     // çevrimdışı sayılmadan önce geçen saniye
  },
  "notify": {
    "telegram": { "token": "", "chatId": "" },
    "discord":  { "webhook": "" }
  },
  "qrHost": "",       // QR/mobil erişim adresi (opsiyonel; boşsa LAN IP kullanılır)
  "tailscale": true   // tailscale IP'sini arayüzde göster
}
```

Ayar eşikleri ve bildirimleri arayüzden de değiştirilebilir (**⚙ Ayarlar** butonu, `POST /api/config`).

## CLI seçenekleri

```bash
node index.js --mode hub --port 8888
node index.js --mode agent --hub http://192.168.1.10:8888 --name RaspberryPi
node index.js --install      # servis olarak kur
node index.js --uninstall    # servisi kaldır
node index.js --no-discover  # LAN keşfi kapalı
node index.js --no-firewall  # firewall işlemini atla
```

Tüm seçenekler: `--mode/-m`, `--port/-p`, `--hub/-H`, `--name/-n`,
`--interval/-i`, `--repo/-r`, `--update-branch/-b`, `--update-interval`,
`--no-discover`, `--no-firewall`, `--install`, `--uninstall`.

## REST API (otorize olmadan aynı LAN'da — dikkat: herkes kullanabilir)

| Yöntem | Yol | Açıklama |
| --- | --- | --- |
| GET | `/api/agents` | bağlı agent listesi |
| GET | `/api/network` | keşfedilen ağ cihazları |
| POST | `/api/run` | `{agentIds[], command, cwd, timeout}` → toplu komut |
| GET | `/api/processes/:agentId` | proses listesi |
| POST | `/api/kill` | `{agentId, pid}` |
| GET | `/api/fs?agent=&path=` | dizin listesi |
| GET | `/api/download?agent=&path=` | dosya indir |
| POST | `/api/upload?agent=&path=` | dosya yükle (raw body) |
| POST | `/api/restart/:agentId` | agent'ı yeniden başlat |
| GET | `/api/history` | komut geçmişi |
| GET | `/api/logs` / `/api/logs/:termId` | terminal oturum kayıtları |
| GET | `/api/qr?host=` | mobil erişim QR (PNG) |
| GET | `/api/hostinfo` | LAN/tailscale adresleri |
| GET/POST | `/api/config` | ayarları oku/güncelle |

## Güvenlik notu

Bu sürüm kimlik doğrulama / TLS içermez; yalnızca güvenilir, aynı LAN'daki
ağlar ve tailscale benzeri VPN'ler için tasarlanmıştır. Komut whitelist'ini
doldurmak, güvenilen ağların dışında en azından kötüye kullanım yüzeyini
daraltır. İnternete açmadan önce mutlaka reverse proxy + kimlik doğrulama.

## Sorun giderme

1. Hub'un çalıştığından emin olun
2. Agent'ın `--hub` adresini kontrol edin
3. Port 8888 (TCP) ve 8889 (UDP) açık olduğundan emin olun
4. Gerekirse `npm install` ve `npm run gen-icons`'ı tekrar çalıştırın
5. macOS terminalinde `posix_spawnp failed` görürseniz `npm install`'ı tekrar
   çalıştırın (agent başlangıçta native binary izinlerini kendisi de onarır)