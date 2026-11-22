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
/** @typedef {{ sha: string, subject: string }} Commit */

const HEX_WORDS_RE = new RegExp(HEX_WORD_RE.source, "g");

/** @param {string} text */
const hasUnlandedLine = (text) => hasLine(text, "Unlanded", "\\S");

/**
 * @param {string} tree
 * @param {import("./git-ceiling.js").GitCeiling} ceiling
 * @returns {GitReader}
 */
const ceilingReader = (tree, ceiling) => (args, noMatch) => {
	try {
		const out = ceiling.git(
			["-C", tree, ...args],
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
 * @param {string} tree
 * @param {number} n
 * @param {string} comment
 * @param {{ ceiling?: import("./git-ceiling.js").GitCeiling }} [opts]
 * @returns {{ pushed: string, commits: Commit[] }}
 */
function readUnlandedCommits(tree, n, comment, { ceiling = NO_CEILING } = {}) {
	const read = ceilingReader(tree, ceiling);
	/**
	 * @param {string[]} args
	 * @param {number[]} [noMatch]
	 */
	const git = (args, noMatch = []) => {
		const r = read(args, noMatch);
		if (!r.ok) throw new Error(`git ${args[0]}: ${r.why}`);
		return r.out;
	};
	const pushed = pushedRef({ tree });
	if (!commitOrThrow(read, pushed))
		throw new Error(`no ${pushed} to compare against`);
	const format = "--format=%h%x00%at%x00%s";
	const named = readNamedCommits(read, comment).map((sha) =>
		git(["log", "-1", format, sha, "--not", pushed]),
	);
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

/** @param {GitReader} read @param {string} text @returns {string[]} */
function readNamedCommits(read, text) {
	const shas = [...new Set(text.match(HEX_WORDS_RE) ?? [])].flatMap((w) => {
		const sha = commitOrThrow(read, w);
		if (sha) return [sha];
		const r = read(["rev-parse", `--disambiguate=${w}`], []);
		if (!r.ok) throw new Error(`git rev-parse: ${r.why}`);
		return r.out
			.split("\n")
			.filter(Boolean)
			.map((oid) => commitOrThrow(read, oid))
			.filter((c) => c !== null);
	});
	return [...new Set(shas)];
}

/**
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

/** @param {GitReader} read @param {string} rev @returns {string | null} */
function commitOrThrow(read, rev) {
	const r = readCommit(read, rev);
	if (!r.ok) throw new Error(`${rev}: ${r.why}`);
	return r.sha;
}

/** @param {number} n @param {{ pushed: string, commits: Commit[] }} unlanded */
function unlandedRefusal(n, { pushed, commits }) {
	const one = commits.length === 1;
	const branch = pushed.slice(REMOTE.length + 1);
	return `#${n}'s commit${one ? " is" : "s are"} not on ${pushed}, under ${one ? "its" : "their"} own hash or ${one ? "its" : "their"} subject:
${commits.map((c) => `  ${c.sha} ${c.subject}`).join("\n")}
Push ${one ? "it" : "them"} first, then close. Pushed from another clone: git fetch ${REMOTE} ${branch}, then re-run. Not this ticket's to land — a neighbour's commit that cites it in passing, or one abandoned: add "**Unlanded:** <why the close stands without ${one ? "it" : "them"}>" to the comment.`;
}

module.exports = {
	hasUnlandedLine,
	readNamedCommits,
	readUnlandedCommits,
	unlandedRefusal,
};
