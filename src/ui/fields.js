/**
 * Field-row factories for the detail pane. One row per leaf: name, offset,
 * raw bytes, editor control (or read-only display for derived/opaque).
 * Components are plain qrp factory functions — a component is a function
 * returning DOM; reactivity comes from thunk children reading `ui.rev`.
 */

import { el, list } from "@nemanjan00/qrp";

/** Coerce user input per node kind before model.set. */
function coerce(node, raw) {
	if (node.kind === "str") return String(raw);
	if (node.kind === "bytes") return raw; // read-only in v1
	return Number(raw);
}

/** The editing control for a scalar leaf (int/str). */
function control(model, ui, node) {
	if (node.kind === "str") {
		return el("input", {
			type: "text",
			class: "ke-input ke-str",
			maxlength: node.size ?? undefined,
			value: () => {
				ui.rev;
				return model.value(node) ?? "";
			},
			onchange: (e) => commit(model, ui, node, e.target.value),
		});
	}

	const enumMap = node.enumName ? model.schema.enums[node.enumName] : null;
	if (enumMap) {
		const entries = Object.entries(enumMap);
		return el(
			"select",
			{
				class: "ke-input ke-enum",
				value: () => {
					ui.rev;
					return String(model.value(node) ?? "");
				},
				onchange: (e) => commit(model, ui, node, Number(e.target.value)),
			},
			list(() => entries, ([v]) => v, ([v, label]) => el("option", { value: v }, label)),
		);
	}

	const t = node.field.type;
	const bounds = { u1: [0, 0xff], u2: [0, 0xffff], u4: [0, 0xffffffff], s1: [-128, 127], s2: [-32768, 32767], s4: [-2147483648, 2147483647] }[t];
	return el("input", {
		type: "number",
		class: "ke-input ke-int",
		min: bounds?.[0],
		max: bounds?.[1],
		value: () => {
			ui.rev;
			const v = model.value(node);
			return v === undefined ? "" : String(v);
		},
		onchange: (e) => commit(model, ui, node, e.target.value),
	});
}

function commit(model, ui, node, raw) {
	const err = model.set(node, coerce(node, raw));
	if (err) {
		ui.error = `${node.path}: ${err.message}`;
	} else if (ui.error?.startsWith(node.path)) {
		ui.error = null;
	}
}

/** One leaf row: [name | offset | raw | control]. */
export function fieldRow(model, ui, node, depth) {
	const ctrl =
		node.kind === "derived"
			? el("code", { class: "ke-derived", title: node.field?.value ? `= ${node.field.value}` : "computed" }, () => {
					ui.rev;
					return model.display(node);
				})
			: node.kind === "opaque" || node.kind === "bytes"
				? el("code", { class: "ke-raw-only" }, () => {
						ui.rev;
						return model.rawHex(node);
					})
				: control(model, ui, node);

	return el(
		"div",
		{
			class: () => `ke-row ke-kind-${node.kind}` + (ui.flash === node.path ? " ke-flash" : ""),
			style: { "--depth": depth },
			title: node.doc || undefined,
			id: `ke-row-${cssId(node.path)}`,
		},
		el("span", { class: "ke-name" }, node.id),
		el("span", { class: "ke-off" }, node.offset != null ? hex(node.offset) : "—"),
		el("span", { class: "ke-raw" }, model.rawHex(node)),
		el("span", { class: "ke-val" }, ctrl),
	);
}

/** Group header row for structs / array elements. */
export function groupRow(model, ui, node, depth, label) {
	const end = node.offset != null && node.size != null ? node.offset + node.size - 1 : null;
	return el(
		"div",
		{
			class: "ke-row ke-group",
			style: { "--depth": depth },
			title: node.doc || undefined,
		},
		el("span", { class: "ke-name" }, label ?? node.id),
		el("span", { class: "ke-off" }, node.offset != null ? `${hex(node.offset)}–${end != null ? hex(end) : "?"}` : "—"),
		el("span", { class: "ke-raw" }, ""),
		el("span", { class: "ke-val ke-struct-tag" }, node.typeName || node.kind),
	);
}

/** Depth-first flatten of a node into renderable rows. */
export function rowsFor(model, ui, node, depth = 0, out = []) {
	if (node.kind === "struct" || (node.kind === "array" && node.elemKind === "struct")) {
		out.push({ type: "group", node, depth });
		for (const c of node.children) rowsFor(model, ui, c, depth + 1, out);
		return out;
	}
	if (node.kind === "array") {
		out.push({ type: "group", node, depth });
		for (const c of node.children) rowsFor(model, ui, c, depth + 1, out);
		return out;
	}
	out.push({ type: "field", node, depth });
	return out;
}

export function hex(n) {
	return "0x" + n.toString(16).toUpperCase();
}

function cssId(path) {
	return path.replace(/[^a-zA-Z0-9_-]/g, "_");
}

