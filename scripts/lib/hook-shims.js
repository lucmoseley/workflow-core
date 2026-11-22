const { toScriptsRel } = require("./core-hooks.js");
const { trimEndRun } = require("./trim-run.js");

const MARK = "wfc hook shim (#2879)";
const EXCLUDE_BEGIN = `# ${MARK}: managed by scripts/keep-hook-shims.js`;
const EXCLUDE_END = `# end ${MARK}`;

const SCRIPT_RE = /(?<![\w./$}"-])scripts\/[\w./-]+\.(?:sh|js)/g;

/**
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
 * @param {string} text
 * @returns {string[]}
 */
function scriptPaths(text) {
	let hooks;
	try {
		hooks = JSON.parse(text)?.hooks;
	} catch {
		return [];
	}
	const commands = Object.values(hooks ?? {})
		.flatMap((groups) => (Array.isArray(groups) ? groups : []))
		.flatMap((group) => group?.hooks ?? [])
		.map((h) => h?.command)
		.filter((c) => typeof c === "string");
	return commands.flatMap((c) =>
		[...toScriptsRel(c).matchAll(SCRIPT_RE)].map((m) => m[0]),
	);
}

/**
 * @param {{sha: string, at: number}[]} reflog
 * @param {number} earliest
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
 * @param {string} exclude
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
 * @property {() => string[]} untracked
 * @property {() => Set<string>} tracked
 * @property {(rel: string) => string | null} readFile
 * @property {(rel: string) => boolean} exists
 * @property {() => string[] | null} deletedSinceLastRun
 * @property {() => void} recordRun
 * @property {() => {sha: string, at: number}[] | null} reflog
 * @property {(shas: string[]) => string[]} hooksAt
 * @property {() => import("./agent-liveness.js").Listing} agents
 * @property {(rel: string, text: string) => void} writeShim
 * @property {(rel: string) => void} removeShim
 * @property {() => string} readExclude
 * @property {(text: string) => void} writeExclude
 */

/**
 * @param {ShimPorts} ports
 * @param {{lazy?: boolean}} [opts]
 * @returns {{wrote: string[], removed: string[], lines: string[], why?: string}}
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
