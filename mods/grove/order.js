import { spaces, run } from "herdr";
import { sh } from "./lib.js";
import { place } from "./git.js";

async function repoKey(s) {
  const cwd = place(s);
  if (!cwd) return null;
  const r = await sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { cwd, on: s.machine });
  if (!r.ok) return null;
  const [common, top] = r.out.split("\n");
  return { repo: JSON.stringify([s.machine, common]), linked: common !== `${top}/.git` };
}

// Spaces in the order the sidebar draws them: each worktree's space straight
// after its main checkout's. space.next and space.prev follow creation order,
// which jumps around once worktrees are nested.
export async function sidebarOrder() {
  const list = await Promise.all(spaces().map(async (s) => ({ s, g: await repoKey(s) })));
  const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
  const nested = (r) => r.g?.linked && mains.has(r.g.repo);
  const out = [];
  const placed = new Set();
  for (const r of list) {
    if (nested(r)) continue;
    out.push(r.s);
    if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
    placed.add(r.g.repo);
    out.push(...list.filter((k) => nested(k) && k.g.repo === r.g.repo).map((k) => k.s));
  }
  return out;
}

export async function step(by) {
  const order = await sidebarOrder();
  const at = order.findIndex((s) => s.active);
  if (order.length < 2 || at < 0) return;
  run("space.select", { id: order[(at + by + order.length) % order.length].id });
}
