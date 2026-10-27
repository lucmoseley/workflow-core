/*
 * pool-imports.js — the files a pool member `@`-imports, which the harness
 * loads into every session with it (#1956).
 *
 * The harness's rules: a path after `@` resolves against the importing file's
 * directory, imports nest up to five hops, and none is evaluated inside a code
 * span or fenced block. A token that names no file is prose (`@me`, an npm
 * scope) and is skipped, as the harness skips it.
 *
 * ONLY FILES INSIDE THE ROOT. A `@~/...` or absolute import is a user-level
 * file this repo cannot delete, so it fails the pool's membership test.
 *
 * RESIDUAL: `--against` materialises the declared pool and nothing it imports
 * (lib/context-budget-pathspecs.js), so an import of an undeclared file reads
 * as absent on both sides of that comparison and is never gated, only reported
 * on a live run.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { requiredGroup } = require("./regex-group.js");

const MAX_HOPS = 5;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)[^`]*?\1/g;
const IMPORT = /(?:^|\s)@(\S+)/g;

/* The errnos that mean a path names no file. Any other is the instrument
 * failing, and throws. */
const NOT_A_FILE = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/**
 * The `@` tokens `text` holds outside code, in order.
 * @param {string} text
 * @returns {string[]}
 */
function importTokens(text) {
	const out = [];
	let fence = "";
	for (const line of text.split("\n")) {
		const f = line.match(FENCE)?.[1];
		if (fence) {
			if (f && f[0] === fence[0] && f.length >= fence.length) fence = "";
			continue;
		}
		if (f) {
			fence = f;
			continue;
		}
		for (const m of line.replace(CODE_SPAN, " ").matchAll(IMPORT))
			out.push(requiredGroup(m, 1, IMPORT));
	}
	return out;
}

/**
 * The root-relative path `token` names from `fromRel`, or null where it names
 * no regular file inside `root`.
 * @param {string} root
 * @param {string} fromRel
 * @param {string} token
 * @returns {string | null}
 */
function resolveImport(root, fromRel, token) {
	if (token.startsWith("~") || path.isAbsolute(token)) return null;
	const abs = path.resolve(root, path.dirname(fromRel), token);
	const rel = path.relative(root, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
	try {
		return fs.statSync(abs).isFile() ? rel.split(path.sep).join("/") : null;
	} catch (e) {
		/* A token naming nothing is prose, skipped as the harness skips it (#1956). */
		if (NOT_A_FILE.has(String(caught(e).code))) return null;
		throw e;
	}
}

/**
 * A member's text, or "" where it is absent, so it imports nothing (#1956).
 * @param {string} root
 * @param {string} rel
 * @returns {string}
 */
function readMember(root, rel) {
	try {
		return fs.readFileSync(path.join(root, rel), "utf8");
	} catch (e) {
		if (NOT_A_FILE.has(String(caught(e).code))) return "";
		throw e;
	}
}

/**
 * Every file the `members` at `root` import, transitively, that is not itself
 * a member — each with the file that first imported it.
 * @param {string} root
 * @param {string[]} members root-relative pool paths
 * @returns {{ path: string, importedBy: string }[]}
 */
function readImportedFiles(root, members) {
	const seen = new Set(members);
	const out = [];
	let frontier = members;
	for (let hop = 1; hop <= MAX_HOPS && frontier.length > 0; hop++) {
		const next = [];
		for (const from of frontier) {
			for (const token of importTokens(readMember(root, from))) {
				const rel = resolveImport(root, from, token);
				if (rel === null || seen.has(rel)) continue;
				seen.add(rel);
				out.push({ path: rel, importedBy: from });
				next.push(rel);
			}
		}
		frontier = next;
	}
	return out;
}

module.exports = { readImportedFiles, importTokens };
