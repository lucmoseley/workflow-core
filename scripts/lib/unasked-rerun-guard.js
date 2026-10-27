/*
 * unasked-rerun-guard.js — guard-unasked-rerun.js's core (workflow-core#2800): find the
 * bare test segment in a command and spend the judge's verdict on it.
 *
 * It does no I/O. The judgement — the attestation, the ledger read, the latch and
 * the refusal log — is lib/unasked-rerun.js's `judge`, handed in as the
 * `judge` port; the rule store, the session id, the host's modules, the doc
 * spelling and the error log arrive as ports too.
 *
 * SCOPE: a bare `npm run test`, `npm run test:changed` or `npm test`, read per
 * segment after shell-words.js's `unwrap` and recognised by
 * lib/suite-launch.js as `npm-vitest`, with nothing after the script name but
 * `--`, `--queue` and redirections — `--queue` changes when a run starts, not
 * what it tests (workflow-core#1153 Q1). The `--queue` is read as its literal text, so a
 * quoted one counts. Never a run naming files or a filter, `--full=` or any
 * other flag — each is a run asked for. The first bare segment is the one
 * judged.
 *
 * THE VERDICT, SPENT (mantahostels#103 §6): no session id allows silently. A judge that says it could not
 * judge (`why`), or that throws, allows and logs why. `unread` — its own work
 * unreadable, so HEAD was judged whole — and `note` — a refusal it could not
 * record — are logged beside the verdict. A deny carries the `unasked-rerun`
 * rule's fragment after the judge's text, its `-landing` twin where the host
 * has the `landing` module on (workflow-core#2936), or a fallback naming the fragment's
 * file where the store cannot give it — a refusal, so never a fail-open
 * record.
 */

const { ruleOrFallback } = require("./guard-verdict.js");
const { parseCommand, unmask, walkCommands } = require("./shell-parse.js");
const { QUOTED, literal, unwrap } = require("./shell-words.js");
const { suiteLaunchKind } = require("./suite-launch.js");
const { caught } = require("./caught.js");

/**
 * suiteLaunchKind's ports. An `npm-vitest` verdict never reads them: the
 * runners and queue-run.js judge node and python words alone.
 * @type {import("./suite-launch.js").LaunchPorts}
 */
const LAUNCH_PORTS = { runners: () => [], isWrapperScript: () => true };

/**
 * @typedef {({ deny?: string, note?: string, why?: string, unread?: string })} Verdict
 *   lib/unasked-rerun.js's `judge` answer
 * @typedef {object} UnaskedPorts
 * @property {(input: { sessionId: string, cwd: string, command: string }) => Verdict} judge
 *   whether the run is an unasked re-run; latches and logs a refusal itself
 * @property {string} sessionId the payload's, "" where it carries none
 * @typedef {import("./kit-context.js").KitContext & UnaskedPorts} UnaskedContext
 */

/**
 * The first segment launching a bare vitest run, masked, and the directory
 * it runs in ("" where the walk cannot know it); null where none does.
 * @param {string} command
 * @param {import("./shell-parse.js").WalkPorts} ports
 * @returns {{ segment: string, cwd: string } | null}
 */
function bareSegment(command, ports) {
	const parsed = parseCommand(command);
	const { spans } = parsed;
	/** @param {string} w */
	const typed = (w) => {
		if (!w.includes(QUOTED)) return w;
		const lit = literal(w, spans);
		return lit.known ? lit.text : w;
	};
	/** @type {{ segment: string, cwd: string } | null} */
	let found = null;
	walkCommands(
		parsed,
		(cmd) => {
			if (found) return;
			const words = unwrap(cmd.words, spans).words;
			if (words.length === 0) return;
			const launch = suiteLaunchKind(words.map(typed), LAUNCH_PORTS);
			if (launch?.kind !== "npm-vitest") return;
			const asked = words
				.slice(launch.taken)
				.some((w) => w !== "--" && literal(w, spans).text !== "--queue");
			if (asked) return;
			found = { segment: cmd.segment, cwd: cmd.cwd };
		},
		ports,
	);
	return found;
}

/**
 * @param {string} command
 * @param {UnaskedContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const bare = bareSegment(command, ctx);
	if (!bare || !ctx.sessionId) return null;
	/** @type {Verdict} */
	let out;
	try {
		out = ctx.judge({
			sessionId: ctx.sessionId,
			cwd: bare.cwd,
			command: unmask(bare.segment),
		});
	} catch (e) {
		out = { why: `the judge threw: ${caught(e).message}` };
	}
	if (out.unread)
		ctx.log(
			"own work unreadable — the re-run judged on all of HEAD (workflow-core#1218)",
			out.unread,
		);
	if (out.why) {
		ctx.log(
			"could not judge whether certificates attest HEAD — a bare test run allowed unjudged",
			out.why,
		);
		return null;
	}
	if (!out.deny) return null;
	if (out.note)
		ctx.log(
			"a refusal went unrecorded — the post-change count (workflow-core#810) undercounts",
			out.note,
		);
	return { deny: `${out.deny}\n\n${unaskedRule(ctx)}` };
}

/**
 * The rule's fragment, its `-landing` twin where the host has `landing` on.
 * @param {UnaskedContext} ctx
 */
function unaskedRule(ctx) {
	return ctx.moduleOn("landing")
		? ruleOrFallback(
				ctx,
				"unasked-rerun-landing",
				"An unasked re-run is refused once a session",
			)
		: ruleOrFallback(
				ctx,
				"unasked-rerun",
				"An unasked re-run is refused once a session",
			);
}

module.exports = { decide };
