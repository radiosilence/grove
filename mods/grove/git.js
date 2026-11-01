import { spaces, panes } from "herdr";
import { git, sh, fill, expand } from "./lib.js";

// Where a space is now: its first terminal's live folder, else where it was made.
export function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Every space with where it is, read once: spaces() and panes() are host
// calls, and a list of folders asking per row is thousands of them a frame.
export function placed() {
  const ps = panes();
  return spaces().map((s) => {
    const tabs = new Set((s.tabs ?? []).map((t) => t.id));
    return { s, at: ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null };
  });
}

const inside = (p, dir) => p === dir || p.startsWith(`${dir}/`);

// The space showing a folder: its first terminal is in it, and not in a
// deeper checkout listed in `others` (a worktree nested in its repo).
export function spaceOf(path, on, others = [], snap = placed()) {
  return snap.find(({ s, at }) => {
    if ((s.machine ?? null) !== (on ?? null)) return false;
    if (!at || !inside(at, path)) return false;
    return !others.some((o) => o !== path && o.length > path.length && inside(at, o));
  })?.s;
}

// owner/repo of a checkout's origin on GitHub, lowercased; null if it has none.
export async function originSlug(path, on) {
  const r = await git(path, ["remote", "get-url", "origin"], on);
  const m = r.ok && r.out.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// The repo a folder belongs to. null outside git.
export async function repoOf(folder, on) {
  const r = await git(folder, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], on);
  if (!r.ok) return null;
  const [top, common] = r.out.split("\n");
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  return { top, main, name: main.split("/").pop(), parent: main.slice(0, main.lastIndexOf("/")), linked: top !== main, on };
}

// Every checkout of the repo, the main one first, then the most recently committed.
export async function checkouts(repo) {
  const [list, refs] = await Promise.all([
    git(repo.main, ["worktree", "list", "--porcelain"], repo.on),
    git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], repo.on),
  ]);
  if (!list.ok) throw new Error(list.err || "git worktree list failed.");
  const when = new Map(
    refs.out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .map(([b, t]) => [b, Number(t) || 0]),
  );
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.includes("bare") || lines.some((l) => l.startsWith("prunable"))) continue;
    const branch =
      lines
        .find((l) => l.startsWith("branch "))
        ?.slice(7)
        .replace(/^refs\/heads\//, "") ?? null;
    out.push({
      path,
      branch,
      main: out.length === 0,
      at: branch ? (when.get(branch) ?? 0) : 0,
      agent: path.includes("/.claude/worktrees/"),
      locked: lines.some((l) => l.startsWith("locked")),
      dirty: null,
      pr: null,
    });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// Uncommitted changes in a checkout: a count, or null when git can't say.
export async function dirtyCount(path, on) {
  const r = await git(path, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], on);
  if (!r.ok) return null;
  return r.out ? r.out.split("\n").length : 0;
}

// Newest PR per head branch, from one list call rather than one per branch.
export async function prsByBranch(repo) {
  const r = await sh("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json", "number,headRefName,state,isDraft,title"], { cwd: repo.main, on: repo.on });
  const map = new Map();
  if (!r.ok) return map;
  for (const pr of JSON.parse(r.out || "[]")) if (!map.has(pr.headRefName)) map.set(pr.headRefName, pr);
  return map;
}

export async function defaultBranch(repo) {
  const r = await git(repo.main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo.on);
  return r.ok ? r.out.replace(/^origin\//, "") : "main";
}

export const worktreeDir = (repo, cfg) => fill(expand(cfg.worktrees, repo.home), { parent: repo.parent, repo: repo.name });
export const worktreePath = (repo, cfg, branch) => `${worktreeDir(repo, cfg)}/${branch}`;

// A checkout of `branch`: the one that exists, else a new one at the
// configured path, from the local branch, else origin's, else a fresh branch
// off the remote default. With `pr`, the branch comes from refs/pull/<n>/head
// (forks included) and never from the default branch: a PR worktree holding
// base code would look like the PR and isn't.
export async function upsert(repo, cfg, branch, { pr, fork = false } = {}) {
  const have = (await checkouts(repo)).find((c) => c.branch === branch);
  if (have) return { path: have.path, created: false };
  const path = worktreePath(repo, cfg, branch);
  if ((await sh("test", ["-d", path], { on: repo.on })).ok) return { path, created: false };

  if (pr) {
    // Refused when the local branch has diverged (your own commits): that branch is used as it is.
    const got = await git(repo.main, ["fetch", "origin", `pull/${pr}/head:${branch}`, "--quiet"], repo.on);
    if (!got.ok && !fork) await git(repo.main, ["fetch", "origin", branch, "--quiet"], repo.on);
    const attempts = [["worktree", "add", path, branch], ...(fork ? [] : [["worktree", "add", "-b", branch, path, `origin/${branch}`]])];
    let last;
    for (const args of attempts) {
      last = await git(repo.main, args, repo.on);
      if (last.ok) return { path, created: true };
    }
    throw new Error(got.ok ? last.err : got.err || `Couldn't fetch PR #${pr}.`);
  }

  const base = await defaultBranch(repo);
  await git(repo.main, ["fetch", "origin", base, "--quiet"], repo.on);
  await git(repo.main, ["fetch", "origin", branch, "--quiet"], repo.on);

  const attempts = [
    ["worktree", "add", path, branch],
    ["worktree", "add", "-b", branch, path, `origin/${branch}`],
    ["worktree", "add", "-b", branch, path, `origin/${base}`],
    ["worktree", "add", "-b", branch, path, base],
  ];
  let last;
  for (const args of attempts) {
    last = await git(repo.main, args, repo.on);
    if (last.ok) return { path, created: true };
  }
  throw new Error(last.err || "git worktree add failed.");
}

// Removes a checkout and its branch. `git branch -d` refuses squash-merged
// branches, which is most of them, so a merged or closed PR also allows -D.
export async function remove(repo, c, { force = false } = {}) {
  if (c.main) throw new Error("That is the main checkout.");
  const r = await git(repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), c.path], repo.on);
  if (!r.ok) throw new Error(r.err || "git worktree remove failed.");
  if (c.branch) {
    const soft = await git(repo.main, ["branch", "-d", c.branch], repo.on);
    if (!soft.ok && (c.pr?.state === "MERGED" || c.pr?.state === "CLOSED")) await git(repo.main, ["branch", "-D", c.branch], repo.on);
  }
}

export const finished = (c) => c.agent || c.pr?.state === "MERGED" || c.pr?.state === "CLOSED";

// What removing a checkout risks and why it is a candidate for cleanup.
export function why(c) {
  if (c.agent) return "agent worktree";
  if (c.pr?.state === "MERGED") return `#${c.pr.number} merged`;
  if (c.pr?.state === "CLOSED") return `#${c.pr.number} closed`;
  return "";
}

export async function prune(repo) {
  await git(repo.main, ["worktree", "prune"], repo.on);
}

export async function log(path, on) {
  const r = await git(path, ["log", "-n", "14", "--format=%h%x09%s%x09%cr"], on);
  return r.ok
    ? r.out
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"))
    : [];
}

export async function status(path, on) {
  const r = await git(path, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short"], on);
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}
