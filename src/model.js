/**
 * CodeplugModel — a byte-accurate, editable view of a binary described by a
 * Schema (see schema.js). Builds a node tree mirroring the spec's structure,
 * reads/writes primitive fields through a DataView, evaluates derived
 * `value:` instances, and tracks dirty bytes for the UI.
 *
 * The model is deliberately framework-free: the qrp UI (src/ui/) subscribes
 * via `model.onChange` and bumps its own reactive state.
 */

import { readPrimitive, writePrimitive, enumLabel } from "./primitives.js";
import { compileExpr } from "./expr.js";

export class CodeplugModel {
	/** @param schema from loadSchema(); @param buffer Uint8Array */
	constructor(schema, buffer) {
		if (!(buffer instanceof Uint8Array)) throw new Error("buffer must be a Uint8Array");
		this.schema = schema;
		this.buffer = buffer;
		this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		this.rev = 0; // bumped on every write (convenience for reactive UIs)
		this.dirtyBytes = new Set();
		this.errors = [...schema.errors];
		this.listeners = new Set();
		this.root = this.#buildRoot();
	}

	/** Subscribe to writes: fn(node) runs after each successful set(). */
	onChange(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	#emit(node) {
		this.rev++;
		for (const fn of this.listeners) {
			try {
				fn(node);
			} catch (e) {
				console.error("kaitai-editor listener failed", e);
			}
		}
	}

	// ---------------------------------------------------------------- building

