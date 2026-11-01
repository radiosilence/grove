// Grove: worktrees, pull requests, issues and frecent folders in one native
// dialog, each opened as a Herdr space. Props: { mode, cwd, space } to open on
// a tab and a folder, or { step: 1 | -1 } to move through spaces in sidebar
// order without showing anything.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { props, focused, spaces, theme, settings, run, closeOverlay, notify, home } from "herdr";
import { sh, json, loadConfig, tilde, ago, rank, fill, expand } from "./lib.js";
import * as G from "./git.js";
import * as H from "./github.js";
import * as F from "./folders.js";
import { step } from "./order.js";

const MODES = [
  { id: "worktrees", label: "Worktrees", icon: "branch", hint: "filter, or type a new branch name" },
  { id: "prs", label: "Pull requests", icon: "pr", hint: "filter, or paste a PR or issue URL" },
  { id: "issues", label: "Issues", icon: "issue", hint: "filter, or paste an issue URL" },
  { id: "folders", label: "Folders", icon: "folder", hint: "filter zoxide's folders, or type a path" },
];
const ROW = 48;
const icon = (name) => `mods/grove/icons/${name}.svg`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;
// Theme colors may already carry alpha (#rrggbbaa); the tint replaces it.
const tint = (c, a = "24") => (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c ?? "") ? `${c.slice(0, 7)}${a}` : c);
const inside = (p, dir) => p === dir || p.startsWith(`${dir}/`);

function remembered() {
  try {
    return localStorage.getItem("mode");
  } catch {
    return null;
  }
}
function remember(mode) {
  try {
    localStorage.setItem("mode", mode);
  } catch {}
}

