import { exec, readTextFile, appHome } from "herdr";

// exec never throws here: a program that can't start reads as a failed run.
export async function sh(cmd, args, opts = {}) {
  try {
    const r = await exec(cmd, args, opts);
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

export const git = (cwd, args, on) => sh("git", args, { cwd, on });

export function json(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const DEFAULTS = {
  // Where `owner/repo#N` and URLs look for a local checkout: <root>/<owner>/<repo>, then <root>/*/<repo>.
  workspace: ["~/workspace"],
  // Worktrees sit beside their repo, so per-directory config (mise, direnv) scoped to the parent still applies.
  worktrees: "{parent}/worktrees/{repo}",
  // Typed into a new issue space's shell. Empty: start nothing.
  issueCommand: 'claude "Work issue #{number}"',
  // PR and issue lists open filtered to you.
  mine: true,
};

export async function loadConfig() {
  const text = await readTextFile(`${appHome()}/grove.json`).catch(() => null);
  const mine = text ? json(text, {}) : {};
  return { ...DEFAULTS, ...mine, workspace: [].concat(mine.workspace ?? DEFAULTS.workspace) };
}

export const expand = (path, home) => (home ? path.replace(/^~(?=\/|$)/, home) : path);
export const tilde = (path, home) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);
export const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

export function ago(when) {
  if (!when) return "";
  const s = Date.now() / 1000 - when;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  if (s < 86400 * 730) return `${Math.round(s / 86400 / 30)}mo`;
  return `${Math.round(s / 86400 / 365)}y`;
}

// How well one word matches: a substring beats a scattered subsequence, and
// an earlier or word-start hit beats a later one. -1: no match.
function wordScore(word, text) {
  const at = text.indexOf(word);
  if (at >= 0) {
    const boundary = at === 0 || /[\s/_\-.#@]/.test(text[at - 1]);
    return 1000 - Math.min(at, 500) + (boundary ? 200 : 0);
  }
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of word) {
    const j = text.indexOf(ch, i);
    if (j < 0) return -1;
    if (last >= 0) gaps += j - last - 1;
    last = j;
    i = j + 1;
  }
  return Math.max(1, 300 - gaps * 4);
}

// Every word of the query must match somewhere in the text.
export function score(query, text) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const hay = text.toLowerCase();
  let total = 0;
  for (const w of words) {
    const s = wordScore(w, hay);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

// Ranks rows by query, keeping the input order for ties (and when the query is empty).
export function rank(rows, query, textOf) {
  if (!query.trim()) return rows;
  return rows
    .map((r, i) => ({ r, i, s: score(query, textOf(r)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r);
}
