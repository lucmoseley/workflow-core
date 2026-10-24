/*
 * census-digest.js — the digest a census row anchors a guard by, and which
 * of those rows a ticket's commits expired (workflow-core#1876), read by both close routes
 * before a completed close (workflow-core#1913).
 *
 * Run as `expired <n>` with the close's comments on stdin, it prints
 * {"rows": [rel, …], "refusal": text} for the host repo, both empty where no
 * row is or the comments carry a `**Census:**` line; on a fault it prints
 * nothing to stdout and exits 1, and on a bad issue number exits 2.
 *
 * THE DIGEST HASHES WHAT CAN CHANGE WHAT THE GUARD PRINTS, not the file.
 * Shell is hashed as shfmt's minified print, and
 * JavaScript as TypeScript's reprint with comments removed: both drop
 * comments and layout and keep every string, heredoc and template literal
 * byte for byte. Any other extension, and shell shfmt cannot parse, hashes
 * its raw bytes.
 *
 * A SHELL GUARD'S DIGEST ALSO HASHES EACH RULE FILE ITS CODE NAMES (workflow-core#1914):
 * each rule fetch reads docs/agents/rules/<id>.txt at run time, so a reworded
 * fragment changes what the guard prints with its code untouched.
 * Residual: an id a sourced lib names, or one built at run time, is unread.
 *
 * Residual: the reprint belongs to the pinned shfmt and typescript, so a bump
 * that changes either's printing expires every row of that language at once.
 * A shebang survives the minify; a `# shellcheck` directive does not.
 */

const { execFileSync } = require("node:child_process");
const { gitBinary } = require("./git-binary.js");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { loadShfmt } = require("./formatters.js");
const { CeilingPassed, NO_CEILING } = require("./git-ceiling.js");
const { hasLine } = require("./marker-line.js");
const {
	RULE_ARG_RE,
	directRuleCounts,
	ruleArgs,
} = require("./rule-emission.js");
const { RuleTableError, expandRuleTables } = require("./rule-table.js");
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

/* lib/rule-emission.js's EMIT_RULE_RE, unanchored — the minified code holds
 * no comment to mismatch — and with an id ending at `;`, `&`, `|` or `)` too,
 * where the minify joins `if …; then gp_rule x; fi` onto one line. */
const EMITTED_RULE_RE = new RegExp(
	`(?<![\\w-])gp_rule(?:_module[ \\t]+[a-z]+)?${ruleArgs("[\\s;&|)]|$")}`,
	"gm",
);

/** @typedef {{ disk?: boolean, ceiling?: import("./git-ceiling.js").GitCeiling }} CensusReadOpts */

/** A formatter the digest needs is not installed, or a gp_rule_path_rows
 * table in the code will not read: BROKEN, never a crash. */
class DigestUnavailable extends Error {}

/* ~10x the largest guard in the set, so a runaway is bounded and nothing real
 * is ever truncated. A ticket's `git log --name-only` over the guards is a
 * few hundred bytes a commit, and a commit's `diff-tree` path list tens of
 * bytes a path, both far under it too. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * A tracked path's bytes AT `rev`, falling back to disk where git cannot answer.
 *
 * The fallback is what lets a non-git fixture — and a path git has not been
 * told about yet — still be measured, at the cost that an uncommitted path
 * reads as committed. `disk: false` refuses it, for a rev that is a past
 * commit, where an absent path means added there rather than unknown.
 * `ceiling` runs the read inside a lib/git-ceiling.js ceiling, whose passing
 * is thrown, never read as an absent path (workflow-core#2210).
 *
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts]
 * @returns {Buffer | null}
 */
