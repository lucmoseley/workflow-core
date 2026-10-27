/*
 * citation-tracker.js — the prefix test (#162), shared by its two callers:
 * `scripts/check-citation-tracker.js`, the pre-commit gate over the staged
 * diff, and lib/citation-write.js, the dispatcher core that judges a `Write`
 * or `Edit` as it lands and hands the session the rule (#2015).
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

 */

const { CITATION_CEILING } = require("./qualify-citations.js");
const { spawnGitSync, GIT_TIMEOUT_MS } = require("./git.js");

/*
 * The commit that rewrote every historical citation into the prefixed form.
 *
 * `WFC_CITATION_BASELINE` overrides it, and is a test-injection point alone:
 * every case runs in a throwaway repo that has no history of this one's. Read
 * at each call, so an in-process case can name its own repo's.
 */
const baselineRev = (env = process.env) =>
	env.WFC_CITATION_BASELINE || "ec8654cd";

const PREFIX = "mantahostels";

/**
 * The band where the two trackers overlap. Above it a prefixed citation is a
 * number this repo's tracker has not reached, so the prefix cannot be a
 * mis-copy.
 *
 * qualify-citations.js's CITATION_CEILING, imported, so the two move together
 * (#726). The price of the headroom: a genuine new citation of an inherited
 * issue the corpus at the baseline commit never spelled, numbered between this tracker's
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
 * corpus at the baseline commit never spells them. #78, an inherited
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
 * @typedef {(args: string[], noMatch: number[]) => GitRead} GitReader
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
function gitOutcome(args, noMatch, cwd, timeout = GIT_TIMEOUT_MS) {
	const r = spawnGitSync(args, {
		cwd,
		encoding: "utf8",
		timeout,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.error) return { ok: false, why: r.error.message };
	if (r.status === 0) return { ok: true, out: r.stdout };
	if (r.status !== null && noMatch.includes(r.status))
		return { ok: true, out: "" };
	const why = (r.stderr || "").trim() || `git exited ${r.status}`;
	return { ok: false, why };
}

/**
 * Whether the baseline commit resolves: `out` empty where it does not.
 *
 * @param {GitReader} [read]
 * @param {string} [rev] baselineRev's answer
 * @returns {GitRead}
 */
function readBaselineCommit(read = gitOutcome, rev = baselineRev()) {
	return read(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], [1]);
}

/**
 * Every issue number the inherited tracker is cited by at the baseline commit.
 *
 * An EMPTY set is a real answer, not a failure: a baseline holding no prefixed
 * citation at all means the prefix names nothing there. Only a git that could
 * not run is `ok: false`.
 *
 * @param {GitReader} [read]
 * @param {string} [rev] baselineRev's answer
 * @returns {{ ok: true, out: Set<number> } | { ok: false, why: string }}
 */
function readInheritedNumbers(read = gitOutcome, rev = baselineRev()) {
	const r = read(
		["grep", "-oh", "-E", `${PREFIX}#[0-9]+`, rev, "--", "."],
		[1],
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

module.exports = {
	PREFIX,
	baselineRev,
	readBaselineCommit,
	gitOutcome,
	readInheritedNumbers,
	judgeLine,
};
