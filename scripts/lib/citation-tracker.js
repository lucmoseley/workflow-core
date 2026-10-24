/*
 * citation-tracker.js — the prefix test (#162), shared by its two callers:
 * `scripts/check-citation-tracker.js`, the pre-commit gate over the staged
 * diff, and `scripts/guard-citation-tracker.sh`, which judges a `Write` or
 * `Edit` as it lands and hands the session the rule (#2015).
 *
 * WHY THE FAULT EXISTS. `ec8654cd` rewrote every historical citation to the
 * `mantahostels#N` form, and this repo's own tracker numbers from 1 — so the
 * two overlap across the whole low band and the prefix is the only thing
 * telling them apart. Most of the citations in any file carry it, so imitating
 * the file's local style is the likelier mistake than not.
 *
 * THE TEST IS THE PRE-REWRITE USE COUNT, not the number's size. A
 * `mantahostels#N` the inherited tracker never used ANYWHERE at `ec8654cd`
 * cannot be a genuine reference to it: every genuine one was written before
 * the rewrite and rewritten by it. So the check is set membership against the
 * numbers that blob-set actually spells, which is one `git grep` and no
 * network call.
 *
 * WHAT IT THEREFORE MISSES, and it is most of the class (#162): a number the
 * inherited tracker DID use. Distinguishing those needs both issues read, and
 * the inherited tracker is unreachable from here.
 *
 * Run as a CLI by the guard: `node citation-tracker.js <root> <rel-path>`, the
 * hook payload on stdin. It prints the notice naming each failed number and
 * exits 0; 3 where the write adds none, 4 where `ec8654cd` is absent (an
 * adopter's repo), 2 where git or the payload could not be read, the cause on
 * stderr.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { CITATION_CEILING } = require("./qualify-citations.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { caught } = require("./caught.js");
const { GIT_TIMEOUT_MS } = require("./dirty-tree.js");
const { writeFd } = require("./write-fd.js");

/*
 * The commit that rewrote every historical citation into the prefixed form.
 *
 * `WFC_CITATION_BASELINE` overrides it, and is a test-injection point alone:
 * every case runs in a throwaway repo that has no history of this one's.
 */
const REWRITE = process.env.WFC_CITATION_BASELINE || "ec8654cd";

const PREFIX = "mantahostels";

/**
 * The band where the two trackers overlap. Above it a prefixed citation is a
 * number this repo's tracker has not reached, so the prefix cannot be a
 * mis-copy.
 *
 * qualify-citations.js's CITATION_CEILING, imported, so the two move together
 * (#726). The price of the headroom: a genuine new citation of an inherited
 * issue the corpus at `REWRITE` never spelled, numbered between this tracker's
 * top and the ceiling, is refused and needs `citation-exempt:`. A ceiling
 * that lags the tracker instead lets a mis-copy through silently, and
 * check-citation-ceiling.js fails before that can happen.
 */
const BAND_MAX = CITATION_CEILING;

const CITE = new RegExp(`${PREFIX}#(\\d+)`, "g");

/*
 * The inherited tracker's owner. `ec8654cd` wrote only the bare prefix, so a
 * citation carrying this owner was written as a cross-repo reference on
 * purpose (#1039). Judged per citation, so a bare one beside it on the same
 * line is still judged; any other owner is judged as bare.
 */
const OWNER = "lucmoseley";

const OWNED_CITE = new RegExp(
	`(?:(?<owner>[\\w.-]+)/)?${PREFIX}#(?<n>\\d+)`,
	"g",
);

/*
 * Genuine inherited citations the pre-rewrite test cannot clear, because the
 * corpus at `REWRITE` never spells them. #78, an inherited
 * consent ticket, survives in the classes sidecar as a declared external
 * reference and so has no prose citation to count. Each other group's
 * evidence is on the issue named above it.
 *
 * ADD TO IT ONLY on evidence that the inherited issue is the one meant: both
 * trackers read (#162), or the number cited while this tracker was below it
 * (#726).
 */
const INHERITED_UNCITED = new Set([
	78,
	// #726
	1459, 2313, 2557, 2586, 3509, 3519, 3527, 3566, 3570, 3592, 3605, 3631,
	// #1938
	1248, 2036,
	// #1947
	932, 1765, 3096,
]);

/*
 * A declared external reference. `docs/doc-map-classes.json`'s `"kind":
 * "external"` entries name the other tracker deliberately — that IS the
 * entry's content — and the `"ref":` line is the shape they take.
 *
 * DELIBERATELY NOT SCOPED TO THAT FILE, and not to the `kind` line either: the
 * kind sits on the line above, which this line-at-a-time scan cannot see, and
 * any JSON spelling a citation as a `"ref"` value is making the same
 * declaration. The cost is that a `"ref": "mantahostels#N"` written anywhere
 * else passes unjudged.
 */
const DECLARED_EXTERNAL = /"ref":\s*"mantahostels#\d+"/;

/*
 * The checker's own test file, whose fixtures must spell the fault to prove
 * the gate catches it. The one path where a prefixed unused number is the
 * subject rather than a mistake.
 */
const SELF_TEST = "scripts/check-citation-tracker.test.ts";

/*
 * The per-line escape, for a genuine reference to an inherited issue the corpus
 * never cited. Nothing validates the reason it gives — same bargain as
 * check-guard-test-isolation.js's `isolation-exempt:`.
 */
const EXEMPT = /citation-exempt:[ \t]*[A-Za-z0-9]/;

/**
 * @typedef {{ ok: true, out: string } | { ok: false, why: string }} GitRead
 */

