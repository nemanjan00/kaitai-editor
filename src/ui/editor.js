/**
 * The qrp codeplug editor: toolbar + block tree + detail pane + hex dump.
 *
 *   const { element, model, dispose } = createKaitaiEditor({ model, hooks });
 *   parent.append(element);
 *
 * `hooks.onBeforeExport(model)` runs before the .bin download — the place
 * for domain fixups like checksum recomputation.
 */

import { state, el, list, when, scoped, untracked, effect } from "@nemanjan00/qrp";
import { download } from "@nemanjan00/qrp/export";
import { fieldRow, groupRow, rowsFor, hex } from "./fields.js";
import { hexView } from "./hexview.js";

/** Storage fields the sidebar shows as editable blocks. */
function blocksOf(model) {
	return model.root.children.filter((c) => c.kind !== "derived");
}

// ------------------------------------------------------------ location hash
// Sidebar blocks are real <a href="#path"> anchors: middle-click, copy-link
// and back/forward all work. Programmatic selection (hex-view clicks) syncs
// via replaceState so no history entries pile up.

function selFromHash(model) {
	if (typeof location === "undefined" || !location.hash) return null;
	try {
		const p = decodeURIComponent(location.hash.slice(1));
		return p && model.byPath(p) ? p : null;
	} catch {
		return null;
	}
}

function hashFor(sel) {
	return `#${encodeURIComponent(sel)}`;
}

function toolbar(model, ui, hooks) {
	const exportBin = () => {
		hooks?.onBeforeExport?.(model);
		const ext = model.schema.meta.fileExtension || "bin";
		download(new Blob([model.buffer.slice()], { type: "application/octet-stream" }), `${model.schema.meta.id}-edited.${ext}`);
		model.markClean();
	};

	const doImport = async (file) => {
		if (!file) return;
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const err = model.load(bytes);
			ui.error = err ? err.message : null;
			ui.flash = null;
		} catch (e) {
			ui.error = `import failed: ${e.message}`;
		}
	};

	const importInput = el("input", {
		type: "file",
		accept: ".bin,application/octet-stream",
		class: "ke-hidden-file",
		onchange: (e) => {
			void doImport(e.target.files?.[0]);
			e.target.value = "";
		},
	});

	return el(
		"header",
		{ class: "ke-toolbar" },
		el("strong", { class: "ke-title" }, model.schema.meta.title || model.schema.meta.id),
		el("span", { class: () => (ui.error ? "ke-error" : "ke-status") }, () => ui.error || ""),
		el("span", { class: "ke-dirty" }, () => {
			ui.rev;
			const n = model.dirtyCount();
			return n ? `${n} dirty byte${n === 1 ? "" : "s"}` : "clean";
		}),
		importInput,
		el("button", { class: "ke-btn", onclick: () => importInput.click() }, "Import .bin"),
		el("button", { class: "ke-btn", onclick: exportBin }, "Export .bin"),
	);
}

function sidebar(model, ui) {
	const blocks = blocksOf(model);
	return el(
		"nav",
		{ class: "ke-sidebar" },
		el("div", { class: "ke-sidebar-head" }, "blocks"),
		el(
			"div",
			{ class: "ke-sidebar-body" },
			list(
				() => blocks,
				(b) => b.path,
				(b) =>
					el(
						"a",
						{
							href: hashFor(b.path),
							class: () => "ke-block" + (ui.sel === b.path ? " ke-active" : ""),
							title: b.doc || undefined,
							onclick: () => {
								// default navigation updates the hash; hashchange sets ui.sel
								ui.sel = b.path;
								ui.flash = null;
							},
						},
						el("span", { class: "ke-block-name" }, b.id),
						el("span", { class: "ke-block-range" }, b.offset != null && b.size != null ? `${hex(b.offset)} · ${b.size}B` : ""),
					),
			),
		),
	);
}

function detail(model, ui) {
	return when(
		() => ui.sel,
		(sel) => {
			const node = model.byPath(sel);
			if (!node) return el("p", { class: "ke-empty" }, "Select a block.");
			const rows = rowsFor(model, ui, node);
			const isGroup = node.children.length > 0;
			return el(
				"section",
				{ class: "ke-detail" },
				el(
					"div",
					{ class: "ke-detail-head" },
					el("h2", {}, node.id),
					node.doc ? el("p", { class: "ke-doc" }, node.doc) : null,
				),
				isGroup
					? el(
							"div",
							{ class: "ke-rows" },
							list(
								() => rows,
								(r) => `${r.type}:${r.node.path}:${r.depth}`,
								(r) =>
									r.type === "group"
										? groupRow(model, ui, r.node, r.depth)
										: fieldRow(model, ui, r.node, r.depth),
							),
						)
					: el("div", { class: "ke-rows" }, fieldRow(model, ui, node, 0)),
			);
		},
		() => el("p", { class: "ke-empty" }, "Select a block on the left."),
	);
}

/**
 * Build the editor UI in a fresh ownership scope. Returns the root element
 * plus a dispose() that tears down every effect/listener.
 */
export function buildEditor({ model, hooks }) {
	const firstBlock = () => blocksOf(model)[0]?.path ?? null;
	const ui = state({ rev: 0, sel: selFromHash(model) ?? firstBlock(), flash: null, error: null });

	const offChange = model.onChange(() => {
		ui.rev++;
	});

	// hash -> selection: real navigation (click, paste URL, back/forward)
	const onHash = () => {
		ui.sel = selFromHash(model) ?? firstBlock();
		ui.flash = null;
	};
	if (typeof window !== "undefined" && window.addEventListener) {
		window.addEventListener("hashchange", onHash);
	}

	// selection -> hash: keep the URL shareable without spamming history
	effect(() => {
		if (typeof location === "undefined" || typeof history === "undefined" || !history.replaceState) return;
		const target = ui.sel ? hashFor(ui.sel) : "";
		if (location.hash !== target) history.replaceState(null, "", target || location.pathname + location.search);
	});

	const element = el(
		"div",
		{ class: "ke-root" },
		toolbar(model, ui, hooks),
		el(
			"main",
			{ class: "ke-main" },
			sidebar(model, ui),
			el("div", { class: "ke-center" }, detail(model, ui)),
			el("aside", { class: "ke-side-right" }, hexView(model, ui)),
		),
	);

	const dispose = () => {
		offChange();
		if (typeof window !== "undefined" && window.removeEventListener) {
			window.removeEventListener("hashchange", onHash);
		}
	};
	return { element, ui, dispose };
}

/**
 * Mount the editor into `parent`. Returns { model, dispose } — dispose tears
 * down effects; the element itself stays owned by the caller's DOM.
 */
export function mountKaitaiEditor(parent, { model, hooks } = {}) {
	if (!model) throw new Error("mountKaitaiEditor: { model } is required");
	const { value, dispose } = scoped(() => untracked(() => buildEditor({ model, hooks })));
	parent.append(value.element);
	return { model, ui: value.ui, dispose };
}
