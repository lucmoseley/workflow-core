const { literal, scanFlags } = require("./shell-words.js");

const PUSH_VALUE_FLAGS = "-o --push-option --repo --receive-pack --exec";

/**
 * @typedef {object} PushRow
 * @property {"push" | "delete" | "unread-push" | "unread-delete"} kind
 * @property {string} ref
 * @property {boolean} forced
 * @property {boolean} bare
 * @typedef {object} PushRead
 * @property {boolean} inert
 * @property {boolean} all
 * @property {boolean} delete
 * @property {PushRow[]} rows
 */

/**
 * @param {string} word
 * @param {string} long
 * @param {number} n
 */
const abbrevOf = (word, long, n) => word.length >= n && long.startsWith(word);

/**
 * @param {string} src
 * @param {(src: string) => string} symbolicName
 */
function fullSrc(src, symbolicName) {
	if (src.startsWith("refs/")) return src;
	const full = symbolicName(src);
	if (full.startsWith("refs/") || full === "HEAD") return full;
	return `refs/heads/${src}`;
}

/**
 * @param {string[]} args
 * @param {string[]} spans
 * @param {(src: string) => string} symbolicName
 * @returns {PushRead}
 */
function readPush(args, spans, symbolicName) {
	const flags = readFlags(args);
	const { positional, tags, ...read } = flags;
	const specs = positional.slice(1);
	/** @type {PushRead} */
	const out = {
		inert: read.inert,
		all: read.all,
		delete: read.delete,
		rows: [],
	};
	if (read.delete)
		out.rows = specs.map((spec) => {
			const lit = literal(spec, spans);
			return lit.known ? row("delete", lit.text) : row("unread-delete", "");
		});
	else if (specs.length === 0) {
		const full = tags ? "HEAD" : fullSrc("HEAD", symbolicName);
		if (full !== "HEAD") out.rows = [row("push", full, read.forced, true)];
	} else out.rows = readSpecs(specs, spans, symbolicName, read.forced);
	return out;
}

/**
 * @param {PushRow["kind"]} kind
 * @param {string} ref
 * @returns {PushRow}
 */
const row = (kind, ref, forced = false, bare = false) => ({
	kind,
	ref,
	forced,
	bare,
});

const FLAG_KEYS =
	/** @type {Record<string, "all" | "tags" | "inert" | "force" | "delete">} */ ({
		"--all": "all",
		"--branches": "all",
		"--mirror": "all",
		"--tags": "tags",
		"-h": "inert",
		"--help": "inert",
		"-n": "inert",
		"--dry-run": "inert",
		"-f": "force",
		"--force": "force",
		"-d": "delete",
	});

/**
 * @param {string} name
 * @returns {"delete" | "lease" | "noLease" | null}
 */
function abbreviated(name) {
	if (abbrevOf(name, "--delete", 4)) return "delete";
	if (abbrevOf(name, "--force-with-lease", 9)) return "lease";
	if (abbrevOf(name, "--no-force-with-lease", 12)) return "noLease";
	return null;
}

/** @param {string[]} args */
function readFlags(args) {
	const read = {
		inert: false,
		all: false,
		delete: false,
		force: false,
		lease: false,
		tags: false,
		/** @type {string[]} */
		positional: [],
	};
	scanFlags(PUSH_VALUE_FLAGS, args, (kind, name, value) => {
		if (kind === "arg") read.positional.push(value);
		else if (kind === "opt") read.lease ||= abbreviated(name) === "lease";
		else if (kind === "flag") {
			const key = Object.hasOwn(FLAG_KEYS, name)
				? FLAG_KEYS[name]
				: abbreviated(name);
			if (key === "noLease") read.lease = false;
			else if (key) read[key] = true;
		}
	});
	return { ...read, forced: read.force || read.lease };
}

/**
 * @param {string[]} specs
 * @param {string[]} spans
 * @param {(src: string) => string} symbolicName
 * @param {boolean} forced
 * @returns {PushRow[]}
 */
function readSpecs(specs, spans, symbolicName, forced) {
	/** @type {PushRow[]} */
	const rows = [];
	for (let i = 0; i < specs.length; i++) {
		const lit = literal(specs[i] ?? "", spans);
		if (lit.known && lit.text === "tag" && i + 1 < specs.length) i++;
		else if (lit.known) rows.push(...readSpec(lit.text, symbolicName, forced));
		else rows.push(row("unread-push", ""));
	}
	return rows;
}

/**
 * @param {string} text
 * @param {(src: string) => string} symbolicName
 * @param {boolean} forced
 * @returns {PushRow[]}
 */
function readSpec(text, symbolicName, forced) {
	const plus = text.startsWith("+");
	const spec = plus ? text.slice(1) : text;
	const colon = spec.indexOf(":");
	if (colon === 0) return [row("delete", spec.slice(1))];
	const full =
		colon > 0
			? destination(spec.slice(0, colon), spec.slice(colon + 1), symbolicName)
			: fullSrc(spec, symbolicName);
	return full === "HEAD" ? [] : [row("push", full, forced || plus)];
}

/**
 * @param {string} src
 * @param {string} dst
 * @param {(src: string) => string} symbolicName
 */
function destination(src, dst, symbolicName) {
	if (dst.startsWith("heads/")) return `refs/${dst}`;
	if (dst.startsWith("refs/")) return dst;
	return fullSrc(src, symbolicName).startsWith("refs/tags/")
		? `refs/tags/${dst}`
		: `refs/heads/${dst}`;
}

module.exports = { readPush };
