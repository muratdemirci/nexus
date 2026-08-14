/**
 * NEXUS - Service installation (systemd / launchd / Windows startup).
 *
 * - Linux  : writes /etc/systemd/system/nexus.service + enable & start
 * - macOS  : writes ~/Library/LaunchAgents/com.nexus.plist
 * - Windows: writes a .cmd into the Startup folder (no admin needed)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function serviceFile() {
  const platform = os.platform();
  const entry = path.resolve(__dirname, 'index.js');
  const cwd = __dirname;
  const node = process.execPath;

  if (platform === 'linux') {
    return {
      target: '/etc/systemd/system/nexus.service',
      content: `[Unit]\nDescription=Nexus Hub & Agent (device management)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${cwd}\nExecStart=${node} ${entry}\nRestart=always\nRestartSec=5\nEnvironment=NODE_ENV=production\n\n[Install]\nWantedBy=multi-user.target\n`,
    };
  }

  if (platform === 'darwin') {
    const dir = path.join(process.env.HOME || '', 'Library', 'LaunchAgents');
    return {
      target: path.join(dir, 'com.nexus.plist'),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>com.nexus</string>\n  <key>ProgramArguments</key><array>\n    <string>${node}</string><string>${entry}</string>\n  </array>\n  <key>WorkingDirectory</key><string>${cwd}</string>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict></plist>\n`,
    };
  }

  if (platform === 'win32') {
    const startup = path.join(
      process.env.APPDATA || '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
    );
    return {
      target: path.join(startup, 'nexus.cmd'),
      content: `@echo off\nstart "" /b "${node}" "${entry}"\n`,
    };
  }

  return null;
}

function installService() {
  const svc = serviceFile();
  if (!svc) return { ok: false, error: `desteklenmeyen OS: ${os.platform()}` };
  const platform = os.platform();

  try {
    if (platform === 'linux') {
      fs.mkdirSync('/etc/systemd/system', { recursive: true });
      fs.writeFileSync(svc.target, svc.content);
      execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe' });
      execFileSync('systemctl', ['enable', 'nexus'], { stdio: 'pipe' });
      execFileSync('systemctl', ['start', 'nexus'], { stdio: 'pipe' });
      return { ok: true, target: svc.target, msg: 'systemd service installed and started. (systemctl status nexus)' };
    }
    if (platform === 'darwin') {
      fs.mkdirSync(path.dirname(svc.target), { recursive: true });
      fs.writeFileSync(svc.target, svc.content);
      try { execFileSync('launchctl', ['unload', svc.target], { stdio: 'pipe' }); } catch {}
      execFileSync('launchctl', ['load', svc.target], { stdio: 'pipe' });
      return { ok: true, target: svc.target, msg: 'launchd servisi kuruldu. (launchctl list | grep com.nexus)' };
    }
    if (platform === 'win32') {
      fs.mkdirSync(path.dirname(svc.target), { recursive: true });
      fs.writeFileSync(svc.target, svc.content);
      return { ok: true, target: svc.target, msg: 'Added to Startup folder — runs automatically at login.' };
    }
  } catch (e) {
    return {
      ok: false,
      target: svc.target,
      error: e.message,
      msg: 'Admin privileges may be required. Service file is ready at: ' + svc.target,
    };
  }
  return { ok: false, error: 'desteklenmeyen OS' };
}

function uninstallService() {
  const svc = serviceFile();
  if (!svc) return { ok: false, error: `desteklenmeyen OS: ${os.platform()}` };
  const platform = os.platform();
  try {
    if (platform === 'linux') {
      try { execFileSync('systemctl', ['stop', 'nexus'], { stdio: 'pipe' }); } catch {}
      try { execFileSync('systemctl', ['disable', 'nexus'], { stdio: 'pipe' }); } catch {}
      if (fs.existsSync(svc.target)) fs.unlinkSync(svc.target);
    } else if (platform === 'darwin') {
      try { execFileSync('launchctl', ['unload', svc.target], { stdio: 'pipe' }); } catch {}
      if (fs.existsSync(svc.target)) fs.unlinkSync(svc.target);
    } else if (platform === 'win32') {
      if (fs.existsSync(svc.target)) fs.unlinkSync(svc.target);
    }
    return { ok: true, msg: 'Service removed.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { installService, uninstallService, serviceFile };