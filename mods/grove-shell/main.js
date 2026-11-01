// Scratch shell in the focused pane's folder, shown as a dialog that closes
// when the shell exits. It runs in a herdr-core terminal with no parent, so it
// stays out of the agents list. Bind with `mod.open:grove-shell` in keys.json.

import { View, div } from "gpui-kit";
import { exec, focused, home, openOverlay, closeOverlay, props, notify } from "herdr";

export default class Shell extends View {
  init(_props, cx) {
    const self = props()?.overlay;
    const cwd = focused()?.cwd || home();
    cx.spawn(async () => {
      let r;
      try {
        r = await exec("hc", ["run", "--json", "--bg", "--rm", "--no-parent", "--cwd", cwd, "--", "zsh", "-i"]);
      } catch (e) {
        r = { code: 1, stdout: "", stderr: String(e?.message ?? e) };
      }
      if (self) closeOverlay(self);
      if (r.code !== 0) {
        notify({ title: "Scratch shell failed", body: r.stderr.trim() || r.stdout.trim(), level: "error" });
        return;
      }
      const { address } = JSON.parse(r.stdout);
      openOverlay({ kind: "dialog", modal: true, layout: { type: "block", content: { terminal: address } }, width: 0.8, height: 0.6 });
    });
  }

  render() {
    return div();
  }
}
