/**
 * NEXUS - Agent-side operations used by the hub (commands, processes, files).
 *
 * All functions are async and throw on failure so the agent can report a
 * clean error back to the hub.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const cproc = require('child_process');

function which(name) {
  const isWin = os.platform() === 'win32';
  const cmd = isWin ? 'where' : 'which';
  try {
    cproc.execSync(`${cmd} ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whitelist check. `cfg.whitelist` is an array of command prefixes (e.g. "ls",
 * "docker ps"). Empty / missing = everything allowed. The first space-separated
 * token (resolved through aliases like git, sudo, npx) is matched.
 */
function isAllowed(cmd, whitelist) {
  if (!whitelist || !whitelist.length) return true;
  const first = String(cmd).trim().split(/\s+/)[0] || '';
  return whitelist.some((w) => {
    const wl = String(w).trim().toLowerCase();
    if (!wl) return false;
    return first.toLowerCase() === wl || first.toLowerCase().startsWith(wl + '/');
  });
}

/**
 * Runs a shell command, capturing output. Never runs through a TTY (safe for
 * batch/silent use). Returns { code, stdout, stderr }.
 */
function runCommand(cmd, { cwd, timeout = 30000, whitelist } = {}) {
  return new Promise((resolve, reject) => {
    if (!cmd || !String(cmd).trim()) return reject(new Error('empty command'));
    if (!isAllowed(cmd, whitelist)) {
      return reject(new Error(`command blocked by whitelist: ${cmd}`));
    }
    const isWin = os.platform() === 'win32';
    const exec = cproc.exec(String(cmd), optsOf());

    function optsOf() {
      const resolvedCwd = cwd && safeDir(cwd) ? path.resolve(cwd) : os.homedir();
      return {
        cwd: resolvedCwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, LANG: 'C.UTF-8' },
      };
    }

    let stdout = '';
    let stderr = '';
    exec.stdout.on('data', (d) => { stdout += d; });
    exec.stderr.on('data', (d) => { stderr += d; });
    exec.on('error', (e) => reject(e));
    exec.on('close', (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  }).catch((e) => {
    // exec() throws sync for invalid cwd etc. — surface as error result.
    if (e && e.code === 'ERR_CHILD_PROCESS_SETUP_STDIO') {
      try { e.kill(); } catch {}
    }
    throw e;
  });
}

/**
 * Directory check - uses path.resolve for canonical path.
 */
function safeDir(p) {
  if (!p) return false;
  try {
    return fs.existsSync(path.resolve(p)) && fs.statSync(path.resolve(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns the best cwd: home directory if it exists, otherwise process.cwd().
 */
function defaultCwd() {
  const home = os.homedir();
  return safeDir(home) ? home : process.cwd();
}

/**
 * File type detection based on extension.
 */
function getFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const textExts = ['.txt', '.md', '.json', '.csv', '.log'];
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
  const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv'];
  const codeExts = ['.html', '.css', '.js', '.py', '.java', '.c', '.cpp', '.ts'];
  
  if (textExts.includes(ext)) return 'text';
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (codeExts.includes(ext)) return 'code';
  return 'file';
}

/**
 * Reads a file safely, returning metadata + first chunk of content + type.
 */
function readFileSafe(filePath) {
  try {
    const target = path.resolve(filePath);
    if (!fs.existsSync(target)) return null;
    const buf = fs.readFileSync(target);
    return {
      content: buf.toString('utf8').substring(0, 10000),
      type: getFileType(target),
      size: buf.length,
    };
  } catch {
    return null;
  }
}

/**
 * Reads a file and returns its base64 content + metadata.
 */
function readFile(file) {
  const target = path.resolve(file);
  if (!target) throw new Error('missing file path');
  const stat = fs.statSync(target);
  return {
    name: path.basename(target),
    path: target,
    size: buf.length,
    mtime: stat.mtimeMs,
    data: buf.toString('base64'),
    type: getFileType(target),
  };
}

/** Writes (and optionally creates the parent dir) a file from base64 data. */
function writeFile(file, base64) {
  const target = path.resolve(file);
  if (!target) throw new Error('missing file path');
  if (typeof base64 !== 'string') throw new Error('missing data');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  return { path: target, size: Buffer.from(base64, 'base64').length };
}

module.exports = {
  which,
  isAllowed,
  runCommand,
  listProcesses,
  killProcess,
  listDir,
  readFile,
  writeFile,
  defaultCwd,
  safeDir,
};