	#buildRoot() {
		const root = {
			id: this.schema.root.name,
			kind: "root",
			path: "",
			doc: this.schema.meta.title,
			offset: 0,
			size: this.buffer.byteLength,
			children: [],
			parent: null,
		};
		for (const f of this.schema.root.fields) {
			const child = this.#instantiate(root, f);
			if (child) root.children.push(child);
		}
		for (const d of this.schema.root.derived) {
			const child = this.#instantiate(root, d);
			if (child) root.children.push(child);
		}
		return root;
	}

	/** Instantiate a schema field under parent node; returns the node (or null). */
	#instantiate(parent, field) {
		const base = parent.offset || 0;
		const offset = field.offset ?? (field.pos != null ? base + field.pos : null);
		const node = {
			id: field.id,
			kind: field.kind,
			path: parent.path ? `${parent.path}.${field.id}` : field.id,
			doc: field.doc,
			field,
			enumName: field.enum,
			parent,
			children: [],
			offset,
			size: null,
		};

		if (field.ifCond != null) {
			const ok = this.#evalBool(node, field.ifCond);
			if (ok === false) return null; // condition false: field absent (KS semantics)
		}

		switch (field.kind) {
			case "int":
			case "str":
			case "bytes":
				node.size = field.repeat ? field.elemSize * field.count : field.elemSize ?? field.size;
				break;
			case "derived":
				node.valueExpr = compileExpr(field.value);
				if (field.writeExpr) {
					node.writeFn = compileExpr(field.writeExpr);
					node.writeTarget = field.writeTarget;
					node.writable = true;
				}
				break;
			case "struct": {
				if (offset == null) return this.#unsupported(parent, field, "unknown offset");
				const type = this.schema.types[field.type];
				if (field.repeat) {
					if (!type || type.size == null) return this.#unsupported(parent, field, "type size unknown");
					node.kind = "array";
					node.elemKind = "struct";
					node.count = field.count;
					node.size = type.size * field.count;
					for (let i = 0; i < field.count; i++) {
						const elem = this.#instantiateStruct(node, field, offset + i * type.size, i);
						if (elem) node.children.push(elem);
					}
				} else {
					if (!type || type.size == null) return this.#unsupported(parent, field, "type size unknown");
					node.size = type.size;
					node.typeName = field.type;
					for (const sf of type.fields) {
						const child = this.#instantiate(node, { ...sf, offset: offset + (sf.offset ?? 0) });
						if (child) node.children.push(child);
					}
					for (const sd of type.derived) {
						const child = this.#instantiate(node, { ...sd, offset: null });
						if (child) node.children.push(child);
					}
				}
				break;
			}
			default:
				return this.#unsupported(parent, field, `unsupported kind ${field.kind}`);
		}

		// arrays of primitives/str.
		if (field.repeat && (field.kind === "int" || field.kind === "str" || field.kind === "bytes")) {
			node.kind = "array";
			node.elemKind = field.kind;
			node.count = field.count;
			node.size = field.elemSize * field.count;
			for (let i = 0; i < field.count; i++) {
				node.children.push({
					...node,
					id: `${field.id}[${i}]`,
					kind: field.kind,
					path: `${node.path}[${i}]`,
					offset: offset + i * field.elemSize,
					size: field.elemSize,
					children: [],
					enumName: field.enum,
				});
			}
		}

		// NOTE: the caller adds the returned node to parent.children — this
		// function never pushes, so children can't be registered twice.
		return node;
	}

	#instantiateStruct(arrayNode, field, offset, index) {
		const type = this.schema.types[field.type];
		if (!type || type.size == null) return null;
		const node = {
			id: `${field.id}[${index}]`,
			kind: "struct",
			typeName: field.type,
			path: `${arrayNode.path}[${index}]`,
			doc: field.doc,
			field,
			parent: arrayNode,
			children: [],
			offset,
			size: type.size,
			enumName: undefined,
		};
		for (const sf of type.fields) {
			const child = this.#instantiate(node, { ...sf, offset: offset + (sf.offset ?? 0) });
			if (child) node.children.push(child);
		}
		for (const sd of type.derived) {
			const child = this.#instantiate(node, { ...sd, offset: null });
			if (child) node.children.push(child);
		}
		return node;
	}

	#unsupported(parent, field, why) {
		this.errors.push(`${field.id}: ${why}`);
		return {
			id: field.id,
			kind: "opaque",
			path: parent.path ? `${parent.path}.${field.id}` : field.id,
			doc: field.doc ? `${field.doc} (not editable: ${why})` : `Not editable: ${why}`,
			field,
			parent,
			children: [],
			offset: field.offset ?? null,
			size: field.size ?? null,
		};
	}

	// ------------------------------------------------------------- expression

	/** Lazily-resolving scope for expressions: names are sibling nodes. */
	#makeValuesProxy(structNode) {
		if (!structNode) return undefined;
		return new Proxy(Object.create(null), {
			get: (_t, key) => {
				if (key === Symbol.toPrimitive) return undefined;
				const child = (structNode.children || []).find((c) => c.id === key || c.id.startsWith(`${key}[`));
				if (!child) return undefined;
				return this.value(child);
			},
			has: () => true,
		});
	}

	#resolve(node, name) {
		if (name === "_") {
			// current struct instance (the derived node's parent)
			return this.#makeValuesProxy(node.parent);
		}
		if (name === "_parent") return this.#makeValuesProxy(node.parent?.parent);
		if (name === "_root") return this.#makeValuesProxy(this.root);
		const scope = node.parent;
		const child = (scope?.children || []).find((c) => c.id === name || c.id.startsWith(`${name}[`));
		if (child) return this.value(child);
		return undefined;
	}

	#evalBool(node, exprSrc) {
		try {
			return !!compileExpr(exprSrc)((name) => this.#resolve(node, name));
		} catch {
			return undefined; // error → treat as present
		}
	}

	// ------------------------------------------------------------------ reads

	/** Value of a node: number/string for leaves, evaluated for derived, undefined for groups. */
	value(node) {
		if (!node) return undefined;
		switch (node.kind) {
			case "int":
			case "str":
			case "bytes":
				if (node.offset == null) return undefined;
				try {
					return readPrimitive(this.view, node.field, node.offset, node.field.endian ?? this.schema.endian);
				} catch (e) {
					return undefined;
				}
			case "derived":
				try {
					return node.valueExpr((name) => this.#resolve(node, name));
				} catch {
					return undefined;
				}
			default:
				return undefined;
		}
	}

	/** Display string for a leaf value (enum label applied when declared). */
	display(node) {
		const v = this.value(node);
		if (v === undefined || v === null) return "—";
		if (node.kind === "bytes") return hexBytes(v);
		if (node.kind === "str") return v;
		if (node.enumName) {
			const label = enumLabel(this.schema.enums, node.enumName, v);
			if (label !== undefined) return label;
		}
		if (typeof v === "bigint") return v.toString();
		if (typeof v === "number") return String(v);
		if (typeof v === "boolean") return v ? "yes" : "no";
		return String(v);
	}

	/** Raw buffer bytes of a node as a hex string (for the "raw" column). */
	rawHex(node) {
		if (node.offset == null || node.size == null) return "…";
		const end = Math.min(node.offset + node.size, this.buffer.byteLength);
		return hexBytes(this.buffer.subarray(node.offset, end));
	}

	// ----------------------------------------------------------------- writes

	/**
	 * Write a leaf value. Returns null on success or an Error (also emitted via
	 * onChange with node=null so UIs can surface it).
	 */
	set(node, value) {
		if (!node) return new Error("no node");
		if (node.kind === "derived") {
			if (!node.writable) return new Error(`"${node.id}" is computed (read-only)`);
			let raw;
			try {
				raw = node.writeFn((name) => (name === "_value" ? value : this.#resolve(node, name)));
			} catch (e) {
				return new Error(`inverse expression failed: ${e.message}`);
			}
			const target = (node.parent?.children || []).find((c) => c.id === node.writeTarget);
			if (!target) return new Error(`write target "${node.writeTarget}" not found`);
			return this.set(target, raw);
		}
		if (node.kind !== "int" && node.kind !== "str" && node.kind !== "bytes") {
			return new Error(`"${node.id}" is not a scalar field`);
		}
		if (node.offset == null) return new Error(`"${node.id}" has no known offset`);
		const err = writePrimitive(this.view, node.field, node.offset, node.field.endian ?? this.schema.endian, value);
		if (err) return err;
		for (let i = 0; i < node.size; i++) this.dirtyBytes.add(node.offset + i);
		this.#emit(node);
		return null;
	}

	isDirty(offset) {
		return this.dirtyBytes.has(offset);
	}

	dirtyCount() {
		return this.dirtyBytes.size;
	}

	markClean() {
		this.dirtyBytes.clear();
		this.#emit(null);
	}

	// ------------------------------------------------------------------ lookup

	/** Deepest (smallest) node whose [offset, offset+size) contains `offset`.
	 *  Top-level blocks may overlap detail fields (a block header covering the
	 *  same range) — the smallest span wins. */
	nodeAt(offset) {
		let best = null;
		const walk = (node) => {
			if (node.offset == null || node.size == null) return;
			if (offset < node.offset || offset >= node.offset + node.size) return;
			if (!best || node.size < best.size) best = node;
			for (const c of node.children || []) walk(c);
		};
		for (const c of this.root.children) walk(c);
		return best;
	}

	/** Find a node by dotted path ("channels[1].tx_raw"). */
	byPath(path) {
		const walk = (node) => {
			if (node.path === path) return node;
			for (const c of node.children || []) {
				const hit = walk(c);
				if (hit) return hit;
			}
			return null;
		};
		return walk(this.root);
	}

	/** A fresh copy of the buffer (post-export snapshot). */
	snapshot() {
		return this.buffer.slice();
	}
}

/** "0a 1b …" hex dump of a byte array, "" for empty. */
export function hexBytes(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}
