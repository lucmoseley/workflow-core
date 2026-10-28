#!/usr/bin/env node
/*
 * check-harness-canary.js — go red when a Claude Code update brings a
 * description-less plugin skill back into the start listing, or stops the
 * Skill tool loading it (#2037).
 *
 * Usage:  node scripts/check-harness-canary.js [--notify | --probe | --probe-agent-id] [--json]
 *
 * WHAT IT GUARDS. A workflow-core skill shipped with no `description` costs
 * no adopter start a listing line and still loads by name (#1958, #2036).
 * That rests on undocumented behaviour, so a harness update could bring
 * the listing cost back, or break every such skill.
 *
 * THE PROBE (`--probe`) builds a throwaway plugin holding two skills, `bare`
 * with no description and `control` with one, and runs one `claude -p` haiku
 * turn against it from an empty scratch directory. It reads the session
 * transcript (#1958's method): the `skill_listing` attachment is the listing
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
 * status` still shows a canary that is not guarding (#2037).
 *
 * THE AGENT_ID PROBE (`--probe-agent-id`, and part of `--probe`) runs in the
 * core's checkout alone, as #1837 is the core's ticket (#2819). It reads the
 * binary for `agent_id` on a subagent's `PreCompact` and `SessionStart`
 * payloads (lib/agent-id-probe.js). It edits no label (mantahostels#136).
 *
 * WFC_CANARY_CLAUDE replaces the `claude` binary; the tests stub the live
 * probe through it. Not WFC_CLAUDE_BIN: this machine points that at a wrapper
 * for `claude agents` (lib/oracle-cache.js), which a `-p` turn must not go
 * through.
 *
 * IMPLICIT:  at every session start, reads the installed Claude Code version; where no probe has passed on it, launches one detached `claude -p` haiku turn against a throwaway plugin, and prints a red verdict at each start until a version passes. In the core's checkout, also reads the binary once per version for `agent_id` on a subagent's compaction payloads, and on finding it comments once on #1837 and prints it at each start.
 * JUSTIFIED: fail-safe — nothing else notices a harness update restoring the listing cost or breaking every description-less skill, and an unreadable version or a failed probe is silence at start, never a block. The agent_id probe replaces #1837's hand re-check per release (#2819).
 * DEFEAT:    none at the hook; a later version that passes ends it, and `--probe` re-runs the probe by hand for a red suspected false; `--probe-agent-id` re-reads the binary for a fixed suspected false.
 */

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { runCheck } = require("./lib/check");
const { probeAgentId } = require("./lib/agent-id-probe.js");
const { caught } = require("./lib/caught.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { readClaudeVersion } = require("./lib/claude-version.js");
const { configDir } = require("./lib/config-dir.js");
const { isCoreRoot } = require("./lib/core-hooks.js");
const { hostRoot } = require("./lib/host-root.js");
const { scriptPath } = require("./lib/script-path.js");

const PLUGIN = "wfccanary";
const BARE = `${PLUGIN}:bare`;
const CONTROL = `${PLUGIN}:control`;

/** One haiku turn took 16.6 s on 2.1.302; the rest is margin. */
const PROBE_TIMEOUT_MS = 180_000;

/** A lock older than this belongs to a probe that died, and is taken over. */
const LOCK_STALE_MS = PROBE_TIMEOUT_MS + 60_000;

/** Between tries of a probe that could not run. A guess, not a measurement. */
const RETRY_MS = 6 * 3_600_000;

/** Of a failed `claude -p`'s output, enough to name the error in one line; a guess. */
const ERROR_CHARS = 200;

const claudeBin = () => process.env.WFC_CANARY_CLAUDE || "claude";
const statePath = () => path.join(configDir(), "wfc-harness-canary.json");
const lockPath = () => path.join(configDir(), "wfc-harness-canary.lock");
const rerun = (flag = "--probe") =>
	`node ${scriptPath("check-harness-canary.js")} ${flag}`;
const isInCore = () => isCoreRoot(hostRoot());

/**
 * @template {{ version: string }} T
 * @param {T | undefined} record
 * @param {string} version
 */
const forVersion = (record, version) =>
	record?.version === version ? record : undefined;

const GAP_ISSUE = 1837;

/**
 * @typedef {{ version: string, verdict: "green" | "red" | "unprobed",
 *   reasons: string[], at: string }} Verdict
 * @typedef {{ version: string, verdict: "fixed" | "not fixed" | "unprobed",
 *   reasons: string[], at: string, commented?: boolean }} AgentIdVerdict
 * @typedef {{ passed?: string, last?: Verdict, agentId?: AgentIdVerdict }} State
 */

/** @returns {State} */
function readState() {
	try {
		return JSON.parse(fs.readFileSync(statePath(), "utf8"));
	} catch {
		/* No state, or a corrupt one: the next probe rewrites it (#2037). */
		return {};
	}
}

/** @param {Partial<State>} change */
function writeState(change) {
	const state = { ...readState(), ...change };
	if (change.last?.verdict === "green") state.passed = change.last.version;
	writeFileAtomic(statePath(), `${JSON.stringify(state, null, "\t")}\n`, {
		mkdir: true,
	});
}

/**
 * Take the probe lock; false where a live probe holds it. Two starts that both
 * find a stale lock can each take it and run two probes, which write the same
 * verdict — accepted, as it needs a probe to have died mid-run first (#2037).
 */
function takeLock() {
	fs.mkdirSync(configDir(), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(lockPath(), new Date().toISOString(), { flag: "wx" });
			return true;
		} catch (e) {
			if (caught(e).code !== "EEXIST") throw e;
		}
		let age;
		try {
			age = Date.now() - fs.statSync(lockPath()).mtimeMs;
		} catch {
			/* The holder released it between the two calls: try again. */
			continue;
		}
		if (age < LOCK_STALE_MS) return false;
		fs.rmSync(lockPath(), { force: true });
	}
	return false;
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
 *   One JSONL record, read only through these optional fields.
 */

/**
 * What the transcript says: the names listed at start (null where no listing
 * was read), whether the model called the Skill tool on `bare`, and the body
 * that call loaded ("" where none). The first listing is the start's; a later
 * one is a delta.
 * @param {string} text
 */
function parseTranscript(text) {
	/** @type {TranscriptRow[]} */
	const rows = [];
	for (const line of text.split("\n")) {
		try {
			rows.push(JSON.parse(line));
		} catch {
			/* A blank or torn line carries nothing the verdict reads. */
		}
	}
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
				`\`claude -p\` exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, ERROR_CHARS)}`,
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
 * Comment on #1837 that `v` found the gap closed; true once posted. The core's
 * own tracker, named, since a detached probe's cwd is no promise.
 * @param {AgentIdVerdict} v
 */
function commentFixed(v) {
	const { gh } = require("./lib/gh");
	const { UPSTREAM_TRACKER } = require("./lib/workflow-core-config.js");
	const body = [
		`**Harness canary (#2819):** Claude Code ${v.version} looks to send \`agent_id\` on a subagent's compaction payloads:`,
		"",
		...v.reasons.map((r) => `- ${r}`),
		"",
		"Read statically from the binary. Confirm with one live subagent compaction (the triage comment's method) before building on it.",
	].join("\n");
	try {
		gh([
			"issue",
			"comment",
			String(GAP_ISSUE),
			"--repo",
			UPSTREAM_TRACKER,
			"--body",
			body,
		]);
		return true;
	} catch {
		/* Fail-open (#2819): a hand run reports it unposted, and the next
		 * start's detached probe retries after RETRY_MS. */
		return false;
	}
}

/**
 * Run the agent_id probe on `version`, comment where it is newly fixed, and
 * record it. The caller holds the lock.
 * @param {string} version
 * @param {AgentIdVerdict | undefined} prior
 */
function probeAgentIdAndRecord(version, prior) {
	/** @type {AgentIdVerdict} */
	const v = {
		version,
		...probeAgentId(claudeBin()),
		at: new Date().toISOString(),
	};
	if (v.verdict === "fixed")
		v.commented =
			(prior?.version === version && prior.commented === true) ||
			commentFixed(v);
	writeState({ agentId: v });
	return v;
}

/**
 * Probe under the lock and record the verdicts; null where a probe holds it.
 * @param {string} version
 * @param {{ listing: boolean, agentId: boolean }} which
 */
function probeAndRecord(version, which) {
	if (!takeLock()) return null;
	try {
		/** @type {Verdict | undefined} */
		let last;
		if (which.listing) {
			last = probe(version);
			writeState({ last });
		}
		if (which.agentId) probeAgentIdAndRecord(version, readState().agentId);
		return { last };
	} finally {
		fs.rmSync(lockPath(), { force: true });
	}
}

/** Launch `flag` detached — node's `detached` starts a new session, so a
 * harness killing the hook's group spares it.
 * @param {"--probe" | "--probe-agent-id"} flag */
function detachProbe(flag) {
	try {
		spawn(process.execPath, [__filename, flag], {
			detached: true,
			stdio: "ignore",
		}).unref();
	} catch {
		/* The next session start retries (#2037). */
	}
}

/** @param {Verdict} last */
const buildRedText = (last) =>
	`HARNESS-CANARY — Claude Code ${last.version} changed how a description-less plugin skill behaves (#2037):\n` +
	last.reasons.map((r) => `  - ${r}\n`).join("") +
	"  Workflow-core's description-less skills rest on that behaviour (#1958): restore their descriptions, or rule otherwise.\n" +
	"  This repeats at each start until a later version passes. Suspect a false red? Re-probe:\n" +
	`    ${rerun()}\n`;

/** @param {AgentIdVerdict} a */
const buildFixedText = (a) =>
	`AGENT-ID-FIXED — Claude Code ${a.version} looks to send agent_id on a subagent's compaction payloads, which #${GAP_ISSUE} (a subagent's compaction gets its parent's prelude, count line and rename) waits on (#2819):\n` +
	a.reasons.map((r) => `  - ${r}\n`).join("") +
	`  Read from the binary; #${GAP_ISSUE}'s close owes one live subagent compaction to confirm it.` +
	(a.commented
		? ` Commented on #${GAP_ISSUE}.\n`
		: ` The comment on #${GAP_ISSUE} is not posted yet; a session start retries it after ${RETRY_MS / 3_600_000} h.\n`);

/**
 * Whether the agent_id probe is owed on `version`: never run on it, or an
 * unprobed verdict or an unposted comment past RETRY_MS.
 * @param {State} state
 * @param {string} version
 */
function isAgentIdOwed(state, version) {
	const a = state.agentId;
	if (a?.version !== version) return true;
	const retry =
		a.verdict === "unprobed" || (a.verdict === "fixed" && !a.commented);
	return retry && Date.now() - Date.parse(a.at) >= RETRY_MS;
}

/**
 * The session-start run: a red or fixed verdict for this version, else
 * silence, after launching the probe where it is owed.
 * @param {import("./lib/check").CheckContext} ctx
 * @param {State} state
 * @param {string} version
 * @param {{ okLine: string, core: boolean }} opts
 */
function atStart(ctx, state, version, { okLine, core }) {
	const agent = forVersion(state.agentId, version);
	if (core && agent?.verdict === "fixed") ctx.say(buildFixedText(agent));
	const agentOwed = core && isAgentIdOwed(state, version);
	const seen = forVersion(state.last, version);
	if (seen?.verdict === "red") {
		ctx.fail("HARNESS-CANARY", seen.reasons.join("; "), seen);
		ctx.say(buildRedText(seen));
		if (agentOwed) detachProbe("--probe-agent-id");
		return {};
	}
	const retrying =
		seen?.verdict === "unprobed" && Date.now() - Date.parse(seen.at) < RETRY_MS;
	if (state.passed !== version && !retrying) detachProbe("--probe");
	else if (agentOwed) detachProbe("--probe-agent-id");
	if (state.passed === version) return { okLine };
	return { okLine: `probing Claude Code ${version} in the background.` };
}

/**
 * A hand run's finding on a version that has not passed, or whose re-probe
 * went red.
 * @param {import("./lib/check").CheckContext} ctx
 * @param {string} version
 * @param {Verdict | undefined} last
 */
function report(ctx, version, last) {
	if (last?.verdict === "red") {
		ctx.fail("HARNESS-CANARY", last.reasons.join("; "), last);
		ctx.say(buildRedText(last));
		return;
	}
	const [tag, msg] =
		last?.verdict === "unprobed"
			? [
					"UNPROBED",
					`the probe could not run on Claude Code ${version}: ${last.reasons.join("; ")}. Re-run: \`${rerun()}\`.`,
				]
			: [
					"NOT-PROBED",
					`Claude Code ${version} has not been probed yet; the next session start launches it, or run \`${rerun()}\`.`,
				];
	ctx.warn(tag, msg, last);
	ctx.say(`${tag} — ${msg}`);
}

/**
 * A hand run's agent_id finding: a warning on anything but "not fixed", which
 * returns the sentence the OK line carries.
 * @param {import("./lib/check").CheckContext} ctx
 * @param {string} version
 * @param {AgentIdVerdict | undefined} a
 */
function reportAgentId(ctx, version, a) {
	if (a?.verdict === "not fixed")
		return ` A subagent's compaction payloads still carry no agent_id (#${GAP_ISSUE}).`;
	if (a?.verdict === "fixed") {
		ctx.warn("AGENT-ID-FIXED", a.reasons.join("; "), a);
		ctx.say(buildFixedText(a));
		return "";
	}
	const again = rerun("--probe-agent-id");
	const [tag, msg] =
		a?.verdict === "unprobed"
			? [
					"AGENT-ID-UNPROBED",
					`the agent_id probe could not read Claude Code ${version}: ${a.reasons.join("; ")}. Re-run: \`${again}\`.`,
				]
			: [
					"AGENT-ID-NOT-PROBED",
					`the agent_id probe has not run on Claude Code ${version}; the next session start launches it, or run \`${again}\`.`,
				];
	ctx.warn(tag, msg, a);
	ctx.say(`${tag} — ${msg}`);
	return "";
}

/**
 * A hand-run `--probe` or `--probe-agent-id`: the listing verdict it leaves.
 * @param {import("./lib/check").CheckContext} ctx
 * @param {string} version
 * @param {boolean} core
 */
function runProbes(ctx, version, core) {
	const listing = ctx.has("--probe");
	if (!(listing || core))
		return ctx.skip(
			`the agent_id probe runs in workflow-core's own checkout alone, for #${GAP_ISSUE}.`,
		);
	const ran = probeAndRecord(version, { listing, agentId: core });
	if (ran === null)
		return ctx.skip(
			`another probe holds ${lockPath()}; its verdict lands in ${statePath()}.`,
		);
	const state = readState();
	return listing || state.last?.version !== version ? ran.last : state.last;
}

runCheck({
	name: "harness-canary",
	usage:
		"node check-harness-canary.js [--notify | --probe | --probe-agent-id] [--json]",
	flags: ["--probe", "--probe-agent-id"],
	run(ctx) {
		const version = readClaudeVersion(claudeBin());
		if (!version)
			return ctx.skip(
				`\`${claudeBin()} --version\` gave no version, so nothing was probed.`,
			);

		const core = isInCore();
		const state = readState();
		const seen = forVersion(state.last, version);
		const okLine = `a description-less plugin skill is unlisted and loads on Claude Code ${version}.`;
		const probing = ctx.has("--probe") || ctx.has("--probe-agent-id");

		if (ctx.notify && !probing)
			return atStart(ctx, state, version, { okLine, core });

		const last = probing ? runProbes(ctx, version, core) : seen;
		const fresh = readState();
		const agentNote = core
			? reportAgentId(ctx, version, forVersion(fresh.agentId, version))
			: "";
		if (
			last?.verdict === "green" ||
			(fresh.passed === version && last?.verdict !== "red")
		)
			return { okLine: okLine + agentNote };
		report(ctx, version, last);
		if (agentNote) ctx.say(`AGENT-ID —${agentNote}`);
		return { okLine, data: { version, passed: fresh.passed ?? null } };
	},
});
