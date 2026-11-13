#!/usr/bin/env node
/*
 * check-harness-canary.js — go red when a Claude Code update brings a
 * description-less plugin skill back into the start listing, or stops the
 * Skill tool loading it (workflow-core#2037).
 *
 * Usage:  node scripts/check-harness-canary.js [--notify | --probe] [--json]
 *
 * WHAT IT GUARDS. A workflow-core skill shipped with no `description` costs
 * no adopter start a listing line and still loads by name (workflow-core#1958, workflow-core#2036).
 * That rests on undocumented behaviour, so a harness update could bring
 * the listing cost back, or break every such skill.
 *
 * THE PROBE (`--probe`) builds a throwaway plugin holding two skills, `bare`
 * with no description and `control` with one, and runs one `claude -p` haiku
 * turn against it from an empty scratch directory. It reads the session
 * transcript (workflow-core#1958's method): the `skill_listing` attachment is the listing
 * the model saw, and the Skill tool's body row is what the tool loaded.
 *   green     `control` listed, `bare` absent, `bare`'s body loaded
 *   red       `bare` listed, or the Skill call for it loaded no body
 *   unprobed  the probe failed for its own reasons: no listing read,
 *             `control` absent from it, the model never called the tool,
 *             or its auth would not bill the subscription (lib/launch-auth.js)
 * Only green records the version, as `passed`. A red lasts until a later
 * version passes: the probe tests the harness, not the shipped skills.
 *
 * AT SESSION START (`--notify`) it spends ~20 ms on `claude --version` and
 * prints only a red verdict for the installed version, at every start. A
 * version neither passed nor probed launches the probe DETACHED and prints
 * nothing, so the next start reports it. A lock file keeps concurrent starts
 * to one probe, and an unprobed verdict waits RETRY_MS before the next try.
 *
 * A HAND RUN reads the recorded verdict and spends nothing. Red is FAIL.
 * Unprobed, or a version not yet probed, is WARN rather than SKIP, so `npm run
 * status` still shows a canary that is not guarding (workflow-core#2037).
 *
 * IMPLICIT:  at every session start, reads the installed Claude Code version; where no probe has passed on it, launches, as no session's process in a systemd user scope of its own stopped after 45 minutes where a user manager answers (workflow-core#4706), one detached `claude -p` haiku turn against a throwaway plugin, and prints a red verdict at each start until a version passes, or a fault reading its state file at the start that finds it (workflow-core#3436).
 * JUSTIFIED: fail-safe — nothing else notices a harness update restoring the listing cost or breaking every description-less skill, and an unreadable version or a failed probe is silence at start, never a block.
 * DEFEAT:    none at the hook; a later version that passes ends it, and `--probe` re-runs the probe by hand for a red suspected false.
 * TREE:      host — probes the harness from a scratch directory
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { CHILD_ERROR_CHARS } = require("./lib/child-buffer.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { parseJsonl } = require("./lib/jsonl.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { readClaudeVersion } = require("./lib/claude-version.js");
const { configDir } = require("./lib/config-dir.js");
const { pidLock } = require("./lib/pid-lock.js");
const { scriptPath } = require("./lib/script-path.js");
const { spawnOutliving } = require("./lib/user-scope.js");

const PLUGIN = "wfccanary";
const BARE = `${PLUGIN}:bare`;
const CONTROL = `${PLUGIN}:control`;

/** One haiku turn took 16.6 s on 2.1.302; the rest is margin. */
const PROBE_TIMEOUT_MS = 180_000;

/** Between tries of a probe that could not run. A guess, not a measurement. */
const RETRY_MS = 6 * 3_600_000;

const statePath = () => path.join(configDir(), "wfc-harness-canary.json");
const lockPath = () => path.join(configDir(), "wfc-harness-canary.lock");
const rerun = () => `node ${scriptPath("check-harness-canary.js")} --probe`;

/**
 * @template {{ version: string }} T
 * @param {T | undefined} record
 * @param {string} version
 */
const forVersion = (record, version) =>
	record?.version === version ? record : undefined;

