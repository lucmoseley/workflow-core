/*
 * verdict-probe.js — whether a repo's declared test command gives the lander
 * a verdict on a red, proved once per command and canary rather than trusted
 * (#5294). A command that has proved it stands its commit-time run down
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
 * THE PROOF RECORD sits in the markers directory, keyed by a hash of the
 * command as it runs (an npm script's own text included) and the canary's
 * content, so a change to either makes it stale. A record that cannot be
 * read is stale, never fresh (fail closed, #5275). A failed probe is recorded
 * too, so the probe runs again only once the command or canary changes; the
 * lander marks a passed record failed on a red naming no failing file in its
 * tree (lib/local-tester.js), which gives the commit its gate back.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { now } = require("./clock.js");
const { readText } = require("./file-read.js");
const { markersDir } = require("./marker-root.js");
const { docPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");
const { parseFailingFiles } = require("./suite-output.js");

const PROBE_VAR = "WFC_VERDICT_PROBE";
const RECORD = "verdict-proof.json";
/* Where a person reads the contract. */
const CONTRACT_AT = `the \`commands.test\` row of §0's gate table in ${docPath("code-standards-base.md")}`;
/* A one-file run's ceiling: a hung probe fails rather than holding a commit.
 * A guess, never measured: this repo's canary run takes seconds, and 10 min
 * leaves a slow adopter runner's start-up room (#5294). */
const PROBE_TIMEOUT_MS = 600_000;
/* A guess, never measured: room for a runner's full output on one file
 * (#5294). */
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;

/* `npm test`, `npm t`, `npm run[-script] <name>` — the script whose text is
 * what actually runs. */
const NPM_SCRIPT = /^npm\s+(?:(?:test|t)|run(?:-script)?\s+(\S+))(?=\s|$)/;

/**
 * @typedef {{ code: number | null, out: string }} RunResult
 * @typedef {(line: string, opts: { cwd: string, env: NodeJS.ProcessEnv }) =>
 *   RunResult} Runner
 * @typedef {{ key: string, verdict: "pass" | "fail", clause?: string,
 *   at: string }} ProofRecord
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
	let script = "";
	try {
		const manifest = readAt(root, "package.json");
		const text = manifest && JSON.parse(manifest).scripts?.[npm[1] ?? "test"];
		if (typeof text === "string") script = text;
	} catch {
		/* Fails open (#5294): an unparseable package.json keys as no script,
		 * the probe then runs against it, and npm reports the fault there. */
	}
	return `${command}\n${script}`;
}

/**
 * The proof key, or null where the canary cannot be read.
 * @param {{ root: string, command: string, canary: string }} at
 * @returns {string | null}
 */
function proofKey({ root, command, canary }) {
	const body = readAt(root, canary);
	if (body === null) return null;
	return crypto
		.createHash("sha256")
		.update(resolvedCommand(command, root))
		.update("\0")
		.update(canary)
		.update("\0")
		.update(body)
		.digest("hex");
}

/** @param {string} markers */
const recordPath = (markers) => path.join(markers, RECORD);

/**
 * The record, or null where it is absent or does not read as one.
 * @param {string} markers
 * @returns {ProofRecord | null}
 */
function readProof(markers) {
	const read = readText(recordPath(markers));
	if (read.state !== "read") return null;
	try {
		const r = JSON.parse(read.data);
		if (typeof r?.key !== "string") return null;
		if (r.verdict !== "pass" && r.verdict !== "fail") return null;
		return r;
	} catch {
		return null;
	}
}

/**
 * @param {string} markers
 * @param {Omit<ProofRecord, "at">} record
 */
function writeProof(markers, record) {
	fs.writeFileSync(
		recordPath(markers),
		`${JSON.stringify({ ...record, at: new Date(now()).toISOString() })}\n`,
	);
}

/**
 * @param {{ root: string, command: string | null, canary: string | null,
 *   markers?: string }} at
 * @returns {ProofState}
 */
function proofState({ root, command, canary, markers = markersDir() }) {
	if (command === null || canary === null) return { state: "none" };
	const key = proofKey({ root, command, canary });
	const record = readProof(markers);
	if (key === null || record === null || record.key !== key)
		return { state: "stale" };
	return record.verdict === "pass"
		? { state: "fresh" }
		: { state: "failed", clause: record.clause ?? "the probe failed" };
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
	const key = proofKey({ root, command, canary });
	if (key === null) {
		const clause = `the canary ${canary} cannot be read`;
		say(`verdict probe: ${clause}`);
		return { state: "failed", clause };
	}
	say(
		`verdict probe: running \`${command} ${canary}\` with and without ${PROBE_VAR}=1`,
	);
	const result = probe({ root, command, canary, run });
	writeProof(
		markers,
		result.ok
			? { key, verdict: "pass" }
			: { key, verdict: "fail", clause: result.clause },
	);
	return result.ok
		? { state: "fresh" }
		: { state: "failed", clause: result.clause };
}

/**
 * Marks a passed record failed: the lander's backstop, on a red that named no
 * failing file in its tree.
 * @param {string} reason
 * @param {string} [markers]
 * @returns {boolean} whether a passed record was there to mark
 */
function voidProof(reason, markers = markersDir()) {
	const record = readProof(markers);
	if (record === null || record.verdict !== "pass") return false;
	writeProof(markers, {
		key: record.key,
		verdict: "fail",
		clause: `the lander's run went red naming no failing file in its tree (${reason})`,
	});
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
	voidProof,
};
