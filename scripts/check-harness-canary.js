#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { runCheck } = require("./lib/check");
const { caught, ignoreFailure } = require("./lib/caught.js");
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

// measured 16.6 s per haiku turn on 2.1.302, #2037
const PROBE_TIMEOUT_MS = 180_000;

// guess, #2037
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

/** @returns {{ state: State, fault?: string }} */
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

/** @param {string} sid */
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

/** @param {string} text */
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
			bg: false,
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
		if (transcript) {
			const slug = path.dirname(transcript);
			const ours = path.basename(slug).includes(path.basename(root));
			fs.rmSync(ours ? slug : transcript, { recursive: true, force: true });
		}
	}
}

/** @param {string} version */
function probeAndRecord(version) {
	fs.mkdirSync(configDir(), { recursive: true });
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

function detachProbe() {
	ignoreFailure(() =>
		spawnOutliving(process.execPath, [__filename, "--probe"], {
			stdio: "ignore",
		}).unref(),
	);
}

/** @param {Verdict} last */
const buildRedText = (last) =>
	`HARNESS-CANARY — Claude Code ${last.version} changed how a description-less plugin skill behaves (#2037):\n` +
	last.reasons.map((r) => `  - ${r}\n`).join("") +
	"  Workflow-core's description-less skills rest on that behaviour (#1958): restore their descriptions, or rule otherwise.\n" +
	"  This repeats at each start until a later version passes. Suspect a false red? Re-probe:\n" +
	`    ${rerun()}\n`;

/**
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
 * @param {import("./lib/check").Ctx} ctx
 * @param {Verdict} last
 */
function reportRed(ctx, last) {
	ctx.fail("HARNESS-CANARY", last.reasons.join("; "), last);
	ctx.say(buildRedText(last));
}

/**
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
