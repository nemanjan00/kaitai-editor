import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { loadSchema } from "../src/schema.js";
import { CodeplugModel } from "../src/model.js";
import { createCodeplug } from "../src/index.js";
import { compileExpr, translateExpr } from "../src/expr.js";

const ksyText = readFileSync(new URL("../sample/gm600_codeplug.ksy", import.meta.url), "utf8");
const ksy = parse(ksyText);
const bin = readFileSync(new URL("../sample/final.bin", import.meta.url));
const schema = loadSchema(ksy);
const model = new CodeplugModel(schema, new Uint8Array(bin));

test("schema: meta and no load errors", () => {
	assert.equal(schema.meta.id, "gm600_codeplug");
	assert.equal(schema.endian, "be");
	assert.deepEqual(schema.errors, []);
});

test("schema: root instances resolved with offsets", () => {
	const byId = Object.fromEntries(schema.root.fields.map((f) => [f.id, f]));
	assert.equal(byId.serial.pos, 0x08);
	assert.equal(byId.own_unit_no.offset, 0x18b);
	assert.equal(byId.channels.offset, 0x1e7);
	assert.equal(byId.channels.count, 4);
	assert.equal(byId.own_groups.count, 15);
	assert.equal(schema.types.channel.size, 7);
	assert.equal(schema.types.own_group.size, 4);
});

test("model: reads serial, unit numbers, checksum", () => {
	const serial = model.byPath("serial");
	assert.equal(model.value(serial), "807IYA0903CG");
	assert.equal(model.value(model.byPath("own_unit_no")), 322);
	assert.equal(model.value(model.byPath("own_fleet_indv_no")), 2001);
	assert.equal(model.value(model.byPath("personality_checksum")), 0xe6);
});

test("model: derived instances evaluate (flags, frequencies, group numbers)", () => {
	assert.equal(model.value(model.byPath("acoustic_feedback")), true); // byte 0x1a3 = 0x6c, bit6 set
	assert.equal(model.value(model.byPath("telephone_type_handset")), false); // byte 0x1aa = 0x00
	assert.equal(model.value(model.byPath("channels[0].rx_hz")), 375000000 + 11371 * 6250);
	assert.equal(model.value(model.byPath("channels[0].tx_hz")), 375000000 + 11371 * 6250);
	assert.equal(model.value(model.byPath("channels[0].is_simplex")), true);
	assert.equal(model.value(model.byPath("channels[0].data_channel")), 0);
	assert.equal(model.display(model.byPath("channels[0].data_channel")), "no"); // enum yes_no
	assert.equal(model.display(model.byPath("channels[0].tx_power")), "high"); // options 0x08 bit3
	assert.equal(model.value(model.byPath("own_groups[0].group_number")), 0x87 + 0x304);
	assert.equal(model.value(model.byPath("own_groups[0].is_empty")), false);
	assert.equal(model.value(model.byPath("own_groups[14].is_empty")), true);
});

test("model: enum labels resolve", () => {
	assert.equal(model.display(model.byPath("channels[0].tx_pl")), "Disabled");
	assert.equal(model.display(model.byPath("own_groups[0].prefix")), "43");
});

test("model: write int round-trips through buffer", () => {
	const node = model.byPath("own_unit_no");
	assert.equal(model.set(node, 999), null);
	assert.equal(model.value(node), 999);
	// BE u2 at 0x18b
	assert.deepEqual([...model.buffer.subarray(0x18b, 0x18d)], [0x03, 0xe7]);
	assert.equal(model.dirtyCount(), 2);
	assert.equal(model.isDirty(0x18b), true);
	assert.equal(model.isDirty(0x18a), false);
});

test("model: write validates range", () => {
	const node = model.byPath("own_unit_no");
	const err = model.set(node, 0x10000);
	assert.ok(err instanceof Error);
	assert.match(err.message, /out of range/);
});

test("model: write string into fixed slot pads with NULs", () => {
	const node = model.byPath("serial");
	assert.equal(model.set(node, "AB"), null);
	assert.equal(model.value(node).slice(0, 2), "AB");
	assert.deepEqual([...model.buffer.subarray(0x08 + 2, 0x08 + 12)], new Array(10).fill(0));
});

test("model: derived fields without a write inverse are read-only", () => {
	const err = model.set(model.byPath("acoustic_feedback"), false);
	assert.ok(err instanceof Error);
	assert.match(err.message, /read-only/);
});

test("model: writable derived (rx_hz) maps back to its raw field", () => {
	const rxHz = model.byPath("channels[0].rx_hz");
	assert.equal(rxHz.writable, true);
	assert.equal(rxHz.writeTarget, "rx_raw");
	// 446.06875 MHz is on the 6.25 kHz grid -> bit15 set, same as before (0xAC6B)
	assert.equal(model.set(rxHz, 375000000 + 11371 * 6250), null);
	assert.equal(model.value(model.byPath("channels[0].rx_raw")), 0xac6b);
	assert.deepEqual([...model.buffer.subarray(0x1e7, 0x1e9)], [0xac, 0x6b]);
	// 5 kHz grid value -> bit15 clear, word = (f - 375 MHz) / 5000.
	// 12001*5000 = 60005000 is NOT divisible by 6250, so the inverse picks the
	// 5 kHz grid; 12000*5000 = 60000000 % 6250 == 0 would pick the 6.25 kHz grid.
	assert.equal(model.set(rxHz, 375000000 + 12001 * 5000), null);
	assert.equal(model.value(model.byPath("channels[0].rx_raw")), 12001);
	assert.deepEqual([...model.buffer.subarray(0x1e7, 0x1e9)], [0x2e, 0xe1]);
});

test("model: writable derived (group_number) round-trips", () => {
	const node = model.byPath("own_groups[0].group_number");
	assert.equal(node.writable, true);
	const before = model.value(node);
	assert.equal(model.set(node, 950), null);
	assert.equal(model.value(model.byPath("own_groups[0].group_raw")), 950 - 0x304);
	assert.equal(model.set(node, before), null);
	assert.equal(model.value(model.byPath("own_groups[0].group_raw")), 0x87);
});

test("model: nodeAt finds deepest field", () => {
	assert.equal(model.nodeAt(0x08).id, "serial");
	assert.equal(model.nodeAt(0x18c).id, "own_unit_no");
	assert.equal(model.nodeAt(0x1e8).path, "channels[0].rx_raw");
});

test("model: onChange fires on writes only", () => {
	let calls = 0;
	const off = model.onChange(() => calls++);
	model.set(model.byPath("low_power_level"), 100);
	off();
	model.set(model.byPath("low_power_level"), 90);
	assert.equal(calls, 1);
});

test("expr: KS operators translate and evaluate", () => {
	assert.equal(translateExpr("a and not b"), "a && !b");
	const fn = compileExpr("(raw & 0x8000) != 0 ? 6250 : 5000");
	assert.equal(fn((n) => ({ raw: 0x8001 })[n]), 6250);
	assert.equal(fn((n) => ({ raw: 1 })[n]), 5000);
});

test("expr: sandbox hides globals, unknown names are undefined", () => {
	const fn = compileExpr("typeof window");
	assert.equal(fn(() => undefined), "undefined");
	const boom = compileExpr("fetch");
	assert.equal(boom(() => undefined), undefined);
});

test("createCodeplug: string ksy parses end to end", async () => {
	const m = await createCodeplug(ksyText, bin.slice(0));
	assert.equal(m.value(m.byPath("own_unit_no")), 322);
});
