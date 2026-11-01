import { sh } from "./lib.js";

// zoxide's folders, most frecent first.
export async function frecent() {
  const r = await sh("zoxide", ["query", "--list", "--score"]);
  if (!r.ok) throw new Error(r.err.includes("No such file") || !r.err ? "zoxide isn't installed." : r.err);
  return r.out
    .split("\n")
    .map((l) => l.trim().match(/^([\d.]+)\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ kind: "folder", path: m[2], score: Number(m[1]) }));
}

export const bump = (path) => sh("zoxide", ["add", "--", path]);

// A folder at a glance: its branch and recent commits in git, else what's in it.
export async function peek(path) {
  const script = [
    'cd "$1" 2>/dev/null || exit 3',
    "if b=$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null); then",
    '  printf "git\\t%s\\n" "$b"; git log -n 12 --format="%h%x09%s%x09%cr" 2>/dev/null',
    "else",
    '  printf "dir\\n"; ls -Ap | head -40',
    "fi",
  ].join("\n");
  const r = await sh("sh", ["-c", script, "sh", path]);
  if (!r.ok) return { missing: true };
  const [head, ...rest] = r.out.split("\n");
  const [kind, branch] = head.split("\t");
  return kind === "git" ? { branch, commits: rest.filter(Boolean).map((l) => l.split("\t")) } : { entries: rest.filter(Boolean) };
}
