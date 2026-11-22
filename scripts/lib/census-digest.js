const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { caught, orFallback } = require("./caught.js");
const { readCommit } = require("./commit-sha.js");
const { loadShfmt } = require("./formatters.js");
const { NO_CEILING } = require("./git-ceiling.js");
const { MANIFEST_REL } = require("./guard-cores.js");
const { hasLine } = require("./marker-line.js");
const { parseEdges, walkReach, walkReachAll } = require("./guard-reach.js");
const {
	firstUnreadInjection,
	namesAnEmission,
} = require("./rule-emission-calls.js");
const { bareCitationGrep } = require("./qualify-citations.js");
const { RULES_DIR } = require("./rule-text.js");
const { scriptPath } = require("./script-path.js");
const { isUnder } = require("./is-under.js");

const DIGEST_HEX_LENGTH = 16;

const DEFAULT_ANCHORS = "scripts/instruction-surface-anchors.json";

/** @typedef {{ disk?: boolean, ceiling?: import("./git-ceiling.js").GitCeiling }} CensusReadOpts */

class DigestUnavailable extends Error {}

// guess, #3167
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

const LIB_DIR = "lib";
const COMPOSED_BINDINGS = ["decide", "buildHostPorts"];
const KIT_LIBS = new Set([
	"guard-entry.js",
	"shell-parse.js",
	"shell-words.js",
]);
/**
 * @typedef {{ root: string, tree: Map<string, string> | null, disk: boolean,
 *   ceiling: import("./git-ceiling.js").GitCeiling }} Snapshot
 */

/** @type {Map<string, Map<string, string>>} */
const treeByCommit = new Map();
/** @type {Map<string, Buffer>} */
const bytesByBlob = new Map();
/** @type {Map<string, string[]>} */
const ruleFilesByBlob = new Map();
/** @type {Map<string, string | Buffer>} */
const codeByBlobAndExt = new Map();

/**
 * @param {string} root
 * @param {string} rev
 * @param {CensusReadOpts} [opts]
 * @returns {Snapshot}
 */
function readSnapshot(root, rev, { disk = true, ceiling = NO_CEILING } = {}) {
	/** @param {string[]} args @param {string} what */
	const git = (args, what) =>
		String(
			ceiling.git(
				["-C", root, ...args],
				{
					encoding: "utf8",
					maxBuffer: GIT_MAX_BUFFER,
					stdio: ["ignore", "pipe", "ignore"],
				},
				what,
			),
		);
	/** @type {import("./git.js").GitReader} */
	const read = (args, noMatch) => {
		try {
			return { ok: true, out: git(args, `git rev-parse ${rev}`) };
		} catch (e) {
			const { status, message } = caught(e);
			if (typeof status !== "number") throw e;
			return noMatch.includes(status)
				? { ok: true, out: "" }
				: { ok: false, why: message };
		}
	};
	const r = readCommit(read, rev);
	if (!r.ok || r.sha === null) return { root, tree: null, disk, ceiling };
	const commit = r.sha;
	let tree = treeByCommit.get(commit);
	if (tree === undefined) {
		tree = new Map();
		for (const entry of git(
			["ls-tree", "-r", "-z", "--full-tree", commit],
			`git ls-tree ${rev}`,
		).split("\0")) {
			const tab = entry.indexOf("\t");
			const [, type, oid] = entry.slice(0, tab).split(" ");
			if (type === "blob" && oid) tree.set(entry.slice(tab + 1), oid);
		}
		treeByCommit.set(commit, tree);
	}
	return { root, tree, disk, ceiling };
}

/**
 * @param {Snapshot} snap
 * @param {Iterable<string>} rels
 */
function prefetch(snap, rels) {
	prefetchAcross([[snap, rels]]);
}

