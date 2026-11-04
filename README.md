# kaitai-editor

**Generic binary/codeplug editor driven by a [Kaitai Struct](https://kaitai.io) `.ksy` spec.**
Load a spec, load a binary, edit the structure in a GUI, export the patched binary.
UI built on [@nemanjan00/qrp](https://qrp.nemanja.top/) — zero-dep, no-framework-lockin DOM.

Born from reverse-engineering Motorola GM600 (MPT1327) codeplugs: the `.ksy` is the
single source of truth for the format, and this editor turns that truth into an
editor without writing any format-specific UI code.

```
┌─ sample/gm600_codeplug.ksy ─┐   ┌─ sample/final.bin ─┐
│  instances: serial @ 0x08 … │ + │  640 raw bytes     │
└──────────────┬──────────────┘   └─────────┬──────────┘
               ▼                            ▼
        loadSchema()                CodeplugModel
               └──────────┬───────────────┘
                          ▼
              mountKaitaiEditor()  →  GUI →  patched .bin
```

## Quick start

```sh
npm install
npm test          # 18 tests: core round-trip + UI smoke (happy-dom)
npm run dev       # esbuild watch + serve on :8080, open /demo/
```

`npm run dev` serves the repo root; the demo fetches `sample/gm600_codeplug.ksy`
and `sample/final.bin` (both gitignored — drop your own into `sample/`, or use the
file pickers in the demo UI). Editing works immediately; **Export .bin** writes the
patched binary, running any registered export hooks first (the demo recomputes the
GM600 additive personality checksum).

Other scripts: `npm run build` (bundle the UI lib to `dist/`), `npm run build:demo`,
`npm run serve` (plain static server).

## Library usage

### Core (framework-free, works in Node and browsers)

```js
import { loadSchema, CodeplugModel, createCodeplug } from "kaitai-editor";
import { parse } from "yaml";

const schema = loadSchema(parse(ksyText));            // .ksy → resolved schema
const model = new CodeplugModel(schema, uint8Array);  // binary → editable model

model.value(model.byPath("own_unit_no"));             // 322
model.set(model.byPath("own_unit_no"), 999);          // writes BE u2 @ 0x18B
model.dirtyCount();                                   // changed bytes
model.snapshot();                                     // copy of patched buffer
```

`CodeplugModel` is intentionally **not** reactive: subscribe with
`model.onChange((node) => …)` and wire it into your framework's state.

### UI (qrp)

```js
import { mountKaitaiEditor } from "kaitai-editor/ui";
import "kaitai-editor/ui.css";   // or let esbuild bundle it from the JS import

const { model, ui, dispose } = mountKaitaiEditor(parentElement, {
  model,                                   // a CodeplugModel
  hooks: {
    onBeforeExport(m) { /* fix checksums; return an Error to block export */ },
  },
});
```

The editor renders: a block tree (top-level `.ksy` instances), a field table per
block (offsets, raw hex, typed inputs, derived values), and a hex dump with dirty
highlighting — click a byte to jump to the field that owns it.

## Supported `.ksy` subset

The editor only needs what a fixed-layout binary spec uses:

| supported | notes |
|---|---|
| `meta`: `id`, `title`, `file-extension`, `endian` | `be`/`le`, per-type override |
| top-level `instances` with `pos` | treated as the root sequence |
| `types` with `seq` of `u1…u8`, `s1…s8`, `f4/f8`, `bool`, `str`, `bytes`, nested types | fixed `size` required for `str` |
| `repeat: expr` | count must be a constant expression |
| `enums` | rendered as labelled dropdowns |
| derived `instances` (`value:`) | evaluated live, shown read-only |
| `size`-only instances | shown as opaque, non-editable blocks |

| not (yet) supported | degradation |
|---|---|
| `switch-on`, `process:` (xor/rol/…), `repeat: eos/until`, non-constant `repeat-expr` | field becomes opaque; listed in `model.errors` |
| `if:` on `seq` fields | evaluated at load; layout assumes present |
| `instances` with `io:` | ignored |
| writing *through* a derived expression (bit flags) | edit the raw byte; the flag re-derives |

Expressions (`value:`, `if:`, `repeat-expr`) run in a sandbox: KS `and/or/not` and
`.to_i` are translated, all globals are shadowed, unknown names are `undefined`.

## Architecture

```
src/
  expr.js        Kaitai expression → sandboxed JS evaluator
  primitives.js  DataView read/write for the scalar type subset
  schema.js      parsed .ksy → normalized, layout-resolved schema (+ errors[])
  model.js       CodeplugModel: node tree, values, writes, dirty tracking
  index.js       core barrel + createCodeplug()
  ui/
    editor.js    qrp app: toolbar/sidebar/detail, export
    fields.js    field-row factories (enum selects, bounded ints, strings)
    hexview.js   hex dump with dirty/selection highlight, click-to-locate
    editor.css   dark theme
demo/            GM600 demo app (esbuild bundle)
test/            node:test suites (core round-trip, happy-dom UI smoke)
```

Design choices:

- **Own read/write interpreter instead of generated Kaitai parsers** — generated
  code parses read-only; an editor needs byte-accurate write-back.
- **Model is framework-free** — qrp reactivity stays at the UI boundary
  (`ui.rev` bumps on `model.onChange`).
- **Checksums are a user hook** — they aren't expressible in `.ksy`; the demo
  shows the pattern (`hooks.onBeforeExport`).

## Status / roadmap

Working: schema loading, round-trip read/write, enums, derived values, arrays,
hex view, export hooks, GM600 demo end-to-end.

Next: `repeat: expr` referencing instance state, `switch-on` unions, bit-flag
checkboxes derived from `value:` patterns, undo/redo, diff view between two dumps.
