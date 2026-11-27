const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { readCommit } = require("./commit-sha.js");
const { gitReader } = require("./git.js");
const guardDigest = require("./guard-digest.js");
const { ANCHORS, parseRows } = require("./registry-anchors-file.js");

/**
 * @typedef {{ guard: string, digest: string, inputs: string[] }} Anchored
 * @typedef {{ guard: string, anchor: string, writer: string | null,
 *   changed: string[], error: string | null }} StaleAtHead
 * @typedef {{ stale: StaleAtHead[], error: string | null }} StaleRead
 * @typedef {import("./git.js").GitReader} GitReader
 */

/**
 * @param {GitReader} git
 * @returns {{ anchors: Record<string, string>, error: string | null }}
 */
function readHeadAnchors(git) {
	const head = readCommit(git, "HEAD");
	if (!head.ok) return { anchors: {}, error: head.why };
	if (head.sha === null) return { anchors: {}, error: null };
	const listed = git(["ls-tree", "--name-only", "HEAD", "--", ANCHORS], []);
	if (!listed.ok) return { anchors: {}, error: listed.why };
	if (!listed.out.trim()) return { anchors: {}, error: null };
	const shown = git(["show", `HEAD:${ANCHORS}`], []);
	if (!shown.ok) return { anchors: {}, error: shown.why };
	const anchors = parseRows(shown.out);
	return anchors
		? { anchors, error: null }
		: {
				anchors: {},
				error: `HEAD's ${ANCHORS} is not a JSON object of digests`,
			};
}

/**
 * @param {GitReader} git
 * @returns {{ dir: string, error: string | null }}
 */
function extractHead(git) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-at-head-"));
	const tar = path.join(dir, ".head.tar");
	const archived = git(["archive", "--format=tar", "-o", tar, "HEAD"], []);
	if (!archived.ok) return { dir, error: archived.why };
	const x = spawnSync("tar", ["-xf", tar, "-C", dir], { encoding: "utf8" });
	fs.rmSync(tar, { force: true });
	if (x.error || x.status !== 0)
		return {
			dir,
			error: `tar could not unpack HEAD: ${x.error?.message ?? String(x.stderr).trim()}`,
		};
	return { dir, error: null };
}

/**
 * @param {string} root
 * @param {string} dir
 * @returns {typeof guardDigest}
 */
function headDigestCode(root, dir) {
	const rel = path.relative(root, path.join(__dirname, "guard-digest.js"));
	const there = path.join(dir, rel);
	if (rel.startsWith("..") || !fs.existsSync(there)) return guardDigest;
	return require(there);
}

/** @param {string} root @param {GitReader} git @returns {Set<string>} */
function readShallow(root, git) {
	const p = git(["rev-parse", "--git-path", "shallow"], []);
	if (!p.ok) return new Set();
	const file = path.resolve(root, p.out.trim());
	if (!fs.existsSync(file)) return new Set();
	return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean));
}

/**
 * @param {string[]} lines
 * @returns {{ added: Map<string, string>, removed: Map<string, string> }}
 */
function parseDiff(lines) {
	const added = new Map();
	const removed = new Map();
	for (const line of lines) {
		const sign = line[0];
		if ((sign !== "+" && sign !== "-") || /^(\+\+\+|---)/.test(line)) continue;
		const rows = parseRows(`{${line.slice(1).trim().replace(/,$/, "")}}`);
		const [entry] = Object.entries(rows ?? {});
		if (entry) (sign === "+" ? added : removed).set(entry[0], entry[1]);
	}
	return { added, removed };
}

/**
 * @param {GitReader} git
 * @param {Map<string, string>} sought
 * @param {string[]} mode
 * @returns {{ writers: Map<string, string>, error: string | null }}
 */
function readWriters(git, sought, mode) {
	/** @type {Map<string, string>} */
	const writers = new Map();
	if (sought.size === 0) return { writers, error: null };
	const log = git(
		[
			"log",
			...mode,
			"-p",
			"--unified=0",
			"--format=%x00%H",
			"HEAD",
			"--",
			ANCHORS,
		],
		[],
	);
	if (!log.ok) return { writers, error: log.why };
	for (const chunk of log.out.split("\0")) {
		const [sha, ...lines] = chunk.split("\n");
		if (!sha) continue;
		const { added, removed } = parseDiff(lines);
		for (const [guard, anchor] of added)
			if (
				!writers.has(guard) &&
				sought.get(guard) === anchor &&
				removed.get(guard) !== anchor
			)
				writers.set(guard, sha);
		if (writers.size === sought.size) break;
	}
	return { writers, error: null };
}

/**
 * @param {string} root
 * @param {Anchored[]} anchored
 * @returns {StaleRead}
 */
function readStaleAtHead(root, anchored) {
	const git = gitReader(root);
	const head = readHeadAnchors(git);
	if (head.error) return { stale: [], error: head.error };
	const moved = anchored.flatMap((a) => {
		const anchor = head.anchors[a.guard];
		return anchor !== undefined && anchor !== a.digest
			? [{ ...a, anchor }]
			: [];
	});
	if (moved.length === 0) return { stale: [], error: null };
	const extracted = extractHead(git);
	try {
		if (extracted.error) return { stale: [], error: extracted.error };
		const { digestOf } = headDigestCode(root, extracted.dir);
		const stale = moved.flatMap((m) => {
			const at = digestOf(extracted.dir, m.guard);
			return at.digest === m.anchor
				? []
				: [{ ...m, inputs: [...new Set([...m.inputs, ...at.hashed])] }];
		});
		return { stale: namePasts(root, git, stale), error: null };
	} finally {
		fs.rmSync(extracted.dir, { recursive: true, force: true });
	}
}

/**
 * @param {string} root
 * @param {GitReader} git
 * @param {(Anchored & { anchor: string })[]} stale
 * @returns {StaleAtHead[]}
 */
function namePasts(root, git, stale) {
	const sought = new Map(stale.map((s) => [s.guard, s.anchor]));
	const plain = readWriters(git, sought, ["--no-merges"]);
	const unfound = new Map([...sought].filter(([g]) => !plain.writers.has(g)));
	const merged = plain.error
		? { writers: new Map(), error: null }
		: readWriters(git, unfound, ["--merges", "--diff-merges=first-parent"]);
	const shallow = readShallow(root, git);
	return stale.map((s) => {
		const base = { guard: s.guard, anchor: s.anchor, changed: [] };
		const found = plain.writers.get(s.guard) ?? merged.writers.get(s.guard);
		const error = found ? null : (plain.error ?? merged.error);
		const writer = found && !shallow.has(found) ? found : null;
		if (error || writer === null) return { ...base, writer, error };
		const diff = git(
			[
				"--literal-pathspecs",
				"diff",
				"--name-only",
				"-z",
				writer,
				"HEAD",
				"--",
				...s.inputs,
			],
			[],
		);
		if (!diff.ok) return { ...base, writer, error: diff.why };
		const changed = diff.out.split("\0").filter(Boolean).sort();
		return { ...base, writer, changed, error: null };
	});
}

module.exports = { readStaleAtHead };
