/**
 * The qrp codeplug editor: toolbar + block tree + detail pane + hex dump.
 *
 *   const { element, model, dispose } = createKaitaiEditor({ model, hooks });
 *   parent.append(element);
 *
 * `hooks.onBeforeExport(model)` runs before the .bin download — the place
 * for domain fixups like checksum recomputation.
 */

import { state, el, list, when, scoped, untracked } from "@nemanjan00/qrp";
import { download } from "@nemanjan00/qrp/export";
import { fieldRow, groupRow, rowsFor, hex } from "./fields.js";
import { hexView } from "./hexview.js";

/** Storage fields the sidebar shows as editable blocks. */
function blocksOf(model) {
	return model.root.children.filter((c) => c.kind !== "derived");
}

function toolbar(model, ui, hooks) {
	const exportBin = () => {
		hooks?.onBeforeExport?.(model);
		const ext = model.schema.meta.fileExtension || "bin";
		download(new Blob([model.buffer.slice()], { type: "application/octet-stream" }), `${model.schema.meta.id}-edited.${ext}`);
		model.markClean();
	};

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
						"button",
						{
							class: () => "ke-block" + (ui.sel === b.path ? " ke-active" : ""),
							title: b.doc || undefined,
							onclick: () => {
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
	const ui = state({ rev: 0, sel: blocksOf(model)[0]?.path ?? null, flash: null, error: null });

	const offChange = model.onChange(() => {
		ui.rev++;
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