/** @param {[Snapshot, Iterable<string>][]} reads */
function prefetchAcross(reads) {
	/** @type {Map<string, string>} */
	const unread = new Map();
	for (const [snap, rels] of reads)
		for (const rel of rels) {
			const oid = snap.tree?.get(rel);
			if (oid !== undefined && !bytesByBlob.has(oid) && !unread.has(oid))
				unread.set(oid, rel);
		}
	const snap = reads[0]?.[0];
	if (unread.size === 0 || snap === undefined) return;
	const what = `git cat-file --batch of ${[...unread.values()].join(", ")}`;
	const out = /** @type {Buffer} */ (
		snap.ceiling.git(
			["-C", snap.root, "cat-file", "--batch"],
			{
				input: `${[...unread.keys()].join("\n")}\n`,
				maxBuffer: GIT_MAX_BUFFER,
				stdio: ["pipe", "pipe", "ignore"],
			},
			what,
		)
	);
	let at = 0;
	while (at < out.length) {
		const eol = out.indexOf(0x0a, at);
		const header = out.subarray(at, eol).toString();
		const [oid, , size] = header.split(" ");
		if (!oid || !/^\d+$/.test(size ?? ""))
			throw new Error(`${what} answered \`${header}\`, not an object`);
		const end = eol + 1 + Number(size);
		bytesByBlob.set(oid, out.subarray(eol + 1, end));
		at = end + 1;
	}
}

/**
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {Buffer | null}
 */
function readAt(snap, rel) {
	const oid = snap.tree?.get(rel);
	if (oid !== undefined) {
		prefetch(snap, [rel]);
		return bytesByBlob.get(oid) ?? null;
	}
	if (!snap.disk) return null;
	try {
		return fs.readFileSync(path.join(snap.root, rel));
	} catch {
		return null;
	}
}

/**
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {string[]}
 */
function readLibRuleFiles(snap, rel) {
	const oid = snap.tree?.get(rel);
	const cached = oid === undefined ? undefined : ruleFilesByBlob.get(oid);
	if (cached !== undefined) return cached;
	const bytes = readAt(snap, rel);
	if (bytes === null) return [];
	const files = namesAnEmission(bytes.toString("utf8"))
		? ruleFilesIn(rel, String(readCode(snap, rel)))
		: [];
	if (oid !== undefined) ruleFilesByBlob.set(oid, files);
	return files;
}

const REACH = {
	follow: /** @type {const} */ (["require"]),
	keep: (/** @type {import("./guard-reach.js").Edge} */ e) =>
		e.to.endsWith(".js"),
};

/**
 * @param {Snapshot} snap
 * @param {string[]} rels
 */
function readTexts(snap, rels) {
	return rels.map((rel) => readAt(snap, rel)?.toString("utf8") ?? null);
}

/**
 * @param {Snapshot} snap
 * @param {string[]} starts
 * @returns {string[]}
 */
function readDeeperRuleFiles(snap, starts) {
	const reached = walkReach(
		starts,
		(paths) => {
			prefetch(snap, paths);
			return readTexts(snap, paths);
		},
		REACH,
	);
	/** @type {Set<string>} */
	const files = new Set();
	for (const rel of reached.keys())
		if (!starts.includes(rel))
			for (const file of readLibRuleFiles(snap, rel)) files.add(file);
	return [...files].sort();
}

/** @param {[Snapshot, string[]][]} reads */
function prefetchReach(reads) {
	prefetchAcross(reads.map(([snap, rels]) => [snap, [...rels, MANIFEST_REL]]));
	const starts = reads.map(([snap, rels]) => [
		...rels,
		...rels.flatMap((rel) => readHosts(snap, rel)),
	]);
	const reached = walkReachAll(
		starts,
		(levels) => {
			prefetchAcross(levels.map((level, i) => [snapAt(reads, i), level]));
			return levels.map((level, i) => readTexts(snapAt(reads, i), level));
		},
		REACH,
	);
	prefetchAcross(
		reached.map((files, i) => {
			const snap = snapAt(reads, i);
			return [
				snap,
				[...files.keys()].flatMap((rel) => readLibRuleFiles(snap, rel)),
			];
		}),
	);
}

/**
 * @param {[Snapshot, string[]][]} reads
 * @param {number} i
 * @returns {Snapshot}
 */
function snapAt(reads, i) {
	return /** @type {[Snapshot, string[]]} */ (reads[i])[0];
}

/**
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {string[]}
 */
function readHosts(snap, rel) {
	return parseEdges(rel, "", {
		kinds: ["host"],
		manifest: () => readManifestAt(snap),
	}).map((e) => e.to);
}

/**
 * @param {Snapshot} snap
 * @returns {import("./guard-cores.js").Manifest | null}
 */
