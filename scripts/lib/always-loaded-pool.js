const { readImportedFiles } = require("./pool-imports.js");
const { readConfig } = require("./workflow-core-config.js");
const { cutAt } = require("./cut-at.js");
const { caught } = require("./caught.js");
const { PRINTED_CHARS_SHOWN } = require("./commit-sha.js");
const { execGit } = require("./git.js");
const { brokenError } = require("./outcome-error.js");

const DEFAULT_POOL_FILES = ["CLAUDE.md", "AGENTS.md"];

/** @type {string[] | undefined} */
let poolFiles;

/** @returns {string[]} */
function getPoolFiles() {
	poolFiles ??= readConfig().alwaysLoaded ?? DEFAULT_POOL_FILES;
	return poolFiles;
}

const readDeclaredStyle = () => readConfig().overrides.output_style || null;

/**
 * @param {string} root
 * @returns {Set<string>}
 */
function getDoubleLoadedFiles(root) {
	const style = readDeclaredStyle();
	if (!style) return new Set();
	const others = getPoolFiles().filter((f) => f !== style);
	const imported = readImportedFiles(root, others).some(
		(f) => f.path === style,
	);
	return new Set(imported ? [style] : []);
}

const TRIGGER_VERDICT_MARKER = "**Trigger:**";

// guess, workflow-core#5529
const TRIGGER_VERDICT_MIN_WORDS = 3;

/**
 * @param {string[]} revs
 * @returns {(number | null)[]}
 */
function readPoolBytesIn(revs) {
	const files = getPoolFiles();
	const groups = revs.map((t) => ({
		commit: t ? `${t}^{commit}` : null,
		files: files.map((rel) => `${t}:${rel}`),
	}));
	const specs = groups.flatMap((g) =>
		g.commit === null ? g.files : [g.commit, ...g.files],
	);
	let out;
	try {
		out = execGit(["cat-file", "--batch-check=%(objectsize)"], {
			encoding: "utf8",
			input: specs.map((spec) => `${spec}\n`).join(""),
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (e) {
		const { stderr, message } = caught(e);
		throw brokenError(
			`git would not read the pool's sizes in ${revs.map((t) => t || "the index").join(", ")}: ${String(stderr ?? "").trim() || message}`,
		);
	}
	const lines = out.split("\n");
	/** @type {Map<string, number | "missing">} */
	const answers = new Map();
	specs.forEach((spec, i) => {
		const line = lines[i] ?? "";
		if (line === `${spec} missing`) answers.set(spec, "missing");
		else if (/^\d+$/.test(line)) answers.set(spec, Number(line));
		else
			throw brokenError(
				`git cat-file --batch-check ${spec} printed ${line.slice(0, PRINTED_CHARS_SHOWN)}`,
			);
	});
	/** @param {string} spec */
	const bytes = (spec) => {
		const a = answers.get(spec);
		return typeof a === "number" ? a : 0;
	};
	return groups.map((g) =>
		g.commit !== null && answers.get(g.commit) === "missing"
			? null
			: g.files.reduce((sum, spec) => sum + bytes(spec), 0),
	);
}

/**
 * @param {string[]} revs
 * @returns {number | null}
 */
function stagedPoolDelta(revs) {
	const [staged, ...bases] = readPoolBytesIn(["", ...revs]);
	if (staged === undefined || staged === null)
		throw new Error("readPoolBytesIn returned no size for the index");
	const committed = bases.filter((b) => b !== null);
	return committed.length === 0 ? null : staged - Math.max(...committed);
}

/**
 * @param {string[]} entry
 * @returns {string}
 */
const entryIssue = (entry) => {
	const [head] = entry;
	if (head === undefined) throw new Error("a shed-ledger entry with no lines");
	return (head.match(/#\d+/) || ["(unnumbered)"])[0];
};

/**
 * @param {string[]} entry
 * @returns {string}
 */
const entryLabel = (entry) => {
	const [head] = entry;
	if (head === undefined) throw new Error("a shed-ledger entry with no lines");
	return (head.match(/#\d+(?: [a-z]+(?=[\s,.*]|$))?/) || ["(unnumbered)"])[0];
};

/**
 * @param {string[][]} entries
 * @param {string[][][]} committedEntries
 * @returns {{ label: string, fault: string }[]}
 */
function triggerVerdictFaults(entries, committedEntries) {
	const newest = entries[0];
	if (newest === undefined)
		return [
			{
				label: "(no entry)",
				fault:
					"the ledger holds no entry at all, so this commit's pool bytes " +
					"name no shed and carry no trigger verdict",
			},
		];
	const label = entryLabel(newest);
	const known = new Set();
	for (const list of committedEntries)
		for (const entry of list) known.add(entryLabel(entry));
	if (known.has(label))
		return [
			{
				label,
				fault:
					"the ledger's newest entry is the one HEAD already held, so this " +
					"commit adds pool bytes and writes no tranche entry of its own",
			},
		];

	const text = newest.join("\n");
	const at = text.indexOf(TRIGGER_VERDICT_MARKER);
	if (at === -1)
		return [
			{
				label,
				fault: `the newest ledger entry carries no \`${TRIGGER_VERDICT_MARKER}\` verdict`,
			},
		];
	const [rest] = cutAt(text.slice(at + TRIGGER_VERDICT_MARKER.length), "\n");
	const n = rest.split(/\s+/).filter(Boolean).length;
	if (n < TRIGGER_VERDICT_MIN_WORDS)
		return [
			{
				label,
				fault:
					`its \`${TRIGGER_VERDICT_MARKER}\` verdict is ${n} word(s); ` +
					`${TRIGGER_VERDICT_MIN_WORDS} is the floor`,
			},
		];
	return [];
}

if (require.main === module) {
	process.stdout.write(`${getPoolFiles().join("\n")}\n`);
}

module.exports = {
	getPoolFiles,
	readDeclaredStyle,
	getDoubleLoadedFiles,
	TRIGGER_VERDICT_MARKER,
	TRIGGER_VERDICT_MIN_WORDS,
	entryIssue,
	entryLabel,
	stagedPoolDelta,
	triggerVerdictFaults,
};
