/*
 * push-dests.js — where a `git push` sends each ref (workflow-core#2405, workflow-core#2785), for the
 * hooks that judge or follow a push: lib/branch-publish.js and
 * lib/lander-on-push.js read one push alike.
 *
 * Each refspec's destination is resolved against the pushing tree: `src:dst`
 * takes `dst`; a
 * bare `src` takes `git rev-parse --symbolic-full-name`, so `HEAD` is the
 * current branch and `v1.2.3` is a tag only where that tag exists locally. A
 * bare `git push` or `git push <remote>` is read as the tree's current branch,
 * as push.default=simple would push it; a `remote.<name>.push` refspec or
 * push.default=matching pushes something else, unseen.
 */

const { literal, scanFlags } = require("./shell-words.js");

/** `git push`'s value-taking flags, from `git push -h` on git 2.43.0. */
const PUSH_VALUE_FLAGS = "-o --push-option --repo --receive-pack --exec";

/**
 * @typedef {object} PushRow
 * @property {"push" | "delete" | "unread-push" | "unread-delete"} kind unread
 *   being a refspec literal cannot read (`git push origin "$B"`)
 * @property {string} ref push: the full destination ref; delete: the word as
 *   written; unread: ""
 * @property {boolean} forced `-f`, `--force`, `--force-with-lease` or a `+`
 *   refspec forces it
 * @property {boolean} bare no refspec was given and the row is the current
 *   branch
 * @typedef {object} PushRead
 * @property {boolean} inert --help or --dry-run, which push nothing
 * @property {boolean} all --all, --branches or --mirror
 * @property {boolean} delete -d or --delete, every row then a deletion
 * @property {PushRow[]} rows one per destination. A detached HEAD's bare
 *   push, which git refuses, and `tag <name>` give none; nor does `--tags`
 *   with no refspec
 */

/**
 * @param {string} word
 * @param {string} long
 * @param {number} n
 */
const abbrevOf = (word, long, n) => word.length >= n && long.startsWith(word);

/**
 * The full ref a bare push source names, or refs/heads/<src> where git cannot
 * name one, a push git refuses; HEAD on a detached HEAD.
 * @param {string} src
 * @param {(src: string) => string} symbolicName `git rev-parse
 *   --symbolic-full-name <src>` in the pushing tree, "" where it fails
 */
function fullSrc(src, symbolicName) {
	if (src.startsWith("refs/")) return src;
	const full = symbolicName(src);
	if (full.startsWith("refs/") || full === "HEAD") return full;
	return `refs/heads/${src}`;
}

/**
 * @param {string[]} args the masked words after `push`
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
 * What a flag no name alone gives is git's abbreviation of, if anything.
 * @param {string} name
 * @returns {"delete" | "lease" | "noLease" | null}
 */
function abbreviated(name) {
	if (abbrevOf(name, "--delete", 4)) return "delete";
	if (abbrevOf(name, "--force-with-lease", 9)) return "lease";
	if (abbrevOf(name, "--no-force-with-lease", 12)) return "noLease";
	return null;
}

/**
 * The push's flags, and its positional words, remote first.
 * @param {string[]} args
 */
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
		/* `tag <name>` is git's spelling of refs/tags/<name>:refs/tags/<name>. */
		if (lit.known && lit.text === "tag" && i + 1 < specs.length) i++;
		else if (lit.known) rows.push(...readSpec(lit.text, symbolicName, forced));
		else rows.push(row("unread-push", ""));
	}
	return rows;
}

/**
 * One refspec's row.
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
 * A `src:dst` refspec's full destination: in `refs/tags/` where `src` is a
 * tag, else `refs/heads/`.
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
