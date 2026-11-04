/**
 * Load a parsed .ksy document (a plain object from the `yaml` package) into a
 * normalized, layout-resolved Schema.
 *
 * Supported subset (deliberate — this is an *editor*, so a field must have a
 * fixed byte position and size to be editable):
 *
 *   meta:     id, title, file-extension, endian (be|le), per-type endian override
 *   types:    user types with `seq` of primitive/str/bytes/nested-type fields,
 *             plus derived `instances` (`value:` expressions)
 *   enums:    int -> label maps
 *   top level: `instances` with absolute `pos` (acts as the root sequence),
 *             `repeat: expr` arrays (count must be a constant or evaluable
 *             without instance state), `size`-only opaque blocks
 *
 * Not supported (fields degrade to read-only/“opaque”, the rest of the spec
 * still loads): `switch-on`, `process:` (xor/rol/…), `repeat: eos/until`,
 * non-constant `repeat-expr`, `if:` on seq fields (treated as always present),
 * streams other than the root buffer, `instances` with `io:`.
 */

import { primitiveSize, isPrimitive } from "./primitives.js";
import { evalExpr } from "./expr.js";

export class UnsupportedError extends Error {}

const docOf = (def) => (typeof def?.doc === "string" ? def.doc : undefined);

function normalizeEnumMap(map) {
	// YAML keys: ints as parsed; KS enum values are ints. Keep both lookups.
	// A member may be the plain form (`1: xz`) or ksc's map form
	// (`1: {id: xz, doc: 67.0 Hz (XZ)}`); prefer doc as the display label.
	const out = Object.create(null);
	for (const [k, v] of Object.entries(map || {})) {
		if (v != null && typeof v === "object") out[k] = String(v.doc || v.id || k);
		else out[k] = String(v);
	}
	return out;
}

