/**
 * kaitai-editor — core: load a .ksy spec, edit the binary it describes.
 * Framework-free; the qrp UI lives in kaitai-editor/ui.
 */

export { loadSchema, UnsupportedError } from "./schema.js";
export { CodeplugModel, hexBytes } from "./model.js";
export { compileExpr, translateExpr, evalExpr } from "./expr.js";
export {
	readPrimitive,
	writePrimitive,
	primitiveSize,
	isPrimitive,
	enumLabel,
} from "./primitives.js";

import { loadSchema } from "./schema.js";
import { CodeplugModel } from "./model.js";

/**
 * One-call helper: parse a .ksy document (already-YAML-parsed object or string)
 * and build the editable model over `buffer` (Uint8Array).
 */
export async function createCodeplug(ksy, buffer) {
	let doc = ksy;
	if (typeof ksy === "string") {
		const { parse } = await import("yaml");
		doc = parse(ksy);
	}
	return new CodeplugModel(loadSchema(doc), buffer);
}
