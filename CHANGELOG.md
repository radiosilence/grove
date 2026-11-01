# Changelog

## Unreleased

First version, from the worktree pickers and popups in radiosilence/dotfiles (`wt-herdr`, `popup-pr`, `popup-worktree`, `popup-space`, `popup-shell`, `space-next`, `space-prev`).

- One native dialog in place of fzf running in hidden terminals: rows show open spaces, uncommitted changes and PR state, and a preview pane shows the selection's commits, changes, PR or issue.
- Worktree removal and a clean-up of finished worktrees in the dialog, covering what `wtclean` did for the interactive case: clean worktrees only, never one with an open space.
- Fork PRs check out to `pr/<n>`, and a PR worktree never falls back to the default branch (radiosilence/dotfiles#117).
- Config in `grove.json` for the worktree path, workspace roots, the issue command and the `@me` filter, instead of constants in shell functions.
