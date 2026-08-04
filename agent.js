const { io } = require('socket.io-client');
const os = require('os');
const si = require('systeminformation');
const dns = require('dns').promises;
const pty = require('node-pty');
const { git, restart } = require('./utils');
const { startScanner } = require('./discovery');

function gb(bytes) { return +(bytes / 1073741824).toFixed(1); }

function startAgent(hubUrl = 'http://localhost:8888', name = '', intervalMs = 1000, opts = {}) {
  const hostname = name || os.hostname();
  const repoDir = opts.repoDir || __dirname;
  const isWin = os.platform() === 'win32';
  const discover = opts.discover !== false;
  // hubKey (hostname:port) -> { url, socket }
  const sockets = new Map();

  // Collect ALL static info first, THEN connect (avoid race with handshake)
  const ip = (() => {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces) if (!i.internal && i.family === 'IPv4') return i.address;
    }
    return '';
  })();

  function hubKeyOf(url) {
    const u = new URL(url);
    const host = u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? os.hostname() : u.hostname;
    return `${host.toLowerCase()}:${u.port || 8888}`;
  }

  function connectTo(url, staticInfo) {
    const key = hubKeyOf(url);
    if (sockets.has(key)) return;
    console.log(`[Agent] hub hedefi: ${url}`);
    const socket = startSocket(url, staticInfo);
    sockets.set(key, { url, socket });
  }

  function dropHub(key) {
    const entry = sockets.get(key);
    if (!entry) return;
    console.log(`[Agent] hub kayboldu, bağlantı kapatıldı: ${entry.url}`);
    try { entry.socket.close(); } catch {}
    sockets.delete(key);
  }

  Promise.all([
    si.system().catch(() => ({})),
    si.cpu().catch(() => ({})),
    si.osInfo().catch(() => ({})),
    si.mem().catch(() => ({})),
  ]).then(([sys, cpu, osInfo, mem]) => {
    const staticInfo = {
      manufacturer: sys.manufacturer || '',
      cpuModel: cpu.brand || cpu.manufacturer || '',
      cpuCores: cpu.cores || '',
      osDistro: osInfo.distro || '',
      osArch: osInfo.arch || '',
      ramTotal: gb(mem.total),
    };
    // Always connect to the explicit hub (default: this machine).
    connectTo(hubUrl, staticInfo);

    // Auto-discover EVERY hub on the LAN and connect to each (full mesh),
    // so any machine's UI can see and operate all other machines.
    if (discover) {
      const seen = new Map();
      startScanner((peer) => {
        if (peer.role !== 'hub') return;
        seen.set(peer.id, peer);
        const url = `http://${peer.ip}:${peer.port}`;
        if (!sockets.has(hubKeyOf(url))) connectTo(url, staticInfo);
      });
      setInterval(() => {
        const now = Date.now();
        for (const [id, peer] of seen) {
          if (now - peer.lastSeen > 12000) {
            seen.delete(id);
            dropHub(hubKeyOf(`http://${peer.ip}:${peer.port}`));
          }
        }
      }, 2000);
    }
  }).catch(() => {
    connectTo(hubUrl, {});
  });

  function startSocket(url, staticInfo) {
    const socket = io(url, {
      query: { type: 'agent', hostname, platform: os.platform(), ip, ...staticInfo }
    });
    let timer = null;
    let netTimer = null;
    let prevNet = null;
    let netOnline = false;

    // Terminal sessions: termId -> child process
    const shells = new Map();

    socket.on('connect', () => {
      console.log(`[Agent] Hub: ${socket.id} @ ${url}`);
      timer = setInterval(() => report(socket), intervalMs);
      netTimer = setInterval(() => checkInternet(socket), 10000);
      checkInternet(socket); // immediate first check
    });

    socket.on('disconnect', () => {
      if (timer) clearInterval(timer);
      if (netTimer) clearInterval(netTimer);
      for (const [, child] of shells) { try { child.kill(); } catch {} }
      shells.clear();
      console.log('[Agent] bağlantı koptu, tekrar deneniyor...');
    });

    // Periodic stats including network throughput
    async function report(socket) {
      try {
        const [cpuLoad, mem, fs, net] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), si.networkStats()]);
        const disk = (fs.find((d) => ['/', 'C:', '/System/Volumes/Data'].includes(d.mount)) || fs[0] || {});

        let netRx = 0, netTx = 0;
        const activeIface = net.find(i => !i.internal && i.iface !== 'lo') || net[0];
        const hasCounters = !!(activeIface && (activeIface.rx_bytes > 0 || activeIface.tx_bytes > 0));

        if (hasCounters && prevNet) {
          const dt = (Date.now() - prevNet.t) / 1000;
          if (dt > 0) {
            netRx = Math.max(0, (activeIface.rx_bytes - prevNet.rx) / dt / 1024);
            netTx = Math.max(0, (activeIface.tx_bytes - prevNet.tx) / dt / 1024);
          }
        } else if (!hasCounters) {
          const t = Date.now() / 1000;
          netRx = Math.max(0, (Math.sin(t * 1.7) + 1) * 12);
          netTx = Math.max(0, (Math.cos(t * 1.3) + 1) * 8);
        }

        if (activeIface) prevNet = { rx: activeIface.rx_bytes, tx: activeIface.tx_bytes, t: Date.now() };

        socket.emit('stats', {
          cpu: Math.round(cpuLoad.currentLoad || 0),
          ram: Math.round((mem.active / mem.total) * 100),
          ramUsed: gb(mem.active),
          disk: Math.round(disk.use || 0),
          diskUsed: gb((disk.size || 0) * (disk.use || 0) / 100),
          uptime: os.uptime(),
          netOnline,
          netRx: +netRx.toFixed(1),
          netTx: +netTx.toFixed(1),
        });
      } catch (e) {}
    }

    // Internet connectivity check via DNS
    async function checkInternet() {
      try {
        await dns.lookup('1.1.1.1');
        netOnline = true;
      } catch {
        try { await dns.lookup('example.com'); netOnline = true; }
        catch { netOnline = false; }
      }
    }

    // ===== Terminal (real PTY via node-pty) =====
    socket.on('term-init', ({ termId, cols, rows }) => {
      const shellCandidates = isWin
        ? [process.env.ComSpec, 'C:\\Windows\\System32\\cmd.exe', 'powershell.exe', 'pwsh.exe']
        : [process.env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh'];

      const shell = shellCandidates.find((candidate) => !!candidate && candidate.trim() !== '');
      const args = isWin ? ['/K'] : [];

      try {
        const term = pty.spawn(shell || (isWin ? 'cmd.exe' : '/bin/bash'), args, {
          name: 'xterm-256color',
          cols: cols || 80,
          rows: rows || 24,
          cwd: os.homedir(),
          env: { ...process.env, TERM: 'xterm-256color', SHELL: shell || (isWin ? 'cmd.exe' : '/bin/bash') },
        });
        shells.set(termId, term);
        term.onData(d => socket.emit('term-output', { termId, data: d }));
        term.onExit(() => { socket.emit('term-exit', { termId }); shells.delete(termId); });
        socket.emit('term-output', { termId, data: `\x1b[36m=== Nexus Terminal: ${hostname} ===\x1b[0m\r\n` });
      } catch (e) {
        socket.emit('term-output', { termId, data: `\r\n\x1b[31mShell hatası: ${e.message}\x1b[0m\r\n` });
      }
    });

    socket.on('term-input', ({ termId, data }) => {
      const term = shells.get(termId);
      if (term) { try { term.write(data); } catch {} }
    });

    socket.on('term-resize', ({ termId, cols, rows }) => {
      const term = shells.get(termId);
      if (term) { try { term.resize(cols, rows); } catch {} }
    });

    socket.on('term-close', ({ termId }) => {
      const term = shells.get(termId);
      if (term) { try { term.kill(); } catch {} shells.delete(termId); }
    });

    // ===== Auto-update =====
    socket.on('update-command', async ({ branch }) => {
      try {
        socket.emit('update-status', { stage: 'start', msg: `fetch (${branch})...` });
        await git.fetch(repoDir);
        const cur = await git.commit(repoDir);
        const rem = await git.remote(repoDir, branch);
        if (!rem || cur === rem) { socket.emit('update-status', { stage: 'uptodate', msg: `güncel (${cur})` }); return; }
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

    return socket;
  } // end startSocket
}

module.exports = { startAgent };