function readManifestAt(snap) {
	const bytes = readAt(snap, MANIFEST_REL);
	if (bytes === null) return null;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch (e) {
		throw new DigestUnavailable(
			`${MANIFEST_REL} will not read as a manifest (${caught(e).message}), so the host ports a core composes cannot be read.`,
			{ cause: e },
		);
	}
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts]
 * @returns {Buffer | null}
 */
function readCommittedBytes(root, rel, rev = "HEAD", opts = {}) {
	return readAt(readSnapshot(root, rev, opts), rel);
}

/** @type {any} */
let typescript;

function loadTypescript() {
	if (typescript) return typescript;
	for (const from of [path.join(process.cwd(), "package.json"), __filename]) {
		const loaded = orFallback(() => createRequire(from)("typescript"), null);
		if (loaded) {
			typescript = loaded;
			return typescript;
		}
	}
	throw new DigestUnavailable(
		"typescript is not installed, so no JavaScript guard can be digested — run npm install.",
	);
}

/**
 * @param {string} rel
 * @param {Buffer} bytes
 * @returns {string | Buffer}
 */
function codeOf(rel, bytes) {
	if (rel.endsWith(".sh")) {
		const format = loadShfmt();
		if (!format)
			throw new DigestUnavailable(
				"@wasm-fmt/shfmt is not installed, so no shell guard can be digested — run npm install.",
			);
		try {
			return format(bytes.toString("utf8"), rel, { minify: true });
		} catch {
			return bytes;
		}
	}
	if (rel.endsWith(".js")) {
		const ts = loadTypescript();
		return ts.transpileModule(bytes.toString("utf8"), {
			compilerOptions: {
				removeComments: true,
				target: ts.ScriptTarget.ESNext,
				module: ts.ModuleKind.Preserve,
				allowJs: true,
			},
			fileName: rel,
		}).outputText;
	}
	return bytes;
}

/**
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {string | Buffer | null}
 */
function readCode(snap, rel) {
	const oid = snap.tree?.get(rel);
	const key =
		oid === undefined ? undefined : `${oid}\0${path.posix.extname(rel)}`;
	const cached = key === undefined ? undefined : codeByBlobAndExt.get(key);
	if (cached !== undefined) return cached;
	const bytes = readAt(snap, rel);
	if (bytes === null) return null;
	const code = codeOf(rel, bytes);
	if (key !== undefined) codeByBlobAndExt.set(key, code);
	return code;
}

/**
 * @param {string} rel
 * @param {string | Buffer} code
 * @returns {string[]}
 */
function ruleFilesOf(rel, code) {
	if (rel.endsWith(".js")) return jsRuleFilesOf(rel, String(code));
	if (!rel.endsWith(".sh")) return [];
	return ruleFilesIn(rel, code.toString());
}

/**
 * @param {string} rel
 * @param {string} code
 * @returns {string[]}
 */
function jsRuleFilesOf(rel, code) {
	const unread = firstUnreadInjection(code);
	if (unread !== undefined)
		throw new DigestUnavailable(
			`${rel}: \`${code.slice(unread).split("\n")[0]}\` hands injectRules no literal id array, so the rule files it prints from cannot be read — list the ids as quoted literals.`,
		);
	return ruleFilesIn(rel, code);
}

/**
 * @param {string} rel
 * @param {string} code
 * @returns {string[]}
 */
function ruleFilesIn(rel, code) {
	return parseEdges(rel, code, { kinds: ["rule-file"] }).map((e) => e.to);
}

/**
 * @param {string} rel
 * @param {string | Buffer} code
 * @returns {string[]}
 */
function composedLibsOf(rel, code) {
	const dir = libDirOf(rel);
	if (dir === null) return [];
	const composes =
		path.posix.dirname(rel) === dir ? isNonKitLib : bindsComposition;
	return parseEdges(rel, String(code), { kinds: ["require"] })
		.filter(
			(e) =>
				path.posix.dirname(e.to) === dir && e.to.endsWith(".js") && composes(e),
		)
		.map((e) => e.to);
}

/** @param {{ to: string }} edge */
const isNonKitLib = (edge) => !KIT_LIBS.has(path.posix.basename(edge.to));

/** @param {{ bindings?: string[] }} edge */
const bindsComposition = (edge) =>
	COMPOSED_BINDINGS.some((b) => edge.bindings?.includes(b));

/** @param {string} rel */
function libDirOf(rel) {
	if (!rel.endsWith(".js")) return null;
	const dir = path.posix.dirname(rel);
	return path.posix.basename(dir) === LIB_DIR
		? dir
		: path.posix.join(dir, LIB_DIR);
}

