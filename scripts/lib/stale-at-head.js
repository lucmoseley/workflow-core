/*
 * stale-at-head.js — the rows a --review re-anchors that were already stale at
 * HEAD, and the inputs that changed under each since its anchor was written
 * (#4756).
 *
 * A re-anchor asserts a re-read of everything that moved the digest, not only
 * the change in hand. A row whose HEAD anchor differs from the digest being
 * written, and one of whose inputs changed between the commit that wrote that
 * anchor and HEAD, carries changes no re-read of this commit's covers: they are
 * named, so the re-anchoring commit reads them or leaves the row stale.
 *
 * The writer is the newest non-merge commit whose diff adds the row at HEAD's
 * value, else the newest merge whose first-parent diff does, as a merge
 * carrying the row writes it (#4514). The pre-commit gate refuses a commit that
 * leaves a row stale (#2617), so the writer is where the anchor was last fresh.
 */

const { GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");
const { ANCHORS, parseRows } = require("./registry-anchors-file.js");

/**
 * @typedef {{ guard: string, digest: string, inputs: string[] }} Anchored a row
 *   this run writes, its new digest and every path that digest hashes
 * @typedef {{ guard: string, anchor: string, writer: string | null,
 *   changed: string[], error: string | null }} StaleAtHead `writer` null where
 *   no commit in HEAD's history wrote `anchor`; `error` where git would not say
 */

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {{ out: string, error: string | null }}
 */
function git(root, args) {
	const r = spawnGitSync(["-C", root, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.error) return { out: "", error: r.error.message };
	if (r.status !== 0)
		return {
			out: "",
			error: String(r.stderr).trim() || `git ${args[0]} exited ${r.status}`,
		};
	return { out: String(r.stdout), error: null };
}

/**
 * The anchors HEAD commits, none where HEAD has no anchors file or no commit.
 *
 * @param {string} root
 * @returns {Record<string, string>}
 */
function readHeadAnchors(root) {
	const listed = git(root, ["ls-tree", "--name-only", "HEAD", "--", ANCHORS]);
	if (listed.error || !listed.out.trim()) return {};
	return parseRows(git(root, ["show", `HEAD:${ANCHORS}`]).out) ?? {};
}

/**
 * Each wanted row's writer, from one `git log -p` over the anchors file: the
 * first commit, newest first, whose diff adds the row at its HEAD value.
 *
 * @param {string} root
 * @param {Map<string, string>} wanted guard → HEAD anchor, emptied as each is found
 * @param {string[]} mode the log's merge handling
 * @returns {{ writers: Map<string, string>, error: string | null }}
 */
function readWriters(root, wanted, mode) {
	/** @type {Map<string, string>} */
	const writers = new Map();
	const log = git(root, [
		"log",
		...mode,
		"-p",
		"--unified=0",
		"--format=%x00%H",
		"HEAD",
		"--",
		ANCHORS,
	]);
	if (log.error) return { writers, error: log.error };
	for (const chunk of log.out.split("\0")) {
		const [sha, ...lines] = chunk.split("\n");
		if (!sha) continue;
		for (const line of lines) {
			const row = parseAdded(line);
			if (row && wanted.get(row.guard) === row.anchor) {
				writers.set(row.guard, sha);
				wanted.delete(row.guard);
			}
		}
		if (wanted.size === 0) break;
	}
	return { writers, error: null };
}

/**
 * The row a diff line adds, or null where it adds none.
 *
 * @param {string} line
 * @returns {{ guard: string, anchor: string } | null}
 */
function parseAdded(line) {
	if (!line.startsWith("+") || line.startsWith("+++")) return null;
	const rows = parseRows(`{${line.slice(1).trim().replace(/,$/, "")}}`);
	const [entry] = Object.entries(rows ?? {});
	return entry ? { guard: entry[0], anchor: entry[1] } : null;
}

/**
 * The rows among `anchored` already stale at HEAD, each with the inputs that
 * changed between its anchor's writer and HEAD. A row HEAD does not anchor, or
 * anchors at the digest written, is left out, as is one whose writer is found
 * and none of whose inputs changed since: only this commit's change moved it.
 *
 * @param {string} root
 * @param {Anchored[]} anchored
 * @returns {StaleAtHead[]}
 */
function readStaleAtHead(root, anchored) {
	if (anchored.length === 0) return [];
	const head = readHeadAnchors(root);
	const moved = anchored.filter(
		(a) => head[a.guard] !== undefined && head[a.guard] !== a.digest,
	);
	if (moved.length === 0) return [];
	const wanted = new Map(moved.map((a) => [a.guard, head[a.guard] ?? ""]));
	const plain = readWriters(root, wanted, ["--no-merges"]);
	const merged =
		wanted.size > 0 && !plain.error
			? readWriters(root, wanted, ["--merges", "--diff-merges=first-parent"])
			: { writers: new Map(), error: null };
	const error = plain.error ?? merged.error;
	/** @type {StaleAtHead[]} */
	const out = [];
	for (const a of moved) {
		const anchor = head[a.guard] ?? "";
		const writer =
			plain.writers.get(a.guard) ?? merged.writers.get(a.guard) ?? null;
		if (error || writer === null) {
			out.push({ guard: a.guard, anchor, writer, changed: [], error });
			continue;
		}
		const diff = git(root, [
			"--literal-pathspecs",
			"diff",
			"--name-only",
			"-z",
			writer,
			"HEAD",
			"--",
			...a.inputs,
		]);
		const changed = diff.out.split("\0").filter(Boolean).sort();
		if (diff.error || changed.length > 0)
			out.push({ guard: a.guard, anchor, writer, changed, error: diff.error });
	}
	return out;
}

module.exports = { readStaleAtHead };
