/*
 * census-digest.js — the digest a census row anchors a guard by, and which
 * of those rows a ticket's commits expired (#1876), read by both close routes
 * before a completed close (#1913).
 *
 * THE DIGEST HASHES WHAT CAN CHANGE WHAT THE GUARD PRINTS, not the file.
 * Shell is hashed as shfmt's minified print, and
 * JavaScript as TypeScript's reprint with comments removed: both drop
 * comments and layout and keep every string, heredoc and template literal
 * byte for byte. Any other extension, and shell shfmt cannot parse, hashes
 * its raw bytes.
 *
 * A GUARD'S DIGEST ALSO HASHES EACH RULE FILE ITS CODE NAMES (#1914, #3011):
 * each rule fetch reads docs/agents/rules/<id>.txt at run time, so a reworded
 * fragment changes what the guard prints with its code untouched. A Node
 * core's names are its direct accessor calls and its injectRules ids; an
 * injectRules value that is no literal id array is BROKEN, quoting it.
 *
 * A NODE GUARD WRAPPER'S DIGEST ALSO HASHES THE CORE AND HOST PORTS IT
 * COMPOSES (#3129): each `./lib/<name>.js` its literal require binds `decide`
 * or `buildHostPorts` from (lib/guard-entry.js's composition root), code and
 * rule files both, an absent one hashing as a marker. guard-entry.js itself
 * is the kit every wrapper runs, so an edit to it expires none. A dispatched
 * core's digest hashes the host ports lib/guard-cores.json binds it to (#3167)
 * the same way.
 *
 * DEEPER LIBS FOLD THEIR RULE FILES, NOT THEIR CODE (#3167): every lib the
 * guard, its composed libs and its host reach through relative requires adds
 * the rule files it names. The cores share shell-parse.js, guard-verdict.js
 * and rule-gates.js, so folding deeper code would expire every row on an edit
 * to any of them.
 * Residual: a deeper lib's non-literal ids, an id a sourced lib names, and
 * one built at run time, are unread. A manifest edit
 * alone rebinding a core's host to an existing lib is unread at a ticket's
 * close, though the census run still reads it.
 *
 * Residual: the reprint belongs to the pinned shfmt and typescript, so a bump
 * that changes either's printing expires every row of that language at once.
 * A shebang survives the minify; a `# shellcheck` directive does not.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readCommit } = require("./commit-sha.js");
const { loadShfmt } = require("./formatters.js");
const { NO_CEILING } = require("./git-ceiling.js");
const { MANIFEST_REL, hostOf } = require("./guard-cores.js");
const { hasLine } = require("./marker-line.js");
const {
	RULE_ARG_RE,
	directRuleCounts,
	emissionMatches,
	firstUnreadInjection,
	namesAnEmission,
} = require("./rule-emission.js");
const { bareCitationGrep } = require("./qualify-citations.js");
const { requiredGroup } = require("./regex-group.js");
const { RULES_DIR } = require("./rule-text.js");
const { scriptPath } = require("./script-path.js");

/*
 * scripts/, not docs/: this is an anchor
 * store scripts read and check-instruction-surface.js writes, not a document
 * anybody reads whole. It
 * also keeps it out of the doc-map's mapped scope, where a new tracked document
 * cannot land without its §A row in the same commit — and docs/doc-map.md is
 * the most contended file in the repo (mantahostels#1539).
 */
const DEFAULT_ANCHORS = "scripts/instruction-surface-anchors.json";

/** @typedef {{ disk?: boolean, ceiling?: import("./git-ceiling.js").GitCeiling }} CensusReadOpts */

/** A formatter the digest needs is not installed, or an injectRules value
 * will not read: BROKEN, never a crash. */
class DigestUnavailable extends Error {}

/* ~10x the largest guard in the set, so a runaway is bounded and nothing real
 * is ever truncated. A ticket's `git log --name-only` over the guards is a
 * few hundred bytes a commit, and a commit's `diff-tree` path list tens of
 * bytes a path, both far under it too, as are the tree listing and blob
 * batches (#3167); an overflow throws, never reading as an absent path. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/* The directory beside a Node guard its composed libs sit in. */
