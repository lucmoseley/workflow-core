const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught, orFallback } = require("./caught.js");
const { now } = require("./clock.js");
const { readRunReach } = require("./code-edges.js");
const { isFile } = require("./file-reach.js");
const { readText } = require("./file-read.js");
const { markersDir } = require("./marker-root.js");
const { coreRoot, docPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");
const { parseFailingFiles } = require("./suite-output.js");

const PROBE_VAR = "WFC_VERDICT_PROBE";
const RECORD = "verdict-proof.json";
const CONTRACT_AT = `the \`commands.test\` row of §0's gate table in ${docPath("code-standards-base.md")}`;
// workflow-core#5294 guess
const PROBE_TIMEOUT_MS = 600_000;
// workflow-core#5294 guess
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;
// workflow-core#5327 guess
const KEPT_KEYS = 16;

const NPM_SCRIPT = /^npm\s+(?:(?:test|t)|run(?:-script)?\s+(\S+))(?=\s|$)/;

/**
 * @typedef {{ code: number | null, out: string }} RunResult
 * @typedef {(line: string, opts: { cwd: string, env: NodeJS.ProcessEnv }) =>
 *   RunResult} Runner
 * @typedef {{ verdict: "pass" | "fail", clause?: string, at: string }} Verdict
 * @typedef {Record<string, Verdict>} ProofRecord
 * @typedef {{ state: "fresh" } | { state: "stale" } |
 *   { state: "failed", clause: string } | { state: "none" }} ProofState
 */

/** @param {string} root @param {string} rel @returns {string | null} */
function readAt(root, rel) {
	const read = readText(path.join(root, rel));
	return read.state === "read" ? read.data : null;
}

/** @param {string} command @param {string} root */
function resolvedCommand(command, root) {
	const npm = NPM_SCRIPT.exec(command.trim());
	if (!npm) return command;
	const script = orFallback(() => {
		const manifest = readAt(root, "package.json");
		const text = manifest && JSON.parse(manifest).scripts?.[npm[1] ?? "test"];
		return typeof text === "string" ? text : "";
	}, "");
	return `${command}\n${script}`;
}

const RUNNER_CONFIGS = [
	"vitest.config.ts",
	"vitest.config.mts",
	"vitest.config.js",
	"vitest.config.mjs",
	"pytest.ini",
];

const QUOTED = /["'`]([^"'`\s]+)["'`]/g;

/** @param {string} text @returns {string[]} */
function pathWords(text) {
	const words = text.split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ""));
	for (const m of text.matchAll(QUOTED)) words.push(m[1] ?? "");
	return words.filter(
		(w) => w !== "" && !w.startsWith("-") && !w.includes("="),
	);
}

/**
 * @param {string} resolved
 * @param {string} root
 * @returns {{ base: string, rel: string }[]}
 */
function runnerStarts(resolved, root) {
	/** @type {Map<string, { base: string, rel: string }>} */
	const found = new Map();
	/** @param {string[]} bases @param {string} word */
	const add = (bases, word) => {
		const rel = path.normalize(word);
		if (path.isAbsolute(rel)) return;
		const base = bases.find((b) => isFile(path.join(b, rel)));
		if (base !== undefined) found.set(`${base}\0${rel}`, { base, rel });
	};
	for (const word of pathWords(resolved)) add([root, coreRoot()], word);
	for (const base of new Set([...found.values()].map((s) => s.base)))
		for (const config of RUNNER_CONFIGS) {
			const text = readAt(base, config);
			if (text === null) continue;
			add([base], config);
			for (const word of pathWords(text)) add([base], word);
		}
	return [...found.values()];
}

/**
 * @param {string} resolved
 * @param {string} root
 * @returns {{ digest: string, faults: string[] }}
 */
function runnerDigest(resolved, root) {
	const hash = crypto.createHash("sha256");
	/** @type {string[]} */
	const faults = [];
	/** @type {Map<string, (start: string, fault?: (file: string, msg: string) => void) => import("./code-edges.js").RunReach>} */
	const walkers = new Map();
	for (const { base, rel } of runnerStarts(resolved, root)) {
		let walk = walkers.get(base);
		if (walk === undefined) {
			walk = readRunReach(base);
			walkers.set(base, walk);
		}
		let reach;
		try {
			reach = walk(rel, (file, msg) => faults.push(`${file} ${msg}`));
		} catch (err) {
			faults.push(`${rel} goes unwalked: ${caught(err).message}`);
			continue;
		}
		for (const { file } of reach.missing) faults.push(`${file} is missing`);
		for (const file of [...reach.unread, ...reach.unknown])
			faults.push(`${file} holds a load the walk cannot read`);
		for (const file of reach.files) {
			const body = readAt(base, file);
			hash.update(
				`${base}\0${file}\0${body === null ? "\0unreadable" : body}\0`,
			);
		}
	}
	for (const fault of faults) hash.update(`fault\0${fault}\0`);
	return { digest: hash.digest("hex"), faults };
}

/**
 * @param {{ root: string, command: string, canary: string }} at
 * @returns {{ key: string, faults: string[] } | null}
 */
function proofKey({ root, command, canary }) {
	const body = readAt(root, canary);
	if (body === null) return null;
	const resolved = resolvedCommand(command, root);
	const runner = runnerDigest(resolved, root);
	const key = crypto
		.createHash("sha256")
		.update(resolved)
		.update("\0")
		.update(runner.digest)
		.update("\0")
		.update(canary)
		.update("\0")
		.update(body)
		.digest("hex");
	return { key, faults: runner.faults };
}

/** @param {string} [markers] */
const recordPath = (markers = markersDir()) => path.join(markers, RECORD);

/** @param {string} markers @returns {ProofRecord} */
function readProof(markers) {
	const read = readText(recordPath(markers));
	if (read.state !== "read") return {};
	let parsed;
	try {
		parsed = JSON.parse(read.data);
	} catch {
		return {};
	}
	/** @type {ProofRecord} */
	const record = {};
	if (parsed === null || typeof parsed !== "object") return record;
	for (const [key, v] of Object.entries(parsed))
		if (v?.verdict === "pass" || v?.verdict === "fail") record[key] = v;
	return record;
}

/**
 * @param {string} markers
 * @param {ProofRecord} record
 */
function writeProof(markers, record) {
	const kept = Object.entries(record)
		.sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
		.slice(0, KEPT_KEYS);
	writeFileAtomic(
		recordPath(markers),
		`${JSON.stringify(Object.fromEntries(kept))}\n`,
	);
}

/**
 * @param {string} markers
 * @param {string} key
 * @param {Omit<Verdict, "at">} verdict
 */
function recordVerdict(markers, key, verdict) {
	writeProof(markers, {
		...readProof(markers),
		[key]: { ...verdict, at: new Date(now()).toISOString() },
	});
}

/**
 * @param {{ root: string, command: string | null, canary: string | null,
 *   markers?: string }} at
 * @returns {ProofState}
 */
function proofState({ root, command, canary, markers = markersDir() }) {
	if (command === null || canary === null) return { state: "none" };
	const key = proofKey({ root, command, canary })?.key;
	const verdict = key === undefined ? undefined : readProof(markers)[key];
	if (verdict === undefined) return { state: "stale" };
	return verdict.verdict === "pass"
		? { state: "fresh" }
		: { state: "failed", clause: verdict.clause ?? "the probe failed" };
}

/** @type {Runner} */
function shellRun(line, { cwd, env }) {
	const r = spawnSync("sh", ["-c", line], {
		cwd,
		env,
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
		maxBuffer: PROBE_MAX_BUFFER,
	});
	return {
		code: r.status,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${caught(r.error).message}` : ""}`,
	};
}

/**
 * @param {{ root: string, command: string, canary: string, run?: Runner,
 *   env?: NodeJS.ProcessEnv }} at
 * @returns {{ ok: true } | { ok: false, clause: string }}
 */
function probe({ root, command, canary, run = shellRun, env = process.env }) {
	const line = `${command} ${shellQuote(canary)}`;
	const red = run(line, { cwd: root, env: { ...env, [PROBE_VAR]: "1" } });
	if (red.code === 0)
		return {
			ok: false,
			clause: `it exits 0 on a red: \`${line}\` passed with ${PROBE_VAR}=1, where the canary fails`,
		};
	const named = parseFailingFiles(red.out);
	if (!named.includes(canary))
		return {
			ok: false,
			clause: `on a red it prints no \`FAIL <path>\`, \`FAILED <path>::<test>\` or \`ERROR <path>\` line naming the canary ${canary}`,
		};
	const others = named.filter((f) => f !== canary);
	if (others.length > 0)
		return {
			ok: false,
			clause: `given ${canary} alone it also named ${others.join(", ")}, so it does not run the files it is given alone`,
		};
	const { [PROBE_VAR]: _, ...plain } = env;
	const green = run(line, { cwd: root, env: plain });
	if (green.code !== 0)
		return {
			ok: false,
			clause: `\`${line}\` exits ${green.code ?? "on a signal"} without ${PROBE_VAR}, where the canary passes`,
		};
	return { ok: true };
}

