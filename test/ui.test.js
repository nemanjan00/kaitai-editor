/**
 * UI smoke tests under happy-dom: mounts the real editor against the GM600
 * sample and exercises the reactive paths (render, select, edit, dirty).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

let mountKaitaiEditor, loadSchema, CodeplugModel, Window;

before(async () => {
	const { Window: HWindow } = await import("happy-dom");
	Window = new HWindow();
	globalThis.window = Window;
	globalThis.document = Window.document;
	for (const name of ["Node", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "SVGElement", "DocumentFragment", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "FocusEvent", "InputEvent", "getComputedStyle", "MutationObserver"]) {
		if (Window[name] !== undefined && globalThis[name] === undefined) globalThis[name] = Window[name];
	}
	globalThis.Blob ??= class {};
	globalThis.URL ??= {};

	({ loadSchema, CodeplugModel } = await import("../src/index.js"));
	({ mountKaitaiEditor } = await import("../src/ui/editor.js"));
});

function makeModel() {
	const ksy = parse(readFileSync(new URL("../sample/gm600_codeplug.ksy", import.meta.url), "utf8"));
	const bin = readFileSync(new URL("../sample/final.bin", import.meta.url));
	return new CodeplugModel(loadSchema(ksy), new Uint8Array(bin));
}

test("ui: mounts toolbar, sidebar and detail", () => {
	const parent = document.createElement("div");
	const { ui } = mountKaitaiEditor(parent, { model: makeModel() });

	assert.ok(parent.querySelector(".ke-toolbar"));
	assert.ok(parent.querySelector(".ke-hex"));
	const blocks = parent.querySelectorAll(".ke-block");
	assert.ok(blocks.length > 10, `expected sidebar blocks, got ${blocks.length}`);
	// first block auto-selected
	assert.ok(parent.querySelector(".ke-detail"));
	assert.equal(ui.sel, "alignment_block");
});

test("ui: selecting a block renders its fields with values", () => {
	const parent = document.createElement("div");
	const { ui } = mountKaitaiEditor(parent, { model: makeModel() });

	ui.sel = "channels";
	const rows = parent.querySelectorAll(".ke-row");
	assert.ok(rows.length > 20, `expected channel rows, got ${rows.length}`);
	const text = parent.textContent;
	assert.match(text, /rx_raw/);
	assert.match(text, /446068750/); // derived rx_hz, live-evaluated
});

test("ui: model write updates the DOM via rev bump", () => {
	const parent = document.createElement("div");
	const { model, ui } = mountKaitaiEditor(parent, { model: makeModel() });

	ui.sel = "own_unit_no"; // leaf block: detail shows a single field row
	const input = parent.querySelector(".ke-detail .ke-input");
	assert.equal(input.value, "322");

	model.set(model.byPath("own_unit_no"), 777);
	assert.equal(input.value, "777"); // reactive binding re-applied via ui.rev
	assert.match(parent.querySelector(".ke-toolbar").textContent, /dirty/);
});

test("ui: hex view flags dirty bytes and click locates the owning block", async () => {
	const parent = document.createElement("div");
	const { model, ui } = mountKaitaiEditor(parent, { model: makeModel() });

	model.set(model.byPath("own_unit_no"), 999);
	const dirty = parent.querySelectorAll(".ke-byte.ke-dirty");
	assert.equal(dirty.length, 2); // u2 = two dirty bytes

	dirty[0].click();
	assert.equal(ui.sel, "own_unit_no"); // jumped to the owning top-level block
	assert.equal(ui.flash, "own_unit_no");
});
