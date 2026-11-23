const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stripVTControlCharacters } = require("node:util");
const { caught, parseErrorText } = require("./caught.js");
const {
	isNetworkFault,
	isPushFaultText,
	PushRefused,
	readGitLines,
	REMOTE_TRIES,
	remoteBackoffMs,
} = require("./network-fault.js");
const { parseFirstLine } = require("./first-line.js");
const { REMOTE } = require("./landing-refs.js");
const { execGit, SHORT_SHA } = require("./git.js");
const { writeFd } = require("./write-fd.js");
const { linkArtefacts, unlinkArtefacts } = require("./isolated-worktree.js");

// guess, #2402
const LANDER_GIT_TIMEOUT_MS = 120 * 1000;
// guess, #2402
const PUSH_TIMEOUT_MS = 20 * 60 * 1000;
// measured to fit up to load 42-56, #3913
const GATED_COMMIT_TIMEOUT_MS = 600 * 1000;

/** @param {string} text */
const parseRefusal = (text) => readGitLines(text)[0] ?? parseFirstLine(text);

// guess, #4515
const REFUSAL_TAIL_LINES = 40;
// guess, #4800
const VERDICT_LINE_MAX = 300;
// guess, #4800
const REFUSAL_MAX = 50_000;
const REFUSAL_CUT = "[…]";

const ADDED_FAULTS = /^The fault\(s\) below are NOT in /;
const VERDICT_LINE =
	/^(?:not carried |no row carried across this merge: |FAIL: )/;

/** @param {string} line */
const cutLine = (line) =>
	line.length > VERDICT_LINE_MAX
		? `${line.slice(0, VERDICT_LINE_MAX - 1)}…`
		: line;

/** @param {string} text */
function parseGateRefusal(text) {
	const whole = parseRefusalText(text, false);
	if (whole.length <= REFUSAL_MAX) return whole;
	const cut = parseRefusalText(text, true);
	return cut.length <= REFUSAL_MAX
		? cut
		: `${cut.slice(0, REFUSAL_MAX)}\n${REFUSAL_CUT}`;
}

/**
 * @param {string} text
 * @param {boolean} cutTail
 */
function parseRefusalText(text, cutTail) {
	const lines = stripVTControlCharacters(text)
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l !== "");
	const tailFrom = lines.length - REFUSAL_TAIL_LINES;
	/** @type {string[]} */
	const kept = [];
	let inFaults = false;
	let next = 0;
	lines.forEach((line, i) => {
		inFaults = ADDED_FAULTS.test(line) || (inFaults && line.startsWith("  "));
		const inTail = i >= tailFrom;
		if (!inTail && !inFaults && !VERDICT_LINE.test(line)) return;
		if (i > next) kept.push(REFUSAL_CUT);
		kept.push(inTail && !cutTail ? line : cutLine(line));
		next = i + 1;
	});
	return kept.join("\n");
}

/** @param {unknown} err */
const readThrownText = (err) => {
	const e = caught(err);
	return String(e.stderr || e.message);
};

/**
 * @param {() => unknown} call
 * @returns {string|null}
 */
function stderrIfThrown(call) {
	try {
		call();
		return null;
	} catch (err) {
		return readThrownText(err);
	}
}
/** @param {string} sha */
const short = (sha) => sha.slice(0, SHORT_SHA);

/**
 * @template T
 * @param {{wait?: (ms: number) => Promise<void>,
 *   retried?: (retry: number, err: unknown) => void}} deps
 * @param {() => T | Promise<T>} call
 * @param {(err: unknown) => boolean} [isFault]
 * @returns {Promise<T>}
 */
async function remote(
	{ wait = pause, retried },
	call,
	isFault = isNetworkFault,
) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await call();
		} catch (err) {
			if (attempt >= REMOTE_TRIES || !isFault(err)) throw err;
			retried?.(attempt, err);
			await wait(remoteBackoffMs(attempt));
		}
	}
}

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} root
 * @param {string[]} shas
 * @returns {string[]}
 */
function readLocalCommits(root, shas) {
	if (shas.length === 0) return [];
	let printed;
	try {
		printed = execGit(["cat-file", "--batch-check=%(objectname)"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: LANDER_GIT_TIMEOUT_MS,
			input: shas.map((sha) => `${sha}^{commit}\n`).join(""),
		});
	} catch {
		return [];
	}
	return printed.split("\n").filter((line) => shas.includes(line));
}

/**
 * @param {string} root
 * @param {string[]} args
 */
const readGit = (root, args) =>
	execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: LANDER_GIT_TIMEOUT_MS,
	});

/**
 * @param {string} root
 * @param {string} a
 * @param {string} b
 */
