#!/usr/bin/env node
// workspace-push — discover local workspaces, map them to remote branches on
// 'origin', and push all changes automatically.
//
// Usage:
//   npx ts-node src/scripts/workspace-push.ts [options] [<workspace-dir> ...]
//
// Options:
//   --config <path>       Path to a JSON config file listing workspace paths
//   --force               Force-push existing branches (default: skip)
//   --skip-empty          Skip workspaces with no uncommitted changes
//   --dry-run             Show what would happen without making changes
//   --branch-prefix <str> Prefix for generated branch names (default: "ws")
//   --commit-message <msg> Custom commit message (default: "workspace push")
//   --verbose             Print detailed git output

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkspaceEntry {
  /** Absolute or relative path to the workspace directory */
  path: string;
  /** Optional explicit branch name (defaults to derived name) */
  branch?: string;
}

interface ConfigFile {
  workspaces: WorkspaceEntry[];
}

type Status = "success" | "skipped-empty" | "skipped-force" | "error";

interface Result {
  workspace: string;
  branch: string;
  status: Status;
  message?: string;
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let configPath: string | undefined;
  let forcePush = false;
  let skipEmpty = true; // default to skipping empty workspaces
  let dryRun = false;
  let branchPrefix = "ws";
  let commitMessage = "workspace push";
  let verbose = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      console.log(`Usage: workspace-push [options] [<workspace-dir> ...]

Options:
  --config <path>       Path to a JSON config file listing workspace paths
  --force               Force-push existing branches (default: skip)
  --skip-empty          Skip workspaces with no uncommitted changes
  --no-skip-empty       Do not skip empty workspaces
  --dry-run             Show what would happen without making changes
  --branch-prefix <str> Prefix for generated branch names (default: "ws")
  --commit-message <msg> Custom commit message (default: "workspace push")
  --verbose             Print detailed git output
  -h, --help            Show this help

Examples:
  workspace-push .                          # Scan current dir for repos
  workspace-push ./repo1 ./repo2            # Process specific paths
  workspace-push --config workspaces.json   # Use config file
  workspace-push --dry-run .                # Preview changes only`);
      process.exit(0);
    } else if (a === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (a === "--force") {
      forcePush = true;
    } else if (a === "--skip-empty") {
      skipEmpty = true;
    } else if (a === "--no-skip-empty") {
      skipEmpty = false;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--branch-prefix" && i + 1 < args.length) {
      branchPrefix = args[++i];
    } else if (a === "--commit-message" && i + 1 < args.length) {
      commitMessage = args[++i];
    } else if (a === "--verbose") {
      verbose = true;
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }

  return { configPath, forcePush, skipEmpty, dryRun, branchPrefix, commitMessage, verbose, positional };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the full path to the git executable on any platform. */
let _gitPath: string | undefined;
function getGitPath(): string {
  if (_gitPath) return _gitPath;
  // Try common locations first (avoids a fork+exec). Forward slashes work on Windows too.
  const candidates = [
    "D:/Program Files/Git/mingw64/bin/git.exe",
    "C:/Program Files/Git/cmd/git.exe",
    "C:/Program Files/Git/mingw64/bin/git.exe",
    "/usr/bin/git",
    "/usr/local/bin/git",
  ];
  for (const c of candidates) {
    // On Windows, accessSync(X_OK) is unreliable — just check existence.
    if (fsSync.existsSync(c)) {
      _gitPath = c;
      return c;
    }
  }
  // Fallback: use 'git' directly (works on Unix / when PATH is set).
  _gitPath = "git";
  return _gitPath;
}

function sanitizeBranchName(name: string): string {
  // Replace characters not allowed in git refs with hyphens; collapse runs.
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-{2,}/g, "-");
}

function deriveBranch(workspacePath: string, prefix: string): string {
  const base = path.basename(workspacePath);
  return `${prefix}-${sanitizeBranchName(base)}`;
}

