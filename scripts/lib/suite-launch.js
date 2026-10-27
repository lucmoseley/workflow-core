/*
 * suite-launch.js — "does this unwrapped command launch a suite, and which
 * kind?" (#1528), for the suite guards and scripts/queue-run.js.
 *
 * THE KINDS:
 *   npm-vitest  `npm test`, `npm run test|test:changed`
 *   npm-watch   `npm run test:watch`
 *   npm-py      `npm test:py`, `npm run test:py`
 *   wrapper     `node <path>/run-vitest.js`
 *   other       a runner other than vitest — see `isOtherRunner` — run bare,
 *               or anything run through scripts/queue-run.js, `queued`
 *               telling which
 * `script` is the npm script's name, empty for the last two kinds, and
 * `taken` counts the words naming the launch, so the script's own argv
 * starts at word `taken`.
 */

const { PY_COLLECTED_TEST } = require("./test-kind.js");
const { unwrap } = require("./shell-words.js");

/**
 * @typedef {"npm-vitest" | "npm-watch" | "npm-py" | "wrapper" | "other"} LaunchKind
 * @typedef {{ kind: LaunchKind, script: string, taken: number,
 *   queued: boolean }} Launch
 * @typedef {object} LaunchPorts
 * @property {() => string[]} runners the host's declared `suiteRunners`
 * @property {(script: string) => boolean} isWrapperScript whether the
 *   host's npm script runs run-vitest.js, the one runner `--queue` belongs
 *   to; a package.json or script it cannot read answers yes
 */

const afterSlash = (/** @type {string} */ w) => w.slice(w.lastIndexOf("/") + 1);

/**
 * A SUITE RUN BY SOMETHING OTHER THAN VITEST (#330): `node --test`, `pytest`,
 * `python3 -m pytest|unittest` and a bare `python3 <x>.test.py`. Judged on
 * argv[0] and the flags BEFORE the script, where `node --test` puts its own: a
 * script taking a `--test` argument is no suite, and `node --test`'s per-file
 * children carry no `--test` of their own, so one run counts once.
 *
 * A HOST'S OWN RUNNER SCRIPTS COUNT TOO, declared under `suiteRunners` as
 * repo-relative paths, matched as a path suffix of the script word. Only the
 * host running this guard is read.
 *
 * A FLAG THAT TAKES A VALUE ENDS THE READ: its value is taken for the script,
 * so `node --import x --test` and `python3 -W ignore -m pytest` go uncounted.
 * @param {string[]} words
 * @param {() => string[]} runners
 */
function isOtherRunner(words, runners) {
	const a0 = afterSlash(words[0] ?? "");
	if (a0 === "pytest" || a0 === "py.test") return true;
	const node = a0 === "node" || a0 === "nodejs";
	const python = a0 === "python" || /^python[0-9]/.test(a0);
	if (!node && !python) return false;
	for (let i = 1; i < words.length; i++) {
		const word = words[i] ?? "";
		if (!word.startsWith("-")) return isSuiteScript(word, python, runners);
		const read = flagRuns(word, words[i + 1] ?? "", node);
		if (read !== null) return read;
	}
	return false;
}

/**
 * What a flag before the script says: a runner, no runner — a flag whose
 * value would be read for the script ends the read — or null to read on.
 * @param {string} word
 * @param {string} next
 * @param {boolean} node node's, else python's
 * @returns {boolean | null}
 */
function flagRuns(word, next, node) {
	if (node && word === "--test") return true;
	if (!node && word === "-m" && (next === "pytest" || next === "unittest"))
		return true;
	return ["-c", "-e", "--eval", "-p"].includes(word) ? false : null;
}

/**
 * Whether the script word is a suite: a Python test file, or a host's
 * declared runner.
 * @param {string} word
 * @param {boolean} python
 * @param {() => string[]} runners
 */
function isSuiteScript(word, python, runners) {
	const base = afterSlash(word);
	if (python && (base === "pytest" || PY_COLLECTED_TEST.test(base)))
		return true;
	return runners().some(
		(r) => r !== "" && (word === r || word.endsWith(`/${r}`)),
	);
}

/** @type {Record<string, LaunchKind>} */
const SCRIPT_KINDS = {
	test: "npm-vitest",
	"test:changed": "npm-vitest",
	"test:watch": "npm-watch",
	"test:py": "npm-py",
};

/**
 * The suite the words launch, wrappers already taken off by `unwrap` and
 * quoted spans read as typed; null where they launch none.
 * @param {string[]} words
 * @param {LaunchPorts} ports
 * @returns {Launch | null}
 */
function suiteLaunchKind(words, ports) {
	if (words.length === 0) return null;
	if (isOtherRunner(words, ports.runners))
		return { kind: "other", script: "", taken: 0, queued: false };
	const a0 = afterSlash(words[0] ?? "");
	if (a0 === "node") return nodeLaunch(words, ports);
	return a0 === "npm" ? npmLaunch(words) : null;
}

/**
 * `node <path>/run-vitest.js`, or a launch through scripts/queue-run.js.
 * @param {string[]} words
 * @param {LaunchPorts} ports
 * @returns {Launch | null}
 */
function nodeLaunch(words, ports) {
	const w1 = words[1] ?? "";
	if (w1 === "queue-run.js" || w1.endsWith("/queue-run.js"))
		return isQueuedLaunch(words.slice(2), ports)
			? { kind: "other", script: "", taken: 0, queued: true }
			: null;
	return w1.endsWith("/run-vitest.js")
		? { kind: "wrapper", script: "", taken: 2, queued: false }
		: null;
}

/**
 * `npm test`, `npm test:py`, or `npm run` one of the suite scripts.
 * @param {string[]} words
 * @returns {Launch | null}
 */
function npmLaunch(words) {
	const w1 = words[1] ?? "";
	const bare = w1 === "test" || w1 === "test:py";
	if (!bare && w1 !== "run") return null;
	const script = bare ? w1 : (words[2] ?? "");
	const kind = Object.hasOwn(SCRIPT_KINDS, script)
		? SCRIPT_KINDS[script]
		: undefined;
	return kind ? { kind, script, taken: bare ? 2 : 3, queued: false } : null;
}

/**
 * Whether the words after `node <path>/queue-run.js` are a launch it takes
 * (#1776). Its `--` is optional, and a wrapper behind it is taken off, as
 * queue-run.js reads the command. Any path ending `queue-run.js` is taken for
 * the core's, so a host script of that name passes as queued.
 * @param {string[]} words
 * @param {LaunchPorts} ports
 */
function isQueuedLaunch(words, ports) {
	const rest = words[0] === "--" ? words.slice(1) : words;
	if (rest.length === 0) return false;
	const inner = unwrap(rest, []).words;
	return inner.length > 0 && isQueueable(inner, ports);
}

/**
 * Whether scripts/queue-run.js takes the launch (#1776): an `other` runner not
 * already queued, or an npm `test`/`test:changed` whose script does not run
 * run-vitest.js.
 * @param {string[]} words
 * @param {LaunchPorts} ports
 */
function isQueueable(words, ports) {
	const launch = suiteLaunchKind(words, ports);
	if (launch?.kind === "other") return !launch.queued;
	if (launch?.kind === "npm-vitest")
		return !ports.isWrapperScript(launch.script);
	return false;
}

/**
 * Whether an npm script body runs run-vitest.js; an empty or absent one reads
 * as yes.
 * @param {string | null} body
 */
const hasWrapperCall = (body) => !body || body.includes("run-vitest.js");

module.exports = {
	afterSlash,
	isOtherRunner,
	suiteLaunchKind,
	isQueueable,
	hasWrapperCall,
};
