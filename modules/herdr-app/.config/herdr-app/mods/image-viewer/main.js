// An image viewer dialog: the picture drawn by the GPU, zoomed with the wheel around
// the pointer, panned by dragging, double-click toggling fit and 100%.
//
// Opened by `herdr-app do mod.open --name image-viewer` (the inline-images Claude Code
// plugin does this): opened that way it is a launcher, which reads the request the
// opener wrote to data/image-viewer/request.json ({ file, width, height, name }, file
// relative to this home, as image() wants), opens itself as a dialog with it, and
// closes. Keys: + / - zoom, 0 fits, 1 shows 100%, arrows or h/j/k/l pan, q or Esc close.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, openOverlay, closeOverlay, notify, theme, appHome } from "herdr";
import * as fs from "fs/promises";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export default class ImageViewer extends View {
  init(_props, cx) {
    const p = props();
    if (!p?.file) {
      // Launcher: hand the request to a dialog copy, then go. Closing this copy ends
      // its task, so it closes only once the request is read.
      cx.spawn(async () => {
        try {
          const req = JSON.parse(await fs.readFile(`${appHome()}/data/image-viewer/request.json`, "utf8"));
          if (!req?.file) throw new Error("no image in the request");
          if (p?.overlay) closeOverlay(p.overlay);
          openOverlay({ mod: "image-viewer", kind: "dialog", width: 0.94, height: 0.92, props: req });
        } catch (e) {
          if (p?.overlay) closeOverlay(p.overlay);
          notify({ title: "Couldn't open the image", body: String(e?.message ?? e), level: "error" });
        }
      });
      return;
    }
    this.size = null; // the picture area, logical px
    this.view = null; // { scale, x, y }: the picture's scale and its top-left in the area
    this.drag = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  fitScale() {
    const { width, height } = props();
    return Math.min(1, this.size.width / width, this.size.height / height);
  }

  // The picture at `scale`, centred.
  centred(scale) {
    const { width, height } = props();
    return { scale, x: (this.size.width - width * scale) / 2, y: (this.size.height - height * scale) / 2 };
  }

  // Zoom by `factor`, keeping the picture's point under (px, py) where it is.
  zoom(factor, px = this.size.width / 2, py = this.size.height / 2) {
    const v = this.view;
    const scale = clamp(v.scale * factor, Math.min(MIN_ZOOM, this.fitScale()), MAX_ZOOM);
    const k = scale / v.scale;
    this.view = { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
  }

  pan(dx, dy) {
    this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
  }

  key(e) {
    const raw = e.key ?? "", k = raw.length === 1 ? raw.toLowerCase() : raw;
    const step = 80;
    switch (k) {
      case "+": case "=": this.zoom(1.25); return true;
      case "-": case "_": this.zoom(1 / 1.25); return true;
      case "0": this.view = this.centred(this.fitScale()); return true;
      case "1": this.view = this.centred(1); return true;
      case "left": case "h": this.pan(step, 0); return true;
      case "right": case "l": this.pan(-step, 0); return true;
      case "up": case "k": this.pan(0, step); return true;
      case "down": case "j": this.pan(0, -step); return true;
      case "q": closeOverlay(props().overlay); return true;
      default: return false;
    }
  }

  render(cx) {
    const p = props();
    if (!p?.file) return div();
    const t = theme();
    const { width, height, name, file } = p;
    if (this.size && !this.view) this.view = this.centred(this.fitScale());
    const v = this.view;

    const area = div()
      .id("image-area")
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .bg(t.canvas)
      .when(Boolean(this.drag), (el) => el.cursor_grabbing())
      .when(!this.drag, (el) => el.cursor_grab())
      .on_size_change((size, cx) => {
        const first = !this.size;
        this.size = size;
        if (first || !this.view) this.view = this.centred(this.fitScale());
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        if (!this.view) return;
        cx.stop_propagation();
        // Lines (a wheel) step a notch at a time; pixels (a trackpad) zoom smoothly.
        const dy = e.delta_lines ? e.delta_lines.y * 40 : e.delta.y;
        const at = e.local_position ?? { x: this.size.width / 2, y: this.size.height / 2 };
        this.zoom(Math.exp(dy * 0.0035), at.x, at.y);
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.handle.focus();
        if (e.click_count >= 2 && this.view) {
          const fit = this.fitScale();
          const at = e.local_position ?? { x: this.size.width / 2, y: this.size.height / 2 };
          // Double-click: 100% around the pointer, or back to fit.
          if (Math.abs(this.view.scale - fit) < 1e-3 && fit < 1) this.zoom(1 / this.view.scale, at.x, at.y);
          else this.view = this.centred(fit);
          this.drag = null;
        } else this.drag = { x: e.position.x, y: e.position.y };
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag || !this.view) return;
        this.pan(e.position.x - this.drag.x, e.position.y - this.drag.y);
        this.drag = { x: e.position.x, y: e.position.y };
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { this.drag = null; cx.notify(); })
      .on_hover((over, cx) => { if (!over && this.drag) { this.drag = null; cx.notify(); } })
      .when(Boolean(v), (el) => el.child(
        image(file).absolute().left(v.x).top(v.y).w(width * v.scale).h(height * v.scale),
      ));

    return v_flex()
      .id("image-viewer")
      .size_full()
      .bg(t.background)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (this.key(e)) { cx.stop_propagation(); cx.notify(); } })
      .child(area)
      .child(h_flex().h(30).flex_none().px(12).gap(12).items_center().border_t(1).border_color(t.border).text_size(12)
        .child(div().min_w(0).truncate().text_color(t.foreground).child(name ?? file))
        .child(div().flex_none().text_color(t.dim).child(`${width}×${height}`))
        .child(div().flex_none().text_color(t.muted).child(v ? `${Math.round(v.scale * 100)}%` : ""))
        .child(div().flex_1())
        .child(div().flex_none().text_color(t.dim).child("wheel zoom · drag pan · double-click fit/100% · 0 fit · 1 100% · Esc close")));
  }
}
