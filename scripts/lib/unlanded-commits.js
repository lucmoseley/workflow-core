/*
 * unlanded-commits.js — the ticket's commits that never reached the pushed
 * ref (#3101).
 *
 * A ticket's commits are those on HEAD citing `#n`, as census-digest.js reads
 * them, and any commit the close's comment names by sha. One is unlanded
 * where the pushed ref (lib/landing-refs.js: `origin/landing` with the
 * `landing` module on) holds neither it nor a twin of the same author date
 * and subject — a push rebased onto a moved `landing` lands under a new hash.
 *
 * Reads the remote-tracking ref as it stands, never fetching: a push from
 * this clone moves it, a push from another clone does not.
 *
 * Residual: an unpushed commit whose author date and subject both repeat a
 * pushed one's reads as landed. A short sha the comment means for a pushed
 * commit, shared with an unpushed or unreachable one it never meant, refuses
 * the close.
 */

const { NO_CEILING, CeilingPassed } = require("./git-ceiling.js");
const { readCommit } = require("./commit-sha.js");
const { REMOTE, pushedRef } = require("./landing-refs.js");
const { hasLine } = require("./marker-line.js");
const { HEX_WORD_RE } = require("./outstanding-line.js");
const { bareCitationGrep } = require("./qualify-citations.js");
const { caught } = require("./caught.js");

/**
 * @typedef {{ ok: true, out: string } | { ok: false, why: string }} GitRead
 * @typedef {(args: string[], noMatch: number[]) => GitRead} GitReader
 */
/** @typedef {{ sha: string, subject: string }} Commit `sha` as `%h` */

/* Unlike SHA_RE, an all-digit or all-letter short sha too (#3230): each is
 * kept only where rev-parse finds a commit by it. */
const HEX_WORDS_RE = new RegExp(HEX_WORD_RE.source, "g");

/**
 * An `**Unlanded:**` line with something after it: why the close stands
 * without them.
 * @param {string} text
 */
const hasUnlandedLine = (text) => hasLine(text, "Unlanded", "\\S");

/**
 * `ceiling`'s git as a GitReader, a passed ceiling still thrown.
 * @param {string} root
 * @param {import("./git-ceiling.js").GitCeiling} ceiling
 * @returns {GitReader}
 */
const ceilingReader = (root, ceiling) => (args, noMatch) => {
	try {
		const out = ceiling.git(
			["-C", root, ...args],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			`git ${args[0]}`,
		);
		return { ok: true, out: String(out) };
	} catch (e) {
		if (e instanceof CeilingPassed) throw e;
		const { status, message } = caught(e);
		if (status !== undefined && noMatch.includes(status))
			return { ok: true, out: "" };
		return { ok: false, why: message };
	}
};

/**
 * Issue `n`'s commits, cited on HEAD or named by sha in `comment`, that the
 * pushed ref holds under no hash, and that ref. `root` is the checkout the
 * close ran from, whose HEAD may be a linked worktree's rather than the host
 * root's. Each half is read on its own: a HEAD git cannot walk still leaves
 * the named commits judged, and throws only where they leave nothing to
 * refuse. Throws where the pushed ref is absent or git cannot answer;
 * CeilingPassed where `ceiling` passes.
 *
 * @param {string} root
 * @param {number} n
 * @param {string} comment
 * @param {{ ceiling?: import("./git-ceiling.js").GitCeiling }} [opts]
 * @returns {{ pushed: string, commits: Commit[] }}
 */
