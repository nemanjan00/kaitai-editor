/**
 * Kaitai Struct expression compilation.
 *
 * KS `value:` / `repeat-expr` expressions are a small expression language that
 * is almost JavaScript: same operators (`& | ^ ~ << >> + - * / % == != < > <= >= ? :`),
 * same literals, with three differences we translate:
 *
 *   - boolean words:  `and` `or` `not`      -> `&&` `||` `!`
 *   - special names:  `_` `_parent` `_root` -> provided by the scope
 *   - casts:          `x.to_i`              -> `to_i(x)`
 *
 * Evaluation is sandboxed with a `with (scope)` Proxy whose `has` trap always
 * returns true, so *every* identifier resolves through our scope and no global
 * (`window`, `fetch`, …) is reachable. Unknown identifiers evaluate to
 * `undefined` instead of throwing, which mirrors KS's lenient feel and lets a
 * spec degrade (field shows "?") instead of breaking the whole editor.
 */

/** Translate a KS expression string into an equivalent JS expression string. */
export function translateExpr(src) {
	let js = String(src);
	js = js.replace(/\band\b/g, "&&").replace(/\bor\b/g, "||").replace(/\bnot\s+/g, "!");
	// KS cast idiom: expr.to_i -> to_i(expr). The operand is a paren group,
	// a member chain, or an atom; keep it simple and greedy-on-parens.
	js = js.replace(/\b([A-Za-z_][\w.]*|\([^()]*\))\.to_i\b/g, (_m, operand) => `to_i(${operand})`);
	// KS single-quoted strings -> JS double-quoted (YAML already stripped most,
	// but inline quotes inside expression strings survive).
	js = js.replace(/'([^'\\]*)'/g, (_m, body) => JSON.stringify(body));
	return js;
}

const CASTS = {
	to_i: (x) => Number(x) | 0,
	to_f: (x) => Number(x),
	to_s: (x) => String(x),
};

/**
 * Make the sandbox target for one evaluation. `resolve(name)` looks up a
 * variable lazily; lookups that throw stay uncaught here so callers can mark
 * the field as unevaluated rather than half-evaluate.
 */
function makeSandbox(resolve) {
	const target = Object.create(null);
	return new Proxy(target, {
		// Shadow every global: `with` consults `has` before the outer scope.
		has: (_t, key) => key !== Symbol.unscopables,
		get: (_t, key) => {
			if (key === Symbol.unscopables) return undefined;
			if (key in CASTS) return CASTS[key];
			return resolve(key);
		},
		set: () => {
			throw new Error("kaitai expressions are read-only");
		},
	});
}

/**
 * Compile a KS expression once; call the result with a resolver.
 *
 *   const fn = compileExpr("options & 0x01");
 *   fn((name) => scopeValues[name]); // -> number
 *
 * The resolver receives identifier names (`_`, `_root`, field ids, …).
 */
export function compileExpr(src) {
	const js = translateExpr(src);
	const body = new Function("sandbox", `with (sandbox) { return (${js}); }`);
	return (resolve) => body(makeSandbox(resolve));
}

/** Convenience: compile + evaluate in one step. Returns undefined on failure. */
export function evalExpr(src, resolve) {
	try {
		return compileExpr(src)(resolve);
	} catch {
		return undefined;
	}
}
