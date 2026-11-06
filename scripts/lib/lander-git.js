/*
 * lander-git.js — the queue lander's git and remote calls, shared by its
 * adapters (lib/queue-lander-adapters.js) and the readers of its refs and
 * ledger (lib/queue-ref-status.js, lib/landing-stall.js): the remote's heads,
 * ancestry, a throwaway worktree, a push, the line naming why git refused,
 * what a gate refusing a merge said, and a remote call's retries.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stripVTControlCharacters } = require("node:util");
const { caught } = require("./caught.js");
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
const { execGit } = require("./git.js");
const { writeFd } = require("./write-fd.js");

/* Untraced: room for a fetch over a slow link. */
const LANDER_GIT_TIMEOUT_MS = 120 * 1000;
/* Untraced: the push runs the checkout's pre-push hook, whose mod tests run
 * `claude plugin test` on a batch touching a mod. */
const PUSH_TIMEOUT_MS = 20 * 60 * 1000;
/* Measured on #3913: the gate stack fits this up to load 42-56, if time scales
 * with load, which no run measured. */
const GATED_COMMIT_TIMEOUT_MS = 600 * 1000;

/**
 * The line naming why a git call failed: git's own refusal where it printed
 * one, as a push's first line is the pre-push hook's, else the first line.
 * @param {string} text
 */
const parseRefusal = (text) => readGitLines(text)[0] ?? parseFirstLine(text);

/* A first guess, unmeasured: room for a gate's findings and the command it
 * names to settle them. */
const REFUSAL_TAIL_LINES = 40;

/**
 * What a gate refusing a merge said: the last REFUSAL_TAIL_LINES non-blank
 * lines, colour stripped. A hook prints its passing checks first and its
 * findings last, so its first line can be an `OK:`.
 * @param {string} text
 */
const parseRefusalTail = (text) =>
	stripVTControlCharacters(text)
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l !== "")
		.slice(-REFUSAL_TAIL_LINES)
		.join("\n");

/**
 * What a failed call printed to stderr, else its error's message.
 * @param {unknown} err
 */
const readThrownText = (err) => {
	const e = caught(err);
	return String(e.stderr || e.message);
};

/**
 * What `call` printed to stderr where it threw, else null.
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
/** Untraced: 9 hex digits, two past git's default abbreviation, unique in any history this size.
 * @param {string} sha */
const short = (sha) => sha.slice(0, 9);

/**
 * `call`'s result, retried with backoff while it fails on a fault `isFault`
 * names, a network fault where none is given.
 * @template T
 * @param {{wait?: (ms: number) => Promise<void>}} deps
 * @param {() => T | Promise<T>} call
 * @param {(err: unknown) => boolean} [isFault]
 * @returns {Promise<T>}
 */
async function remote({ wait = pause }, call, isFault = isNetworkFault) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await call();
		} catch (err) {
			if (attempt >= REMOTE_TRIES || !isFault(err)) throw err;
			await wait(remoteBackoffMs(attempt));
		}
	}
}

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Those of `shas` that name a commit present in `root`'s repo; none where git
 * cannot be asked, so a caller fetches.
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
 * Git in `root`, its output read, under the lander's timeout.
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
 * Whether commit `a` is `b` or one of its ancestors in `root`'s repo. Exit 1
 * is git's no; any other fault throws.
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
 * The heads of lib/landing-refs.js's remote that `patterns` match, each sha
 * by its full ref name. Where one is not a commit `areLocal` finds, `fetch`'s
 * refspecs for those heads are fetched first; none fetches nothing.
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
 * `use`'s result in a throwaway worktree of `root` detached at `tip`, so the
 * checkout's own tree and branch are never touched. The worktree is removed
 * after; a removal that fails prints and never replaces the result, as a
 * hook's child that left its commit's group can still be writing there
 * (#3913).
 * @template T
 * @param {string} root
 * @param {string} tip
 * @param {{program: string, use: string}} names the program printing a
 *   failed removal, and what the worktree is for
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
		return use(dir, inTree);
	} finally {
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
 * The files a merge left conflicted in the worktree `inTree` runs git in.
 * @param {(args: string[]) => string} inTree
 * @returns {string[]}
 */
const readConflictedFiles = (inTree) =>
	inTree(["diff", "--name-only", "--diff-filter=U"])
		.split("\n")
		.filter(Boolean);

/**
 * A push from `root` to lib/landing-refs.js's remote. Its timeout is the
 * pre-push hook's run, which a retry would only repeat, so it throws as no
 * network fault; a refusal whose git lines name no fault throws PushRefused.
 * @param {string} root
 * @param {string[]} args the push's flags and refspecs
 * @param {NodeJS.ProcessEnv} [env]
 */
function pushRemote(root, args, env = process.env) {
	try {
		execGit(["push", "--quiet", REMOTE, ...args], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: PUSH_TIMEOUT_MS,
			env,
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

module.exports = {
	GATED_COMMIT_TIMEOUT_MS,
	LANDER_GIT_TIMEOUT_MS,
	isAncestor,
	parseRefusal,
	parseRefusalTail,
	pushRemote,
	readConflictedFiles,
	readRemoteHeads,
	remote,
	short,
	withThrowawayTree,
};
