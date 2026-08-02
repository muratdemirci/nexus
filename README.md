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

### 1) Hub çalıştırma

```bash
npm run hub
```

Bu mod, web arayüzünü ve hub servisini başlatır. Tarayıcıdan şu adrese gidin:

```text
http://localhost:5000
```

### 2) Agent çalıştırma

Aynı bilgisayarda yerel olarak test etmek için:

```bash
npm run agent
```

Bu komut, varsayılan olarak `http://localhost:5000` adresindeki hub'a bağlanır.

### 3) Aynı anda hub + agent çalıştırma

```bash
npm start
```

Bu komut hem hub hem de agent'ı aynı anda başlatır.

## Özel ayarlar

Hub ve agent için parametreler verilebilir:

```bash
node index.js --mode hub --port 5000
node index.js --mode agent --hub http://192.168.1.10:5000 --name RaspberryPi
```

Kullanılabilir seçenekler:

- `--mode` / `-m`: `hub`, `agent`, `both`
- `--port` / `-p`: hub portu
- `--hub` / `-H`: agent'ın bağlanacağı hub adresi
- `--name` / `-n`: agent adı
- `--interval` / `-i`: durum raporu aralığı (ms)

## Notlar

- Varsayılan hub portu: `5000`
- Web arayüzü `public/` klasöründen sunulur
- Agent, sistem bilgilerini hub'a gönderir ve terminal açma/komut çalıştırma gibi işlevleri destekler

## Sorun giderme

Eğer bağlantı kurulamazsa:

1. Hub'un çalıştığından emin olun
2. Agent'ın `--hub` adresini kontrol edin
3. Port 5000'in açık olduğundan emin olun
4. Gerekirse `npm install` komutunu yeniden çalıştırın
