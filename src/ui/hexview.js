/**
 * Hex dump pane: 16 bytes/row, dirty bytes highlighted, click a byte to
 * locate the field that owns it. Reacts to model writes through ui.rev.
 */

import { el, list } from "@nemanjan00/qrp";

const BYTES_PER_ROW = 16;

/** Find the top-level ancestor of `node` (the sidebar block it belongs to). */
function topBlock(node) {
	let n = node;
	while (n.parent && n.parent.kind !== "root") n = n.parent;
	return n;
}

export function hexView(model, ui) {
	const length = model.buffer.byteLength;
	const rows = [];
	for (let off = 0; off < length; off += BYTES_PER_ROW) rows.push(off);

	const locate = (offset) => {
		const node = model.nodeAt(offset);
		if (!node) return;
		const block = topBlock(node);
		ui.sel = block.path;
		ui.flash = node.path;
		// scroll the field row into view once the detail pane rebuilds
		queueMicrotask(() => {
			document.getElementById(`ke-row-${node.path.replace(/[^a-zA-Z0-9_-]/g, "_")}`)?.scrollIntoView?.({ block: "center" });
		});
	};

	const selRange = () => {
		const n = model.byPath(ui.sel);
		return n && n.offset != null && n.size != null ? [n.offset, n.offset + n.size] : null;
	};

	return el(
		"div",
		{ class: "ke-hex", onmousedown: (e) => e.preventDefault() },
		el("div", { class: "ke-hex-head" }, "hex — click a byte to locate its field"),
		el(
			"div",
			{ class: "ke-hex-body" },
			list(
				() => rows,
				(off) => off,
				(off) => {
					const bytes = Array.from(model.buffer.subarray(off, Math.min(off + BYTES_PER_ROW, length)));
					return el(
						"div",
						{ class: "ke-hex-row" },
						el("span", { class: "ke-hex-off" }, off.toString(16).padStart(4, "0")),
						el(
							"span",
							{ class: "ke-hex-bytes" },
							bytes.map((b, i) => {
								const o = off + i;
								return el(
									"span",
									{
										class: () => {
											ui.rev;
											const r = selRange();
											return (
												"ke-byte" +
												(model.isDirty(o) ? " ke-dirty" : "") +
												(r && o >= r[0] && o < r[1] ? " ke-sel" : "")
											);
										},
										onclick: () => locate(o),
									},
									b.toString(16).padStart(2, "0"),
								);
							}),
						),
						el(
							"span",
							{ class: "ke-hex-ascii" },
							bytes.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")),
						),
					);
				},
			),
		),
	);
}
