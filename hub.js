const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { git, restart } = require('./utils');

function startHub(port = 8888, opts = {}) {
  const repoDir = opts.repoDir || __dirname;
  const branch = opts.updateBranch || 'main';
  const pollSec = opts.updateInterval || 60;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const agents = new Map();
  // termId -> { browserSocketId, agentSocketId }
  const terms = new Map();
  let info = { branch: null, commit: null, remote: null, update: false };
  let busy = false;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
  app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));

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

      socket.on('stats', (s) => {
        a.stats = s; a.lastSeen = Date.now();
        io.emit('stats-update', { id: socket.id, stats: s });
      });

      // Terminal relay: agent -> browser
      socket.on('term-output', ({ termId, data }) => {
        const ts = terms.get(termId);
        if (ts) io.to(ts.browserSocketId).emit('term-output', { termId, data });
      });
      socket.on('term-exit', ({ termId }) => {
        const ts = terms.get(termId);
        if (ts) { io.to(ts.browserSocketId).emit('term-exit', { termId }); terms.delete(termId); }
      });

      socket.on('update-status', (st) => io.emit('update-status', { from: a.hostname, ...st }));
      socket.on('disconnect', () => {
        agents.delete(socket.id);
        io.emit('agent-list', [...agents.values()]);
      });

    } else {
      socket.emit('agent-list', [...agents.values()]);
      socket.emit('repo-info', info);

      // Browser -> agent: open terminal on a device
      socket.on('init-term', ({ agentId, termId, cols, rows }) => {
        const agentSock = io.sockets.sockets.get(agentId);
        if (agentSock) {
          terms.set(termId, { browserSocketId: socket.id, agentSocketId: agentId });
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