function readUnlandedCommits(root, n, comment, { ceiling = NO_CEILING } = {}) {
	const read = ceilingReader(root, ceiling);
	/**
	 * @param {string[]} args
	 * @param {number[]} [noMatch]
	 */
	const git = (args, noMatch = []) => {
		const r = read(args, noMatch);
		if (!r.ok) throw new Error(`git ${args[0]}: ${r.why}`);
		return r.out;
	};
	const pushed = pushedRef({ root });
	if (!commitOrThrow(read, pushed))
		throw new Error(`no ${pushed} to compare against`);
	const format = "--format=%h%x00%at%x00%s";
	const named = [...new Set(comment.match(HEX_WORDS_RE) ?? [])]
		.flatMap((w) => {
			const sha = commitOrThrow(read, w);
			if (sha) return [sha];
			/* No commit, or more than one (#3233): each it may mean is judged,
			 * since a throw would fail the check open. */
			return git(["rev-parse", `--disambiguate=${w}`])
				.split("\n")
				.filter(Boolean)
				.map((oid) => commitOrThrow(read, oid))
				.filter((c) => c !== null);
		})
		/* Empty where the pushed ref holds it: the walk starts at it. */
		.map((sha) => git(["log", "-1", format, sha, "--not", pushed]));
	/** @type {Error | null} */
	let headUnread = null;
	let cited = "";
	try {
		cited = git([
			"log",
			"-E",
			`--grep=${bareCitationGrep(n)}`,
			format,
			"HEAD",
			"--not",
			pushed,
		]);
	} catch (e) {
		if (e instanceof CeilingPassed) throw e;
		headUnread = /** @type {Error} */ (e);
	}
	/** @type {Map<string, { at: string, subject: string }>} */
	const candidates = new Map();
	for (const line of [...cited.split("\n"), ...named]) {
		const [sha, at, subject] = line.trim().split("\0");
		if (sha && at && subject !== undefined)
			candidates.set(sha, { at, subject });
	}
	const commits =
		candidates.size > 0 ? unlandedOf(git, pushed, candidates) : [];
	if (commits.length === 0 && headUnread) throw headUnread;
	return { pushed, commits };
}

/**
 * `candidates` with no twin on `pushed`: a commit of the same author date and
 * subject, which a rebase or cherry-pick keeps. A twin's committer date is
 * at or after its author date, so `--since` the oldest candidate's misses
 * none.
 * @param {(args: string[]) => string} git
 * @param {string} pushed
 * @param {Map<string, { at: string, subject: string }>} candidates
 * @returns {Commit[]}
 */
function unlandedOf(git, pushed, candidates) {
	const oldest = Math.min(...[...candidates.values()].map((c) => Number(c.at)));
	const landed = new Set(
		git(["log", `--since=${oldest}`, "--format=%at%x00%s", pushed]).split("\n"),
	);
	return [...candidates]
		.filter(([, c]) => !landed.has(`${c.at}\0${c.subject}`))
		.map(([sha, { subject }]) => ({ sha, subject }));
}

/**
 * The full sha `rev` names, null where it names none; throws where git would
 * not answer.
 * @param {GitReader} read
 * @param {string} rev
 * @returns {string | null}
 */
function commitOrThrow(read, rev) {
	const r = readCommit(read, rev);
	if (!r.ok) throw new Error(`${rev}: ${r.why}`);
	return r.sha;
}

/**
 * The refusal both close routes print over `commits`, escape included.
 * @param {number} n
 * @param {{ pushed: string, commits: Commit[] }} unlanded
 */
function unlandedRefusal(n, { pushed, commits }) {
	const one = commits.length === 1;
	const branch = pushed.slice(REMOTE.length + 1);
	return `#${n}'s commit${one ? " is" : "s are"} not on ${pushed}, under ${one ? "its" : "their"} own hash or ${one ? "its" : "their"} subject:
${commits.map((c) => `  ${c.sha} ${c.subject}`).join("\n")}
Push ${one ? "it" : "them"} first, then close. Pushed from another clone: git fetch ${REMOTE} ${branch}, then re-run. Not this ticket's to land — a neighbour's commit that cites it in passing, or one abandoned: add "**Unlanded:** <why the close stands without ${one ? "it" : "them"}>" to the comment.`;
}

module.exports = { hasUnlandedLine, readUnlandedCommits, unlandedRefusal };
