// Selects the next space in sidebar order: each worktree's space straight after its main checkout's.
// Bind with `mod.open:grove-next` in keys.json.

import { View, div } from "gpui-kit";
import { focused, openOverlay, closeOverlay, props } from "herdr";

export default class Launch extends View {
  init() {
    const f = focused();
    const self = props()?.overlay;
    if (self) closeOverlay(self);
    openOverlay({ mod: "grove", props: { step: 1, cwd: f?.cwd, space: f?.space }, kind: "popup", frame: "none", width: 2, height: 2 });
  }

  render() {
    return div();
  }
}
