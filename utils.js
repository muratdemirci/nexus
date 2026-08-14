const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, cwd) {
  return new Promise((res, rej) => {
    exec(cmd, { cwd: cwd ? path.resolve(cwd) : os.homedir(), maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) {
        const err = new Error((stderr || e.message || String(e)).trim() || String(e));
        err.stdout = stdout;
        return rej(err);
      }
      res(stdout.trim());
    });
  });
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const git = {
  commit: (cwd) => run('git rev-parse --short HEAD', cwd).catch(() => null),
  head: (cwd) => run('git rev-parse HEAD', cwd).catch(() => null),
  branch: (cwd) => run('git rev-parse --abbrev-ref HEAD', cwd).catch(() => null),
  fetch: (cwd) => run('git fetch origin --prune', cwd).catch(() => null),
  remote: (cwd, b) => run(`git rev-parse --short origin/${b}`, cwd).catch(() => null),
  remoteHead: (cwd, b) => run(`git rev-parse origin/${b}`, cwd).catch(() => null),
  pending: (cwd, b) => run(`git log HEAD..origin/${b} --pretty=format:%h %s -10`, cwd).catch(() => ''),
  pull: (cwd, b, { ff = false } = {}) => run(`git pull ${ff ? '--ff-only ' : ''}origin ${b}`, cwd),
  install: (cwd) => run('npm install --no-audit --no-fund', cwd),
};

function restart(args) {
  const entry = path.resolve(__dirname, 'index.js');
  const child = spawn(process.execPath, [entry, ...args], { cwd: __dirname, detached: true, stdio: 'inherit' });
  child.unref();
  setTimeout(() => process.exit(0), 1500);
}

module.exports = { run, loadConfig, git, restart };