function committedBytes(
	root,
	rel,
	rev = "HEAD",
	{ disk = true, ceiling = NO_CEILING } = {},
) {
	const args = ["-C", root, "show", `${rev}:${rel}`];
	/** @type {import("node:child_process").ExecFileSyncOptions} */
	const opts = {
		maxBuffer: GIT_MAX_BUFFER,
		/* git's own "does not exist in HEAD" goes to stderr on every untracked
		 * path, which is a normal answer here rather than something to print. */
		stdio: ["ignore", "pipe", "ignore"],
	};
	try {
		return /** @type {Buffer} */ (
			ceiling.git(args, opts, `git show ${rev}:${rel}`)
		);
	} catch (e) {
		if (e instanceof CeilingPassed) throw e;
		if (!disk) return null;
		/* Either git cannot answer at all (no repo) or the path is not in HEAD.
		 * Disk decides which: present on disk means untracked or unstaged-new. */
		try {
			return fs.readFileSync(path.join(root, rel));
		} catch {
			return null;
		}
	}
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
 * The rule files a shell guard's code prints from, sorted.
 *
 * @param {string} rel
 * @param {string | Buffer} code codeOf's answer
 * @returns {string[]}
 */
function ruleFilesOf(rel, code) {
	if (!rel.endsWith(".sh")) return [];
	let text;
	try {
		text = expandRuleTables(code.toString());
	} catch (e) {
		if (e instanceof RuleTableError)
			throw new DigestUnavailable(`${rel}: ${e.message}`, { cause: e });
		throw e;
	}
	const ids = new Set(directRuleCounts(text).keys());
	for (const m of text.matchAll(EMITTED_RULE_RE))
		for (const a of (m[1] ?? "").matchAll(RULE_ARG_RE)) if (a[1]) ids.add(a[1]);
	return [...ids].sort().map((id) => `${RULES_DIR}/${id}.txt`);
}

/**
 * `rel`'s code at `rev` and the rule files it names, or null where it is gone.
 *
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts] as committedBytes takes it
 * @returns {{ code: string | Buffer, ruleFiles: string[] } | null}
 */
function inputsOf(root, rel, rev, opts) {
	const bytes = committedBytes(root, rel, rev, opts);
	if (bytes === null) return null;
	const code = codeOf(rel, bytes);
	return { code, ruleFiles: ruleFilesOf(rel, code) };
}

/**
 * The census digest of `rel` at `rev`, or null where it is gone. Sixteen hex
 * characters, matching guard-registry-anchors.json's width: an anchor file is
 * read by people, and a full sha256 per row buys nothing here.
 *
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts] as committedBytes takes it
 * @returns {string | null}
 */
function digestOf(root, rel, rev, opts) {
	const inputs = inputsOf(root, rel, rev, opts);
	if (inputs === null) return null;
	const hash = crypto.createHash("sha256").update(inputs.code);
	/* A guard naming no rule file hashes as it did before workflow-core#1914. A named file
	 * that is absent hashes as a marker, not BROKEN: the guard then prints its
	 * fallback, and adding the file moves the digest. */
	for (const file of inputs.ruleFiles)
		hash
			.update(`\0${file}\0`)
			.update(committedBytes(root, file, rev, opts) ?? "\0absent");
	return hash.digest("hex").slice(0, 16);
}

/**
 * Which of `rels` name each rule file at `rev`: the guards a commit to that
 * file expires.
 *
 * @param {string} root
 * @param {string[]} rels
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts] as committedBytes takes it
 * @returns {Map<string, string[]>}
 */
function ruleReaders(root, rels, rev, opts) {
	/** @type {Map<string, string[]>} */
	const readers = new Map();
	for (const rel of rels.filter((r) => r.endsWith(".sh")))
		for (const file of inputsOf(root, rel, rev, opts)?.ruleFiles ?? [])
			readers.set(file, [...(readers.get(file) ?? []), rel]);
	return readers;
}

/**
 * The anchored guards among `rels` that a change to `file` can expire: the
 * guard itself, or the guards naming it as a rule file at `rev`. The readers
 * are read once, on the first rule file asked about.
 *
 * @param {string} root
 * @param {string[]} rels
 * @param {string} [rev]
 * @param {CensusReadOpts} [opts] as committedBytes takes it
 * @returns {(file: string) => string[]}
 */
function guardsChangedBy(root, rels, rev, opts) {
	const anchored = new Set(rels);
	/** @type {Map<string, string[]> | undefined} */
	let readers;
	return (file) => {
		if (anchored.has(file)) return [file];
		if (!file.startsWith(`${RULES_DIR}/`)) return [];
		readers ??= ruleReaders(root, rels, rev, opts);
		return readers.get(file) ?? [];
	};
}

/**
 * The anchored guards that commits on HEAD citing `#n` changed the digest of,
 * and that HEAD still leaves unanchored — the rows the ticket owes a
 * re-measure, a commit to a rule file a guard names at HEAD among them. A
 * cite is lib/qualify-citations.js's BARE_CITATION, spelt for
 * git's ERE, so `mantahostels#n` is another tracker's. A row a neighbour expired again
 * after the ticket re-anchored it is still named here.
 *
 * @param {string} root
 * @param {Record<string, { digest: string }>} guards the baseline's rows
 * @param {number} n
 * @returns {string[]}
 */
function rowsExpiredByTicket(root, guards, n) {
	const rels = Object.keys(guards);
	if (rels.length === 0) return [];
	/** @param {string[]} args */
	const git = (args) =>
		execFileSync(gitBinary(), ["-C", root, ...args], {
			encoding: "utf8",
			maxBuffer: GIT_MAX_BUFFER,
			stdio: ["ignore", "pipe", "pipe"],
		});
	/* Messages first, then the files of the commits that matched: a pathspec on
	 * the history walk diffs every commit's tree, and guard-issue-close.sh runs
	 * this inside a 4 s budget (workflow-core#1913). */
	const shas = git([
		"log",
		"-E",
		`--grep=(^|[^[:alnum:]_$&{#])#${n}([^[:alnum:]_]|$)`,
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
	]);
	const guardsOf = guardsChangedBy(root, rels);
	/** @type {Set<string>} */
	const changed = new Set();
	for (const entry of log.split("\0").slice(1)) {
		const [sha, ...files] = entry.split("\n").filter(Boolean);
		for (const rel of files.flatMap(guardsOf)) {
			if (changed.has(rel)) continue;
			if (
				digestOf(root, rel, `${sha}^`, { disk: false }) !==
				digestOf(root, rel, sha)
			)
				changed.add(rel);
		}
	}
	return rels.filter(
		(rel) => changed.has(rel) && digestOf(root, rel) !== guards[rel]?.digest,
	);
}

/**
 * A `**Census:**` line with something after it.
 * @param {string} text
 */
const hasCensusLine = (text) => hasLine(text, "Census", "\\S");

/**
 * rowsExpiredByTicket over the repo's own anchors file. A repo with none has
 * no census to owe. Throws where git, the file or a formatter cannot answer.
 *
 * @param {string} root
 * @param {number} n
 * @returns {string[]}
 */
function expiredRows(root, n) {
	const file = path.join(root, DEFAULT_ANCHORS);
	if (!fs.existsSync(file)) return [];
	const { guards } = JSON.parse(fs.readFileSync(file, "utf8"));
	return rowsExpiredByTicket(root, guards ?? {}, n);
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
	committedBytes,
	digestOf,
	expiredRows,
	guardsChangedBy,
	hasCensusLine,
};

if (require.main === module) {
	const { parseOrExit } = require("./cli-args");
	const { caught } = require("./caught.js");
	const { hostRoot } = require("./host-root.js");
	const { writeFd } = require("./write-fd.js");
	const { positionals } = parseOrExit(process.argv.slice(2), {
		usage:
			"usage: node census-digest.js expired <n>  (the close's comments on stdin)",
		flags: {},
		commands: {
			expired: {
				usage: "expired <n>: issue n's expired census rows, as JSON",
				min: 1,
			},
		},
	});
	const n = Number(positionals[0]);
	if (!Number.isInteger(n) || n < 1) {
		writeFd(2, `not an issue number: ${positionals[0]}\n`);
		process.exit(2);
	}
	try {
		const rows = hasCensusLine(fs.readFileSync(0, "utf8"))
			? []
			: expiredRows(hostRoot(), n);
		const refusal = rows.length > 0 ? censusRefusal(n, rows) : "";
		writeFd(1, `${JSON.stringify({ rows, refusal })}\n`);
	} catch (e) {
		writeFd(2, `${caught(e).message.split("\n")[0]}\n`);
		process.exit(1);
	}
}
