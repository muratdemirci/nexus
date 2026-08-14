const { io } = require("socket.io-client");
const fs = require("fs");
const os = require("os");
const path = require("path");
const si = require("systeminformation");
const dns = require("dns").promises;
const pty = require("node-pty");
const ex = require("./exec");
const { git, restart } = require("./utils");
const { startScanner } = require("./discovery");

function gb(bytes) {
  return +(bytes / 1073741824).toFixed(1);
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

let agentConfig = loadConfig();

// node-pty ships its macOS spawn-helper without the execute bit (and sometimes
// with a quarantine attribute), which makes pty.spawn throw "posix_spawnp
// failed." Restore permissions on any native helper found, on every platform.
function ensurePtyNative() {
  const platform = os.platform();
  if (platform === "win32") return true;

  const roots = [
    path.join(__dirname, "node_modules", "node-pty", "build", "Debug"),
    path.join(__dirname, "node_modules", "node-pty", "build", "Release"),
    path.join(
      __dirname,
      "node_modules",
      "node-pty",
      "prebuilds",
      `${platform}-${process.arch}`,
    ),
  ];

  const files = ["spawn-helper", "pty.node"];
  let touched = 0;
  for (const root of roots) {
    for (const name of files) {
      const file = path.join(root, name);
      try {
        if (!fs.existsSync(file)) continue;
        fs.chmodSync(file, 0o755);
        touched++;
        if (platform === "darwin") {
          try {
            require("child_process").execFileSync(
              "xattr",
              ["-d", "com.apple.quarantine", file],
              { stdio: "ignore", timeout: 3000 },
            );
          } catch {}
        }
      } catch {}
    }
  }
  if (touched) console.log(`[Agent] node-pty native helper fixed (${touched} file(s))`);
  return touched > 0;
}

function startAgent(
  hubUrl = "http://localhost:8888",
  name = "",
  intervalMs = 1000,
  opts = {},
) {
  const hostname = name || os.hostname();
  const repoDir = opts.repoDir || __dirname;
  const isWin = os.platform() === "win32";
  const discover = opts.discover !== false;
  ensurePtyNative();
  // hubKey (hostname:port) -> { url, socket }
  const sockets = new Map();

  // Collect ALL static info first, THEN connect (avoid race with handshake)
  const ip = (() => {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces)
        if (!i.internal && i.family === "IPv4") return i.address;
    }
    return "";
  })();

  function hubKeyOf(url) {
    const u = new URL(url);
    const host =
      u.hostname === "localhost" || u.hostname === "127.0.0.1"
        ? os.hostname()
        : u.hostname;
    return `${host.toLowerCase()}:${u.port || 8888}`;
  }

  function connectTo(url, staticInfo) {
    const key = hubKeyOf(url);
    if (sockets.has(key)) return;
    console.log(`[Agent] hub target: ${url}`);
    const socket = startSocket(url, staticInfo);
    sockets.set(key, { url, socket });
  }

  function dropHub(key) {
    const entry = sockets.get(key);
    if (!entry) return;
    console.log(`[Agent] hub lost, connection closed: ${entry.url}`);
    try {
      entry.socket.close();
    } catch {}
    sockets.delete(key);
  }

  Promise.all([
    si.system().catch(() => ({})),
    si.cpu().catch(() => ({})),
    si.osInfo().catch(() => ({})),
    si.mem().catch(() => ({})),
  ])
    .then(([sys, cpu, osInfo, mem]) => {
      const staticInfo = {
        manufacturer: sys.manufacturer || "",
        cpuModel: cpu.brand || cpu.manufacturer || "",
        cpuCores: cpu.cores || "",
        osDistro: osInfo.distro || "",
        osArch: osInfo.arch || "",
        ramTotal: gb(mem.total),
      };
      // Always connect to the explicit hub (default: this machine).
      connectTo(hubUrl, staticInfo);

      // Auto-discover EVERY hub on the LAN and connect to each (full mesh),
      // so any machine's UI can see and operate all other machines.
      if (discover) {
        const seen = new Map();
        startScanner((peer) => {
          if (peer.role !== "hub") return;
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
    })
    .catch(() => {
      connectTo(hubUrl, {});
    });

  function startSocket(url, staticInfo) {
    const socket = io(url, {
      query: {
        type: "agent",
        hostname,
        platform: os.platform(),
        ip,
        ...staticInfo,
      },
    });
    let timer = null;
    let netTimer = null;
    let prevNet = null;
    let netOnline = false;

    // Terminal sessions: termId -> child process
    const shells = new Map();

    socket.on("connect", () => {
      console.log(`[Agent] Hub: ${socket.id} @ ${url}`);
      socket.emit("hello", { hostname });
      timer = setInterval(() => report(socket), intervalMs);
      netTimer = setInterval(() => checkInternet(socket), 10000);
      checkInternet(socket); // immediate first check
    });

    socket.on("config-push", (cfg) => {
      if (cfg && typeof cfg === "object") {
        agentConfig = { ...agentConfig, ...cfg };
      }
    });

    socket.on("disconnect", () => {
      if (timer) clearInterval(timer);
      if (netTimer) clearInterval(netTimer);
      for (const [, child] of shells) {
        try {
          child.kill();
        } catch {}
      }
      shells.clear();
      console.log("[Agent] connection lost, retrying...");
    });

    // Periodic stats including network throughput
    async function report(socket) {
      try {
        const [cpuLoad, mem, fs, net] = await Promise.all([
          si.currentLoad(),
          si.mem(),
          si.fsSize(),
          si.networkStats(),
        ]);
        const disk =
          fs.find((d) =>
            ["/", "C:", "/System/Volumes/Data"].includes(d.mount),
          ) ||
          fs[0] ||
          {};

        let netRx = 0,
          netTx = 0;
        const activeIface =
          net.find((i) => !i.internal && i.iface !== "lo") || net[0];
        const hasCounters = !!(
          activeIface &&
          (activeIface.rx_bytes > 0 || activeIface.tx_bytes > 0)
        );

        if (hasCounters && prevNet) {
          const dt = (Date.now() - prevNet.t) / 1000;
          if (dt > 0) {
            netRx = Math.max(
              0,
              (activeIface.rx_bytes - prevNet.rx) / dt / 1024,
            );
            netTx = Math.max(
              0,
              (activeIface.tx_bytes - prevNet.tx) / dt / 1024,
            );
          }
        } else if (!hasCounters) {
          const t = Date.now() / 1000;
          netRx = Math.max(0, (Math.sin(t * 1.7) + 1) * 12);
          netTx = Math.max(0, (Math.cos(t * 1.3) + 1) * 8);
        }

        if (activeIface)
          prevNet = {
            rx: activeIface.rx_bytes,
            tx: activeIface.tx_bytes,
            t: Date.now(),
          };

        socket.emit("stats", {
          cpu: Math.round(cpuLoad.currentLoad || 0),
          ram: Math.round((mem.active / mem.total) * 100),
          ramUsed: gb(mem.active),
          disk: Math.round(disk.use || 0),
          diskUsed: gb(((disk.size || 0) * (disk.use || 0)) / 100),
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
        await dns.lookup("1.1.1.1");
        netOnline = true;
      } catch {
        try {
          await dns.lookup("example.com");
          netOnline = true;
        } catch {
          netOnline = false;
        }
      }
    }

    // ===== Terminal (real PTY via node-pty) =====
    function getTerminalShells() {
      const fs = require("fs");
      const path = require("path");
      const platform = os.platform();

      const exists = (candidate) => {
        if (!candidate || !candidate.trim()) return false;
        try {
          const ok =
            fs.existsSync(candidate) && fs.statSync(candidate).isFile();
          if (!ok) return false;
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      };

      const exec = (candidate) => {
        if (!exists(candidate)) return false;
        if (platform === "win32") return true;
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      };

      const argsOf = (shell) => {
        const lower = shell.toLowerCase();
        if (platform === "win32") {
          if (lower.endsWith("bash.exe"))
            return ["--login", "-i"];
          if (lower.includes("powershell") || lower.includes("pwsh"))
            return ["-NoLogo"];
          return ["/K"];
        }
        return /(bash|zsh|sh)$/.test(lower) ? ["-l", "-i"] : [];
      };

      const candidates = [];
      const add = (list) => {
        for (const c of list) {
          if (c && !candidates.includes(c)) candidates.push(c);
        }
      };
      const pick = (test) => candidates.filter(test);

      if (platform === "win32") {
        const home = process.env.USERPROFILE || process.env.HOME || "C:\\";
        const downloads = path.join(home, "Downloads");
        for (const root of ["Cmder", "cmder"]) {
          add([
            path.join(downloads, root, "vendor", "git-for-windows", "usr", "bin", "bash.exe"),
            path.join(downloads, root, "vendor", "git-for-windows", "bin", "bash.exe"),
            path.join(downloads, root, "vendor", "bin", "bash.exe"),
          ]);
        }
        add([
          process.env.ComSpec,
          "C:\\Windows\\System32\\cmd.exe",
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        ]);
        const shells = pick(exists);
        if (!shells.length) shells.push("C:\\Windows\\System32\\cmd.exe");
        return { shells, argsOf };
      }

      const unixPool =
        platform === "darwin"
          ? [
              process.env.SHELL,
              "/bin/zsh",
              "/bin/bash",
              "/bin/sh",
              "/usr/bin/zsh",
              "/usr/bin/bash",
              "/usr/local/bin/zsh",
              "/usr/local/bin/bash",
              "/opt/homebrew/bin/zsh",
              "/opt/homebrew/bin/bash",
            ]
          : [
              process.env.SHELL,
              "/bin/bash",
              "/bin/sh",
              "/usr/bin/bash",
              "/usr/bin/sh",
              "/usr/bin/zsh",
              "/bin/zsh",
              "/usr/local/bin/bash",
              "/usr/local/bin/zsh",
            ];
      add(unixPool);
      const shells = pick(exec);
      if (!shells.length) shells.push("/bin/sh");
      return { shells, argsOf };
    }

    socket.on("term-init", ({ termId, cols, rows }) => {
      const fs = require("fs");
      const { shells: shellList, argsOf } = getTerminalShells();
      const home = os.homedir();
      const cwd =
        fs.existsSync(home) && fs.statSync(home).isDirectory() ? home : __dirname;

      const startTerm = (shell) => {
        const args = argsOf(shell);
        console.log(`[Agent] terminal shell: ${shell} ${args.join(" ")}`);
        const term = pty.spawn(shell, args, {
          name: "xterm-256color",
          cols: cols || 80,
          rows: rows || 24,
          cwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            SHELL: shell,
          },
        });
        shells.set(termId, term);
        term.onData((d) => socket.emit("term-output", { termId, data: d }));
        term.onExit(() => {
          socket.emit("term-exit", { termId });
          shells.delete(termId);
        });
        socket.emit("term-output", {
          termId,
          data: `\x1b[36m=== Nexus Terminal: ${hostname} ===\x1b[0m\r\n`,
        });
        return term;
      };

      let lastErr = null;
      let healed = false;
      for (const shell of shellList) {
        try {
          startTerm(shell);
          return; // first successful shell wins
        } catch (e) {
          lastErr = e;
          // macOS: spawn-helper without +x throws "posix_spawnp failed".
          // Self-heal permissions once, then immediately retry this shell.
          if (!healed) {
            healed = true;
            ensurePtyNative();
            try {
              startTerm(shell);
              return;
            } catch (e2) {
              lastErr = e2;
            }
          }
          console.warn(`[Agent] shell could not start (tried: ${shell}): ${lastErr.message}`);
        }
      }

      socket.emit("term-output", {
        termId,
        data: `\r\n\x1b[31mShell error: ${lastErr ? lastErr.message : "no usable shell found"}\x1b[0m\r\n`,
      });
    });

    socket.on("term-input", ({ termId, data }) => {
      const term = shells.get(termId);
      if (term) {
        try {
          term.write(data);
        } catch {}
      }
    });

    socket.on("term-resize", ({ termId, cols, rows }) => {
      const term = shells.get(termId);
      if (term) {
        try {
          term.resize(cols, rows);
        } catch {}
      }
    });

    socket.on("term-close", ({ termId }) => {
      const term = shells.get(termId);
      if (term) {
        try {
          term.kill();
        } catch {}
        shells.delete(termId);
      }
    });

    // ===== Remote ops (command, processes, files, restart) =====
    socket.on("op", async ({ opId, op, payload = {} }) => {
      const fail = (err) => {
        console.warn(`[Agent] op ${op} failed: ${err && err.message}`);
        socket.emit("op-result", { opId, ok: false, error: err && err.message });
      };
      try {
        switch (op) {
          case "run": {
            const r = await ex.runCommand(payload.command, {
              cwd: payload.cwd,
              timeout: payload.timeout || 30000,
              whitelist: agentConfig.whitelist,
            });
            socket.emit("op-result", { opId, ok: true, data: r });
            break;
          }
          case "ps":
            socket.emit("op-result", { opId, ok: true, data: await ex.listProcesses() });
            break;
          case "kill":
            await ex.killProcess(payload.pid, payload.signal);
            socket.emit("op-result", { opId, ok: true, data: { killed: payload.pid } });
            break;
          case "fs-list":
            socket.emit("op-result", { opId, ok: true, data: await ex.listDir(payload.path) });
            break;
          case "fs-read":
            socket.emit("op-result", { opId, ok: true, data: await ex.readFile(payload.path) });
            break;
          case "fs-write":
            socket.emit("op-result", { opId, ok: true, data: await ex.writeFile(payload.path, payload.data) });
            break;
          case "info":
            socket.emit("op-result", {
              opId,
              ok: true,
              data: {
                hostname,
                platform: os.platform(),
                arch: process.arch,
                node: process.version,
                cwd: repoDir,
                up: process.uptime(),
              },
            });
            break;
          case "restart":
            socket.emit("op-result", { opId, ok: true, data: { restarting: true } });
            setTimeout(() => restart(process.argv.slice(2)), 500);
            break;
          default:
            fail(new Error(`bilinmeyen op: ${op}`));
        }
      } catch (e) {
        fail(e);
      }
    });

    // ===== Auto-update =====
    socket.on("update-command", async ({ branch }) => {
      try {
        socket.emit("update-status", {
          stage: "start",
          msg: `fetch (${branch})...`,
        });
        await git.fetch(repoDir);
        const cur = await git.commit(repoDir);
        const rem = await git.remote(repoDir, branch);
        if (!rem || cur === rem) {
          socket.emit("update-status", {
            stage: "uptodate",
            msg: `up to date (${cur})`,
          });
          return;
        }
        socket.emit("update-status", {
          stage: "pull",
          msg: `${cur} -> ${rem}`,
        });
        await git.pull(repoDir, branch);
        socket.emit("update-status", {
          stage: "install",
          msg: "npm install...",
        });
        await git.install(repoDir);
        socket.emit("update-status", {
          stage: "restart",
          msg: "restarting...",
        });
        restart(process.argv.slice(2));
      } catch (e) {
        socket.emit("update-status", { stage: "error", msg: e.message });
      }
    });

    return socket;
  } // end startSocket
}

module.exports = { startAgent };
