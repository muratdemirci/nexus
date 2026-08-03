# Nexus

Nexus, hub ve agent yapısına sahip bir cihaz yönetim ve uzaktan terminal sistemi. Ana sunucu (hub), bağlı cihazları listeler, durum bilgilerini gösterir ve terminal erişimi sağlar.

## Gereksinimler

- Node.js 18+
- npm
- Git

## Kurulum

Proje klasörüne gidin:

```bash
cd nexus
npm install
```

## Çalıştırma

### 0) Aynı yerel ağdaki birden çok bilgisayarı birbirine bağlama (LAN keşfi)

Nexus, aynı subnet üzerindeki bilgisayarları UDP broadcast ile otomatik keşfeder
(`discovery.js`, UDP port `8889`). Her makine hub beacon yayınlar, her agent
LAN'daki **tüm** hub'ları bulup **hepsine** bağlanır. Böylece her makinenin
arayüzü ağdaki diğer tüm cihazları görür ve aralarında terminal açılabilir.

Diğer makinelere yeni IP adresi girmeye gerek yoktur; sadece `npm start`
çalıştırın. Web arayüzündeki **"AĞDAKİ CİHAZLAR"** paneli keşfedilen cihazları listeler.

Tek makinede test için değişiklik yoktur — sadece kendinizi görürsünüz.

> **Güvenlik duvarı (Windows):** Keşif (`UDP 8889`) ve web arayüzü (`TCP 8888`)
> için gelen bağlantılara izin verin. Windows Güvenlik Duvarı'na `node` için
> özel kural ekleyin, ya da apache/modemde **AP/İstemci İzolasyonu** (AP isolation)
> kapalı olduğundan emin olun.

Keşfi kapatmak isterseniz `--no-discover` kullanın.

### 1) Hub çalıştırma

```bash
npm run hub
```

Bu mod, web arayüzünü ve hub servisini başlatır. Tarayıcıdan şu adrese gidin:

```text
http://localhost:8888
```

### 2) Agent çalıştırma

Aynı bilgisayarda yerel olarak test etmek için:

```bash
npm run agent
```

Bu komut, varsayılan olarak `http://localhost:8888` adresindeki hub'a bağlanır.

### 3) Aynı anda hub + agent çalıştırma

```bash
npm start
```

Bu komut hem hub hem de agent'ı aynı anda başlatır.

## Özel ayarlar

Hub ve agent için parametreler verilebilir:

```bash
node index.js --mode hub --port 8888
node index.js --mode agent --hub http://192.168.1.10:8888 --name RaspberryPi
```

Kullanılabilir seçenekler:

- `--mode` / `-m`: `hub`, `agent`, `both`
- `--port` / `-p`: hub portu
- `--hub` / `-H`: agent'ın bağlanacağı hub adresi
- `--name` / `-n`: agent adı
- `--interval` / `-i`: durum raporu aralığı (ms)
- `--no-discover`: LAN keşfini kapatır

## Notlar

- Varsayılan hub portu: `8888`
- Web arayüzü `public/` klasöründen sunulur
- Agent, sistem bilgilerini hub'a gönderir ve terminal açma/komut çalıştırma gibi işlevleri destekler

## Sorun giderme

Eğer bağlantı kurulamazsa:

1. Hub'un çalıştığından emin olun
2. Agent'ın `--hub` adresini kontrol edin
3. Port 8888 (TCP) ve 8889 (UDP) açık olduğundan emin olun
4. Gerekirse `npm install` komutunu yeniden çalıştırın
