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
	globalThis.location = Window.location;
	globalThis.history = Window.history;
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
	// derived rx_hz is now an editable input; assert its value (not textContent)
	const rxHzRow = [...parent.querySelectorAll(".ke-detail .ke-row")].find((r) =>
		r.querySelector(".ke-name")?.textContent === "rx_hz",
	);
	assert.ok(rxHzRow, "rx_hz row missing");
	assert.equal(rxHzRow.querySelector("input")?.value, "446068750");
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

test("ui: enum select shows human-readable label and current value", () => {
	const parent = document.createElement("div");
	const { ui } = mountKaitaiEditor(parent, { model: makeModel() });

	ui.sel = "channels";
	const select = parent.querySelector(".ke-detail select.ke-input");
	assert.ok(select, "expected an enum select in the channel rows");
	const labels = [...select.options].map((o) => o.textContent);
	assert.ok(labels.includes("67.0 Hz (XZ)"), `PL labels missing, got: ${labels.slice(0, 3)}`);
	assert.ok(labels.includes("250.3 Hz (M7)"));
	// channel 0 tx_pl = 0 -> "Disabled" shown as selected (happy-dom's per-option
	// `selected` state is unreliable while detached; assert via select.value)
	assert.equal(String(select.value), "0");
	assert.equal(select.options[select.selectedIndex]?.textContent, "Disabled");
});

test("ui: editing a writable derived field writes the raw bytes", () => {
	const parent = document.createElement("div");
	const { model, ui } = mountKaitaiEditor(parent, { model: makeModel() });

	ui.sel = "channels";
	const row = [...parent.querySelectorAll(".ke-detail .ke-row")].find((r) =>
		r.querySelector(".ke-name")?.textContent === "rx_hz",
	);
	assert.ok(row, "rx_hz row not found");
	const input = row.querySelector("input");
	assert.ok(input, "rx_hz should be editable (has -ke-write-expr)");

	input.value = String(375000000 + 12001 * 5000); // 5 kHz grid (60,005,000 not on 6.25 kHz grid)
	input.dispatchEvent(new window.Event("change", { bubbles: true }));
	assert.equal(model.value(model.byPath("channels[0].rx_raw")), 12001);
	assert.equal(model.value(model.byPath("channels[0].rx_hz")), 375000000 + 12001 * 5000);
});

test("ui: sidebar blocks are real hash links", () => {
	const parent = document.createElement("div");
	const { ui } = mountKaitaiEditor(parent, { model: makeModel() });

	const anchors = [...parent.querySelectorAll("a.ke-block")];
	assert.ok(anchors.length > 10, `expected sidebar links, got ${anchors.length}`);
	const channels = anchors.find((a) => a.getAttribute("href") === "#channels");
	assert.ok(channels, "expected an <a href=\"#channels\"> in the sidebar");

	channels.click(); // real anchor: onclick selects, default nav updates the hash
	assert.equal(ui.sel, "channels");
});

test("ui: hashchange drives the selection (deep link / back-forward)", () => {
	const parent = document.createElement("div");
	const { ui } = mountKaitaiEditor(parent, { model: makeModel() });

	globalThis.location.hash = "#own_groups"; // simulate pasted/back-button URL
	window.dispatchEvent(new window.Event("hashchange"));
	assert.equal(ui.sel, "own_groups");

	ui.sel = "channels"; // selection syncs back via replaceState
	assert.equal(globalThis.location.hash, "#channels");
});

test("ui: Import .bin reloads the model buffer", async () => {
	const parent = document.createElement("div");
	const { model, ui } = mountKaitaiEditor(parent, { model: makeModel() });

	const input = parent.querySelector('.ke-toolbar input[type="file"]');
	assert.ok(input, "hidden file input missing");
	const btn = [...parent.querySelectorAll(".ke-toolbar button")].find((b) => b.textContent === "Import .bin");
	assert.ok(btn, "Import .bin button missing");

	const modified = model.snapshot();
	modified[0x18b] = 0x02;
	modified[0x18c] = 0xbc; // own_unit_no = 700
	const file = new window.File([modified.slice().buffer], "edited.bin");
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	input.dispatchEvent(new window.Event("change", { bubbles: true }));
	await new Promise((r) => setTimeout(r, 0));

	assert.equal(model.value(model.byPath("own_unit_no")), 700);
	assert.equal(ui.error, null);

	// wrong size surfaces an error instead of corrupting the buffer
	const bad = new window.File([new Uint8Array(10).buffer], "bad.bin");
	Object.defineProperty(input, "files", { value: [bad], configurable: true });
	input.dispatchEvent(new window.Event("change", { bubbles: true }));
	await new Promise((r) => setTimeout(r, 0));
	assert.match(ui.error, /size mismatch/);
});
