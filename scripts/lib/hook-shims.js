/*
 * hook-shims.js — keeps an exit-0 shim at each hook script a live session
 * still runs after the shared tree deleted it (#2879).
 *
 * WHY. A session reads its hook lines once, at its start (docs/environment.md),
 * so a session started before a port keeps running the old line. Where the
 * port deleted that line's script, every call the line matches fails to start
 * and, under `"onFailure": "block"`, is refused. The shim lets the call
 * through.
 *
 * WHICH SCRIPTS ARE HELD. Those the self-plugin's hooks file names at every
 * commit the main checkout's HEAD sat on since the earliest live session
 * started: its reflog, plus the entry current at that start. A held script
 * gone from disk and from the index gets a shim; a path still in the index is
 * a deletion in progress, left to the commit that lands it.
 *
 * WHEN A SHIM GOES. Once no held line names it. An empty listing holds HEAD
 * alone. A listing that will not read, or a record with no readable start,
 * writes and removes nothing and records no run, so the next commit tries
 * again.
 *
 * A shim is an untracked file whose bytes are exactly `shimText` of its path,
 * so no other file is ever taken for one. Each is listed in a managed block of
 * .git/info/exclude, so `git status` stays clean and a `git add` of a path
 * whose deletion is staged cannot stage the shim. Discovery reads the files,
 * never the block, so a block one writer lost is rebuilt on the next run.
 *
 * The core: it does no I/O, every read and write arriving as a port
 * (`keep-hook-shims.js` wires the production ones).
 */

const { trimEndRun } = require("./trim-run.js");

const MARK = "wfc hook shim (#2879)";
const EXCLUDE_BEGIN = `# ${MARK}: managed by scripts/keep-hook-shims.js`;
const EXCLUDE_END = `# end ${MARK}`;

const SCRIPT_RE =
	/(?:"\$CLAUDE_PROJECT_DIR"\/|\$\{CLAUDE_PROJECT_DIR\}\/)(scripts\/[\w./-]+\.(?:sh|js))/g;

/**
 * The earliest start in a listing, in ms: +Infinity for none live, and the
 * reason where the listing or a start time will not read.
 * @param {import("./agent-liveness.js").Listing} listed
 * @returns {number | string}
 */
function earliestStart(listed) {
	if (!listed.agents) return listed.why;
	let earliest = Number.POSITIVE_INFINITY;
	for (const a of listed.agents) {
		const t = Number(a?.startedAt);
		if (!Number.isFinite(t)) return `session ${a?.sessionId} has no start time`;
		earliest = Math.min(earliest, t);
	}
	return earliest;
}

/**
 * Every script a hooks file's commands name, `scripts/…` relative to the
 * repo root. A file that will not parse names none.
 * @param {string} text
 * @returns {string[]}
 */
function scriptPaths(text) {
	let hooks;
	try {
		hooks = JSON.parse(text)?.hooks;
	} catch {
		/* An old commit's broken hooks file loaded no lines, so it holds none. */
		return [];
	}
	const commands = Object.values(hooks ?? {})
		.flatMap((groups) => (Array.isArray(groups) ? groups : []))
		.flatMap((group) => group?.hooks ?? [])
		.map((h) => h?.command)
		.filter((c) => typeof c === "string");
	return commands.flatMap((c) =>
		[...c.matchAll(SCRIPT_RE)].flatMap((m) => (m[1] ? [m[1]] : [])),
	);
}

/**
 * The reflog entries a live session may have started on: every one at or
 * after `earliest`, and the newest before it, which was HEAD at that start.
 * @param {{sha: string, at: number}[]} reflog newest first, `at` in ms
 * @param {number} earliest the earliest live session start, in ms
 * @returns {string[]}
 */
function heldRevs(reflog, earliest) {
	/** @type {string[]} */
	const out = [];
	for (const e of reflog) {
		out.push(e.sha);
		if (e.at < earliest) break;
	}
	return out;
}

/**
 * @param {string} rel
 * @returns {string}
 */
function shimText(rel) {
	return rel.endsWith(".js")
		? `// ${MARK}: a live session still runs this retired hook script's line.\nprocess.stdin.resume();\n`
		: `#!/usr/bin/env bash\n# ${MARK}: a live session still runs this retired hook script's line.\ncat >/dev/null\nexit 0\n`;
}

