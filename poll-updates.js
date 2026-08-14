#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { run, git } = require("./utils");

function parseArgs(argv) {
  const out = {
    repo: process.cwd(),
    branch: null,
    interval: 30,
    once: false,
    install: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--repo":
      case "-r":
        out.repo = argv[++i];
        break;
      case "--branch":
      case "-b":
        out.branch = argv[++i];
        break;
      case "--interval":
      case "-i":
        out.interval = Number(argv[++i]) || 30;
        break;
      case "--once":
        out.once = true;
        break;
      case "--no-install":
        out.install = false;
        break;
      default:
        break;
    }
  }

  return out;
}

async function resolveBranch(repoPath, requestedBranch) {
  if (requestedBranch) {
    return requestedBranch;
  }

  try {
    const branch = await run("git branch --show-current", repoPath);
    if (branch) {
      return branch;
    }
  } catch (_error) {
    // fall through to default below
  }

  return "main";
}

async function checkForUpdates({ repo, branch, install }) {
  const repoPath = path.resolve(repo);
  const packageJsonPath = path.join(repoPath, "package.json");

  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  const activeBranch = await resolveBranch(repoPath, branch);
  const effectiveBranch = activeBranch || "main";

  try {
    await git.fetch(repoPath);
  } catch (error) {
    console.log(`[poll] fetch failed: ${error.message}`);
    return { updated: false, reason: "fetch-failed" };
  }

  const currentHead = await git.head(repoPath);
  const remoteHead = await git.remoteHead(repoPath, effectiveBranch);

  if (!currentHead || !remoteHead) {
    console.log(`[poll] branch ${effectiveBranch} not found on origin yet.`);
    return { updated: false, reason: "branch-not-found" };
  }

  if (currentHead === remoteHead) {
    return { updated: false, reason: "up-to-date", currentHead, remoteHead };
  }

  console.log(
    `[poll] update detected: ${currentHead.slice(0, 8)} -> ${remoteHead.slice(0, 8)}`,
  );

  try {
    await git.pull(repoPath, effectiveBranch, { ff: true });
  } catch (error) {
    console.log(`[poll] pull failed: ${error.message}`);
    return { updated: false, reason: "pull-failed" };
  }

  if (install && fs.existsSync(packageJsonPath)) {
    try {
      await git.install(repoPath);
      console.log("[poll] npm install finished");
    } catch (error) {
      console.log(`[poll] npm install failed: ${error.message}`);
    }
  }

  return { updated: true, reason: "pulled", currentHead, remoteHead };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoPath = path.resolve(opts.repo);

  const detectedBranch = await resolveBranch(repoPath, opts.branch);
  const finalOptions = { ...opts, branch: detectedBranch };

  console.log(`[poll] repo: ${repoPath}`);
  console.log(`[poll] branch: ${detectedBranch}`);
  console.log(`[poll] interval: ${finalOptions.interval}s`);

  const runOnce = async () => {
    try {
      const result = await checkForUpdates(finalOptions);
      console.log(`[poll] status: ${result.reason}`);
      if (result.updated) {
        console.log("[poll] repo updated successfully");
      }
    } catch (error) {
      console.error("[poll] error:", error.message);
    }
  };

  if (opts.once) {
    await runOnce();
    return;
  }

  await runOnce();
  setInterval(
    () => {
      runOnce().catch(() => {});
    },
    Math.max(opts.interval, 5) * 1000,
  );
}

main().catch((error) => {
  console.error("[poll] fatal:", error.message);
  process.exit(1);
});