/**
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {{ code: string | Buffer, libs: Map<string, string | Buffer | null>, ruleFiles: string[] } | null}
 */
function readInputs(snap, rel) {
	const code = readCode(snap, rel);
	if (code === null) return null;
	// #3129
	const ruleFiles = new Set(ruleFilesOf(rel, code));
	const libs = rel.endsWith(".js")
		? readComposed(snap, rel, code, ruleFiles)
		: new Map();
	prefetch(snap, ruleFiles);
	return { code, libs, ruleFiles: [...ruleFiles] };
}

/**
 * @param {Snapshot} snap
 * @param {string} rel
 * @param {string | Buffer} code
 * @param {Set<string>} ruleFiles
 * @returns {Map<string, string | Buffer | null>}
 */
function readComposed(snap, rel, code, ruleFiles) {
	const composed = [
		...new Set([...composedLibsOf(rel, code), ...readHosts(snap, rel)]),
	];
	prefetch(snap, composed);
	/** @type {Map<string, string | Buffer | null>} */
	const libs = new Map();
	for (const lib of composed) {
		const libCode = readCode(snap, lib);
		libs.set(lib, libCode);
		if (libCode !== null)
			for (const file of ruleFilesOf(lib, libCode)) ruleFiles.add(file);
	}
	for (const file of readDeeperRuleFiles(snap, [rel, ...composed]))
		ruleFiles.add(file);
	return libs;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts]
 * @returns {string | null}
 */
function digestOf(root, rel, rev, opts) {
	return digestAt(readSnapshot(root, rev ?? "HEAD", opts), rel);
}

/**
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {string | null}
 */
function digestAt(snap, rel) {
	const inputs = readInputs(snap, rel);
	if (inputs === null) return null;
	const hash = crypto.createHash("sha256").update(inputs.code);
	for (const [lib, code] of inputs.libs)
		hash.update(`\0${lib}\0`).update(code ?? "\0absent");
	// #1914
	for (const file of inputs.ruleFiles)
		hash.update(`\0${file}\0`).update(readAt(snap, file) ?? "\0absent");
	return hash.digest("hex").slice(0, DIGEST_HEX_LENGTH);
}

/**
 * @param {string} root
 * @param {string[]} rels
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts]
 * @returns {(file: string) => string[]}
 */
function guardsChangedBy(root, rels, rev, opts) {
	return guardsChangedAt(() => readSnapshot(root, rev ?? "HEAD", opts), rels);
}

/**
 * @param {() => Snapshot} snapOf
 * @param {string[]} rels
 * @returns {(file: string) => string[]}
 */
function guardsChangedAt(snapOf, rels) {
	const anchored = new Set(rels);
	/** @type {Map<string, string[]> | undefined} */
	let readers;
	return (file) => {
		if (anchored.has(file)) return [file];
		if (!isUnder(file, [RULES_DIR]) && !isLibFile(file)) return [];
		readers ??= inputReaders(snapOf(), rels);
		return readers.get(file) ?? [];
	};
}

/**
 * @param {Snapshot} snap
 * @param {string[]} rels
 * @returns {Map<string, string[]>}
 */
function inputReaders(snap, rels) {
	prefetchReach([[snap, rels]]);
	/** @type {Map<string, string[]>} */
	const readers = new Map();
	for (const rel of rels) {
		const inputs = readInputs(snap, rel);
		for (const file of [
			...(inputs?.libs.keys() ?? []),
			...(inputs?.ruleFiles ?? []),
		])
			readers.set(file, [...(readers.get(file) ?? []), rel]);
	}
	return readers;
}

/**
 * @param {string} root
 * @param {Record<string, { digest: string }>} guards
 * @param {number} n
 * @param {Pick<CensusReadOpts, "ceiling">} [opts]
 * @returns {string[]}
 */
