/**
 * The qrp codeplug editor: toolbar + block tree + detail pane + hex dump.
 *
 *   const { element, model, dispose } = createKaitaiEditor({ model, hooks });
 *   parent.append(element);
 *
 * `hooks.onBeforeExport(model)` runs before the .bin download — the place
 * for domain fixups like checksum recomputation.
 *
 * `base` is the app's mount path (e.g. "/demo/"); selections are pushed as
 * clean History-API URLs under it ("/demo/channels%5B0%5D"). The server must
 * fall back to the app shell for those paths (see scripts/serve.mjs).
 */

import { state, el, list, when, scoped, untracked, effect } from "@nemanjan00/qrp";
import { download } from "@nemanjan00/qrp/export";
import { fieldRow, groupRow, rowsFor, hex } from "./fields.js";
import { hexView } from "./hexview.js";

/** Storage fields the sidebar shows as editable blocks. */
function blocksOf(model) {
	return model.root.children.filter((c) => c.kind !== "derived");
}

// ---------------------------------------------------- History-API routing
// Sidebar blocks are real <a href="/base/path"> anchors: middle-click,
// copy-link and back/forward all work. Clicking pushes a history entry;
// programmatic selection (hex-view clicks) syncs via replaceState so no
// entries pile up. popstate drives the selection back the other way.

function selFromUrl(model, base) {
	if (typeof location === "undefined") return null;
	let p = location.pathname;
	if (base && base !== "/") {
		if (!p.startsWith(base)) return null;
		p = p.slice(base.length);
	} else if (p.startsWith("/")) {
		p = p.slice(1);
	}
	if (!p) return null;
	try {
		p = decodeURIComponent(p);
		return model.byPath(p) ? p : null;
	} catch {
		return null;
	}
}

function urlFor(base, sel) {
	return (base || "/") + encodeURIComponent(sel);
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

function sidebar(model, ui, base) {
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
							href: urlFor(base, b.path),
							class: () => "ke-block" + (ui.sel === b.path ? " ke-active" : ""),
							title: b.doc || undefined,
							onclick: (e) => {
								e?.preventDefault?.(); // we navigate via pushState ourselves
								if (typeof history !== "undefined" && history.pushState) {
									history.pushState(null, "", urlFor(base, b.path));
								}
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
export function buildEditor({ model, hooks, base = "/" }) {
	const firstBlock = () => blocksOf(model)[0]?.path ?? null;
	const ui = state({ rev: 0, sel: selFromUrl(model, base) ?? firstBlock(), flash: null, error: null });

	const offChange = model.onChange(() => {
		ui.rev++;
	});

	// URL -> selection: back/forward and pasted deep links
	const onPop = () => {
		ui.sel = selFromUrl(model, base) ?? firstBlock();
		ui.flash = null;
	};
	if (typeof window !== "undefined" && window.addEventListener) {
		window.addEventListener("popstate", onPop);
	}

	// selection -> URL: keep the URL shareable without spamming history
	effect(() => {
		if (typeof location === "undefined" || typeof history === "undefined" || !history.replaceState) return;
		const target = ui.sel ? urlFor(base, ui.sel) : base;
		if (location.pathname !== target) history.replaceState(null, "", target);
	});

	const element = el(
		"div",
		{ class: "ke-root" },
		toolbar(model, ui, hooks),
		el(
			"main",
			{ class: "ke-main" },
			sidebar(model, ui, base),
			el("div", { class: "ke-center" }, detail(model, ui)),
			el("aside", { class: "ke-side-right" }, hexView(model, ui)),
		),
	);

	const dispose = () => {
		offChange();
		if (typeof window !== "undefined" && window.removeEventListener) {
			window.removeEventListener("popstate", onPop);
		}
	};
	return { element, ui, dispose };
}

/**
 * Mount the editor into `parent`. Returns { model, dispose } — dispose tears
 * down effects; the element itself stays owned by the caller's DOM.
 */
export function mountKaitaiEditor(parent, { model, hooks, base } = {}) {
	if (!model) throw new Error("mountKaitaiEditor: { model } is required");
	const { value, dispose } = scoped(() => untracked(() => buildEditor({ model, hooks, base })));
	parent.append(value.element);
	return { model, ui: value.ui, dispose };
}
