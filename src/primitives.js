/**
 * Primitive type read/write against a DataView, covering the KS type subset a
 * binary/codeplug spec realistically uses: u1/u2/u4/u8, s1/s2/s4/s8, f4/f8,
 * bool, str (fixed `size`, single-byte encoding) and raw `bytes`/`size`-only
 * fields. Endianness comes from `meta.endian` and can be overridden per type
 * (KS: `meta.endian` on a user type).
 */

const INT_TYPES = {
	u1: { size: 1, get: "getUint8", set: "setUint8", min: 0, max: 0xff },
	u2: { size: 2, get: "getUint16", set: "setUint16", min: 0, max: 0xffff },
	u4: { size: 4, get: "getUint32", set: "setUint32", min: 0, max: 0xffffffff },
	u8: { size: 8, get: "getBigUint64", set: "setBigUint64", min: 0n, max: 0xffffffffffffffffn, big: true },
	s1: { size: 1, get: "getInt8", set: "setInt8", min: -0x80, max: 0x7f },
	s2: { size: 2, get: "getInt16", set: "setInt16", min: -0x8000, max: 0x7fff },
	s4: { size: 4, get: "getInt32", set: "setInt32", min: -0x80000000, max: 0x7fffffff },
	s8: { size: 8, get: "getBigInt64", set: "setBigInt64", min: -0x8000000000000000n, max: 0x7fffffffffffffffn, big: true },
	f4: { size: 4, get: "getFloat32", set: "setFloat32", float: true },
	f8: { size: 8, get: "getFloat64", set: "setFloat64", float: true },
};

/** Static byte size of a primitive type, or null if the type isn't one. */
export function primitiveSize(type) {
	if (type === "bool") return 1;
	const t = INT_TYPES[type];
	return t ? t.size : null;
}

export function isPrimitive(type) {
	return type === "bool" || type in INT_TYPES;
}

export function isStringType(type) {
	return type === "str" || type === "bytes" || type == null;
}

const textDecoders = new Map();

function decoderFor(encoding) {
	const enc = encoding || "ascii";
	// latin1/ascii family: TextDecoder maps bytes 1:1 to code points, which is
	// what a codeplug wants (raw bytes, no UTF-8 multibyte surprises).
	if (!textDecoders.has(enc)) {
		textDecoders.set(enc, new TextDecoder(enc === "ascii" ? "latin1" : enc));
	}
	return textDecoders.get(enc);
}

/** Single-byte encode (TextEncoder is UTF-8-only in browsers; codeplug str
 *  fields are fixed-width single-byte slots anyway). */
function encodeBytes(str, encoding) {
	const enc = encoding || "ascii";
	if (enc.toLowerCase().startsWith("utf")) return new TextEncoder().encode(str);
	const out = new Uint8Array(str.length);
	for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
	return out;
}

/**
 * Read a primitive field. `field.type` must be a primitive/str; `field.size`
 * is required for str/bytes. `endian` is "be" | "le".
 */
export function readPrimitive(view, field, offset, endian) {
	const { type, size, encoding } = field;
	if (type === "bool") return view.getUint8(offset) !== 0;
	const t = INT_TYPES[type];
	if (t) {
		const value = view[t.get](offset, endian === "le");
		return t.big ? value : value;
	}
	// str / bytes-with-size / size-only field
	if (size == null) throw new Error(`field "${field.id}": str/bytes needs a size`);
	const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, size);
	if (type === "bytes") return bytes.slice();
	return decoderFor(encoding).decode(bytes);
}

/**
 * Write a primitive field; returns an Error or null. Strings are written
 * byte-per-char and NUL/truncated to `size` (codeplug semantics: fixed slots).
 */
export function writePrimitive(view, field, offset, endian, value) {
	const { type, size, encoding } = field;
	if (type === "bool") {
		view.setUint8(offset, value ? 1 : 0);
		return null;
	}
	const t = INT_TYPES[type];
	if (t) {
		if (t.float) {
			const n = Number(value);
			if (!Number.isFinite(n)) return new Error(`"${value}" is not a number`);
			view[t.set](offset, n, endian === "le");
			return null;
		}
		const n = t.big ? BigInt(value) : Number(value);
		if (Number.isNaN(n) || (t.big ? false : !Number.isInteger(n))) {
			return new Error(`"${value}" is not an integer`);
		}
		if (n < t.min || n > t.max) {
			return new Error(`${value} out of range for ${type} (${t.min}…${t.max})`);
		}
		view[t.set](offset, n, endian === "le");
		return null;
	}
	if (typeof value !== "string") return new Error(`expected a string`);
	if (value.length > size) return new Error(`string longer than ${size} bytes`);
	const bytes = encodeBytes(value, encoding);
	const slot = new Uint8Array(view.buffer, view.byteOffset + offset, size);
	slot.fill(0); // codeplug strings are NUL/space-padded fixed slots
	slot.set(bytes);
	return null;
}

/** Format a value as the enum label when the field has one, else the raw value. */
export function enumLabel(enums, enumName, value) {
	const map = enums?.[enumName];
	if (!map) return undefined;
	if (Object.hasOwn(map, value)) return map[value];
	return undefined;
}