const LIB_DIR = "lib";
const LIB_FILE = "[\\w.-]+\\.js";
/* A literal destructuring require of a lib in LIB_DIR, in codeOf's reprint:
 * group 1 the bindings, group 2 the file. */
const LIB_REQUIRE_RE = new RegExp(
	`\\{([^}]*)\\}\\s*=\\s*require\\(\\s*["']\\./${LIB_DIR}/(${LIB_FILE})["']\\s*\\)`,
	"g",
);
/* Where LIB_REQUIRE_RE's path can lead, from any guard's directory. */
const LIB_PATH_RE = new RegExp(`(?:^|/)${LIB_DIR}/${LIB_FILE}$`);
const COMPOSED_BINDING_RE = /(?<![\w$])(?:decide|buildHostPorts)(?![\w$])/;
/**
 * @typedef {{ requires: string[], ruleFiles: string[] }} LibFacts
 * @typedef {{ root: string, tree: Map<string, string> | null, disk: boolean,
 *   ceiling: import("./git-ceiling.js").GitCeiling }} Snapshot
 */

/* Keyed by commit and by blob id, neither of which ever changes, so a pass
 * over every row lists each tree once and reads and scans each file once.
 * A lib's facts key on its directory too, its requires resolving from it. */
/** @type {Map<string, Map<string, string>>} */
const treeByCommit = new Map();
/** @type {Map<string, Buffer>} */
const bytesByBlob = new Map();
/** @type {Map<string, LibFacts>} */
const factsByBlobAndDir = new Map();
/* A reprint keys on its extension too, which picks the printer. */
/** @type {Map<string, string | Buffer>} */
const codeByBlobAndExt = new Map();

/**
 * `rev`'s tree as each tracked path's blob id. `tree` is null where git
 * answers that `root` is no repo or `rev` no commit, every path then reading
 * from disk unless `disk` is false; any other failure throws.
 *
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
			/* An exit status is git's own answer; anything else (the ceiling, a
			 * missing binary) is no answer, and never reads as an absent tree. */
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
 * Reads every one of `rels` tracked in `snap` and not yet read, in one
 * `cat-file --batch`.
 *
 * @param {Snapshot} snap
 * @param {Iterable<string>} rels
 */
function prefetch(snap, rels) {
	prefetchAcross([[snap, rels]]);
}

/**
 * prefetch over several snapshots of one repo in one batch.
 *
 * @param {[Snapshot, Iterable<string>][]} reads
 */
