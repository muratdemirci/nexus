/**
 * NEXUS - Cross-platform firewall / port setup for LAN discovery & hub access.
 *
 * Runs at startup: detects the OS, verifies, and (when possible) ensures the
 * inbound firewall rules needed for the hub (TCP) and LAN discovery (UDP).
 *
 * - Windows: netsh advfirewall (8888/tcp, 8889/udp)
 * - macOS   : Application Firewall per-app allow for node (socketfilterfw)
 * - Linux   : hint for iptables/ufw
 */
const os = require('os');
const { execFile } = require('child_process');

const port = Number(process.env.NEXUS_PORT || 8888);
const dport = Number(process.env.NEXUS_DPORT || 8889);

const hubRule = 'Nexus Hub ' + port;
const discRule = 'Nexus Discovery ' + dport;

function isAdminWindows() {
  return new Promise((resolve) => execFile('net', ['session'], { windowsHide: true }, (err) => resolve(!err)));
}

function execNet(name, args) {
  return new Promise((resolve) => execFile(name, args, { windowsHide: true }, (e, out, errOut) => resolve({ err: e, out: out || '', errOut: errOut || '' })));
}

function netshWin(args) {
  return execNet('netsh', ['advfirewall', 'firewall'].concat(args));
}

function macAllowNode() {
  const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
  const nodePath = process.execPath;
  return new Promise((resolve) => {
    try {
      execFile(fw, ['--add', nodePath], () => {
        execFile(fw, ['--unblockapp', nodePath], (e) => resolve(!e));
      });
    } catch { resolve(false); }
  });
}

function linuxHint() {
  return [
    'Linux: run as root to apply rules:',
    `  sudo ufw allow ${port}/tcp   # hub web UI`,
    `  sudo ufw allow ${dport}/udp  # LAN discovery`,
  ];
}

/**
 * Verifies whether the rules are in place.
 * Returns { os, applied, rules:{...}, hint:[] }.
 */
async function checkFirewall() {
  const platform = os.platform();
  const rules = {};
  let applied = false;

  if (platform === 'win32') {
    for (const key of ['tcp', 'udp']) {
      const name = key === 'tcp' ? hubRule : discRule;
      const r = await execNet('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + name]);
      rules[name] = { ok: !r.err && /Enabled:\s+Yes/i.test(r.out), enabled: true };
    }
    applied = rules[hubRule].ok && rules[discRule].ok;
  } else if (platform === 'darwin') {
    rules['node (socketfilterfw)'] = { ok: true, note: 'per-app permission' };
    applied = true;
  } else if (platform === 'linux') {
    const r = await execNet('iptables', ['-L', 'INPUT', '-n']);
    rules['iptables INPUT'] = { ok: !r.err };
    applied = !r.err;
  } else {
    rules[platform] = { ok: true };
    applied = true;
  }

  return { os: platform, applied, rules, hint: platform === 'linux' ? linuxHint() : [] };
}

/**
 * Ensures inbound rules exist (adds where possible). Never throws.
 */
async function ensureFirewall() {
  const platform = os.platform();

  if (platform === 'win32') {
    if (!(await isAdminWindows())) {
      return {
        mode: 'hint',
        lines: [
          'Could not check firewall rules — no admin rights. Run these commands as admin:',
          `  netsh advfirewall firewall add rule name="${hubRule}" dir=in action=allow protocol=TCP localport=${port}`,
          `  netsh advfirewall firewall add rule name="${discRule}" dir=in action=allow protocol=UDP localport=${dport}`,
        ],
      };
    }
    for (const [key, proto, rw] of [['tcp', 'TCP', hubRule], ['udp', 'UDP', discRule]]) {
      const show = await execNet('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + rw]);
      const present = !show.err && /Enabled:\s+Yes/i.test(show.out);
      if (!present) await netshWin(['add', 'rule', 'name=' + rw, 'dir=in', 'action=allow', 'protocol=' + proto, 'localport=' + port]);
    }
    return { mode: 'ok', lines: [`Windows: ${hubRule} + ${discRule} ready (TCP ${port}, UDP ${dport}).`] };
  }

  if (platform === 'darwin') {
    const ok = await macAllowNode();
    return {
      mode: ok ? 'ok' : 'hint',
      lines: ok
        ? ['macOS: Application Firewall allows node.']
        : ['macOS: could not set permission → System Settings → Privacy & Security → Firewall → allow node to accept incoming connections.'],
    };
  }

  if (platform === 'linux') {
    return { mode: 'hint', lines: linuxHint() };
  }

  return { mode: 'hint', lines: [`Unknown OS (${platform}) — set rules manually.`] };
}

module.exports = { ensureFirewall, checkFirewall, isAdminWindows, port, dport, hubRule, discRule };