/** Execute a git command using spawnSync (native arg handling — no shell quoting issues on Windows). */
function git(cwd: string, args: string[], opts?: { silent?: boolean }): string {
  const gp = getGitPath();
  try {
    const result = spawnSync(gp, args, {
      cwd,
      encoding: "utf-8",
      stdio: opts?.silent ? ["pipe", "pipe", "pipe"] : undefined,
    });

    if (result.error) throw result.error;
    return (result.stdout ?? "").trim();
  } catch (err: any) {
    const msg = err.message || String(err);
    throw new Error(`git ${args[0]} failed: ${msg}`);
  }
}

/** Like git() but returns null on failure instead of throwing. */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function hasChanges(cwd: string): boolean {
  // git diff --quiet returns exit code 0 if clean, 1 if dirty (not an error).
  const gp = getGitPath();
  try {
    const result = spawnSync(gp, ["diff", "--quiet"], { cwd, stdio: "pipe" });
    if (result.error) return true; // actual failure — assume dirty
    return result.status !== 0; // non-zero means there are changes
  } catch {
    return true;
  }
}

function isGitRepo(dir: string): boolean {
  try {
    const gp = getGitPath();
    const result = spawnSync(gp, ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      stdio: "pipe",
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

// ── Workspace discovery ─────────────────────────────────────────────────────

async function loadConfig(configPath: string): Promise<WorkspaceEntry[]> {
  const raw = await fs.readFile(configPath, "utf-8");
  const cfg: ConfigFile = JSON.parse(raw);
  return cfg.workspaces;
}

function discoverFromDir(root: string): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  try {
    const items = fsSync.readdirSync(root, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const subPath = path.join(root, item.name);
      // Check if this directory is a git repo or contains .git file (worktree marker).
      const dotGit = path.join(subPath, ".git");
      let isRepo = false;
      try {
        const stat = fsSync.statSync(dotGit);
        if (stat.isFile()) isRepo = true; // worktree .git file
        else if (stat.isDirectory()) isRepo = true;
      } catch { /* not a repo */ }

      if (!isRepo) continue;

      entries.push({ path: subPath });
    }
  } catch (err: any) {
    console.error(`Error scanning directory ${root}: ${err.message}`);
  }
  return entries;
}

// ── Core logic ───────────────────────────────────────────────────────────────

async function processWorkspace(
  wsPath: string,
  opts: { forcePush: boolean; skipEmpty: boolean; dryRun: boolean; branchPrefix: string; commitMessage: string; verbose: boolean }
): Promise<Result> {
  const absPath = path.resolve(wsPath);

  // Validate it's a git repo.
  if (!isGitRepo(absPath)) {
    return { workspace: absPath, branch: "", status: "error", message: "Not a git repository" };
  }

  // Derive branch name.
  const branch = opts.branchPrefix ? deriveBranch(wsPath, opts.branchPrefix) : path.basename(absPath);

  // Check for changes.
  if (opts.skipEmpty && !hasChanges(absPath)) {
    return { workspace: absPath, branch, status: "skipped-empty", message: "No uncommitted changes" };
  }

  const remote = "origin";

  try {
    // Ensure origin remote exists.
    const remotes = gitTry(absPath, ["remote"]);
    if (!remotes?.includes(remote)) {
      return { workspace: absPath, branch, status: "error", message: `Remote '${remote}' not configured` };
    }

    // Fetch latest refs from origin.
    if (opts.verbose) {
      console.log(`  [fetch] ${absPath}`);
    }
    git(absPath, ["fetch", remote]);

    // Check if branch already exists on origin.
    const existingBranch = gitTry(absPath, ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`]);
    const hasRemoteBranch = existingBranch !== null;

    // Stage all changes (including untracked files).
    if (!opts.dryRun) {
      git(absPath, ["add", "."]);
    }

    // Check if there's anything to commit after staging.
    let needsCommit = true;
    if (!opts.dryRun) {
      try {
        const gp = getGitPath();
        const result = spawnSync(gp, ["diff", "--cached", "--quiet"], { cwd: absPath, stdio: "pipe" });
        needsCommit = result.status !== 0 && !result.error;
      } catch { /* changes staged — good */ }
    }

    if (!needsCommit) {
      return { workspace: absPath, branch, status: "skipped-empty", message: "Nothing to commit after staging" };
    }

    // Commit.
    if (!opts.dryRun) {
      git(absPath, ["commit", "-m", opts.commitMessage]);
    }

    // Create or switch to the local branch.
    const currentBranch = gitTry(absPath, ["branch", "--show-current"]);
    if (currentBranch !== branch) {
      if (!opts.dryRun) {
        git(absPath, ["checkout", "-B", branch]);
      }
    }

    // Push.
    if (hasRemoteBranch) {
      const pushFlags = opts.forcePush ? ["--force"] : [];
      if (!opts.dryRun) {
        try {
          git(absPath, ["push", remote, branch, ...pushFlags]);
        } catch (err: any) {
          return { workspace: absPath, branch, status: "error", message: `Push failed: ${err.message}` };
        }
      }
    } else {
      if (!opts.dryRun) {
        try {
          git(absPath, ["push", "-u", remote, branch]);
        } catch (err: any) {
          return { workspace: absPath, branch, status: "error", message: `Push failed: ${err.message}` };
        }
      }
    }

    const pushMsg = hasRemoteBranch ? "Would force-push" : "Would create and push";
    return { workspace: absPath, branch, status: opts.dryRun ? "success" as Status : "success", message: opts.dryRun ? `${pushMsg} (dry run)` : (hasRemoteBranch ? "Pushed (force)" : "Pushed and set upstream") };
  } catch (err: any) {
    return { workspace: absPath, branch, status: "error", message: err.message };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const results: Result[] = [];

  // Discover workspaces.
  let workspaces: WorkspaceEntry[] = [];

  if (opts.configPath) {
    console.log(`Loading config from ${opts.configPath}`);
    workspaces = await loadConfig(opts.configPath);
  } else if (opts.positional.length > 0) {
    // Explicit paths provided.
    for (const p of opts.positional) {
      const abs = path.resolve(p);
      if (!isGitRepo(abs)) {
        console.error(`Warning: ${abs} is not a git repository, skipping.`);
        continue;
      }
      workspaces.push({ path: abs });
    }
  } else {
    // Default: scan current directory for sub-repos.
    const cwd = process.cwd();
    console.log(`Scanning ${cwd} for git repositories...`);
    workspaces = discoverFromDir(cwd);
    if (workspaces.length === 0) {
      console.error("No git repositories found in current directory.");
      console.error("Pass workspace paths or use --config <path>.");
      process.exit(1);
    }
  }

  if (opts.dryRun) {
    console.log("\n=== DRY RUN — no changes will be made ===\n");
  }

  // Process each workspace.
  for (const ws of workspaces) {
    const absPath = path.resolve(ws.path);
    console.log(`Processing: ${absPath}`);
    if (ws.branch) {
      console.log(`  Branch override: ${ws.branch}`);
    }

    const result = await processWorkspace(absPath, opts);
    results.push(result);

    // Print status.
    const iconMap: Record<string, string> = { success: "✓", "skipped-empty": "-", "skipped-force": "-", error: "✗" };
    const icon = iconMap[result.status] ?? "?";
    console.log(`  ${icon} [${result.status.toUpperCase()}] → ${result.branch}`);
    if (result.message) {
      console.log(`    ${result.message}`);
    }
  }

  // Summary.
  const successCount = results.filter(r => r.status === "success").length;
  const skipCount = results.filter(r => r.status === "skipped-empty" || r.status === "skipped-force").length;
  const errorCount = results.filter(r => r.status === "error").length;

  console.log(`\n=== Summary: ${results.length} workspaces — ${successCount} success, ${skipCount} skipped, ${errorCount} errors ===`);

  if (errorCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
