/**
 * NEXUS - Notification module (Telegram bot + Discord webhook).
 *
 * Pure Node (https), no external deps. Ships as fire-and-forget: never throws.
 *
 * Config shape (config.json -> notify):
 *   {
 *     "telegram": { "token": "...", "chatId": "..." },
 *     "discord":  { "webhook": "https://discord.com/api/webhooks/..." }
 *   }
 */
const https = require('https');
const http = require('http');

function postJson(url, body) {
  return new Promise((resolve) => {
    let client = https;
    let target = url;
    try {
      const u = new URL(url);
      client = u.protocol === 'http:' ? http : https;
      target = u.href;
    } catch {}
    const data = JSON.stringify(body);
    const req = client.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Nexus/1.0',
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => {
      try { req.destroy(); } catch {}
      resolve(false);
    });
    req.write(data);
    req.end();
  });
}

function escapeMd(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function title(fields) {
  // Rich embed friendly summary line
  return fields.map(([k, v]) => `${k}: ${v}`).join(' · ');
}

async function sendTelegram(config, fields, text) {
  if (!config || !config.token || !config.chatId) return false;
  const msg = text || title(fields);
  return postJson(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    chat_id: config.chatId,
    text: msg,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

async function sendDiscord(config, fields, text) {
  if (!config || !config.webhook) return false;
  const name = (fields && fields[0] && fields[0][1]) || 'Nexus';
  const content = text || title(fields).slice(0, 1990);
  const payload = {
    username: name,
    content,
  };
  if (fields && fields.length) {
    payload.embeds = [{
      color: 0x4cc9f0,
      description: fields.map(([k, v]) => `**${escapeMd(k)}** ${escapeMd(v)}`).join('\n').slice(0, 4000),
      timestamp: new Date().toISOString(),
    }];
  }
  return postJson(config.webhook, payload);
}

/**
 * Sends a message through every configured channel.
 * collect optional array of [ [k,v], ... ] fields and a preformatted text.
 */
async function notify(cfg, fields, text) {
  const results = [];
  const n = (cfg && cfg.notify) || {};
  if (n.telegram) results.push(await sendTelegram(n.telegram, fields, text));
  if (n.discord) results.push(await sendDiscord(n.discord, fields, text));
  return results.some(Boolean);
}

module.exports = { notify, sendTelegram, sendDiscord, postJson };