const { isNpmRun, scriptOfNpmCommand } = require("./npm-options.js");
const { JS_TEST_FILE, PY_COLLECTED_TEST } = require("./test-kind.js");

/**
 * @typedef {"npm-vitest" | "npm-watch" | "npm-py" | "wrapper" | "other"} LaunchKind
 * @typedef {{ kind: LaunchKind, script: string, taken: number,
 *   queued: boolean }} Launch
 * @typedef {object} LaunchPorts
 * @property {() => string[]} runners
 * @property {(script: string) => boolean} isWrapperScript
 */

const afterSlash = (/** @type {string} */ w) => w.slice(w.lastIndexOf("/") + 1);

/**
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
 * @param {string} word
 * @param {string} next
 * @param {boolean} node
 * @returns {boolean | null}
 */
function flagRuns(word, next, node) {
	if (node && word === "--test") return true;
	if (!node && word === "-m" && (next === "pytest" || next === "unittest"))
		return true;
	return ["-c", "-e", "--eval", "-p"].includes(word) ? false : null;
}

/**
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

/**
 * @param {string[]} words
 */
function hasNamedTestFiles(words) {
	const a0 = afterSlash(words[0] ?? "");
	if (a0 === "pytest" || a0 === "py.test")
		return isNamedPytestRun(words.slice(1));
	if (a0 === "node" || a0 === "nodejs") {
		const at = words.indexOf("--test");
		const paths = words.slice(at + 1).filter((w) => !w.startsWith("-"));
		return (
			at > 0 && paths.length > 0 && paths.every((w) => JS_TEST_FILE.test(w))
		);
	}
	return isNamedPythonRun(words);
}

/**
 * @param {string[]} words
 */
function isNamedPythonRun(words) {
	for (let i = 1; i < words.length; i++) {
		const word = words[i] ?? "";
		if (word === "-m") {
			const argv = words.slice(i + 2);
			if (words[i + 1] === "unittest") return isNamedUnittestRun(argv);
			return words[i + 1] === "pytest" && isNamedPytestRun(argv);
		}
		if (word.startsWith("-")) continue;
		if (afterSlash(word) === "pytest")
			return isNamedPytestRun(words.slice(i + 1));
		return PY_COLLECTED_TEST.test(afterSlash(word));
	}
	return false;
}

/** @param {string[]} argv */
function isNamedPytestRun(argv) {
	const paths = pytestPathWords(argv);
	return (
		paths.length > 0 &&
		paths.every((w) => PY_COLLECTED_TEST.test(w.split("::")[0] ?? ""))
	);
}

const UNITTEST_VALUED_FLAGS = new Set(["-k", "--durations"]);
const UNITTEST_MODULE_SEGMENT = /^test_\w+$|^\w+_test$/;

/** @param {string[]} argv */
function isNamedUnittestRun(argv) {
	const targets = argv.filter(
		(w, i) =>
			!w.startsWith("-") && !UNITTEST_VALUED_FLAGS.has(argv[i - 1] ?? ""),
	);
	return targets.length > 0 && targets.every(isUnittestTarget);
}

/** @param {string} word */
function isUnittestTarget(word) {
	if (word.includes("/") || word.endsWith(".py"))
		return PY_COLLECTED_TEST.test(afterSlash(word));
	const segments = word.split(".");
	const end = segments.findIndex((seg) => /^[A-Z]/.test(seg));
	const module = end < 0 ? segments : segments.slice(0, end);
	return UNITTEST_MODULE_SEGMENT.test(module.at(-1) ?? "");
}

/** @type {Record<string, LaunchKind>} */
const SCRIPT_KINDS = {
	test: "npm-vitest",
	"test:changed": "npm-vitest",
	"test:watch": "npm-watch",
	"test:py": "npm-py",
};

/**
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
	if (w1.endsWith("/run-pytest.js"))
		return { kind: "npm-py", script: "", taken: 2, queued: false };
	return w1.endsWith("/run-vitest.js")
		? { kind: "wrapper", script: "", taken: 2, queued: false }
		: null;
}

/**
 * @param {string[]} words
 * @returns {{ script: string, taken: number } | null}
 */
function npmScriptOf(words) {
	if (afterSlash(words[0] ?? "") !== "npm") return null;
	const w1 = words[1] ?? "";
	if (isNpmRun(w1)) return words[2] ? { script: words[2], taken: 3 } : null;
	const script = w1 === "test:py" ? w1 : scriptOfNpmCommand(w1);
	return script ? { script, taken: 2 } : null;
}

/** @param {string[]} words @returns {Launch | null} */
function npmLaunch(words) {
	const run = npmScriptOf(words);
	const kind =
		run && Object.hasOwn(SCRIPT_KINDS, run.script)
			? SCRIPT_KINDS[run.script]
			: undefined;
	return run && kind ? { kind, ...run, queued: false } : null;
}

