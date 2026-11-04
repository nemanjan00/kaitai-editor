/**
 * Demo: GM600 codeplug editor.
 *
 * Serves as both the runnable demo (npm run dev → http://localhost:8080/demo/)
 * and a worked example of embedding the editor with a domain hook: the GM600
 * personality checksum is additive, so on export we fold the sum of all
 * personality-block byte deltas into the checksum byte.
 *
 * Note: the spec documents the summed extent only approximately ("~radio
 * 0x0F1D-0x0FE0, not pinned"); the hook below covers the personality block
 * (file 0x188-0x273) and follows the documented "+= sum of deltas" rule.
 */

import { parse } from "yaml";
import { loadSchema, CodeplugModel } from "../src/index.js";
import { mountKaitaiEditor } from "../src/ui/index.js";

const app = document.getElementById("app");

const PERSONALITY_START = 0x188;
const PERSONALITY_END = 0x274; // exclusive; checksum byte itself at 0x274
const CHECKSUM_OFFSET = 0x274;

/** Original bytes at load, for delta-sum checksum maintenance. */
let pristine = null;

function gm600Hooks(model) {
	pristine = model.buffer.slice();
	return {
		onBeforeExport(m) {
			// fold the sum of personality-block deltas into the checksum byte
			let delta = 0;
			for (let i = PERSONALITY_START; i < PERSONALITY_END; i++) {
				delta = (delta + (m.buffer[i] - pristine[i])) & 0xff;
			}
			if (delta !== 0) {
				const sum = (pristine[CHECKSUM_OFFSET] + delta) & 0xff;
				m.buffer[CHECKSUM_OFFSET] = sum; // direct poke; checksum field is display-only here
				pristine = m.buffer.slice();
				m.markClean();
			}
		},
	};
}

async function loadSample() {
	const [ksyText, bin] = await Promise.all([
		fetch("../sample/gm600_codeplug.ksy").then((r) => {
			if (!r.ok) throw new Error(`ksy fetch: ${r.status}`);
			return r.text();
		}),
		fetch("../sample/final.bin").then((r) => {
			if (!r.ok) throw new Error(`bin fetch: ${r.status}`);
			return r.arrayBuffer();
		}),
	]);
	const model = new CodeplugModel(loadSchema(parse(ksyText)), new Uint8Array(bin));
	app.textContent = "";
	mountKaitaiEditor(app, { model, hooks: gm600Hooks(model) });
}

function filePickers() {
	app.textContent = "";
	const ksyInput = document.createElement("input");
	const binInput = document.createElement("input");
	for (const [input, accept] of [[ksyInput, ".ksy,.yaml,.yml"], [binInput, ".bin"]]) {
		input.type = "file";
		input.accept = accept;
		input.style.cssText = "display:block;margin:18px auto;color:#d5dbe3";
		app.append(input);
	}
	const go = async () => {
		if (!ksyInput.files[0] || !binInput.files[0]) return;
		const ksyText = await ksyInput.files[0].text();
		const bin = await binInput.files[0].arrayBuffer();
		const model = new CodeplugModel(loadSchema(parse(ksyText)), new Uint8Array(bin));
		app.textContent = "";
		mountKaitaiEditor(app, { model, hooks: {} });
	};
	binInput.onchange = go;
}

loadSample().catch(() => filePickers());