/**
 * @typedef {{ version: string, verdict: "green" | "red" | "unprobed",
 *   reasons: string[], at: string }} Verdict
 * @typedef {{ passed?: string, last?: Verdict }} State
 */

/**
 * The state file, and why it was unreadable where it was. A missing file is
 * no fault: nothing has been probed yet. Fail-open (workflow-core#2037): an unreadable one
 * reads as unprobed, so the next probe rewrites it, and the run that loads it
 * prints the fault (workflow-core#3436).
 * @returns {{ state: State, fault?: string }}
 */
function loadState() {
	let text;
	try {
		text = fs.readFileSync(statePath(), "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return { state: {} };
		return { state: {}, fault: caught(e).message };
	}
	try {
		const state = JSON.parse(text);
		if (state && typeof state === "object" && !Array.isArray(state))
			return { state };
		return { state: {}, fault: "it holds no JSON object" };
	} catch (e) {
		return { state: {}, fault: caught(e).message };
	}
}

/** The state alone: `run` has already printed any fault before this reads. */
const readState = () => loadState().state;

/** @param {Partial<State>} change */
function writeState(change) {
	const state = { ...readState(), ...change };
	if (change.last?.verdict === "green") state.passed = change.last.version;
	writeFileAtomic(statePath(), `${JSON.stringify(state, null, "\t")}\n`, {
		mkdir: true,
	});
}

/**
 * The throwaway plugin, under `root`.
 * @param {string} root
 * @param {string} nonce
 */
function writePlugin(root, nonce) {
	const plugin = path.join(root, "plugin");
	/** @type {[string, string][]} */
	const files = [
		[".claude-plugin/plugin.json", JSON.stringify({ name: PLUGIN })],
		[
			"skills/bare/SKILL.md",
			`---\nname: bare\n---\n\nReply with exactly ${nonce} and nothing else.\n`,
		],
		[
			"skills/control/SKILL.md",
			"---\nname: control\ndescription: Canary control skill. Never use it.\n---\n\nReply with CONTROL.\n",
		],
	];
	for (const [rel, body] of files) {
		fs.mkdirSync(path.dirname(path.join(plugin, rel)), { recursive: true });
		fs.writeFileSync(path.join(plugin, rel), body);
	}
	return plugin;
}

/**
 * The transcript `claude -p --session-id <sid>` wrote, found by name, since
 * its project directory is a slug of the scratch cwd's real path.
 * @param {string} sid
 */
function transcriptOf(sid) {
	const projects = path.join(configDir(), "projects");
	if (!fs.existsSync(projects)) return null;
	for (const d of fs.readdirSync(projects)) {
		const at = path.join(projects, d, `${sid}.jsonl`);
		if (fs.existsSync(at)) return at;
	}
	return null;
}

/**
 * @typedef {{ type?: string, name?: string, id?: string, input?: { skill?: string } }} ContentBlock
 * @typedef {{ type?: string, isMeta?: boolean, sourceToolUseID?: string,
 *   attachment?: { type?: string, names?: unknown[] },
 *   message?: { content?: unknown } }} TranscriptRow
 */

/**
 * What the transcript says: the names listed at start (null where no listing
 * was read), whether the model called the Skill tool on `bare`, and the body
 * that call loaded ("" where none). The first listing is the start's; a later
 * one is a delta.
 * @param {string} text
 */
function parseTranscript(text) {
	const rows = /** @type {TranscriptRow[]} */ (parseJsonl(text).rows);
	const listing = rows.find((r) => r?.attachment?.type === "skill_listing");
	const names = listing ? (listing.attachment?.names ?? []).map(String) : null;
	const call = rows
		.flatMap((r) =>
			r?.type === "assistant" && Array.isArray(r.message?.content)
				? /** @type {ContentBlock[]} */ (r.message.content)
				: [],
		)
		.find(
			(b) =>
				b?.type === "tool_use" &&
				b.name === "Skill" &&
				[BARE, "bare"].includes(b.input?.skill ?? ""),
		);
	const body = call
		? rows
				.filter((r) => r?.isMeta && r.sourceToolUseID === call.id)
				.map((r) => JSON.stringify(r.message?.content ?? ""))
				.join("")
		: "";
	return { names, called: Boolean(call), body };
}

/**
 * The verdict a parsed transcript gives, with its reasons.
 * @param {ReturnType<typeof parseTranscript> | null} t
 * @param {string} nonce
 * @returns {[Verdict["verdict"], string[]]}
 */
function judge(t, nonce) {
	if (!t?.names)
		return ["unprobed", ["the session transcript held no skill listing"]];
	if (!t.names.includes(CONTROL))
		return [
			"unprobed",
			[
				`the control skill ${CONTROL}, which has a description, was not listed either, so the listing read is wrong`,
			],
		];
	if (!(t.called || t.names.includes(BARE)))
		return ["unprobed", [`the model never called the Skill tool on ${BARE}`]];
	const reasons = [];
	if (t.names.includes(BARE))
		reasons.push(`${BARE}, which has no description, is in the start listing`);
	if (t.called && !t.body.includes(nonce))
		reasons.push(`the Skill tool loaded no body for ${BARE}`);
	return [reasons.length > 0 ? "red" : "green", reasons];
}

/**
 * One `claude -p` turn against the throwaway plugin.
 * @param {string} version
 * @returns {Verdict}
 */
function probe(version) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-harness-canary-"));
	const sid = crypto.randomUUID();
	const nonce = `CANARY-${crypto.randomBytes(4).toString("hex")}`;
	/** @param {Verdict["verdict"]} verdict @param {string[]} reasons */
	const verdictOf = (verdict, reasons) => ({
		version,
		verdict,
		reasons,
		at: new Date().toISOString(),
	});
	let transcript = null;
	try {
		const plugin = writePlugin(root, nonce);
		const cwd = path.join(root, "project");
		fs.mkdirSync(cwd);
		const refusal = launchAuthRefusal({
			bin: claudeBin(),
			env: process.env,
			cwd,
		});
		if (refusal) return verdictOf("unprobed", [refusal]);
		const r = spawnSync(
			claudeBin(),
			[
				"-p",
				"--model",
				"haiku",
				"--plugin-dir",
				plugin,
				"--session-id",
				sid,
				`Call the Skill tool with skill "${BARE}" and do what it says.`,
			],
			{ cwd, encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
		);
		transcript = transcriptOf(sid);
		if (r.error) return verdictOf("unprobed", [r.error.message]);
		if (r.status !== 0)
			return verdictOf("unprobed", [
				`\`claude -p\` exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, CHILD_ERROR_CHARS)}`,
			]);
		const t = transcript
			? parseTranscript(fs.readFileSync(transcript, "utf8"))
			: null;
		const [verdict, reasons] = judge(t, nonce);
		return verdictOf(verdict, reasons);
	} catch (e) {
		return verdictOf("unprobed", [caught(e).message]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		/* The project dir is a slug of the scratch cwd, so it is this probe's
		 * alone where it carries the scratch dir's unique name. */
		if (transcript) {
			const slug = path.dirname(transcript);
			const ours = path.basename(slug).includes(path.basename(root));
			fs.rmSync(ours ? slug : transcript, { recursive: true, force: true });
		}
	}
}

/**
 * Probe under the lock and record the verdict; null where a probe holds it.
 * @param {string} version
 */
function probeAndRecord(version) {
	fs.mkdirSync(configDir(), { recursive: true });
	/* Held while the probe lives; `PROBE_TIMEOUT_MS` ends a hung one (workflow-core#4016). */
	const lock = pidLock(lockPath(), path.basename(__filename));
	if (!lock.acquire()) return null;
	try {
		const last = probe(version);
		writeState({ last });
		return last;
	} finally {
		lock.release();
	}
}

/** Launch the probe through the outliving launch (workflow-core#4706): in a session of
 * its own, so a harness killing the hook's group spares it, and outside this
 * session's scope, so the session's end does too. */
function detachProbe() {
	try {
		spawnOutliving(process.execPath, [__filename, "--probe"], {
			stdio: "ignore",
		}).unref();
	} catch {
		/* The next session start retries (workflow-core#2037). */
	}
}

/** @param {Verdict} last */
const buildRedText = (last) =>
	`HARNESS-CANARY — Claude Code ${last.version} changed how a description-less plugin skill behaves (workflow-core#2037):\n` +
	last.reasons.map((r) => `  - ${r}\n`).join("") +
	"  Workflow-core's description-less skills rest on that behaviour (workflow-core#1958): restore their descriptions, or rule otherwise.\n" +
	"  This repeats at each start until a later version passes. Suspect a false red? Re-probe:\n" +
	`    ${rerun()}\n`;

/**
 * The session-start run: a red verdict for this version, else silence, after
 * launching the probe where it is owed.
 * @param {import("./lib/check").Ctx} ctx
 * @param {State} state
 * @param {string} version
 * @param {string} okLine
 */
function atStart(ctx, state, version, okLine) {
	const seen = forVersion(state.last, version);
	if (seen?.verdict === "red") {
		reportRed(ctx, seen);
		return {};
	}
	const retrying =
		seen?.verdict === "unprobed" && Date.now() - Date.parse(seen.at) < RETRY_MS;
	if (state.passed !== version && !retrying) detachProbe();
	if (state.passed === version) return { okLine };
	return { okLine: `probing Claude Code ${version} in the background.` };
}

/**
 * A red listing verdict: a failure, with its text.
 * @param {import("./lib/check").Ctx} ctx
 * @param {Verdict} last
 */
function reportRed(ctx, last) {
	ctx.fail("HARNESS-CANARY", last.reasons.join("; "), last);
	ctx.say(buildRedText(last));
}

/**
 * A warning, printed as well as recorded.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} tag
 * @param {string} msg
 * @param {object} [data]
 */
function warnSaying(ctx, tag, msg, data) {
	ctx.warn(tag, msg, data);
	ctx.say(`${tag} — ${msg}`);
}

/**
 * The warning on a probe that has not run on `version`, or could not.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} version
 * @param {Verdict | undefined} last
 */
function warnUnprobed(ctx, version, last) {
	const [tag, msg] =
		last?.verdict === "unprobed"
			? [
					"UNPROBED",
					`the probe could not run on Claude Code ${version}: ${last.reasons.join("; ")}. Re-run: \`${rerun()}\`.`,
				]
			: [
					"NOT-PROBED",
					`the probe has not run on Claude Code ${version}; the next session start launches it, or run \`${rerun()}\`.`,
				];
	warnSaying(ctx, tag, msg, last);
}

/**
 * A hand run's finding on a version that has not passed, or whose re-probe
 * went red.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} version
 * @param {Verdict | undefined} last
 */
function report(ctx, version, last) {
	if (last?.verdict === "red") reportRed(ctx, last);
	else warnUnprobed(ctx, version, last);
}

runCheck({
	name: "harness-canary",
	usage: "node check-harness-canary.js [--notify | --probe] [--json]",
	flags: ["--probe"],
	run(ctx) {
		const version = readClaudeVersion(claudeBin());
		if (!version)
			return ctx.skip(
				`\`${claudeBin()} --version\` gave no version, so nothing was probed.`,
			);

		const { state, fault } = loadState();
		if (fault)
			warnSaying(
				ctx,
				"STATE-CORRUPT",
				`${statePath()} is unreadable (${fault}), so every verdict reads as unprobed until a probe rewrites it: the next session start launches one, or run \`${rerun()}\`.`,
			);
		const seen = forVersion(state.last, version);
		const okLine = `a description-less plugin skill is unlisted and loads on Claude Code ${version}.`;
		const probing = ctx.has("--probe");

		if (ctx.notify && !probing) return atStart(ctx, state, version, okLine);

		let last = seen;
		if (probing) {
			last = probeAndRecord(version) ?? undefined;
			if (last === undefined)
				return ctx.skip(
					`another probe holds ${lockPath()}; its verdict lands in ${statePath()}.`,
				);
		}
		const fresh = readState();
		if (
			last?.verdict === "green" ||
			(fresh.passed === version && last?.verdict !== "red")
		)
			return { okLine };
		report(ctx, version, last);
		return { okLine, data: { version, passed: fresh.passed ?? null } };
	},
});
