const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { relativeUnder } = require("./is-under.js");
const { requiredGroup } = require("./regex-group.js");

const MAX_HOPS = 5;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// eslint-disable-next-line regexp/no-super-linear-move -- input is the host repo's own files, which its own writers control; a crafted one slows the check, nothing worse (#4642)
const CODE_SPAN = /(`+)[^`]*?\1/g;
const IMPORT = /(?:^|\s)@(\S+)/g;

const NOT_A_FILE = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/**
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
 * @param {string} root
 * @param {string} fromRel
 * @param {string} token
 * @returns {string | null}
 */
function resolveImport(root, fromRel, token) {
	if (token.startsWith("~") || path.isAbsolute(token)) return null;
	const abs = path.resolve(root, path.dirname(fromRel), token);
	const rel = relativeUnder(root, abs);
	if (rel === null) return null;
	try {
		return fs.statSync(abs).isFile() ? rel.split(path.sep).join("/") : null;
	} catch (e) {
		if (NOT_A_FILE.has(String(caught(e).code))) return null;
		throw e;
	}
}

/**
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
 * @param {string} root
 * @param {string[]} members
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
