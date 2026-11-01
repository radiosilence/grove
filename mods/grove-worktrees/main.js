// Opens Grove on the focused pane's worktrees.
// Bind with `mod.open:grove-worktrees` in keys.json.

import { View, div } from "gpui-kit";
import { focused, openOverlay, closeOverlay, props } from "herdr";

export default class Launch extends View {
  init() {
    const f = focused();
    const self = props()?.overlay;
    if (self) closeOverlay(self);
    openOverlay({ mod: "grove", props: { mode: "worktrees", cwd: f?.cwd, space: f?.space }, kind: "dialog", width: 0.8, height: 0.74 });
  }

  render() {
    return div();
  }
}
