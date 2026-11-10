/*
 * stale-at-head.js — the rows a --review re-anchors that were already stale at
 * HEAD, and the inputs that changed under each since its anchor was written
 * (#4756).
 *
 * A re-anchor asserts a re-read of everything that moved the digest, not only
 * the change in hand. A row is stale at HEAD where its digest over HEAD's tree,
 * extracted, differs from HEAD's anchor; the inputs named are those of its
 * closure at HEAD or now that changed between the commit that wrote that anchor
 * and HEAD, so the re-anchoring commit reads them or leaves the row stale.
 *
 * HEAD's digest is taken by HEAD's own digest code where HEAD carries it at
 * this library's path, so a commit changing that code does not read every row
 * as stale at HEAD (#4807).
 *
 * The writer is the newest non-merge commit whose diff adds the row at HEAD's
 * value without removing it at that value, a line moved or re-emitted being no
 * write; else the newest merge whose first-parent diff does, as a merge
 * carrying the row writes it (#4514). Residual: a writer that itself committed
 * the row stale, through a gate stood down (#2853), bypassed, or an anchor
 * hashed from bytes it did not stage, names no input, and the row is printed
 * with that said.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { gitReader } = require("./git.js");
const guardDigest = require("./guard-digest.js");
const { ANCHORS, parseRows } = require("./registry-anchors-file.js");

/**
 * @typedef {{ guard: string, digest: string, inputs: string[] }} Anchored a row
 *   this run writes, its new digest and every path that digest hashes
 * @typedef {{ guard: string, anchor: string, writer: string | null,
 *   changed: string[], error: string | null }} StaleAtHead `writer` null where
 *   the history this clone holds shows no commit writing `anchor`; `error`
 *   where git would not say
 * @typedef {{ stale: StaleAtHead[], error: string | null }} StaleRead `error`
 *   where git would not say which rows are stale at HEAD
 * @typedef {import("./git.js").GitReader} GitReader
 */

/**
 * The anchors HEAD commits: none where HEAD is unborn or carries no anchors
 * file.
 *
 * @param {GitReader} git
 * @returns {{ anchors: Record<string, string>, error: string | null }}
 */
function readHeadAnchors(git) {
	const head = git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], [1]);
	if (!head.ok) return { anchors: {}, error: head.why };
	if (!head.out.trim()) return { anchors: {}, error: null };
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
 * HEAD's tree extracted to a fresh directory, removed by the caller.
 *
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
 * The digest code HEAD carries at this library's path, or this one's where it
 * carries none, as when the library is a plugin's outside the tree.
 *
 * @param {string} root
 * @param {string} dir HEAD's extracted tree
 * @returns {typeof guardDigest}
 */
function headDigestCode(root, dir) {
	const rel = path.relative(root, path.join(__dirname, "guard-digest.js"));
	const there = path.join(dir, rel);
	if (rel.startsWith("..") || !fs.existsSync(there)) return guardDigest;
	return require(there);
}

/**
 * The SHAs this clone's history is cut off at, none in a full clone: a boundary
 * commit's diff adds every row, so it is no writer.
 *
 * @param {string} root
 * @param {GitReader} git
 * @returns {Set<string>}
 */
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
 * Each sought row's writer, from one `git log -p` over the anchors file.
 *
 * @param {GitReader} git
 * @param {Map<string, string>} sought guard → HEAD anchor
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
 * The rows among `anchored` stale at HEAD, each with the inputs of its closure
 * at HEAD or now that changed between its anchor's writer and HEAD.
 *
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
 * Each stale row's writer and the inputs changed since it.
 *
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
