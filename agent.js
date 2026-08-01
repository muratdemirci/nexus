const { io } = require('socket.io-client');
const os = require('os');
const si = require('systeminformation');
const { git, restart } = require('./utils');

function startAgent(hubUrl = 'http://localhost:5000', name = '', intervalMs = 2000, opts = {}) {
  const hostname = name || os.hostname();
  const repoDir = opts.repoDir || __dirname;

  const ip = (() => {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces) if (!i.internal && i.family === 'IPv4') return i.address;
    }
    return '';
  })();

  const socket = io(hubUrl, { query: { type: 'agent', hostname, platform: os.platform(), ip } });
  let timer = null;

  socket.on('connect', () => {
    console.log(`[Agent] Hub bağlantısı kuruldu: ${socket.id}`);
    timer = setInterval(async () => {
      try {
        const [cpu, mem, fs] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()]);
        const disk = (fs.find((d) => d.mount === 'C:' || d.mount === '/') || fs[0] || {});
        socket.emit('stats', {
          cpu: Math.round(cpu.currentLoad || 0),
          ram: Math.round((mem.active / mem.total) * 100),
          disk: Math.round(disk.use || 0),
          uptime: os.uptime(),
        });
      } catch (e) {}
    }, intervalMs);
  });

  socket.on('disconnect', () => { if (timer) clearInterval(timer); console.log('[Agent] bağlantı koptu, yeniden deneniyor...'); });

  // Hub -> all agents: pull + build + restart
  socket.on('update-command', async ({ branch }) => {
    try {
      socket.emit('update-status', { stage: 'start', msg: `fetch (${branch})...` });
      await git.fetch(repoDir);
      const cur = await git.commit(repoDir);
      const rem = await git.remote(repoDir, branch);
      if (!rem || cur === rem) { socket.emit('update-status', { stage: 'uptodate', msg: `zaten güncel (${cur})` }); return; }
      socket.emit('update-status', { stage: 'pull', msg: `${cur} -> ${rem}` });
      await git.pull(repoDir, branch);
      socket.emit('update-status', { stage: 'install', msg: 'npm install...' });
      await git.install(repoDir);
      socket.emit('update-status', { stage: 'restart', msg: 'yeniden başlatılıyor...' });
      restart(process.argv.slice(2));
    } catch (e) {
      socket.emit('update-status', { stage: 'error', msg: e.message });
    }
  });
}

module.exports = { startAgent };