/**
 * `exclude` with its managed block naming exactly `paths`, and no block where
 * there are none.
 * @param {string} exclude the current .git/info/exclude text
 * @param {string[]} paths
 * @returns {string}
 */
function withExcludes(exclude, paths) {
	const lines = exclude.split("\n");
	const begin = lines.indexOf(EXCLUDE_BEGIN);
	const end = lines.indexOf(EXCLUDE_END, begin);
	const kept =
		begin !== -1 && end !== -1
			? [...lines.slice(0, begin), ...lines.slice(end + 1)]
			: lines;
	const body = trimEndRun(kept.join("\n"), "\n");
	const head = body === "" ? "" : `${body}\n`;
	if (paths.length === 0) return head;
	const block = [
		EXCLUDE_BEGIN,
		...paths.sort().map((p) => `/${p}`),
		EXCLUDE_END,
	];
	return `${head}${block.join("\n")}\n`;
}

/**
 * @typedef {object} ShimPorts
 * @property {() => string[]} untracked untracked files under scripts/
 * @property {() => Set<string>} tracked the index's files under scripts/
 * @property {(rel: string) => string | null} readFile
 * @property {(rel: string) => boolean} exists
 * @property {() => string[] | null} deletedSinceLastRun files under scripts/
 *   deleted between the HEAD the last run saw and this one, null where there
 *   is no such HEAD or git will not say
 * @property {() => void} recordRun
 * @property {() => {sha: string, at: number}[] | null} reflog newest first
 * @property {(shas: string[]) => string[]} hooksAt the text of each hooks
 *   file a session loads, the self-plugin's and the project settings, at each
 *   commit that has one
 * @property {() => import("./agent-liveness.js").Listing} agents
 * @property {(rel: string, text: string) => void} writeShim
 * @property {(rel: string) => void} removeShim
 * @property {() => string} readExclude
 * @property {(text: string) => void} writeExclude
 */

/**
 * Writes the shims held lines need and removes the rest.
 *
 * `lazy` returns at once where no shim exists and no script was deleted since
 * the last run: the hooks' route. Diffing from the last run's HEAD, never from the previous one,
 * catches a merge or reset that deleted a script at the next commit.
 *
 * @param {ShimPorts} ports
 * @param {{lazy?: boolean}} [opts]
 * @returns {{wrote: string[], removed: string[], lines: string[], why?: string}}
 *   `lines` is the report to print: one line per shim, or the one `why`
 */
function keepShims(ports, { lazy = false } = {}) {
	const shims = ports
		.untracked()
		.filter(
			(rel) =>
				/\.(?:sh|js)$/.test(rel) && ports.readFile(rel) === shimText(rel),
		);
	if (lazy && shims.length === 0 && ports.deletedSinceLastRun()?.length === 0) {
		ports.recordRun();
		return { wrote: [], removed: [], lines: [] };
	}

	const earliest = earliestStart(ports.agents());
	const reflog = ports.reflog();
	if (typeof earliest === "string" || !reflog) {
		const why = typeof earliest === "string" ? earliest : "no reflog to read";
		const line = `keep-hook-shims: no shim kept or removed: ${why}`;
		return { wrote: [], removed: [], lines: [line], why };
	}

	/** @type {Set<string>} */
	const held = new Set();
	for (const text of ports.hooksAt(heldRevs(reflog, earliest)))
		for (const rel of scriptPaths(text)) held.add(rel);

	const tracked = ports.tracked();
	const wrote = [...held].filter(
		(rel) => !tracked.has(rel) && !ports.exists(rel),
	);
	const removed = shims.filter((rel) => !held.has(rel));
	for (const rel of wrote) ports.writeShim(rel, shimText(rel));
	for (const rel of removed) ports.removeShim(rel);

	const kept = [...shims.filter((rel) => !removed.includes(rel)), ...wrote];
	const exclude = ports.readExclude();
	const next = withExcludes(exclude, kept);
	if (next !== exclude) ports.writeExclude(next);
	ports.recordRun();

	const lines = [
		...wrote.map(
			(rel) =>
				`wrote hook shim ${rel}: a live session still runs its retired line (#2879)`,
		),
		...removed.map(
			(rel) => `removed hook shim ${rel}: no live session runs its line`,
		),
	];
	return { wrote, removed, lines };
}

module.exports = { keepShims };