function readRowsExpiredByTicket(
	root,
	guards,
	n,
	{ ceiling = NO_CEILING } = {},
) {
	const rels = Object.keys(guards);
	if (rels.length === 0) return [];
	/** @param {string[]} args */
	const git = (args) =>
		String(
			ceiling.git(
				["-C", root, ...args],
				{
					encoding: "utf8",
					maxBuffer: GIT_MAX_BUFFER,
					stdio: ["ignore", "pipe", "pipe"],
				},
				`git ${args[0]}`,
			),
		);
	// #1913
	const shas = git([
		"log",
		"-E",
		`--grep=${bareCitationGrep(n)}`,
		"--format=%H",
		"HEAD",
	])
		.split("\n")
		.filter(Boolean);
	if (shas.length === 0) return [];
	const log = git([
		"log",
		"--no-walk=unsorted",
		"--format=%x00%H",
		"--name-only",
		...shas,
		"--",
		...rels,
		RULES_DIR,
		...libDirsOf(rels),
	]);
	/** @type {Snapshot | undefined} */
	let head;
	const headSnap = () => {
		head ??= readSnapshot(root, "HEAD", { ceiling });
		return head;
	};
	const guardsOf = guardsChangedAt(headSnap, rels);
	const commits = log
		.split("\0")
		.slice(1)
		.flatMap((entry) => {
			const [sha, ...files] = entry.split("\n").filter(Boolean);
			const touched = [...new Set(files.flatMap(guardsOf))];
			if (sha === undefined || touched.length === 0) return [];
			return [
				{
					touched,
					before: readSnapshot(root, `${sha}^`, { disk: false, ceiling }),
					after: readSnapshot(root, sha, { ceiling }),
				},
			];
		});
	if (commits.length === 0) return [];
	const reached = [...new Set(commits.flatMap((c) => c.touched))];
	prefetchReach([
		...commits.flatMap(({ touched, before, after }) => [
			/** @type {[Snapshot, string[]]} */ ([before, touched]),
			/** @type {[Snapshot, string[]]} */ ([after, touched]),
		]),
		[headSnap(), reached],
	]);
	/** @type {Set<string>} */
	const changed = new Set();
	for (const { touched, before, after } of commits)
		for (const rel of touched)
			if (!changed.has(rel) && digestAt(before, rel) !== digestAt(after, rel))
				changed.add(rel);
	return rels.filter(
		(rel) =>
			changed.has(rel) && digestAt(headSnap(), rel) !== guards[rel]?.digest,
	);
}

/** @param {string} file */
function isLibFile(file) {
	return (
		file.endsWith(".js") &&
		path.posix.basename(path.posix.dirname(file)) === LIB_DIR
	);
}

/** @param {string[]} rels */
function libDirsOf(rels) {
	const dirs = rels.map(libDirOf).filter((dir) => dir !== null);
	if (dirs.length > 0) dirs.push(path.posix.dirname(MANIFEST_REL));
	return [...new Set(dirs)];
}

/** @param {string} text */
const hasCensusLine = (text) => hasLine(text, "Census", "\\S");

/**
 * @param {string} root
 * @param {number} n
 * @param {Pick<CensusReadOpts, "ceiling">} [opts]
 * @returns {string[]}
 */
function readExpiredRows(root, n, opts) {
	const bytes = readCommittedBytes(root, DEFAULT_ANCHORS, "HEAD", {
		...opts,
		disk: false,
	});
	if (bytes === null) return [];
	const { guards } = JSON.parse(bytes.toString("utf8"));
	return readRowsExpiredByTicket(root, guards ?? {}, n, opts);
}

/**
 * @param {number} n
 * @param {string[]} rows
 */
function censusRefusal(n, rows) {
	const one = rows.length === 1;
	const censusScript = scriptPath("check-instruction-surface.js");
	return `#${n}'s commits changed what ${rows.length} guard${one ? "" : "s"} the instruction-surface census measured print${one ? "s" : ""}, and ${one ? "its row is" : "their rows are"} not re-anchored:\n${rows.map((r) => `  ${r}`).join("\n")}\nRe-measure each (node ${censusScript} --touched-by <its commit> says how), then  node ${censusScript} --rebaseline --only ${rows.join(",")}  and commit ${DEFAULT_ANCHORS}. Or, leaving ${one ? "it" : "them"} for another ticket, add "**Census:** <why not re-anchored, and which ticket owns it>" to the comment.`;
}

module.exports = {
	DEFAULT_ANCHORS,
	DIGEST_HEX_LENGTH,
	DigestUnavailable,
	GIT_MAX_BUFFER,
	censusRefusal,
	readCommittedBytes,
	digestOf,
	readExpiredRows,
	guardsChangedBy,
	hasCensusLine,
};