export function loadSchema(ksy) {
	if (!ksy || typeof ksy !== "object") throw new Error("ksy must be a parsed object");
	const meta = ksy.meta || {};
	const endian = meta.endian === "le" ? "le" : "be";
	const errors = [];

	const rawTypes = ksy.types || {};
	const enums = Object.fromEntries(
		Object.entries(ksy.enums || {}).map(([k, v]) => [k, normalizeEnumMap(v)]),
	);

	/** Normalize one type definition; returns {name, endian, fields, derived, size}. */
	function normalizeType(name, def, inheritedEndian) {
		const typeEndian = def?.meta?.endian === "le" ? "le" : def?.meta?.endian === "be" ? "be" : inheritedEndian;
		const fields = [];
		const derived = [];

		for (const entry of def?.seq || []) {
			try {
				fields.push(normalizeField(entry, typeEndian));
			} catch (e) {
				errors.push(`${name}.${entry?.id}: ${e.message}`);
			}
		}
		for (const [id, inst] of Object.entries(def?.instances || {})) {
			if (inst.value != null) {
				try {
					derived.push(normalizeField({ ...inst, id }, typeEndian));
				} catch (e) {
					errors.push(`${name}.${id}: ${e.message}`);
				}
			}
			// pos-based instances inside user types are legal in KS but rare in
			// codeplug specs; skip them (they're addressable later if needed).
		}
		return { name, endian: typeEndian, fields, derived, size: null };
	}

	/** Normalize one seq entry / top-level instance into a FieldSpec. */
	function normalizeField(def, typeEndian) {
		const id = def.id;
		if (!id) throw new UnsupportedError("field without id");
		if (def.switchon != null || def["switch-on"] != null) {
			throw new UnsupportedError("switch-on types are not supported");
		}

		const field = {
			id,
			doc: docOf(def),
			pos: def.pos != null ? Number(def.pos) : null,
			size: def.size != null ? Number(def.size) : null,
			enum: def.enum,
			encoding: def.encoding,
			endian: def.endian === "le" ? "le" : def.endian === "be" ? "be" : typeEndian,
			ifCond: def.if != null ? String(def.if) : null,
		};

		// Derived value instances (only reachable inside normalizeType, but the
		// top-level instances loop below reuses this for uniformity).
		if (def.value != null) {
			field.kind = "derived";
			field.value = String(def.value);
			// Optional write-inverse (kaitai-editor extension, `-ke-` prefix is
			// ignored by ksc): given the new derived value as `_value`, the
			// expression must yield the raw value for `writeTarget` (a sibling
			// field). Makes the derived node editable in the UI.
			if (def["-ke-write-expr"] != null) {
				field.writeExpr = String(def["-ke-write-expr"]);
				field.writeTarget = def["-ke-write-target"] != null ? String(def["-ke-write-target"]) : null;
				if (!field.writeTarget) throw new UnsupportedError(`derived "${id}" has -ke-write-expr but no -ke-write-target`);
			}
			return field;
		}

		// Repeat: only constant `expr` keeps the layout static.
		if (def.repeat != null) {
			if (def.repeat !== "expr") throw new UnsupportedError(`repeat: ${def.repeat} is not supported`);
			const count = evalExpr(String(def["repeat-expr"] ?? def.repeatExpr ?? ""), () => undefined);
			if (!Number.isInteger(count) || count < 0) {
				throw new UnsupportedError(`repeat-expr "${def["repeat-expr"]}" is not a constant`);
			}
			field.repeat = "expr";
			field.count = count;
		}

		const type = def.type;
		if (type == null || type === "str" || type === "bytes") {
			if (type !== "str" && field.size == null) {
				throw new UnsupportedError(`"${id}" needs a size (str/bytes without size)`);
			}
			field.type = type || "bytes";
			field.kind = type === "bytes" || type == null ? "bytes" : "str";
			if (field.kind === "str" && field.size == null) throw new UnsupportedError(`str "${id}" needs size`);
			return field;
		}
		if (isPrimitive(type)) {
			field.type = type;
			field.kind = "int";
			field.size = primitiveSize(type);
			return field;
		}
		// user type
		if (!(type in rawTypes)) throw new UnsupportedError(`unknown type "${type}"`);
		field.type = type;
		field.kind = "struct";
		return field;
	}

	const types = Object.fromEntries(
		Object.entries(rawTypes).map(([name, def]) => [name, normalizeType(name, def, endian)]),
	);

	// Resolve struct field element sizes (recursive; null = dynamically sized).
	function typeSize(type, seen = new Set()) {
		if (!type || seen.has(type.name)) return null;
		seen.add(type.name);
		let total = 0;
		for (const f of type.fields) {
			const s = fieldElemSize(f, seen);
			if (s == null) return null;
			total += s * (f.repeat ? f.count : 1);
		}
		return total;
	}
	function fieldElemSize(f, seen) {
		if (f.size != null) return f.size;
		if (f.kind === "struct") return typeSize(types[f.type], seen);
		if (f.kind === "int") return f.size;
		return null;
	}
	for (const t of Object.values(types)) t.size = typeSize(t);

	// Top-level instances = the root sequence (absolute positions).
	const rootFields = [];
	const rootDerived = [];
	for (const [id, inst] of Object.entries(ksy.instances || {})) {
		const def = { ...inst, id };
		try {
			const field = normalizeField(def, endian);
			if (field.kind === "derived") {
				rootDerived.push(field);
			} else {
				if (field.pos == null && !field.repeat) {
					throw new UnsupportedError("top-level instance needs pos");
				}
				rootFields.push(field);
			}
		} catch (e) {
			errors.push(`${id}: ${e.message}`);
		}
	}

	// Sequential-layout resolution: explicit `pos` seeks; otherwise the field
	// continues after the previous one. Top level: base 0, positions absolute.
	assignOffsets(rootFields, 0);
	for (const t of Object.values(types)) assignOffsets(t.fields, 0);

	function assignOffsets(fields, base) {
		let cursor = 0;
		for (const f of fields) {
			if (f.kind === "derived") continue;
			const rel = f.pos != null ? f.pos : cursor;
			f.offset = base + rel;
			const elem = f.size ?? (f.kind === "struct" ? types[f.type]?.size : null);
			f.elemSize = elem;
			const span = elem != null ? elem * (f.repeat ? f.count : 1) : null;
			f.span = span;
			if (span != null) cursor = rel + span;
			else cursor = rel; // unknown width: next relative field is ambiguous
			if (f.kind === "struct" && !f.repeat && types[f.type]?.size != null) {
				// nested layout resolved lazily by the model at instance base
			}
		}
	}

	return {
		meta: {
			id: meta.id || "root",
			title: meta.title,
			fileExtension: meta["file-extension"],
		},
		endian,
		types,
		enums,
		root: { name: meta.id || "root", endian, fields: rootFields, derived: rootDerived },
		errors,
	};
}

/** True when a field occupies bytes in the buffer (vs a derived value). */
export function isStorageField(f) {
	return f.kind !== "derived";
}
