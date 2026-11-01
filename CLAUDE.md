# grove

Commit and push straight to `main`; no PRs. Saving a file reloads the mods in a running Herdr window, and nothing deploys from this repo.

Run `herdr-app check` on every mod folder you touch (`mise run check`, in the background) and `oxlint mods` / `oxfmt mods` before pushing. Keep `README.md`, `RECIPE.md` and `CHANGELOG.md` in step with behaviour: herdr.dev builds its listing from the recipe.
