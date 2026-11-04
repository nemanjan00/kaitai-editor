/**
 * Dev orchestrator: esbuild --watch + the SPA-fallback static server.
 * Kills both children on SIGINT/SIGTERM or when either one exits.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();

const esbuildBin = join(root, "node_modules", "esbuild", "bin", "esbuild");
const esbuild = spawn(
	esbuildBin,
	["demo/app.js", "--bundle", "--format=iife", "--outfile=demo/bundle.js", "--loader:.css=css", "--watch=forever"],
	{ stdio: "inherit" },
);
const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs")], { stdio: "inherit" });

let shuttingDown = false;
const shutdown = (code) => {
	if (shuttingDown) return;
	shuttingDown = true;
	esbuild.kill();
	server.kill();
	process.exit(code);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
esbuild.on("exit", (code) => shutdown(code ?? 1));
server.on("exit", (code) => shutdown(code ?? 1));
