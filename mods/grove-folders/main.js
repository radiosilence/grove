// Opens Grove on zoxide's folders.
// Bind with `mod.open:grove-folders` in keys.json.

import { View, div } from "gpui-kit";
import { focused, openOverlay, closeOverlay, props } from "herdr";

export default class Launch extends View {
  init() {
    const f = focused();
    const self = props()?.overlay;
    if (self) closeOverlay(self);
    openOverlay({ mod: "grove", props: { mode: "folders", cwd: f?.cwd, space: f?.space }, kind: "dialog", width: 0.8, height: 0.74 });
  }

  render() {
    return div();
  }
}
