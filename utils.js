const { exec, spawn } = require('child_process');
const path = require('path');

function run(cmd, cwd) {
  return new Promise((res, rej) => {
    exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (e, stdout) => {
      if (e) return rej(e);
      res(stdout.trim());
    });
  });
}

const git = {
  commit: (cwd) => run('git rev-parse --short HEAD', cwd).catch(() => null),
  branch: (cwd) => run('git rev-parse --abbrev-ref HEAD', cwd).catch(() => null),
  fetch: (cwd) => run('git fetch origin --prune', cwd).catch(() => null),
  remote: (cwd, b) => run(`git rev-parse --short origin/${b}`, cwd).catch(() => null),
  pending: (cwd, b) => run(`git log HEAD..origin/${b} --pretty=format:%h %s -10`, cwd).catch(() => ''),
  pull: (cwd, b) => run(`git pull origin ${b}`, cwd),
  install: (cwd) => run('npm install --no-audit --no-fund', cwd),
};

function restart(args) {
  const entry = path.resolve(__dirname, 'index.js');
  const child = spawn(process.execPath, [entry, ...args], { cwd: __dirname, detached: true, stdio: 'inherit' });
  child.unref();
  setTimeout(() => process.exit(0), 1500);
}

module.exports = { git, restart };
