const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { git, restart } = require('./utils');
const { startBeacon, trackPeers, lanIP } = require('./discovery');
const { notify } = require('./notify');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function startHub(port = 8888, opts = {}) {
  const repoDir = opts.repoDir || __dirname;
  const branch = opts.updateBranch || 'main';
  const pollSec = opts.updateInterval || 60;
  const name = opts.name || os.hostname();
  const discover = opts.discover !== false;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const agents = new Map();
  // termId -> { browserSocketId, agentSocketId, hostname, start, log:[] }
  const terms = new Map();
  // opId -> { resolve, reject, timer }
  const pendingOps = new Map();
  // hostname -> { lastSeen, offlineNotified, timer, socketId }
  const deviceStates = new Map();
  // agentId -> [ {ts, command, cwd, code} ]
  const history = new Map();
  // agentId -> { cpu:bool, ram:bool, disk:bool }
  const alertState = new Map();

  let cfg = { ...loadConfig() };
  let info = { branch: null, commit: null, remote: null, update: false };
  let busy = false;

  function saveConfig(next) {
    cfg = { ...loadConfig(), ...next };
    try {
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 2));
    } catch {}
    const push = { whitelist: cfg.whitelist, thresholds: cfg.thresholds };
    io.emit('config-update', { ...cfg });
    io.emit('config-push', push);
    return cfg;
  }

  // ---------- Agent op relay (request/response over socket.io) ----------
  function callAgent(agentId, op, payload = {}, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const ag = io.sockets.sockets.get(agentId);
      if (!ag) return reject(new Error('agent çevrimdışı'));
      const opId = 'op' + Date.now() + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        pendingOps.delete(opId);
        reject(new Error('zaman aşımı'));
      }, timeout);
      pendingOps.set(opId, { resolve, reject, timer });
      ag.emit('op', { opId, op, payload });
    });
  }

  // ---------- Alerts (thresholds) ----------
  function checkAlerts(a, stats) {
    const t = cfg.thresholds || {};
    const st = alertState.get(a.id) || {};
    const check = (metric, value, limit) => {
      if (value == null || !limit) return;
      const fired = !!st[metric];
      if (value >= limit && !fired) {
        st[metric] = true;
        notify(cfg, [[metric.toUpperCase(), `${Math.round(value)}% (eşik %${limit})`], ['Cihaz', a.hostname]]);
        io.emit('alert', { agentId: a.id, hostname: a.hostname, metric, value, limit });
        console.log(`[Hub] UYARI ${a.hostname} ${metric}=${value}% >= %${limit}`);
      } else if (value < limit && fired) {
        st[metric] = false;
      }
    };
    check('cpu', stats.cpu, t.cpu);
    check('ram', stats.ram, t.ram);
    check('disk', stats.disk, t.disk);
    alertState.set(a.id, st);
  }

  // ---------- Static / REST ----------
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
  app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));

  // Upload must be handled BEFORE the global JSON parser (raw body of any type).
  app.post('/api/upload', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
    const agent = req.query.agent;
    const p = req.query.path;
    if (!agent || !p) return res.status(400).json({ error: 'agent/path eksik' });
    try {
      const data = req.body.toString('base64');
      const r = await callAgent(agent, 'fs-write', { path: p, data }, 120000);
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.use(express.json());

  app.post('/webhook', (req, res) => {
    if (req.body && req.body.ref === `refs/heads/${branch}`) broadcastUpdate();
    res.json({ ok: true });
  });
  app.get('/api/agents', (req, res) => res.json([...agents.values()]));
  app.get('/api/network', (req, res) => res.json(network.all));

  app.get('/api/hostinfo', (req, res) => {
    const ips = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces) if (!i.internal && i.family === 'IPv4') ips.push(i.address);
    }
    const host = cfg.qrHost || ips[0] || lanIP() || 'localhost';
    const ts = ips.find((ip) => ip.startsWith('100.')) || '';
    res.json({ host, url: `http://${host}:${port}`, lanIPs: ips, tailscaleIP: ts, hostname: os.hostname() });
  });

  app.get('/api/qr', async (req, res) => {
    const host = req.query.host || cfg.qrHost || lanIP() || 'localhost';
    const url = `http://${host}:${port}`;
    try {
      const png = await QRCode.toBuffer(url, {
        width: 340,
        margin: 1,
        color: { dark: '#0a0e14', light: '#ffffff' },
      });
      res.type('png').send(png);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Batch / single command run (also used for single-agent "run")
  app.post('/api/run', async (req, res) => {
    const body = req.body || {};
    const agentIds = Array.isArray(body.agentIds) && body.agentIds.length ? body.agentIds : [...agents.keys()];
    const command = String(body.command || '').trim();
    if (!command) return res.status(400).json({ error: 'komut boş' });
    const results = {};
    for (const id of agentIds) {
      const ag = io.sockets.sockets.get(id);
      if (!ag) { results[id] = { ok: false, error: 'çevrimdışı' }; continue; }
      try {
        const r = await callAgent(id, 'run', { command, cwd: body.cwd, timeout: body.timeout || 30000 }, (body.timeout || 30000) + 10000);
        results[id] = { ok: true, data: r };
        if (!history.has(id)) history.set(id, []);
        history.get(id).push({ ts: Date.now(), command, cwd: body.cwd || '', from: 'run', code: r.code });
        while (history.get(id).length > 200) history.get(id).shift();
      } catch (e) {
        results[id] = { ok: false, error: e.message };
      }
    }
    io.emit('history-update', historyDump());
    res.json(results);
  });

  app.get('/api/processes/:agentId', async (req, res) => {
    try { res.json(await callAgent(req.params.agentId, 'ps')); }
    catch (e) { res.status(404).json({ error: e.message }); }
  });

  app.post('/api/kill', async (req, res) => {
    const { agentId, pid } = req.body || {};
    if (!pid) return res.status(400).json({ error: 'pid eksik' });
    try { res.json(await callAgent(agentId, 'kill', { pid })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/fs', async (req, res) => {
    const agent = req.query.agent;
    const p = req.query.path || '';
    if (!agent) return res.status(400).json({ error: 'agent eksik' });
    try {
      const items = await callAgent(agent, 'fs-list', { path: p });
      res.json({ path: p, items });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/download', async (req, res) => {
    const { agent, path: p } = req.query;
    if (!agent || !p) return res.status(400).json({ error: 'agent/path eksik' });
    try {
      const f = await callAgent(agent, 'fs-read', { path: p }, 30000);
      const buf = Buffer.from(f.data, 'base64');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
      res.send(buf);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/restart/:agentId', async (req, res) => {
    try { res.json(await callAgent(req.params.agentId, 'restart')); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/history', (req, res) => res.json(historyDump()));
  app.get('/api/history/:agentId', (req, res) => res.json(history.get(req.params.agentId) || []));

  app.get('/api/logs', (req, res) => {
    res.json([...terms.entries()].map(([termId, ts]) => ({
      termId,
      hostname: ts.hostname,
      start: ts.start,
      chars: (ts.log || []).join('').length,
      open: !!io.sockets.sockets.get(ts.agentSocketId),
    })));
  });
  app.get('/api/logs/:termId', (req, res) => {
    const ts = terms.get(req.params.termId);
    if (!ts) return res.status(404).json({ error: 'oturum yok' });
    res.type('text/plain; charset=utf-8').send((ts.log || []).join(''));
  });

  app.get('/api/config', (req, res) => res.json({
    whitelist: cfg.whitelist,
    thresholds: cfg.thresholds,
    notify: cfg.notify,
    qrHost: cfg.qrHost,
    tailscale: cfg.tailscale,
  }));
  app.post('/api/config', (req, res) => {
    const body = req.body || {};
    if (body.whitelist !== undefined && !Array.isArray(body.whitelist)) return res.status(400).json({ error: 'whitelist dizi olmalı' });
    const next = saveConfig(body);
    console.log('[Hub] ayarlar güncellendi');
    res.json(next);
  });

  function historyDump() {
    return [...history.entries()].map(([id, list]) => ({ id, list }));
  }

  // ---------- LAN discovery ----------
  let network = { all: () => [] };
  let beacon = null;
  if (discover) {
    const peers = trackPeers(({ type, peer }) => {
      console.log(`[Net] ${type} ${peer.role}: ${peer.hostname} (${peer.src})`);
    });
    network = peers;
    beacon = startBeacon({ role: 'hub', name, port });
  }

  // ---------- Git auto-update ----------
  async function refresh(silent = false) {
    info.branch = (await git.branch(repoDir)) || info.branch;
    info.commit = (await git.commit(repoDir)) || info.commit;
    await git.fetch(repoDir);
    info.remote = (await git.remote(repoDir, branch)) || info.remote;
    info.update = !!(info.remote && info.commit && info.remote !== info.commit);
    io.emit('repo-info', info);
    if (!silent) console.log(info.update ? `[Hub] güncelleme var: ${info.commit} -> ${info.remote}` : `[Hub] güncel (${info.commit})`);
    return info.update;
  }

  async function broadcastUpdate() {
    if (busy) return;
    busy = true;
    const has = await refresh(true);
    io.emit('update-status', { from: 'Hub', stage: 'start', msg: has ? `Güncelleme (${info.commit} -> ${info.remote})` : 'Doğrulanıyor.' });
    io.emit('update-command', { branch, repoDir });
    if (has) {
      try {
        io.emit('update-status', { from: 'Hub', stage: 'pull', msg: 'Hub pull...' });
        await git.pull(repoDir, branch);
        io.emit('update-status', { from: 'Hub', stage: 'install', msg: 'Hub npm install...' });
        await git.install(repoDir);
        io.emit('update-status', { from: 'Hub', stage: 'restart', msg: 'Hub yeniden başlatılıyor...' });
        restart(process.argv.slice(2));
      } catch (e) {
        io.emit('update-status', { from: 'Hub', stage: 'error', msg: e.message });
        busy = false;
      }
    } else { busy = false; }
  }

  // ---------- Socket handling ----------
  io.on('connection', (socket) => {
    const t = socket.handshake.query.type;
    if (t === 'agent') {
      const q = socket.handshake.query;
      const a = {
        id: socket.id,
        hostname: q.hostname || '?',
        platform: q.platform || '?',
        ip: q.ip || '?',
        manufacturer: q.manufacturer || '',
        cpuModel: q.cpuModel || '',
        cpuCores: q.cpuCores || '',
        osDistro: q.osDistro || '',
        osArch: q.osArch || '',
        ramTotal: q.ramTotal || '',
        stats: {},
        status: 'online',
        lastSeen: Date.now()
      };
      agents.set(socket.id, a);
      console.log(`[Hub] Agent: ${a.hostname} (${a.ip})`);
      io.emit('agent-list', [...agents.values()]);

      // online status / reconnect detection
      const prev = deviceStates.get(a.hostname);
      if (prev) {
        if (prev.timer) clearTimeout(prev.timer);
        if (prev.offlineNotified) {
          prev.offlineNotified = false;
          notify(cfg, [['DURUM', 'ÇEVRİMİÇİ'], ['Cihaz', a.hostname]]);
          io.emit('alert', { agentId: a.id, hostname: a.hostname, metric: 'online', value: 0, limit: 0 });
        }
      }
      deviceStates.set(a.hostname, { lastSeen: Date.now(), offlineNotified: false, socketId: socket.id, timer: null });

      socket.on('stats', (s) => {
        a.stats = s; a.lastSeen = Date.now();
        io.emit('stats-update', { id: socket.id, stats: s });
        checkAlerts(a, s);
      });

      // Op results: resolve pending REST calls
      socket.on('op-result', ({ opId, ok, data, error }) => {
        const p = pendingOps.get(opId);
        if (!p) return;
        clearTimeout(p.timer);
        pendingOps.delete(opId);
        if (ok) p.resolve(data);
        else p.reject(new Error(error || 'op hatası'));
      });

      // Terminal relay: agent -> browser (+ session log capture)
      socket.on('term-output', ({ termId, data }) => {
        const ts = terms.get(termId);
        if (ts) {
          io.to(ts.browserSocketId).emit('term-output', { termId, data });
          ts.log = ts.log || [];
          ts.log.push(data);
          if (ts.log.join('').length > 2e6) ts.log.shift();
        }
      });
      socket.on('term-exit', ({ termId }) => {
        const ts = terms.get(termId);
        if (ts) { io.to(ts.browserSocketId).emit('term-exit', { termId }); }
      });

      socket.on('update-status', (st) => io.emit('update-status', { from: a.hostname, ...st }));
      socket.on('disconnect', () => {
        agents.delete(socket.id);
        io.emit('agent-list', [...agents.values()]);
        const st = deviceStates.get(a.hostname);
        if (st) {
          const offSec = (cfg.thresholds || {}).offline || 60;
          st.timer = setTimeout(() => {
            if (!st.offlineNotified) {
              st.offlineNotified = true;
              notify(cfg, [['DURUM', 'ÇEVRİMDIŞI'], ['Cihaz', a.hostname]]);
              io.emit('alert', { agentId: a.id, hostname: a.hostname, metric: 'offline', value: 100, limit: 100 });
              console.log(`[Hub] ÇEVRİMDIŞI: ${a.hostname}`);
            }
          }, offSec * 1000);
        }
      });

    } else {
      socket.emit('agent-list', [...agents.values()]);
      socket.emit('repo-info', info);
      socket.emit('config-update', { ...cfg });

      // Browser -> agent: open terminal on a device
      socket.on('init-term', ({ agentId, termId, cols, rows }) => {
        const agentSock = io.sockets.sockets.get(agentId);
        if (agentSock) {
          const ag = agents.get(agentId);
          terms.set(termId, {
            browserSocketId: socket.id,
            agentSocketId: agentId,
            hostname: ag ? ag.hostname : '?',
            start: Date.now(),
            log: [],
          });
          agentSock.emit('term-init', { termId, cols, rows });
        } else {
          socket.emit('term-output', { termId, data: '\r\n\x1b[31mAgent çevrimdışı.\x1b[0m\r\n' });
        }
      });

      socket.on('term-input', ({ termId, data }) => {
        const ts = terms.get(termId);
        if (ts && ts.browserSocketId === socket.id) {
          const ag = io.sockets.sockets.get(ts.agentSocketId);
          if (ag) ag.emit('term-input', { termId, data });
        }
      });

      socket.on('term-resize', ({ termId, cols, rows }) => {
        const ts = terms.get(termId);
        if (ts && ts.browserSocketId === socket.id) {
          const ag = io.sockets.sockets.get(ts.agentSocketId);
          if (ag) ag.emit('term-resize', { termId, cols, rows });
        }
      });

      socket.on('term-close', ({ termId }) => {
        const ts = terms.get(termId);
        if (ts && ts.browserSocketId === socket.id) {
          const ag = io.sockets.sockets.get(ts.agentSocketId);
          if (ag) ag.emit('term-close', { termId });
          terms.delete(termId);
        }
      });

      socket.on('disconnect', () => {
        for (const [termId, ts] of terms.entries()) {
          if (ts.browserSocketId === socket.id) {
            const ag = io.sockets.sockets.get(ts.agentSocketId);
            if (ag) ag.emit('term-close', { termId });
            terms.delete(termId);
          }
        }
      });
    }
  });

  setInterval(() => { if (!busy) refresh(true).then((u) => { if (u) broadcastUpdate(); }).catch(() => {}); }, pollSec * 1000);
  refresh();

  server.listen(port, '0.0.0.0', () => console.log(`[Hub] http://localhost:${port} | poll: ${pollSec}s | branch: ${branch}`));
}

module.exports = { startHub };