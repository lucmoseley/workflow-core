/*
 * verdict-probe.js — whether a repo's declared test command gives the lander
 * a verdict on a red, proved once per command, runner and canary rather than
 * trusted (workflow-core#5294). A command that has proved it stands its commit-time run down
 * (lib/test-gate.js): the lander's run before `main` moves is then the gate.
 *
 * THE VERDICT CONTRACT, written for a person at the `commands.test` row of the
 * code-standards base's gate table: the command exits 0 on green and non-zero
 * on red; on red it prints each failing test file on its own line as
 * `FAIL <path>` or `FAILED <path>::<test>` / `ERROR <path>`, the path from the
 * repo root; given file paths as arguments, it runs those files alone.
 *
 * THE PROBE is two one-file runs of `<command> <canary>`, the canary being
 * `commands.testCanary`: a test file that passes on a normal run and fails
 * only under WFC_VERDICT_PROBE=1. Under the variable the run must exit
 * non-zero, name the canary on a failing-file line and name no other file;
 * without it, it must exit 0. A failing probe names the clause it broke.
 *
 * THE PROOF RECORD sits in the markers directory, one verdict per key: a hash
 * of the command as it runs (an npm script's own text included), the runner
 * it resolves to and the canary's content, so a change to any of them makes
 * it stale. The runner is every file a word of the command names, in the
 * working copy or else the core (an adopter's `resolve-core.js` runs a core
 * script), and each runner config at its root with the files it names, with
 * everything each one's run reaches (lib/code-edges.js) (workflow-core#5327). Keys are kept side by side, because the record is the main
 * checkout's and worktrees at different bases hold different runners. A
 * record that cannot be read is stale, never fresh (fail closed, workflow-core#5275). A
 * failed probe is recorded too, so it runs again only once its key changes;
 * the lander marks every passed verdict failed on a red naming no failing
 * file in its tree (lib/local-tester.js), which gives the commit its gate
 * back.
 */

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
/* Where a person reads the contract. */
const CONTRACT_AT = `the \`commands.test\` row of §0's gate table in ${docPath("code-standards-base.md")}`;
/* A one-file run's ceiling: a hung probe fails rather than holding a commit.
 * A guess, never measured: this repo's canary run takes seconds, and 10 min
 * leaves a slow adopter runner's start-up room (workflow-core#5294). */
const PROBE_TIMEOUT_MS = 600_000;
/* A guess, never measured: room for a runner's full output on one file
 * (workflow-core#5294). */
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;
/* How many keys the record keeps, most recent first. A guess, never
 * measured: room for each worktree's base at once (workflow-core#5327). */
const KEPT_KEYS = 16;

/* `npm test`, `npm t`, `npm run[-script] <name>` — the script whose text is
 * what actually runs. */
const NPM_SCRIPT = /^npm\s+(?:(?:test|t)|run(?:-script)?\s+(\S+))(?=\s|$)/;

/**
 * @typedef {{ code: number | null, out: string }} RunResult
 * @typedef {(line: string, opts: { cwd: string, env: NodeJS.ProcessEnv }) =>
 *   RunResult} Runner
 * @typedef {{ verdict: "pass" | "fail", clause?: string, at: string }} Verdict
 * @typedef {Record<string, Verdict>} ProofRecord verdicts by key
 * @typedef {{ state: "fresh" } | { state: "stale" } |
 *   { state: "failed", clause: string } | { state: "none" }} ProofState
 */

/**
 * `rel` in the working copy, or null where it is absent or unreadable.
 * @param {string} root
 * @param {string} rel
 * @returns {string | null}
 */
function readAt(root, rel) {
	const read = readText(path.join(root, rel));
	return read.state === "read" ? read.data : null;
}

/**
 * The command as it runs: its own text, and an npm script's text beside it.
 * @param {string} command
 * @param {string} root
 */
function resolvedCommand(command, root) {
	const npm = NPM_SCRIPT.exec(command.trim());
	if (!npm) return command;
	// Fails open (workflow-core#5294): an unparseable package.json keys as no script, the
	// probe then runs against it, and npm reports the fault there.
	const script = orFallback(() => {
		const manifest = readAt(root, "package.json");
		const text = manifest && JSON.parse(manifest).scripts?.[npm[1] ?? "test"];
		return typeof text === "string" ? text : "";
	}, "");
	return `${command}\n${script}`;
}

/* Config files a test runner reads by name, not through a load the walk
 * follows. */
const RUNNER_CONFIGS = [
	"vitest.config.ts",
	"vitest.config.mts",
	"vitest.config.js",
	"vitest.config.mjs",
	"pytest.ini",
];

/* A quoted string, such as a config's `"./scripts/vitest-pass-reporter.ts"`. */
const QUOTED = /["'`]([^"'`\s]+)["'`]/g;

/**
 * Each word and quoted string of `text`, the candidates for a path.
 * @param {string} text
 * @returns {string[]}
 */
function pathWords(text) {
	const words = text.split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ""));
	for (const m of text.matchAll(QUOTED)) words.push(m[1] ?? "");
	return words.filter(
		(w) => w !== "" && !w.startsWith("-") && !w.includes("="),
	);
}

/**
 * Where the runner a command resolves to starts: each file a word names, in
 * the working copy or else the core, then each base's runner configs and the
 * files they name.
 * @param {string} resolved the command as it runs
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
 * A digest of what the runner holds: each start and each file its run
 * reaches, with its content. A gap in the walk keys as its fault, and is
 * returned for the probe to print.
 * @param {string} resolved the command as it runs
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
 * The proof key and the runner walk's faults, or null where the canary
 * cannot be read.
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

/**
 * The record's verdicts; none where it is absent or does not read as one,
 * and none for an entry that is no verdict.
 * @param {string} markers
 * @returns {ProofRecord}
 */
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
	/* Renamed into place, so a concurrent reader never parses half a record.
	 * Residual: two writers' read-modify-write can still race in a window of
	 * milliseconds, at worst losing a lander's void, so commits skip their run
	 * until its next nameless red; the lander still gates main. */
	writeFileAtomic(
		recordPath(markers),
		`${JSON.stringify(Object.fromEntries(kept))}\n`,
	);
}

/**
 * Records `verdict` under `key`, beside the other keys' verdicts.
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
 * The two runs, and the clause the command broke where it broke one.
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
 * Probes where the record is stale and a canary is declared, recording the
 * result; returns the state after.
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

/**
 * Marks every passed verdict failed: the lander's backstop, on a red that
 * named no failing file in its tree. The lander's merged tree holds a key no
 * worktree does, so every worktree reprobes after it (workflow-core#5327).
 * @param {string} reason
 * @param {string} [markers]
 * @returns {boolean} whether a passed verdict was there to mark
 */
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

/**
 * Why a proof stands no gate down.
 * @param {ProofState} state
 */
function buildNoProofReason(state) {
	if (state.state === "none")
		return "no canary declared (`commands.testCanary`)";
	if (state.state === "failed")
		return `the verdict probe failed: ${state.clause}`;
	return "no fresh verdict proof";
}

/**
 * The line saying why the commit gate stays, where a test command is declared.
 * @param {ProofState} state
 */
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