export default class Grove extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.step) {
      this.headless = true;
      cx.spawn(async () => {
        await step(p.step);
        this.close();
      });
      return;
    }
    const f = focused();
    const space = spaces().find((s) => s.id === (p.space ?? f?.space));
    this.on = space?.machine ?? null;
    this.cwd = p.cwd || f?.cwd || (space && G.place(space)) || home();
    this.home = this.on ? null : home();
    this.mode = MODES.some((m) => m.id === p.mode) ? p.mode : (MODES.find((m) => m.id === remembered())?.id ?? "worktrees");
    this.queries = { worktrees: "", prs: "", issues: "", folders: "" };
    this.at = {};
    this.scroll = {};
    this.data = {};
    this.failed = {};
    this.details = new Map();
    this.busy = "";
    this.error = "";
    this.armed = null;
    this.repo = undefined;
    this.inputFocused = true;

    this.input = InputState.new({ placeholder: "Search" });
    this.input.on("change", (_e, cx) => {
      const v = this.input.value();
      if (v === this.queries[this.mode]) return;
      this.queries[this.mode] = v;
      this.at[this.mode] = 0;
      this.scroll[this.mode] = 0;
      this.armed = null;
      this.error = "";
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.act(this.rows()[this.at[this.mode] ?? 0], cx));
    this.input.on("focus", (_e, cx) => ((this.inputFocused = true), cx.notify()));
    this.input.on("blur", (_e, cx) => ((this.inputFocused = false), cx.notify()));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => {
      this.cfg = await loadConfig();
      if (this.on) this.home = (await sh("sh", ["-c", 'printf %s "$HOME"'], { on: this.on })).out || null;
      const repo = await G.repoOf(this.cwd, this.on);
      if (repo) repo.home = this.home;
      this.repo = repo;
      if (this.cfg.mine) this.queries.prs = this.queries.issues = "@me ";
      this.input.set_value(this.queries[this.mode]);
      if (!repo && !p.mode && this.mode !== "folders") this.mode = "folders";
      this.load(this.mode, cx);
      if (repo && this.mode !== "worktrees") this.load("worktrees", cx);
      cx.notify();
    });
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // ── Data ─────────────────────────────────────────────────────────────

  load(mode, cx, force = false) {
    if (!force && this.data[mode] !== undefined) return;
    if (!force) this.data[mode] = null;
    delete this.failed[mode];
    cx.spawn(async (cx) => {
      try {
        if (mode === "folders") this.data.folders = await F.frecent();
        else if (!this.repo) this.data[mode] = [];
        else if (mode === "worktrees") {
          const list = await G.checkouts(this.repo);
          this.data.worktrees = list;
          cx.notify();
          await this.enrich(list, cx);
        } else {
          const [list] = await Promise.all([mode === "prs" ? H.pullRequests(this.repo) : H.issues(this.repo), H.login().then((l) => (this.login = l))]);
          this.data[mode] = list;
        }
      } catch (e) {
        this.failed[mode] = String(e?.message ?? e);
        this.data[mode] ??= [];
      }
      cx.notify();
    });
  }

  // PR state comes from one gh call; uncommitted changes from a git status per
  // checkout, all at once, since on a monorepo each one walks the whole tree.
  async enrich(list, cx) {
    const prs = G.prsByBranch(this.repo).then((map) => {
      for (const c of list) c.pr = c.branch ? (map.get(c.branch) ?? null) : null;
      cx.notify();
    });
    const dirty = Promise.all(
      list.map(async (c) => {
        c.dirty = await G.dirtyCount(c.path, this.on);
      }),
    ).then(() => cx.notify());
    await Promise.all([prs, dirty]);
  }

  paths() {
    return (this.data.worktrees ?? []).map((c) => c.path);
  }

  // The checkout the focused pane is in: the deepest one containing it.
  here() {
    return (this.data.worktrees ?? []).filter((c) => inside(this.cwd, c.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path;
  }

  worktreeFor(x) {
    const list = this.data.worktrees ?? [];
    if (x.kind === "pr") return list.find((c) => c.branch === x.branch);
    return list.find((c) => c.branch === String(x.number) || c.branch?.startsWith(`${x.number}-`));
  }

  // "@me" in a query is the signed-in GitHub user.
  query() {
    const q = this.queries[this.mode] ?? "";
    return this.login ? q.replace(/(^|\s)@me(?=\s|$)/g, `$1@${this.login}`) : q;
  }

  rows() {
    const d = this.data[this.mode];
    if (!Array.isArray(d)) return [];
    const raw = this.queries[this.mode] ?? "";
    const q = this.query();
    const h = this.home;

    if (this.mode === "worktrees") {
      const paths = this.paths();
      const here = this.here();
      const rows = d.map((c) => ({ key: `wt:${c.path}`, kind: "worktree", c, space: G.spaceOf(c.path, this.on, paths), here: c.path === here }));
      const out = rank(rows, q, (r) => `${r.c.branch ?? "detached"} ${tilde(r.c.path, h)} ${r.c.pr ? `#${r.c.pr.number} ${r.c.pr.title}` : ""}`);
      const name = raw.trim();
      if (name && !/\s/.test(name) && !d.some((c) => c.branch === name)) out.push({ key: `new:${name}`, kind: "create", branch: name });
      if (!name) {
        const doomed = rows.filter((r) => !r.c.main && !r.space && !r.here && !r.c.locked && r.c.dirty === 0 && G.finished(r.c)).map((r) => r.c);
        if (doomed.length) out.push({ key: "sweep", kind: "sweep", doomed });
      }
      return out;
    }

    if (this.mode === "prs" || this.mode === "issues") {
      const rows = d.map((x) => ({ key: `${x.kind}:${x.number}`, kind: x.kind, x, wt: this.worktreeFor(x) }));
      const out = rank(rows, q, (r) => `#${r.x.number} @${r.x.who} ${r.x.title} ${r.x.branch ?? ""} ${r.x.labels.join(" ")}${r.x.draft ? " draft" : ""}`);
      const ref = H.parseRef(raw);
      if (ref && (ref.owner || !d.some((x) => x.number === ref.number))) out.unshift({ key: `ref:${ref.label}`, kind: "ref", ref });
      return out;
    }

    const rows = d.map((f) => ({ key: `dir:${f.path}`, kind: "folder", path: f.path, space: this.spaceAt(f.path) }));
    const out = rank(rows, q, (r) => tilde(r.path, h));
    const typed = raw.trim();
    if (/^[~/]/.test(typed)) {
      const path = expand(typed, h).replace(/\/+$/, "") || "/";
      if (!d.some((f) => f.path === path)) out.unshift({ key: `path:${path}`, kind: "path", path, space: this.spaceAt(path) });
    }
    return out;
  }

  // Folders open where a space already is, exactly: a parent folder isn't its repo's spaces.
  spaceAt(path) {
    return spaces().find((s) => !s.machine && G.place(s) === path);
  }

  // ── Actions ──────────────────────────────────────────────────────────

  work(cx, label, fn) {
    if (this.busy) return;
    this.busy = label;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!(await fn(cx))) return this.close();
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = "";
      cx.notify();
    });
  }

  // Selects the space already showing `path`, else makes one. `command` is
  // typed into a new space's shell, so it runs with the folder's environment
  // (mise, direnv) the way a person's own typing would.
  async openSpace(path, name, { command, on = this.on, exact = false } = {}) {
    const there = exact ? this.spaceAt(path) : G.spaceOf(path, on, this.paths());
    if (there) return run("space.select", { id: there.id });
    const args = { folder: path, ...(name ? { name } : {}), ...(on ? { machine: on } : {}) };
    if (command) {
      const r = await sh("herdr-app", ["do", "space.new", JSON.stringify(args)]);
      if (r.ok) {
        const terminal = json(r.out, {}).terminal;
        if (terminal) await sh("hc", ["send", terminal, command]);
        return;
      }
    }
    run("space.new", args);
  }

  async checkoutPR(repo, pr, on) {
    const { path } = await G.upsert(repo, this.cfg, pr.branch, { pr: pr.number, fork: pr.fork });
    await this.openSpace(path, pr.branch, { on });
  }

  async checkoutIssue(repo, issue, on) {
    const have = repo === this.repo ? this.worktreeFor({ kind: "issue", number: issue.number }) : null;
    const branch = have?.branch ?? H.issueSlug(issue.number, issue.title);
    const { path } = await G.upsert(repo, this.cfg, branch);
    const command = this.cfg.issueCommand ? fill(this.cfg.issueCommand, { number: issue.number, title: issue.title }) : null;
    await this.openSpace(path, branch, { command, on });
  }

  act(r, cx) {
    if (!r || this.busy) return;
    if (r.kind === "worktree") return this.work(cx, "Opening…", () => this.openSpace(r.c.path, r.c.branch ?? base(r.c.path)));
    if (r.kind === "create") {
      return this.work(cx, `Creating ${r.branch}…`, async () => {
        const { path } = await G.upsert(this.repo, this.cfg, r.branch);
        await this.openSpace(path, r.branch);
      });
    }
    if (r.kind === "sweep") return this.sweep(r, cx);
    if (r.kind === "pr") return this.work(cx, `Checking out #${r.x.number}…`, () => this.checkoutPR(this.repo, r.x));
    if (r.kind === "issue") return this.work(cx, `Starting on #${r.x.number}…`, () => this.checkoutIssue(this.repo, r.x));
    if (r.kind === "ref") return this.work(cx, `Looking up ${r.ref.label}…`, () => this.openRef(r.ref));
    if (r.kind === "folder" || r.kind === "path") {
      return this.work(cx, "Opening…", async () => {
        if (!(await sh("test", ["-d", r.path])).ok) throw new Error(`${tilde(r.path, this.home)} isn't a folder.`);
        F.bump(r.path);
        await this.openSpace(r.path, null, { on: null, exact: true });
      });
    }
  }

  // A pasted reference may name another repo: it opens from that repo's
  // checkout under the workspace roots, on this machine.
  async openRef(ref) {
    let repo = this.repo;
    let on = this.on;
    if (ref.owner) {
      const path = await H.localCheckout(this.cfg, home(), ref.owner, ref.name);
      if (!path) throw new Error(`No checkout of ${ref.owner}/${ref.name} under ${this.cfg.workspace.join(" or ")}.`);
      repo = await G.repoOf(path, null);
      if (repo) repo.home = home();
      on = null;
    }
    if (!repo) throw new Error("This folder isn't in a git repository. Paste a full URL instead.");
    const hit = await H.resolve(repo, ref);
    if (hit.kind === "pr") await this.checkoutPR(repo, hit, on);
    else await this.checkoutIssue(repo, hit, on);
  }

  remove(r, cx) {
    if (r?.kind !== "worktree") return;
    const c = r.c;
    if (c.main) {
      this.error = "That is the main checkout. It stays.";
      return;
    }
    if (this.armed !== r.key && this.armed !== `force:${r.key}`) {
      this.armed = r.key;
      this.error = "";
      return;
    }
    const force = this.armed === `force:${r.key}` || (c.dirty ?? 0) > 0;
    this.work(cx, `Removing ${c.branch ?? base(c.path)}…`, async (cx) => {
      try {
        await G.remove(this.repo, c, { force });
      } catch (e) {
        this.armed = `force:${r.key}`;
        throw new Error(`${e.message} ⌃X again forces it.`);
      }
      this.armed = null;
      if (r.space) run("space.close", { id: r.space.id, confirmed: true });
      this.load("worktrees", cx, true);
      return true;
    });
  }

  sweep(r, cx) {
    if (this.armed !== "sweep") {
      this.armed = "sweep";
      return cx.notify();
    }
    this.armed = null;
    this.work(cx, `Removing ${r.doomed.length} worktree${r.doomed.length > 1 ? "s" : ""}…`, async (cx) => {
      const results = await Promise.allSettled(r.doomed.map((c) => G.remove(this.repo, c)));
      await G.prune(this.repo);
      const failed = results.map((x, i) => [x, r.doomed[i]]).filter(([x]) => x.status === "rejected");
      const gone = results.length - failed.length;
      notify({
        title: `Removed ${gone} worktree${gone === 1 ? "" : "s"}`,
        body: failed.length ? `Kept ${failed.map(([, c]) => c.branch).join(", ")}: ${failed[0][0].reason?.message ?? "git refused"}` : r.doomed.map((c) => c.branch).join(", "),
        level: failed.length ? "warning" : "success",
      });
      this.load("worktrees", cx, true);
      return true;
    });
  }

  browse(r) {
    if (!r) return;
    const opts = { cwd: this.repo?.main, on: this.on };
    if (r.kind === "pr" || r.kind === "issue") sh("gh", [r.kind, "view", String(r.x.number), "--web"], opts);
    else if (r.kind === "worktree" && r.c.pr) sh("gh", ["pr", "view", String(r.c.pr.number), "--web"], opts);
    else if ((r.kind === "folder" || r.kind === "path") && !this.on) sh("open", [r.path]);
  }

  setMode(id, cx) {
    if (id === this.mode) return;
    this.mode = id;
    this.armed = null;
    this.error = "";
    remember(id);
    this.input.set_value(this.queries[id]);
    this.input.focus();
    if (this.repo !== undefined) this.load(id, cx);
    cx.notify();
  }

  key(e, cx) {
    const k = e.key;
    const ctrl = e.modifiers.control;
    const rows = this.rows();
    const n = rows.length;
    const at = this.at[this.mode] ?? 0;
    const go = (to) => {
      this.at[this.mode] = to;
      this.armed = null;
      this.error = "";
    };
    if (k === "escape") {
      if (this.armed || this.error) {
        this.armed = null;
        this.error = "";
      } else return this.close();
    } else if ((k === "down" || (ctrl && k === "n")) && n) go((at + 1) % n);
    else if ((k === "up" || (ctrl && k === "p")) && n) go((at + n - 1) % n);
    else if (k === "pagedown" && n) go(Math.min(n - 1, at + 8));
    else if (k === "pageup" && n) go(Math.max(0, at - 8));
    else if (k === "tab") {
      const i = MODES.findIndex((m) => m.id === this.mode);
      this.setMode(MODES[(i + (e.modifiers.shift ? MODES.length - 1 : 1)) % MODES.length].id, cx);
    } else if (ctrl && k === "x") this.remove(rows[at], cx);
    else if (ctrl && k === "r") {
      this.details.clear();
      this.load(this.mode, cx, true);
    } else if (ctrl && k === "o") this.browse(rows[at]);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ── Preview data ─────────────────────────────────────────────────────

  detailKey(r) {
    return ["worktree", "pr", "issue", "folder"].includes(r?.kind) ? r.key : null;
  }

  async fetchDetail(r) {
    if (r.kind === "worktree") {
      const [commits, changes] = await Promise.all([G.log(r.c.path, this.on), G.status(r.c.path, this.on)]);
      return { commits, changes };
    }
    if (r.kind === "pr") return H.prDetail(this.repo, r.x.number);
    if (r.kind === "issue") return H.issueDetail(this.repo, r.x.number);
    return F.peek(r.path);
  }

  // Fetched once the selection rests, so holding an arrow key doesn't start a gh call per row.
  want(r, cx) {
    const key = this.detailKey(r);
    if (!key || this.details.has(key) || this.pending === key) return;
    this.pending = key;
    cx.timer.after(140, (cx) => {
      if (this.pending !== key || this.details.has(key)) return;
      this.details.set(key, { loading: true });
      cx.spawn(async (cx) => {
        let v;
        try {
          v = await this.fetchDetail(r);
        } catch (e) {
          v = { error: String(e?.message ?? e) };
        }
        this.details.set(key, v);
        if (this.pending === key) this.pending = null;
        cx.notify();
      });
    });
  }

  // ── Render ───────────────────────────────────────────────────────────

  chip(text, color) {
    return div().flex_none().px(6).py(1).rounded(5).text_size(10.5).font_medium().text_color(color).bg(tint(color, "1f")).child(text);
  }

  kbd(keys, label, t) {
    return h_flex().gap(5).items_center().child(div().px(5).rounded(4).bg(t.raised).border(1).border_color(t.border).text_color(t.muted).child(keys)).child(div().text_color(t.dim).child(label));
  }

  prColor(pr, t) {
    if (!pr) return t.dim;
    if (pr.isDraft || pr.state === "DRAFT") return t.dim;
    return { OPEN: t.ansi2, MERGED: t.ansi5, CLOSED: t.ansi1 }[pr.state] ?? t.dim;
  }

  tile(name, color) {
    return h_flex()
      .flex_none()
      .size(28)
      .rounded(8)
      .items_center()
      .justify_center()
      .bg(tint(color, "22"))
      .child(svg(icon(name)).size(15).text_color(color));
  }

  row(t, r, on, i) {
    const h = this.home;
    let tileName = "branch";
    let color = t.muted;
    let title = "";
    let sub = "";
    const right = [];
    const armed = this.armed === r.key || this.armed === `force:${r.key}` || (r.kind === "sweep" && this.armed === "sweep");

    if (r.kind === "worktree") {
      const c = r.c;
      color = c.main ? t.accent : c.agent ? t.ansi5 : c.pr ? this.prColor(c.pr, t) : t.muted;
      title = c.branch ?? "detached HEAD";
      sub = tilde(c.path, h);
      if (c.main) right.push(this.chip("main", t.accent));
      if (c.agent) right.push(this.chip("agent", t.ansi5));
      if (c.locked) right.push(this.chip("locked", t.dim));
      if (c.dirty > 0) right.push(this.chip(`${c.dirty} changed`, t.ansi3));
      if (c.pr) right.push(this.chip(`#${c.pr.number} ${c.pr.isDraft ? "draft" : c.pr.state.toLowerCase()}`, this.prColor(c.pr, t)));
      if (r.here) right.push(this.chip("here", t.foreground));
      else if (r.space) right.push(this.chip("open", t.accent));
      if (c.at) right.push(div().w(30).text_size(11).text_color(t.dim).child(ago(c.at)));
    } else if (r.kind === "create") {
      tileName = "plus";
      color = t.accent;
      title = `Create ${r.branch}`;
      sub = this.repo ? tilde(G.worktreePath(this.repo, this.cfg, r.branch), h) : "";
    } else if (r.kind === "sweep") {
      tileName = "trash";
      color = t.ansi1;
      title = `Clean up ${r.doomed.length} finished worktree${r.doomed.length > 1 ? "s" : ""}`;
      sub = r.doomed.map((c) => c.branch ?? base(c.path)).join(", ");
    } else if (r.kind === "pr" || r.kind === "issue") {
      const x = r.x;
      tileName = r.kind;
      color = r.kind === "pr" ? (x.draft ? t.dim : t.ansi2) : t.ansi2;
      title = x.title;
      sub = [`#${x.number}`, x.who ? `@${x.who}` : "unassigned", r.kind === "pr" ? (x.fork ? `fork: ${x.head}` : x.branch) : x.labels.join(", ")].filter(Boolean).join(" · ");
      if (x.draft) right.push(this.chip("draft", t.dim));
      if (x.review === "APPROVED") right.push(this.chip("approved", t.ansi2));
      if (x.review === "CHANGES_REQUESTED") right.push(this.chip("changes", t.ansi1));
      if (r.wt) right.push(this.chip(G.spaceOf(r.wt.path, this.on, this.paths()) ? "open" : "worktree", t.accent));
      right.push(div().w(30).text_size(11).text_color(t.dim).child(ago(x.updated)));
    } else if (r.kind === "ref") {
      tileName = "link";
      color = t.accent;
      title = `Open ${r.ref.label}`;
      sub = r.ref.kind === "issue" ? "issue → worktree" : "PR or issue → worktree";
    } else {
      tileName = r.kind === "path" ? "plus" : "folder";
      color = r.space ? t.accent : t.muted;
      title = r.kind === "path" ? `Open ${tilde(r.path, h)}` : base(r.path);
      sub = tilde(r.path, h);
      if (r.space) right.push(this.chip("open", t.accent));
    }

    if (armed) {
      right.length = 0;
      const lose = r.kind === "worktree" && r.c.dirty > 0 ? ` · ${r.c.dirty} uncommitted change${r.c.dirty > 1 ? "s" : ""} lost` : "";
      right.push(
        div()
          .text_size(11.5)
          .font_medium()
          .text_color(t.blocked)
          .child(r.kind === "sweep" ? "↵ again to remove" : `⌃X again to remove${lose}`),
      );
    }

    return h_flex()
      .id(`row-${r.key}`)
      .h(ROW - 4)
      .px(10)
      .gap(10)
      .items_center()
      .rounded(9)
      .cursor_pointer()
      .when(on, (el) => el.bg(armed ? tint(t.blocked, "1c") : t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        this.at[this.mode] = i;
        this.act(r, cx);
      })
      .child(this.tile(tileName, color))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(
            div()
              .truncate()
              .text_color(t.foreground)
              .when(r.here === true, (d) => d.font_semibold())
              .child(title),
          )
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(sub)),
      )
      .child(h_flex().flex_none().gap(6).items_center().children(right));
  }

  list(t, rows, at) {
    const mode = this.mode;
    const d = this.data[mode];
    const needsRepo = mode !== "folders";
    const message = (text, color = t.dim) => v_flex().flex_1().items_center().justify_center().gap(8).p(24).text_color(color).child(text);

    if (needsRepo && this.repo === null) return message(`${tilde(this.cwd, this.home)} isn't in a git repository. Tab over to Folders to pick one.`);
    if (this.repo === undefined || d === null || d === undefined) {
      return message(
        h_flex()
          .gap(8)
          .items_center()
          .child(svg(icon("spinner")).size(14).text_color(t.dim).spin(900))
          .child("Loading…"),
      );
    }
    if (this.failed[mode] && !rows.length) return message(this.failed[mode], t.blocked);
    if (!rows.length) return message(this.queries[mode]?.trim() ? "Nothing matches." : "Nothing here yet.");

    const height = this.listH ?? 360;
    const total = rows.length * ROW;
    let scroll = this.scroll[mode] ?? 0;
    if (at * ROW < scroll) scroll = at * ROW;
    if ((at + 1) * ROW > scroll + height) scroll = (at + 1) * ROW - height;
    scroll = clamp(scroll, 0, Math.max(0, total - height));
    this.scroll[mode] = scroll;
    const first = Math.floor(scroll / ROW);
    const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 1);
    const maxScroll = Math.max(0, total - height);

    return div()
      .id("grove-list")
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .on_size_change((size, cx) => {
        const h = size.height / (settings().zoom || 1);
        if (Math.abs(h - (this.listH ?? 0)) > 0.5) {
          this.listH = h;
          cx.notify();
        }
      })
      .on_scroll_wheel((e, cx) => {
        const s = clamp((this.scroll[mode] ?? 0) - e.delta.y, 0, maxScroll);
        this.scroll[mode] = s;
        // The selection follows the wheel, so the next frame doesn't scroll back to it.
        let a = this.at[mode] ?? 0;
        a = clamp(a, Math.ceil(s / ROW), Math.max(Math.ceil(s / ROW), Math.floor((s + height) / ROW) - 1));
        this.at[mode] = Math.min(a, rows.length - 1);
        cx.notify();
      })
      .children(
        rows.slice(first, last).map((r, j) =>
          div()
            .absolute()
            .left(8)
            .right(8)
            .top((first + j) * ROW - scroll + 2)
            .child(this.row(t, r, first + j === at, first + j)),
        ),
      );
  }

  section(title, t, count) {
    return h_flex()
      .gap(6)
      .items_center()
      .pt(4)
      .text_size(10.5)
      .font_semibold()
      .text_color(t.dim)
      .child(title.toUpperCase())
      .when(count != null, (el) => el.child(div().text_color(t.dim).child(String(count))));
  }

  commits(list, t) {
    const mono = settings().font ?? "JetBrains Mono";
    return v_flex()
      .gap(3)
      .children(
        list.map(([hash, subject, when], i) =>
          h_flex()
            .id(`c-${i}`)
            .gap(8)
            .text_size(12)
            .child(div().flex_none().font_family(mono).text_size(11).text_color(t.ansi3).child(hash))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(subject))
            .child(
              div()
                .flex_none()
                .text_size(11)
                .text_color(t.dim)
                .child(when ?? ""),
            ),
        ),
      );
  }

  preview(t, r) {
    const shell = (...kids) => v_flex().id("grove-preview").flex_1().min_w(0).min_h(0).gap(10).px(16).py(12).border_l(1).border_color(t.border).overflow_y_scroll().children(kids);
    const head = (title, sub) =>
      v_flex()
        .gap(3)
        .child(div().text_size(14.5).font_semibold().text_color(t.foreground).child(title))
        .when(Boolean(sub), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(sub)));
    const prose = (text) => div().text_color(t.muted).line_height(19).child(text);
    if (!r) return shell();
    const h = this.home;
    const key = this.detailKey(r);
    const d = key ? this.details.get(key) : null;
    const wait = () =>
      h_flex()
        .gap(8)
        .items_center()
        .text_color(t.dim)
        .child(svg(icon("spinner")).size(13).text_color(t.dim).spin(900))
        .child("Loading…");
    const failed = d?.error ? div().text_color(t.blocked).child(d.error) : null;

    if (r.kind === "worktree") {
      const c = r.c;
      const chips = [];
      if (c.main) chips.push(this.chip("main checkout", t.accent));
      if (c.agent) chips.push(this.chip("agent worktree", t.ansi5));
      if (c.dirty === 0) chips.push(this.chip("clean", t.ansi2));
      if (c.dirty > 0) chips.push(this.chip(`${c.dirty} uncommitted`, t.ansi3));
      if (c.at) chips.push(this.chip(`committed ${ago(c.at)} ago`, t.dim));
      return shell(
        head(c.branch ?? "detached HEAD", tilde(c.path, h)),
        h_flex().gap(6).flex_wrap().children(chips),
        c.pr
          ? h_flex()
              .gap(8)
              .items_center()
              .child(svg(icon("pr")).size(13).text_color(this.prColor(c.pr, t)))
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`#${c.pr.number} ${c.pr.title}`))
          : null,
        !d || d.loading ? wait() : failed,
        d?.changes?.length ? this.section("Changes", t, d.changes.length) : null,
        d?.changes?.length
          ? v_flex()
              .gap(2)
              .children(
                d.changes.slice(0, 12).map((l, i) => {
                  const m = l.match(/^\s*(\S+)\s+(.*)$/) ?? [l, "", l];
                  return h_flex()
                    .id(`ch-${i}`)
                    .gap(8)
                    .text_size(12)
                    .child(
                      div()
                        .w(18)
                        .flex_none()
                        .text_color(m[1].includes("D") ? t.ansi1 : m[1].includes("?") ? t.dim : t.ansi3)
                        .child(m[1]),
                    )
                    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(m[2]));
                }),
              )
              .when(d.changes.length > 12, (el) =>
                el.child(
                  div()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(`and ${d.changes.length - 12} more`),
                ),
              )
          : null,
        d?.commits?.length ? this.section("Recent commits", t) : null,
        d?.commits?.length ? this.commits(d.commits, t) : null,
      );
    }

    if (r.kind === "pr" || r.kind === "issue") {
      const x = r.x;
      if (!d || d.loading) return shell(head(x.title, `#${x.number}`), wait());
      if (failed) return shell(head(x.title, `#${x.number}`), failed);
      const chips = [];
      const stateColor = { OPEN: t.ansi2, MERGED: t.ansi5, CLOSED: t.ansi1, DRAFT: t.dim }[d.state] ?? t.dim;
      chips.push(this.chip(d.state.toLowerCase(), stateColor));
      if (d.who) chips.push(this.chip(`@${d.who}`, t.muted));
      if (r.kind === "pr") {
        chips.push(this.chip(`+${d.diff.add} −${d.diff.del}`, t.muted));
        chips.push(this.chip(`${d.diff.files} file${d.diff.files === 1 ? "" : "s"}`, t.muted));
        if (d.checks.fail) chips.push(this.chip(`${d.checks.fail} failing`, t.ansi1));
        if (d.checks.pending) chips.push(this.chip(`${d.checks.pending} running`, t.ansi3));
        if (d.checks.pass && !d.checks.fail && !d.checks.pending) chips.push(this.chip("checks pass", t.ansi2));
        if (d.review === "APPROVED") chips.push(this.chip("approved", t.ansi2));
        if (d.review === "CHANGES_REQUESTED") chips.push(this.chip("changes requested", t.ansi1));
      } else {
        for (const l of d.labels) chips.push(this.chip(l, t.accent));
        if (d.assignees.length) chips.push(this.chip(d.assignees.map((a) => `@${a}`).join(" "), t.muted));
        if (d.comments) chips.push(this.chip(`${d.comments} comment${d.comments === 1 ? "" : "s"}`, t.dim));
      }
      const where = r.wt ? tilde(r.wt.path, h) : r.kind === "pr" ? d.branches : `branch ${H.issueSlug(x.number, x.title)}`;
      return shell(
        head(d.title, `#${d.number} · ${where}`),
        h_flex().gap(6).flex_wrap().children(chips),
        div().h(1).bg(t.border),
        TextView.markdown(`md-${key}`, d.body).selectable(true).text_size(12.5).text_color(t.muted),
      );
    }

    if (r.kind === "folder") {
      return shell(
        head(base(r.path), tilde(r.path, h)),
        !d || d.loading ? wait() : null,
        d?.missing ? div().text_color(t.blocked).child("This folder no longer exists. zoxide will forget it in time.") : null,
        d?.branch
          ? h_flex()
              .gap(6)
              .child(this.chip(d.branch, t.accent))
              .when(Boolean(r.space), (el) => el.child(this.chip("open in a space", t.muted)))
          : null,
        d?.commits?.length ? this.section("Recent commits", t) : null,
        d?.commits?.length ? this.commits(d.commits, t) : null,
        d?.entries ? this.section("Contents", t, d.entries.length) : null,
        d?.entries
          ? v_flex()
              .gap(2)
              .children(
                d.entries.map((e, i) =>
                  div()
                    .id(`e-${i}`)
                    .text_size(12)
                    .text_color(e.endsWith("/") ? t.foreground : t.muted)
                    .child(e),
                ),
              )
          : null,
      );
    }

    if (r.kind === "create") {
      return shell(
        head(`New worktree: ${r.branch}`, this.repo ? tilde(G.worktreePath(this.repo, this.cfg, r.branch), h) : ""),
        prose(
          `Checks out ${r.branch} if it exists here or on origin; otherwise starts a new branch from origin's default branch. It opens as a space named ${r.branch}, nested under ${this.repo?.name ?? "its repo"} in the sidebar.`,
        ),
      );
    }

    if (r.kind === "sweep") {
      return shell(
        head("Clean up finished worktrees", `${r.doomed.length} in ${this.repo?.name ?? ""}`),
        prose(
          "Worktrees whose PR is merged or closed, and worktrees left by agents. Each one is clean and has no space open; anything with uncommitted changes stays. Branches go with them when their PR is finished.",
        ),
        v_flex()
          .gap(4)
          .children(
            r.doomed.map((c, i) =>
              h_flex()
                .id(`d-${i}`)
                .gap(8)
                .items_center()
                .child(svg(icon("branch")).size(12).text_color(t.dim))
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_color(t.foreground)
                    .child(c.branch ?? base(c.path)),
                )
                .child(div().text_size(11).text_color(t.dim).child(G.why(c))),
            ),
          ),
      );
    }

    if (r.kind === "ref") {
      const where = r.ref.owner ? `from the ${r.ref.owner}/${r.ref.name} checkout under ${this.cfg.workspace.join(" or ")}` : `in ${this.repo?.name ?? "this repo"}`;
      return shell(
        head(r.ref.label, "Look up on GitHub"),
        prose(
          `A PR is checked out from refs/pull/${r.ref.number}/head, which works for forks too. An issue gets a worktree named after it${this.cfg.issueCommand ? `, and its space starts with: ${fill(this.cfg.issueCommand, { number: r.ref.number, title: "…" })}` : ""}. Opens ${where}.`,
        ),
      );
    }

    return shell(head(tilde(r.path, h), r.space ? "Open in a space" : "New space here"));
  }

  header(t) {
    const count = (id) => {
      const d = this.data[id];
      return Array.isArray(d) && (id === "folders" || this.repo) ? String(d.length) : "";
    };
    const where = this.repo ? this.repo.name : tilde(this.cwd, this.home);
    return h_flex()
      .px(14)
      .pt(12)
      .pb(10)
      .gap(4)
      .items_center()
      .children(
        MODES.map((m) => {
          const on = m.id === this.mode;
          return h_flex()
            .id(`mode-${m.id}`)
            .h(28)
            .px(10)
            .gap(7)
            .items_center()
            .rounded(8)
            .cursor_pointer()
            .text_color(on ? t.foreground : t.muted)
            .when(on, (el) => el.bg(t.selected))
            .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
            .on_click((_e, cx) => this.setMode(m.id, cx))
            .child(
              svg(icon(m.icon))
                .size(14)
                .text_color(on ? t.accent : t.dim),
            )
            .child(div().font_medium().child(m.label))
            .when(Boolean(count(m.id)), (el) => el.child(div().text_size(11).text_color(t.dim).child(count(m.id))));
        }),
      )
      .child(div().flex_1())
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .px(8)
          .h(24)
          .rounded(7)
          .bg(t.raised)
          .text_size(11.5)
          .text_color(t.muted)
          .child(svg(icon("tree")).size(12).text_color(t.accent))
          .child(where)
          .when(Boolean(this.repo?.linked), (el) => el.child(div().text_color(t.dim).child("worktree")))
          .when(Boolean(this.on), (el) => el.child(div().text_color(t.dim).child(`on ${this.on}`))),
      );
  }

  search(t) {
    const loading = this.data[this.mode] === null || this.repo === undefined;
    return h_flex()
      .mx(14)
      .h(38)
      .flex_none()
      .px(11)
      .gap(9)
      .items_center()
      .rounded(10)
      .border(1)
      .border_color(this.inputFocused ? t.accent : t.input)
      .bg(t.background)
      .child(svg(icon("search")).size(15).text_color(t.dim))
      .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
      .when(loading, (el) => el.child(svg(icon("spinner")).size(13).text_color(t.dim).spin(900)))
      .when(!loading, (el) =>
        el.child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(MODES.find((m) => m.id === this.mode).hint),
        ),
      );
  }

  footer(t, sel) {
    const left = this.busy
      ? h_flex()
          .gap(8)
          .items_center()
          .text_color(t.muted)
          .child(svg(icon("spinner")).size(12).text_color(t.accent).spin(900))
          .child(this.busy)
      : this.error
        ? div().flex_1().min_w(0).truncate().text_color(t.blocked).child(this.error)
        : this.failed[this.mode] && this.rows().length
          ? div().flex_1().min_w(0).truncate().text_color(t.ansi3).child(this.failed[this.mode])
          : null;
    const verb = { worktree: "open", create: "create", sweep: "clean up", pr: "check out", issue: "start", ref: "look up", folder: "open", path: "open" }[sel?.kind] ?? "open";
    const keys = [this.kbd("↵", verb, t), this.kbd("⇥", "switch", t)];
    if (sel?.kind === "worktree" && !sel.c.main) keys.push(this.kbd("⌃X", "remove", t));
    if (sel && (sel.kind === "pr" || sel.kind === "issue" || (sel.kind === "worktree" && sel.c.pr) || ((sel.kind === "folder" || sel.kind === "path") && !this.on)))
      keys.push(this.kbd("⌃O", sel.kind === "folder" || sel.kind === "path" ? "finder" : "browser", t));
    keys.push(this.kbd("⌃R", "refresh", t));
    return h_flex()
      .px(16)
      .h(36)
      .flex_none()
      .gap(14)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .text_size(11)
      .child(left ?? div().flex_1())
      .when(Boolean(left), (el) => el.child(div().flex_1()))
      .children(keys);
  }

  render(cx) {
    if (this.headless) return div();
    const t = theme();
    const rows = this.rows();
    const at = clamp(this.at[this.mode] ?? 0, 0, Math.max(0, rows.length - 1));
    this.at[this.mode] = at;
    const sel = rows[at];
    this.want(sel, cx);
    const wide = (this.width ?? 900) >= 760;
    return v_flex()
      .id("grove")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        const w = size.width / (settings().zoom || 1);
        if (Math.abs(w - (this.width ?? 0)) > 0.5) {
          this.width = w;
          cx.notify();
        }
      })
      .size_full()
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .child(this.header(t))
      .child(this.search(t))
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .mt(10)
          .border_t(1)
          .border_color(t.border)
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .min_h(0)
              .pt(4)
              .child(this.list(t, rows, at)),
          )
          .when(wide, (el) => el.child(this.preview(t, sel))),
      )
      .child(this.footer(t, sel));
  }
}