// lucmoseley/mantahostels#313 measured ~7% gain from `-n 2` on the 2-vCPU CI runner
const TEST_PY_WORKERS = 2;

const PYTEST_VALUED_FLAGS = new Set([
	"-c",
	"-k",
	"-m",
	"-n",
	"-o",
	"-p",
	"-r",
	"-W",
	"--basetemp",
	"--confcutdir",
	"--deselect",
	"--dist",
	"--durations",
	"--ignore",
	"--ignore-glob",
	"--junitxml",
	"--maxfail",
	"--maxprocesses",
	"--numprocesses",
	"--rootdir",
	"--tb",
]);

/** @param {string[]} argv */
function pytestPathWords(argv) {
	return argv.filter(
		(w, i) => !w.startsWith("-") && !PYTEST_VALUED_FLAGS.has(argv[i - 1] ?? ""),
	);
}

/** @param {string[]} argv */
function isWholePytestRun(argv) {
	const own = argv[0] === "--" ? argv.slice(1) : argv;
	if (own.length === 0) return false;
	return !isNamedPytestRun(own);
}

/** @param {string[]} words @param {LaunchPorts} ports */
function isQueuedLaunch(words, ports) {
	const rest = words[0] === "--" ? words.slice(1) : words;
	if (rest.length === 0) return false;
	const { unwrapArgv } = require("./shell-parse.js");
	return unwrapArgv(rest).some(
		({ words: inner }) => inner.length > 0 && isQueueable(inner, ports),
	);
}

/** @param {string[]} words @param {LaunchPorts} ports */
function isQueueable(words, ports) {
	const launch = suiteLaunchKind(words, ports);
	if (launch?.kind === "other") return !launch.queued;
	if (launch?.kind === "npm-py") return true;
	if (launch?.kind === "npm-vitest")
		return !ports.isWrapperScript(launch.script);
	return false;
}

/**
 * @param {Launch} launch
 * @param {string[]} words
 */
const isSnapshotLaunch = (launch, words) => {
	const { QUEUE_FLAG, isSnapshotArgv } = require("./launch-route.js");
	return (
		(launch.kind === "wrapper" || launch.kind === "npm-vitest") &&
		!words.includes(QUEUE_FLAG) &&
		isSnapshotArgv(words)
	);
};

/** @param {string | null} body */
const hasWrapperCall = (body) => !body || body.includes("run-vitest.js");

/**
 * @param {import("./file-read.js").FileRead<string>} got
 * @param {(fault: string) => void} say
 * @returns {Record<string, unknown> | null}
 */
function parsePackageScripts(got, say) {
	if (got.state === "absent") return null;
	if (got.state === "unreadable") {
		say("package.json unreadable");
		return null;
	}
	try {
		return JSON.parse(got.data)?.scripts ?? {};
	} catch {
		say("package.json is not JSON");
		return null;
	}
}

/**
 * @param {() => Pick<import("./guard-host-ports.js").TreePorts, "read">} tree
 * @param {(what: string) => void} log
 * @returns {LaunchPorts["isWrapperScript"]}
 */
function buildIsWrapperScript(tree, log) {
	/** @type {Record<string, unknown> | null | undefined} */
	let scripts;
	return (script) => {
		if (scripts === undefined)
			scripts = parsePackageScripts(tree().read("package.json"), (fault) =>
				log(
					`${fault} — \`--queue\` offered without knowing whether \`${script}\` runs run-vitest.js`,
				),
			);
		if (!scripts) return true;
		const body = scripts[script];
		return hasWrapperCall(typeof body === "string" ? body : null);
	};
}

/**
 * @param {() => Pick<import("./guard-host-ports.js").TreePorts, "read">} tree
 * @param {(what: string) => void} log
 * @returns {(script: string) => boolean}
 */
function buildCallsWrapperScript(tree, log) {
	/** @type {Record<string, unknown> | null | undefined} */
	let scripts;
	return (script) => {
		if (scripts === undefined)
			scripts = parsePackageScripts(tree().read("package.json"), (fault) =>
				log(`${fault} — no npm script counted as running run-vitest.js`),
			);
		const body = scripts?.[script];
		return typeof body === "string" && body.includes("run-vitest.js");
	};
}

module.exports = {
	afterSlash,
	isOtherRunner,
	npmScriptOf,
	suiteLaunchKind,
	isQueueable,
	isWholePytestRun,
	hasNamedTestFiles,
	pytestPathWords,
	TEST_PY_WORKERS,
	buildCallsWrapperScript,
	buildIsWrapperScript,
	isSnapshotLaunch,
};
