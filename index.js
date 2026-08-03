/**
 * NEXUS - Hub + Agent entry. Modes: both (default) | hub | agent
 */
const os = require('os');
const path = require('path');

function parseArgs() {
  const a = process.argv.slice(2);
  const p = { mode: 'both', port: 8888, hub: 'http://localhost:8888', name: os.hostname(), interval: 1000, repoDir: path.resolve(__dirname), updateBranch: 'main', updateInterval: 60, discover: true, firewall: true };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '--mode': case '-m': p.mode = a[++i]; break;
      case '--port': case '-p': p.port = parseInt(a[++i], 10); break;
      case '--hub': case '-H': p.hub = a[++i]; break;
      case '--name': case '-n': p.name = a[++i]; break;
      case '--interval': case '-i': p.interval = parseInt(a[++i], 10); break;
      case '--repo': case '-r': p.repoDir = a[++i]; break;
      case '--update-branch': case '-b': p.updateBranch = a[++i]; break;
      case '--update-interval': p.updateInterval = parseInt(a[++i], 10); break;
      case '--no-discover': p.discover = false; break;
      case '--no-firewall': p.firewall = false; break;
    }
  }
  if (!['both', 'hub', 'agent', 'server', 'client'].includes(p.mode)) p.mode = 'both';
  if (p.mode === 'server') p.mode = 'hub';
  if (p.mode === 'client') p.mode = 'agent';
  return p;
}

const cfg = parseArgs();
console.log(`\n  NEXUS  —  mod: ${cfg.mode.toUpperCase()}\n  ${cfg.mode !== 'agent' ? `hub: http://localhost:${cfg.port}` : `agent -> ${cfg.hub} (${cfg.name})`} | keşif: ${cfg.discover ? 'LAN açık' : 'kapalı'}\n`);

// OS-aware firewall check/setup (auto at startup unless --no-firewall).
if (cfg.firewall) {
  process.env.NEXUS_PORT = String(cfg.port);
  const { checkFirewall, ensureFirewall } = require('./setup');
  checkFirewall().then((ck) => {
    console.log(`  OS: ${ck.os} | firewall: ${ck.applied ? 'kural aktif' : 'kuralsız'}`);
    if (!ck.applied) {
      ensureFirewall().then((r) => r.lines.forEach((l) => console.log(`  ${r.mode === 'ok' ? '' : 'firewall '}${l}`)));
    }
  });
}

if (cfg.mode === 'hub' || cfg.mode === 'both') {
  const { startHub } = require('./hub.js');
  startHub(cfg.port, { repoDir: cfg.repoDir, updateBranch: cfg.updateBranch, updateInterval: cfg.updateInterval, name: cfg.name, discover: cfg.discover });
}
if (cfg.mode === 'agent' || cfg.mode === 'both') {
  setTimeout(() => {
    const { startAgent } = require('./agent.js');
    startAgent(cfg.hub, cfg.name, cfg.interval, { repoDir: cfg.repoDir, updateBranch: cfg.updateBranch, discover: cfg.discover });
  }, cfg.mode === 'both' ? 800 : 0);
}
