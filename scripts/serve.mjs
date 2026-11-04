/**
 * Static dev server with SPA fallback for the editor's History-API routes.
 *
 *   node scripts/serve.mjs        # PORT env, default 8080
 *
 * Serves the repo root; any GET under /demo/ that doesn't match a real file
 * falls back to demo/index.html so deep links like /demo/channels%5B0%5D
 * load the app (which then reads the path and selects the block).
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 8080);

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".bin": "application/octet-stream",
	".ksy": "text/plain; charset=utf-8",
	".yaml": "text/plain; charset=utf-8",
	".yml": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".png": "image/png",
};

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, "http://localhost");
		if (url.pathname === "/") {
			res.writeHead(302, { location: "/demo/" });
			return res.end();
		}
		const path = normalize(join(root, decodeURIComponent(url.pathname)));
		if (path !== root && !path.startsWith(root + sep)) {
			res.writeHead(403);
			return res.end("forbidden");
		}
		try {
			const data = await readFile(path);
			res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
			return res.end(data);
		} catch {
			// SPA fallback: deep links under the demo mount get the app shell
			if (url.pathname.startsWith("/demo/")) {
				const data = await readFile(join(root, "demo/index.html"));
				res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
				return res.end(data);
			}
			res.writeHead(404);
			return res.end("not found");
		}
	} catch (e) {
		res.writeHead(500);
		return res.end(String(e));
	}
});

server.listen(port, () => {
	console.log(`serving ${root}`);
	console.log(`demo: http://localhost:${port}/demo/`);
});
