const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { git, restart } = require('./utils');

function startHub(port = 5000, opts = {}) {
  const repoDir = opts.repoDir || __dirname;
  const branch = opts.updateBranch || 'main';
  const pollSec = opts.updateInterval || 60;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const agents = new Map();
  let info = { branch: null, commit: null, remote: null, update: false };
  let busy = false;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // GitHub webhook (optional). Push on watched branch -> broadcast update.
  app.post('/webhook', (req, res) => {
    if (req.body && req.body.ref === `refs/heads/${branch}`) broadcastUpdate();
    res.json({ ok: true });
  });

  app.get('/api/agents', (req, res) => res.json([...agents.values()]));

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
    io.emit('update-status', { from: 'Hub', stage: 'start', msg: has ? `Güncelleme başladı (${info.commit} -> ${info.remote})` : 'Cihazlar doğrulanıyor (zaten güncel).' });
    // 1. tell every agent to pull + build + restart
    io.emit('update-command', { branch, repoDir });
    // 2. update the hub itself
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
    } else {
      busy = false;
    }
  }

  io.on('connection', (socket) => {
    const t = socket.handshake.query.type;
    if (t === 'agent') {
      const q = socket.handshake.query;
      const a = { id: socket.id, hostname: q.hostname, platform: q.platform, ip: q.ip, stats: {}, status: 'online', lastSeen: Date.now() };
      agents.set(socket.id, a);
      console.log(`[Hub] Agent bağlandı: ${a.hostname} (${a.ip})`);
      io.emit('agent-list', [...agents.values()]);
      socket.on('stats', (s) => { a.stats = s; a.lastSeen = Date.now(); io.emit('stats-update', { id: socket.id, stats: s }); });
      socket.on('update-status', (st) => io.emit('update-status', { from: a.hostname, ...st }));
      socket.on('disconnect', () => { agents.delete(socket.id); io.emit('agent-list', [...agents.values()]); });
    } else {
      socket.emit('agent-list', [...agents.values()]);
      socket.emit('repo-info', info);
      socket.on('check-update', () => refresh());
      socket.on('trigger-update', () => broadcastUpdate());
    }
  });

  // Background poll: if a new commit landed on the remote, fan out the update.
  setInterval(() => { if (!busy) refresh(true).then((u) => { if (u) broadcastUpdate(); }).catch(() => {}); }, pollSec * 1000);
  refresh();

  server.listen(port, '0.0.0.0', () => console.log(`[Hub] http://localhost:${port} | poll: ${pollSec}s | branch: ${branch}`));
}

module.exports = { startHub };