function prefetchAcross(reads) {
	/** @type {Map<string, string>} oid → the first path naming it */
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
	/* Each object is `<oid> <type> <size>\n<bytes>\n`. */
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
 * `rel`'s bytes in `snap`, as readCommittedBytes reads them.
 *
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
 * `rel`'s relative requires, as paths from the root, and the rule files its
 * literal ids name, or null where `rel` is absent from `snap`. A non-literal
 * injectRules is no BROKEN here: rule-emission.js's own scans spell the key.
 *
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {LibFacts | null}
 */
function readLibFacts(snap, rel) {
	const dir = path.posix.dirname(rel);
	const oid = snap.tree?.get(rel);
	const key = oid === undefined ? undefined : `${oid}\0${dir}`;
	const cached = key === undefined ? undefined : factsByBlobAndDir.get(key);
	if (cached !== undefined) return cached;
	const bytes = readAt(snap, rel);
	if (bytes === null) return null;
	const text = bytes.toString("utf8");
	/** @type {{ fileName: string }[]} */
	const imported = loadTypescript().preProcessFile(
		text,
		true,
		true,
	).importedFiles;
	const requires = imported
		.map((f) => f.fileName)
		.filter((name) => /^\.\.?\//.test(name))
		.map((name) =>
			path.posix.join(dir, path.posix.extname(name) ? name : `${name}.js`),
		)
		.filter((lib) => lib.endsWith(".js"));
	/* Only the reprint's ids count, and a lib naming no emission has none. */
	/** @type {string[]} */
	let ruleFiles = [];
	if (namesAnEmission(text)) {
		const code = String(readCode(snap, rel));
		ruleFiles = ruleFilesIn(code, emissionMatches(code));
	}
	const facts = { requires, ruleFiles };
	if (key !== undefined) factsByBlobAndDir.set(key, facts);
	return facts;
}

/**
 * The rule files every lib `starts` reach through relative requires names,
 * `starts`' own excluded: each level's unread files read in one batch.
 *
 * @param {Snapshot} snap
 * @param {string[]} starts
 * @returns {string[]}
 */
function readDeeperRuleFiles(snap, starts) {
	/** @type {Set<string>} */
	const files = new Set();
	const seen = new Set(starts);
	prefetch(snap, starts);
	let level = unseenRequires(snap, starts, seen);
	while (level.length > 0) {
		prefetch(snap, level);
		for (const rel of level)
			for (const file of readLibFacts(snap, rel)?.ruleFiles ?? [])
				files.add(file);
		level = unseenRequires(snap, level, seen);
	}
	return [...files].sort();
}

/**
 * Reads every file each snapshot's guards' digests reach — each guard, its
 * host, every lib reached through relative requires and the rule files they
 * name — in one batch per require level across every snapshot (#3411).
 *
 * @param {[Snapshot, string[]][]} reads each snapshot with its guards
 */
function prefetchReach(reads) {
	prefetchAcross(reads.map(([snap, rels]) => [snap, [...rels, MANIFEST_REL]]));
	const walks = reads.map(([snap, rels]) => {
		const seen = new Set(rels);
		const level = [...rels];
		for (const rel of rels) {
			const host = rel.endsWith(".js") ? readHost(snap, rel) : null;
			if (host !== null && !seen.has(host)) {
				seen.add(host);
				level.push(host);
			}
		}
		return { snap, seen, level, ruleFiles: new Set() };
	});
	let live = walks;
	while (live.length > 0) {
		prefetchAcross(live.map((w) => [w.snap, w.level]));
		for (const w of live) {
			for (const rel of w.level)
				for (const file of readLibFacts(w.snap, rel)?.ruleFiles ?? [])
					w.ruleFiles.add(file);
			w.level = unseenRequires(w.snap, w.level, w.seen);
		}
		live = live.filter((w) => w.level.length > 0);
	}
	prefetchAcross(walks.map((w) => [w.snap, w.ruleFiles]));
}

/**
 * The libs `level` requires that `seen` lacks, each added to it.
 *
 * @param {Snapshot} snap
 * @param {string[]} level
 * @param {Set<string>} seen accumulator: every lib already reached
 * @returns {string[]}
 */
function unseenRequires(snap, level, seen) {
	/** @type {string[]} */
	const next = [];
	for (const rel of level)
		for (const lib of readLibFacts(snap, rel)?.requires ?? [])
			if (!seen.has(lib)) {
				seen.add(lib);
				next.push(lib);
			}
	return next;
}

/**
 * The host lib guard-cores.json binds the dispatched core at `rel` to in
 * `snap`, or null.
 *
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {string | null}
 */
function readHost(snap, rel) {
	const bytes = readAt(snap, MANIFEST_REL);
	if (bytes === null) return null;
	try {
		return hostOf(JSON.parse(bytes.toString("utf8")), rel);
	} catch (e) {
		throw new DigestUnavailable(
			`${MANIFEST_REL} will not read as a manifest (${caught(e).message}), so the host ports a core composes cannot be read.`,
			{ cause: e },
		);
	}
}

/**
 * A tracked path's bytes AT `rev`, falling back to disk where git cannot answer.
 *
 * The fallback is what lets a non-git fixture — and a path git has not been
 * told about yet — still be measured, at the cost that an uncommitted path
 * reads as committed. `disk: false` refuses it, for a rev that is a past
 * commit, where an absent path means added there rather than unknown.
 * `ceiling` runs the read inside a lib/git-ceiling.js ceiling, whose passing
 * is thrown, never read as an absent path (#2210).
 *
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

/**
 * typescript from the working directory's node_modules first, then the
 * plugin's, as loadShfmt resolves shfmt. Throws where neither has it.
 */
function loadTypescript() {
	if (typescript) return typescript;
	for (const from of [path.join(process.cwd(), "package.json"), __filename]) {
		try {
			typescript = createRequire(from)("typescript");
			return typescript;
		} catch {
			// Not installed from here; the next root may have it.
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
			return bytes; // unparseable: any edit to it is worth naming
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
 * `rel`'s code in `snap`, as codeOf gives it, or null where it is absent.
 *
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
 * The rule files a guard's code prints from, sorted.
 *
 * @param {string} rel
 * @param {string | Buffer} code codeOf's answer
 * @returns {string[]}
 */
function ruleFilesOf(rel, code) {
	if (rel.endsWith(".js")) return jsRuleFilesOf(rel, String(code));
	if (!rel.endsWith(".sh")) return [];
	return ruleFilesIn(code.toString(), []);
}

/**
 * ruleFilesOf for a Node core.
 *
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
	return ruleFilesIn(code, emissionMatches(code));
}

/**
 * The rule files `text`'s direct accessor calls and `emissions` name, sorted.
 *
 * @param {string} text
 * @param {Iterable<RegExpMatchArray>} emissions each holding its ids in group 1
 * @returns {string[]}
 */
function ruleFilesIn(text, emissions) {
	const ids = new Set(directRuleCounts(text).keys());
	for (const m of emissions)
		for (const a of (m[1] ?? "").matchAll(RULE_ARG_RE)) if (a[1]) ids.add(a[1]);
	return [...ids].sort().map((id) => `${RULES_DIR}/${id}.txt`);
}

/**
 * The libs a Node guard wrapper composes: the core and host ports it hands
 * guard-entry's run.
 *
 * @param {string} rel
 * @param {string | Buffer} code codeOf's answer
 * @returns {string[]}
 */
function composedLibsOf(rel, code) {
	const dir = libDirOf(rel);
	if (dir === null) return [];
	return [...String(code).matchAll(LIB_REQUIRE_RE)]
		.filter((m) =>
			COMPOSED_BINDING_RE.test(requiredGroup(m, 1, LIB_REQUIRE_RE)),
		)
		.map((m) => path.posix.join(dir, requiredGroup(m, 2, LIB_REQUIRE_RE)));
}

/**
 * The directory a Node guard at `rel` composes its libs from, or null for
 * any other guard.
 *
 * @param {string} rel
 */
function libDirOf(rel) {
	return rel.endsWith(".js")
		? path.posix.join(path.posix.dirname(rel), LIB_DIR)
		: null;
}

/**
 * `rel`'s code in `snap`, each lib it composes or its manifest host with that
 * lib's code (null where absent), and the rule files all of them and their
 * deeper libs name, `rel`'s own first; null where `rel` is gone.
 *
 * @param {Snapshot} snap
 * @param {string} rel
 * @returns {{ code: string | Buffer, libs: Map<string, string | Buffer | null>, ruleFiles: string[] } | null}
 */
function readInputs(snap, rel) {
	const code = readCode(snap, rel);
	if (code === null) return null;
	/* Appended, never re-sorted: a lib-less row keeps its pre-#3129 digest. */
	const ruleFiles = new Set(ruleFilesOf(rel, code));
	const libs = rel.endsWith(".js")
		? readComposed(snap, rel, code, ruleFiles)
		: new Map();
	prefetch(snap, ruleFiles);
	return { code, libs, ruleFiles: [...ruleFiles] };
}

/**
 * The libs the Node guard at `rel` composes or its manifest host, each with
 * its code (null where absent), adding to `ruleFiles` theirs and their deeper
 * libs'.
 *
 * @param {Snapshot} snap
 * @param {string} rel
 * @param {string | Buffer} code `rel`'s, as codeOf gives it
 * @param {Set<string>} ruleFiles accumulator: the digest's rule files
 * @returns {Map<string, string | Buffer | null>}
 */
function readComposed(snap, rel, code, ruleFiles) {
	const host = readHost(snap, rel);
	const composed = [...composedLibsOf(rel, code), ...(host ? [host] : [])];
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
 * The census digest of `rel` at `rev`, or null where it is gone. Sixteen hex
 * characters, matching guard-registry-anchors.json's width: an anchor file is
 * read by people, and a full sha256 per row buys nothing here.
 *
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts] as readCommittedBytes takes it
 * @returns {string | null}
 */
function digestOf(root, rel, rev, opts) {
	return digestAt(readSnapshot(root, rev ?? "HEAD", opts), rel);
}

/**
 * digestOf in `snap`.
 *
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
	/* A guard naming no rule file hashes as it did before #1914. A named file
	 * that is absent hashes as a marker, not BROKEN: the guard then prints its
	 * fallback, and adding the file moves the digest. */
	for (const file of inputs.ruleFiles)
		hash.update(`\0${file}\0`).update(readAt(snap, file) ?? "\0absent");
	return hash.digest("hex").slice(0, 16);
}

/**
 * The anchored guards among `rels` that a change to `file` can expire: the
 * guard itself, or the guards composing it or naming it as a rule file at
 * `rev`. The readers are read once, on the first rule file or lib asked
 * about.
 *
 * @param {string} root
 * @param {string[]} rels
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts] as readCommittedBytes takes it
 * @returns {(file: string) => string[]}
 */
function guardsChangedBy(root, rels, rev, opts) {
	return guardsChangedAt(() => readSnapshot(root, rev ?? "HEAD", opts), rels);
}

/**
 * guardsChangedBy in the snapshot `snapOf` gives.
 *
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
		if (!file.startsWith(`${RULES_DIR}/`) && !LIB_PATH_RE.test(file)) return [];
		readers ??= inputReaders(snapOf(), rels);
		return readers.get(file) ?? [];
	};
}

/**
 * Which of `rels` compose each lib or name each rule file in `snap`: the
 * guards a commit to that file expires.
 *
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
 * The anchored guards that commits on HEAD citing `#n` changed the digest of,
 * and that HEAD still leaves unanchored — the rows the ticket owes a
 * re-measure, a commit to a lib a guard composes or a rule file it names at
 * HEAD among them. A cite is lib/qualify-citations.js's bareCitationGrep. A
 * row a neighbour expired again
 * after the ticket re-anchored it is still named here.
 *
 * @param {string} root
 * @param {Record<string, { digest: string }>} guards the baseline's rows
 * @param {number} n
 * @param {Pick<CensusReadOpts, "ceiling">} [opts] every git read inside
 *   `ceiling`, so a caller with a time budget gets CeilingPassed, not a hang
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
	/* Messages first, then the files of the commits that matched: a pathspec on
	 * the history walk diffs every commit's tree, and the guard-issue-close core runs
	 * this inside a 4 s budget (#1913). */
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
	/* Each commit's guards with its parent's and its own snapshot. */
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

/**
 * The directories `rels`' Node guards can compose a lib from: each wrapper's
 * lib/, and the manifest's where a core's host sits.
 *
 * @param {string[]} rels
 */
function libDirsOf(rels) {
	const dirs = rels.map(libDirOf).filter((dir) => dir !== null);
	if (dirs.length > 0) dirs.push(path.posix.dirname(MANIFEST_REL));
	return [...new Set(dirs)];
}

/**
 * A `**Census:**` line with something after it.
 * @param {string} text
 */
const hasCensusLine = (text) => hasLine(text, "Census", "\\S");

/**
 * readRowsExpiredByTicket over the repo's own anchors file as HEAD holds it, so
 * a neighbour's uncommitted copy neither refuses a close nor excuses one
 * (#3521). A repo with none has no census to owe. Throws where git, the file or
 * a formatter cannot answer.
 *
 * @param {string} root
 * @param {number} n
 * @param {Pick<CensusReadOpts, "ceiling">} [opts] as readRowsExpiredByTicket takes it
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
 * The refusal both close routes print over `rows`, escape included.
 *
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
	DigestUnavailable,
	GIT_MAX_BUFFER,
	censusRefusal,
	readCommittedBytes,
	digestOf,
	readExpiredRows,
	guardsChangedBy,
	hasCensusLine,
};