/**
 * @param {{ root: string, command: string | null, canary: string | null,
 *   markers?: string, run?: Runner, say?: (line: string) => void }} at
 * @returns {ProofState}
 */
function ensureProof({
	root,
	command,
	canary,
	markers = markersDir(),
	run,
	say = () => undefined,
}) {
	const before = proofState({ root, command, canary, markers });
	if (before.state !== "stale" || command === null || canary === null)
		return before;
	const proof = proofKey({ root, command, canary });
	if (proof === null) {
		const clause = `the canary ${canary} cannot be read`;
		say(`verdict probe: ${clause}`);
		return { state: "failed", clause };
	}
	for (const fault of proof.faults)
		say(
			`verdict probe: the runner's walk cannot follow ${fault}, so its key holds the gap, not what lies past it (workflow-core#5327)`,
		);
	say(
		`verdict probe: running \`${command} ${canary}\` with and without ${PROBE_VAR}=1`,
	);
	const result = probe({ root, command, canary, run });
	recordVerdict(
		markers,
		proof.key,
		result.ok
			? { verdict: "pass" }
			: { verdict: "fail", clause: result.clause },
	);
	return result.ok
		? { state: "fresh" }
		: { state: "failed", clause: result.clause };
}

/** @param {string} reason @param {string} [markers] @returns {boolean} */
function voidProof(reason, markers = markersDir()) {
	const record = readProof(markers);
	const passed = Object.keys(record).filter(
		(k) => record[k]?.verdict === "pass",
	);
	if (passed.length === 0) return false;
	const clause = `the lander's run went red naming no failing file in its tree (${reason})`;
	for (const key of passed)
		record[key] = {
			verdict: "fail",
			clause,
			at: new Date(now()).toISOString(),
		};
	writeProof(markers, record);
	return true;
}

/** @param {ProofState} state */
function buildNoProofReason(state) {
	if (state.state === "none")
		return "no canary declared (`commands.testCanary`)";
	if (state.state === "failed")
		return `the verdict probe failed: ${state.clause}`;
	return "no fresh verdict proof";
}

/** @param {ProofState} state */
function buildStaysLine(state) {
	return `the commit-time gate run stays — ${buildNoProofReason(state)}. The verdict contract: ${CONTRACT_AT}.`;
}

module.exports = {
	CONTRACT_AT,
	buildNoProofReason,
	buildStaysLine,
	ensureProof,
	proofState,
	recordPath,
	voidProof,
};
