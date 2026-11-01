import { sh, json, expand } from "./lib.js";

const gh = (args, repo, slug) => sh("gh", slug ? [...args, "--repo", slug] : args, { cwd: repo?.main, on: repo?.on });

let me = null;
export async function login() {
  if (me) return me;
  const r = await sh("gh", ["api", "user", "-q", ".login"]);
  if (r.ok) me = r.out;
  return me;
}

export async function pullRequests(repo) {
  const r = await gh(["pr", "list", "--limit", "100", "--json", "number,title,author,headRefName,isCrossRepository,isDraft,updatedAt,reviewDecision,labels"], repo);
  if (!r.ok) throw new Error(r.err || "gh pr list failed.");
  return json(r.out, []).map((p) => ({
    kind: "pr",
    number: p.number,
    title: p.title,
    who: p.author?.login ?? "",
    branch: localBranch(p),
    head: p.headRefName,
    fork: p.isCrossRepository,
    draft: p.isDraft,
    review: p.reviewDecision,
    labels: (p.labels ?? []).map((l) => l.name),
    updated: Date.parse(p.updatedAt) / 1000 || 0,
  }));
}

export async function issues(repo) {
  const r = await gh(["issue", "list", "--limit", "200", "--json", "number,title,assignees,labels,updatedAt,author"], repo);
  if (!r.ok) throw new Error(r.err || "gh issue list failed.");
  return json(r.out, []).map((i) => ({
    kind: "issue",
    number: i.number,
    title: i.title,
    who: i.assignees?.[0]?.login ?? "",
    author: i.author?.login ?? "",
    labels: (i.labels ?? []).map((l) => l.name),
    updated: Date.parse(i.updatedAt) / 1000 || 0,
  }));
}

// A fork's head branch is often named like one here (its `main`), and git
// won't fetch into a branch that is checked out, so fork PRs get their own
// namespace.
export const localBranch = (p) => (p.isCrossRepository ? `pr/${p.number}` : p.headRefName);

// A reference typed or pasted into the box: a URL, owner/repo#N, or #N / N.
export function parseRef(text) {
  const q = text.trim();
  let m = q.match(/https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d+)/);
  if (m) return { owner: m[1], name: m[2], number: Number(m[4]), kind: m[3] === "pull" ? "pr" : "issue", label: `${m[1]}/${m[2]}#${m[4]}` };
  m = q.match(/(?:^|\s)([\w.-]+)\/([\w.-]+)#(\d+)(?:\s|$)/);
  if (m) return { owner: m[1], name: m[2], number: Number(m[3]), kind: null, label: `${m[1]}/${m[2]}#${m[3]}` };
  m = q.match(/^#?(\d+)$/);
  if (m) return { owner: null, name: null, number: Number(m[1]), kind: null, label: `#${m[1]}` };
  return null;
}

// The local checkout of owner/repo: <root>/<owner>/<repo>, else <root>/*/<repo>.
export async function localCheckout(cfg, home, owner, name) {
  const script = 'for p in "$1/$2/$3" "$1"/*/"$3"; do [ -e "$p/.git" ] && { printf %s "$p"; exit 0; }; done; exit 1';
  for (const root of cfg.workspace) {
    const r = await sh("sh", ["-c", script, "sh", expand(root, home), owner, name]);
    if (r.ok && r.out) return r.out;
  }
  return null;
}

// What a bare number names: GitHub numbers PRs and issues from one sequence,
// and `gh pr view` only finds PRs, so a miss there means an issue.
export async function resolve(repo, ref) {
  const slug = ref.owner ? `${ref.owner}/${ref.name}` : null;
  if (ref.kind !== "issue") {
    const pr = await gh(["pr", "view", String(ref.number), "--json", "number,title,headRefName,isCrossRepository"], repo, slug);
    if (pr.ok) {
      const p = json(pr.out, {});
      return { kind: "pr", number: p.number, title: p.title, branch: localBranch(p), fork: p.isCrossRepository };
    }
    if (ref.kind === "pr") throw new Error(pr.err || `No PR #${ref.number}.`);
  }
  const issue = await gh(["issue", "view", String(ref.number), "--json", "number,title"], repo, slug);
  if (!issue.ok) throw new Error(issue.err || `Nothing numbered #${ref.number}.`);
  const i = json(issue.out, {});
  return { kind: "issue", number: i.number, title: i.title };
}

// <n>-<kebab-title>, at most 48 characters of title: 931-rating-reconciliation.
export function issueSlug(n, title) {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s ? `${n}-${s}` : String(n);
}

function checks(rollup) {
  const out = { pass: 0, fail: 0, pending: 0 };
  for (const c of rollup ?? []) {
    const v = (c.conclusion || c.state || c.status || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) out.pass++;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) out.fail++;
    else out.pending++;
  }
  return out;
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}\n\n…` : text);

export async function prDetail(repo, number) {
  const r = await gh(
    ["pr", "view", String(number), "--json", "number,title,body,author,state,isDraft,reviewDecision,additions,deletions,changedFiles,headRefName,baseRefName,statusCheckRollup,url"],
    repo,
  );
  if (!r.ok) throw new Error(r.err || "gh pr view failed.");
  const p = json(r.out, {});
  return {
    title: p.title,
    number: p.number,
    url: p.url,
    state: p.isDraft ? "DRAFT" : p.state,
    who: p.author?.login,
    review: p.reviewDecision,
    diff: { add: p.additions, del: p.deletions, files: p.changedFiles },
    branches: `${p.headRefName} → ${p.baseRefName}`,
    checks: checks(p.statusCheckRollup),
    body: clip((p.body ?? "").trim() || "_No description._", 6000),
  };
}

export async function issueDetail(repo, number) {
  const r = await gh(["issue", "view", String(number), "--json", "number,title,body,author,state,labels,assignees,comments,url"], repo);
  if (!r.ok) throw new Error(r.err || "gh issue view failed.");
  const i = json(r.out, {});
  const comments = (i.comments ?? []).slice(-3).map((c) => `---\n\n**@${c.author?.login ?? "?"}**\n\n${c.body.trim()}`);
  return {
    title: i.title,
    number: i.number,
    url: i.url,
    state: i.state,
    who: i.author?.login,
    labels: (i.labels ?? []).map((l) => l.name),
    assignees: (i.assignees ?? []).map((a) => a.login),
    comments: (i.comments ?? []).length,
    body: clip([(i.body ?? "").trim() || "_No description._", ...comments].join("\n\n"), 8000),
  };
}