/**
 * git's THREE outcomes, kept apart — where dirty-tree.js's `gitRead` folds
 * every failure into null.
 *
 * `git grep` exits 1 on no match and >1 on failure, and `rev-parse --verify`
 * exits 1 on an unknown ref and 128 outside a repository — so a wrapper that
 * folds every non-zero into one answer reports a broken apparatus as an empty
 * result. That is the fail-open `lib/check.js`'s SUBJECT/APPARATUS split exists
 * to prevent, and it is why `noMatch` is named per call rather than assumed.
 *
 * @param {string[]} args
 * @param {number[]} noMatch exit codes that mean "asked and answered nothing"
 * @param {string} [cwd]
 * @returns {GitRead}
 */
function gitOutcome(args, noMatch, cwd) {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.error) return { ok: false, why: r.error.message };
	if (r.status === 0) return { ok: true, out: r.stdout };
	if (r.status !== null && noMatch.includes(r.status))
		return { ok: true, out: "" };
	const why = (r.stderr || "").trim() || `git exited ${r.status}`;
	return { ok: false, why };
}

/**
 * Whether `REWRITE` resolves: `out` empty where it does not.
 *
 * @param {string} [cwd]
 * @returns {GitRead}
 */
function baselineCommit(cwd) {
	return gitOutcome(
		["rev-parse", "--verify", "--quiet", `${REWRITE}^{commit}`],
		[1],
		cwd,
	);
}

/**
 * Every issue number the inherited tracker is cited by at `REWRITE`.
 *
 * An EMPTY set is a real answer, not a failure: a baseline holding no prefixed
 * citation at all means the prefix names nothing there. Only a git that could
 * not run is `ok: false`.
 *
 * @param {string} [cwd]
 * @returns {{ ok: true, out: Set<number> } | { ok: false, why: string }}
 */
function inheritedNumbers(cwd) {
	const r = gitOutcome(
		["grep", "-oh", "-E", `${PREFIX}#[0-9]+`, REWRITE, "--", "."],
		[1],
		cwd,
	);
	if (!r.ok) return r;
	const seen = new Set();
	for (const m of r.out.matchAll(CITE)) seen.add(Number(m[1]));
	return { ok: true, out: seen };
}

/**
 * One line's inherited-tracker citations, judged.
 *
 * @param {{file: string, line: string}} at
 * @param {Set<number>} inherited
 * @returns {{citations: number, found: number[]}} the line's citations
 *   counted, and the numbers the inherited tracker never used
 */
function judgeLine({ file, line }, inherited) {
	/** @type {number[]} */
	const found = [];
	if (file.startsWith(SELF_TEST)) return { citations: 0, found };
	if (DECLARED_EXTERNAL.test(line) || EXEMPT.test(line))
		return { citations: 0, found };
	let citations = 0;
	for (const m of line.matchAll(OWNED_CITE)) {
		if (m.groups?.owner === OWNER) continue;
		const n = Number(m.groups?.n);
		if (n > BAND_MAX) continue;
		citations++;
		if (inherited.has(n) || INHERITED_UNCITED.has(n)) continue;
		found.push(n);
	}
	return { citations, found };
}

/**
 * The lines a `Write` or `Edit` adds: those of the new text that the text it
 * replaces does not already carry — the file on disk for a `Write`,
 * `old_string` for an `Edit` — so a write that only moves an old citation
 * is not judged for it.
 *
 * @param {string} root
 * @param {string} rel
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>}} payload
 * @returns {string[]}
 */
function writtenLines(root, rel, payload) {
	const input = payload.tool_input ?? {};
	const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
	let before = "";
	let after = "";
	if (payload.tool_name === "Edit") {
		before = text(input.old_string);
		after = text(input.new_string);
	} else {
		after = text(input.content);
		try {
			before = fs.readFileSync(path.join(root, rel), "utf8");
		} catch (e) {
			// A new file: every line is added. Any other fault is no answer.
			if (caught(e).code !== "ENOENT") throw e;
		}
	}
	const had = new Set(before.split("\n"));
	return after.split("\n").filter((l) => !had.has(l));
}

/**
 * @param {string[]} argv `<root> <rel-path>`
 * @param {string} stdin the hook payload
 * @returns {{code: number, out: string}}
 */
function main([root, rel], stdin) {
	if (!root || !rel) return { code: 2, out: "" };
	const lines = writtenLines(root, rel, JSON.parse(stdin)).filter((l) =>
		l.includes(`${PREFIX}#`),
	);
	if (lines.length === 0) return { code: 3, out: "" };
	const baseline = baselineCommit(root);
	if (!baseline.ok) throw new Error(baseline.why);
	if (!baseline.out.trim()) return { code: 4, out: "" };
	const inherited = inheritedNumbers(root);
	if (!inherited.ok) throw new Error(inherited.why);
	const found = new Set();
	for (const line of lines)
		for (const n of judgeLine({ file: rel, line }, inherited.out).found)
			found.add(n);
	if (found.size === 0) return { code: 3, out: "" };
	const named = [...found]
		.sort((a, b) => a - b)
		.map((n) => `${PREFIX}#${n} (write #${n})`)
		.join(" ");
	return {
		code: 0,
		out: `${rel} adds ${named} — the inherited tracker never used that number, so the citation means this repo's own issue.\n`,
	};
}

module.exports = {
	PREFIX,
	REWRITE,
	baselineCommit,
	gitOutcome,
	inheritedNumbers,
	judgeLine,
};

if (require.main === module) {
	let result;
	try {
		result = main(process.argv.slice(2), fs.readFileSync(0, "utf8"));
	} catch (e) {
		writeFd(2, `${caught(e).message}\n`);
		result = { code: 2, out: "" };
	}
	if (result.out) writeFd(1, result.out);
	process.exitCode = result.code;
}
