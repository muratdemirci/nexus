const { io } = require('socket.io-client');
const os = require('os');
const si = require('systeminformation');
const dns = require('dns').promises;
const { spawn } = require('child_process');
const { git, restart } = require('./utils');

function gb(bytes) { return +(bytes / 1073741824).toFixed(1); }

function startAgent(hubUrl = 'http://localhost:5000', name = '', intervalMs = 2000, opts = {}) {
  const hostname = name || os.hostname();
  const repoDir = opts.repoDir || __dirname;
  const isWin = os.platform() === 'win32';

  // Collect ALL static info first, THEN connect (avoid race with handshake)
  const ip = (() => {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces) if (!i.internal && i.family === 'IPv4') return i.address;
    }
    return '';
  })();

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
    startSocket(staticInfo);
  }).catch(() => startSocket({}));

  function startSocket(staticInfo) {
  const socket = io(hubUrl, {
    query: { type: 'agent', hostname, platform: os.platform(), ip, ...staticInfo }
  });
  let timer = null;
  let netTimer = null;
  let prevNet = null;
  let netOnline = false;

  // Terminal sessions: termId -> child process
  const shells = new Map();

  socket.on('connect', () => {
    console.log(`[Agent] Hub: ${socket.id}`);
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

        // Network speed: compare with previous measurement
        let netRx = 0, netTx = 0;
        const activeIface = net.find(i => !i.internal && i.iface !== 'lo') || net[0];
        if (activeIface && prevNet) {
          const dt = (Date.now() - prevNet.t) / 1000;
          if (dt > 0) {
            netRx = Math.max(0, (activeIface.rx_bytes - prevNet.rx) / dt / 1024);
            netTx = Math.max(0, (activeIface.tx_bytes - prevNet.tx) / dt / 1024);
          }
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

    // ===== Terminal =====
    socket.on('term-init', ({ termId, cols, rows }) => {
      const shell = isWin ? 'powershell.exe' : '/bin/bash';
      const args = isWin ? ['-NoLogo'] : ['-i'];
      try {
        const child = spawn(shell, args, {
          env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols || 80), LINES: String(rows || 24) },
          cwd: os.homedir(),
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        shells.set(termId, child);
        child.stdout.on('data', d => socket.emit('term-output', { termId, data: d }));
        child.stderr.on('data', d => socket.emit('term-output', { termId, data: d }));
        child.on('exit', () => { socket.emit('term-exit', { termId }); shells.delete(termId); });
        child.on('error', (e) => socket.emit('term-output', { termId, data: `\r\n\x1b[31m${e.message}\x1b[0m\r\n` }));
      } catch (e) {
        socket.emit('term-output', { termId, data: `\r\n\x1b[31mShell hatası: ${e.message}\x1b[0m\r\n` });
      }
    });

    socket.on('term-input', ({ termId, data }) => {
      const child = shells.get(termId);
      if (child) { try { child.stdin.write(data); } catch {} }
    });

    socket.on('term-resize', ({ termId, cols, rows }) => {
      // best-effort; no PTY so resize is advisory
    });

    socket.on('term-close', ({ termId }) => {
      const child = shells.get(termId);
      if (child) { try { child.kill(); } catch {} shells.delete(termId); }
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
  } // end startSocket
}

module.exports = { startAgent };
