const fs = require("node:fs");
const path = require("node:path");
const { claimByArbiter } = require("./script-claim.js");
const { caught } = require("./caught.js");
const { coreRoot } = require("./script-path.js");
const { EDGES_FILE } = require("./test-pass-marker.js");
const { buildManifestText } = require("./read-edges-render.js");

// guess, #1860
const CLAIM_TIMEOUT_MS = 5000;

// #5579
/**
 * @typedef {{ root: string, loaded: Map<string, string> }} Extractor
 */

/** @returns {Extractor} */
function loadedExtractor() {
	const root = coreRoot();
	/** @type {Map<string, string>} */
	const loaded = new Map();
	/** @param {NodeJS.Module | undefined} mod */
	const walk = (mod) => {
		if (!mod) return;
		const rel = path.relative(root, mod.filename);
		if (loaded.has(rel) || rel.startsWith("..") || rel.includes("node_modules"))
			return;
		loaded.set(rel, fs.readFileSync(mod.filename, "utf8"));
		for (const child of mod.children) walk(child);
	};
	walk(require.cache[require.resolve("./read-edges-render.js")]);
	return { root, loaded };
}

const LOADED = loadedExtractor();

/** @param {string} p */
function realOrSelf(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * @param {Extractor} extractor
 * @param {string} root
 * @param {string} home
 * @returns {string|null}
 */
function extractorDrift({ root: pluginRoot, loaded }, root, home) {
	if (realOrSelf(pluginRoot) !== realOrSelf(home)) return null;
	for (const [rel, text] of loaded) {
		let now;
		try {
			now = fs.readFileSync(path.join(root, rel), "utf8");
		} catch {
			return rel;
		}
		if (now !== text) return rel;
	}
	return null;
}

/**
 * @typedef {(file: string, session: string|null, cwd: string) => import("./script-claim.js").ClaimResult} ClaimFn
 * @type {ClaimFn}
 */
function claimWithArbiter(file, session, cwd) {
	return claimByArbiter(file, { session, cwd, timeoutMs: CLAIM_TIMEOUT_MS });
}

/**
 * @param {string} dir
 * @returns {string|null|Error}
 */
function readManifest(dir) {
	try {
		return fs.readFileSync(path.join(dir, EDGES_FILE), "utf8");
	} catch (error) {
		return caught(error).code === "ENOENT"
			? null
			: new Error(caught(error).message);
	}
}

/**
 * @param {string} home
 * @param {string} text
 * @param {{ given: string|null, session: string|null, claimFn: ClaimFn,
 *   err: { write: (s: string) => unknown } }} by
 * @returns {string|null}
 */
function writeShared(home, text, { given, session, claimFn, err }) {
	const shared = readManifest(home);
	if (shared instanceof Error) return `it would not read (${shared.message})`;
	if (shared !== given) return "it holds an edit this run was not given";
	const file = path.join(home, EDGES_FILE);
	const claim = claimFn(file, session, home);
	if (!claim.claimed) return claim.why;
	if (claim.warning) err.write(`${claim.warning}\n`);
	try {
		fs.writeFileSync(file, text);
		return null;
	} catch (error) {
		return caught(error).message;
	}
}

/**
 * @param {() => Record<string, string[]>} render
 * @param {{ root: string, home: string, session: string|null, claimFn?: ClaimFn,
 *   extractor?: Extractor,
 *   out: { write: (s: string) => unknown }, err: { write: (s: string) => unknown } }} at
 */
function freshenManifest(
	render,
	{
		root,
		home,
		session,
		claimFn = claimWithArbiter,
		extractor = LOADED,
		out,
		err,
	},
) {
	const drift = extractorDrift(extractor, root, home);
	if (drift) {
		err.write(
			`${EDGES_FILE} left alone: this run loaded ${drift} before the tree it runs on changed it, so its render is not that tree's. Regenerate it before you commit: npm run gen:test-read-edges (#5579).\n`,
		);
		return;
	}
	let rendered;
	try {
		rendered = render();
	} catch {
		return;
	}
	const text = buildManifestText(rendered);
	const given = readManifest(root);
	if (given === text) return;
	if (given instanceof Error) {
		err.write(
			`${EDGES_FILE} not brought up to date before the run (${given.message}) — the commit gate will ask for it after your run passes (#1860).\n`,
		);
		return;
	}
	try {
		fs.writeFileSync(path.join(root, EDGES_FILE), text);
	} catch (error) {
		err.write(
			`${EDGES_FILE} not brought up to date before the run (${caught(error).message}) — the commit gate will ask for it after your run passes (#1860).\n`,
		);
		return;
	}
	if (home === root || readManifest(home) === text) return;
	const why = writeShared(home, text, { given, session, claimFn, err });
	if (why) {
		err.write(
			`${EDGES_FILE}: the working tree's copy is left alone — ${why}. Regenerate it before you commit: npm run gen:test-read-edges (#1860).\n`,
		);
		return;
	}
	out.write(
		`${EDGES_FILE} brought up to date from the read graph this tree renders, before the run (#1860) — commit it with your work.\n`,
	);
}

module.exports = { freshenManifest };