function isAncestor(root, a, b) {
	try {
		readGit(root, ["merge-base", "--is-ancestor", a, b]);
		return true;
	} catch (err) {
		if (caught(err).status === 1) return false;
		throw err;
	}
}

/**
 * @param {string} root
 * @param {string[]} patterns
 * @param {(heads: Map<string, string>) => string[]} fetch
 * @param {(shas: string[]) => boolean} [areLocal]
 * @returns {Map<string, string>}
 */
function readRemoteHeads(
	root,
	patterns,
	fetch,
	areLocal = (shas) =>
		readLocalCommits(root, shas).length === new Set(shas).size,
) {
	const heads = new Map(
		readGit(root, ["ls-remote", REMOTE, ...patterns])
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [sha = "", ref = ""] = line.split("\t");
				return [ref, sha];
			}),
	);
	const refspecs = fetch(heads);
	if (refspecs.length > 0 && !areLocal([...heads.values()]))
		readGit(root, ["fetch", "--quiet", REMOTE, ...refspecs]);
	return heads;
}

/**
 * @template T
 * @param {string} root
 * @param {string} tip
 * @param {{program: string, use: string}} names
 * @param {(dir: string, inTree: (args: string[], timeout?: number) => string) => T} use
 * @returns {T}
 */
function withThrowawayTree(root, tip, { program, use: purpose }, use) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${program}-${purpose}-`));
	readGit(root, ["worktree", "add", "--quiet", "--detach", dir, tip]);
	/** @param {string[]} args @param {number} [timeout] */
	const inTree = (args, timeout = LANDER_GIT_TIMEOUT_MS) =>
		execGit(args, {
			cwd: dir,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout,
		});
	try {
		const linkFault = linkArtefacts(root, dir);
		if (linkFault !== null) throw new Error(linkFault);
		return use(dir, inTree);
	} finally {
		unlinkArtefacts(dir);
		const unremoved = stderrIfThrown(() =>
			readGit(root, ["worktree", "remove", "--force", dir]),
		);
		if (unremoved !== null)
			writeFd(
				2,
				`${program}: could not remove the ${purpose}'s worktree ${dir}: ${parseRefusal(unremoved)}\n`,
			);
	}
}

/**
 * @param {(args: string[]) => string} inTree
 * @returns {string[]}
 */
const readConflictedFiles = (inTree) =>
	inTree(["diff", "--name-only", "--diff-filter=U"])
		.split("\n")
		.filter(Boolean);

/**
 * @param {string} root
 * @param {string[]} args
 * @param {string} [to]
 */
function pushRemote(root, args, to = REMOTE) {
	try {
		execGit(["push", "--quiet", to, ...args], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: PUSH_TIMEOUT_MS,
		});
	} catch (err) {
		const e = caught(err);
		if (e.status !== undefined && !isPushFaultText(e.stderr ?? ""))
			throw new PushRefused(e.message, { cause: err });
		if (e.code !== "ETIMEDOUT") throw err;
		throw new Error(
			`git push ${args.join(" ")} timed out after ${PUSH_TIMEOUT_MS / 60_000} min`,
			{ cause: err },
		);
	}
}

const STALE = /\(stale info\)/;
const GONE = /remote ref does not exist/;

/**
 * @param {string} root
 * @param {string} branch
 * @param {string} sha
 * @param {string} [to]
 * @returns {boolean}
 */
function deleteRemoteRef(root, branch, sha, to = REMOTE) {
	const ref = `refs/heads/${branch}`;
	try {
		pushRemote(root, [`--force-with-lease=${ref}:${sha}`, `:${ref}`], to);
		return true;
	} catch (err) {
		const refused = parseErrorText(err);
		if (GONE.test(refused)) return true;
		if (STALE.test(refused)) return false;
		throw err;
	}
}

/**
 * @param {string} root
 * @param {string} branch
 * @param {string} sha
 */
function createRemoteRef(root, branch, sha) {
	const ref = `refs/heads/${branch}`;
	try {
		pushRemote(root, [`--force-with-lease=${ref}:`, `${sha}:${ref}`]);
	} catch (err) {
		if (!STALE.test(parseErrorText(err))) throw err;
		const held = readGit(root, ["ls-remote", REMOTE, ref]).split("\t")[0];
		if (held !== sha) throw err;
	}
}

module.exports = {
	createRemoteRef,
	deleteRemoteRef,
	GATED_COMMIT_TIMEOUT_MS,
	LANDER_GIT_TIMEOUT_MS,
	isAncestor,
	parseRefusal,
	REFUSAL_TAIL_LINES,
	parseGateRefusal,
	PUSH_TIMEOUT_MS,
	pushRemote,
	readConflictedFiles,
	readGit,
	readRemoteHeads,
	remote,
	short,
	withThrowawayTree,
};
