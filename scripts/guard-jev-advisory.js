#!/usr/bin/env node
/*
 * guard-jev-advisory.js — the seam-1 Jev Advisory check (spec at #200, under
 * #199).
 *
 * WHAT IT IS FOR. `guard-priced-options.js` reads only the blocks a
 * `❓ **Qn**` round marker opens, so a session that puts a real choice to the
 * founder in plain prose is caught by nothing. Telling "here are two courses
 * of action, pick one" from "here is what I did and why" is a semantic
 * judgement. This guard is the additive second reader: it looks at exactly
 * the messages the other guard never looks at, and asks a vendor model one
 * boolean question about them.
 *
 * IT IS PERMANENTLY **ADVISORY** AND THERE IS NO GRADUATION PATH (#173). It
 * never emits a `decision`, so it can never refuse a turn. The warn channel is
 * `systemMessage`, which reaches the founder's screen and never the model — the
 * consequence being that the session that wrote the unlettered choice is never
 * told, and in a background job with no terminal the line reaches nobody live.
 * `check-jev-flags.js` reads the log back on `npm run status` for exactly
 * that case (#202).
 *
 * THE STOP CONDITION, #199's own words (ruled at #175): more than one wrong
 * flag in ten flagged turns, over the first 20 sessions; or a Jev outage
 * notice fires in more than one session in ten. Both are countable from
 * `.jev-advisory-log.jsonl` and from nothing else. THE SECOND LIMB COUNTS `outage` ALONE: a `malformed` notice is
 * not an outage notice and never counts toward reversal (#226). Tripping it
 * deletes this file and its registration.
 *
 * IMPLICIT:  appends one JSONL line per turn under `.claude/tmp/markers/`,
 *            carrying the outgoing text itself on a `flagged` line and on no
 *            other (#285), and on a turn that passes every gate sends the
 *            turn's own text to the Vercel AI Gateway; emits at most one
 *            advisory line and refuses nothing, ever.
 * JUSTIFIED: fail-safe — #175 made the adoption reversible on evidence, and
 *            evidence not collected from the first session cannot be argued
 *            from later.
 * DEFEAT:    name `jev-advisory` in `.claude/workflow-core.json`'s `disabled`
 *            list, or set `WFC_JEV_ADVISORY=0` for one session.
 *
 * WHAT LEAVES THIS MACHINE, AND NOTHING ELSE (#172): the outgoing message text,
 * swept by gitleaks' own rule set first. No file content, no diff, no index
 * read — so #172's staged-and-gitleaks-passed limb does not bind. A sweep
 * finding, or gitleaks absent from the machine, means the check sends
 * nothing.
 *
 * RESIDUALS:
 *   - The master switch has a SECOND spelling, the script's own basename
 *     `guard-jev-advisory.js`, which `lib/stop-guard.js` honours before this
 *     file is reached at all. That route writes no log line — a guard switched
 *     fully off should not cost a write a turn — so a reader counting turns
 *     from the log must not read a gap as "nothing found".
 *   - THE REDACTION SWEEP NEEDS `gitleaks stdin` (#227). On a binary without
 *     it the sweep sees a non-zero exit it cannot read as anything but "do
 *     not send", so the check goes quiet rather than leaking: the empty-input
 *     probe tells that from a real finding and logs `why: "unswept"`, but
 *     nothing announces it live, and such a machine contributes nothing to
 *     #175's trial.
 *   - `outage` cannot tell a timeout from an unreachable host from a real 500:
 *     the SDK SYNTHESISES a 500 for a refused connection and for an abort, so
 *     all three arrive alike, and all three mean the same thing to #175's second
 *     limb. A reply the gateway delivered whole and could not read is not among
 *     them — `isMalformedReply` sorts it out (#226). THE CLOCK NARROWS THIS
 *     ONE WAY ONLY: a call that ran the full `ABORT_MS` is re-asked as an abort
 *     (`ABORT_RETRIES`), but a real 500 arriving at the ceiling is re-asked
 *     too, and the logged `outage` still names no cause.
 *   - The confidence is logged to TWO DECIMALS, which is the resolution #200
 *     asked for and less than Jev returns. #171's deferred threshold question
 *     gets 0.01 granularity and not the raw figure.
 *
 * FAILING OPEN IS THE WHOLE CONTRACT: `stop-guard.js`'s `onMessageAsync`
 * swallows anything thrown or rejected below, and the registration's `|| true`
 * answers a `require` that throws before it.
 */

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const hookBlock = require("./lib/hook-block");
const { scriptPath } = require("./lib/script-path.js");
const stopGuard = require("./lib/stop-guard");
const jevLog = require("./lib/jev-log.js");
const { guardDisabled } = require("./lib/workflow-core-config");
const { hasRoundMarker } = require("./lib/round-marker");
const { envFileValue } = require("./lib/env-file.js");

/**
 * The master switch's spelling in `.claude/workflow-core.json`'s `disabled`
 * list. Deliberately NOT the script's basename: that spelling is honoured
 * inside `stop-guard.js` before this file runs, and so cannot be logged.
 */
const CHECK_NAME = "jev-advisory";

/** The single-session override, any of `0`, `false` or `off`. */
const ENV_SWITCH = "WFC_JEV_ADVISORY";
const OFF_VALUES = new Set(["0", "false", "off"]);

/** The warn counter, spent by an advisory line and by nothing else. */
const WARN_PREFIX = ".jev-advisory-nagged-";

/**
 * How much of a flagged message is stored on its log line (#285).
 *
 * FOUR THOUSAND CHARACTERS, above the longest flag on record (#285): a
 * truncated line is worse to judge than a whole one, truncation taking the
 * tail where this repo's lettered options sit. `messageLen` is the
 * untruncated length, so a reader can always tell.
 */
const TEXT_CAP = 4000;

/**
 * How many advisory lines a session may be given before the guard goes quiet.
 * `hook-block.js`'s `MAX_BLOCKS`, which is 3 — a borrowed figure, picked for a
 * guard that REFUSES and unrevised for one that only nags (#173).
 */
const WARN_BUDGET = hookBlock.MAX_BLOCKS;

/**
 * The outage notice's cap.
 *
 * ONE, AND ON ITS OWN COUNTER — #200's ninth user story: an unreachable vendor
 * must not spend the budget that exists to stop nuisance flagging.
 */
const OUTAGE_BUDGET = 1;

/**
 * The malformed notice's cap, on a third counter.
 *
 * ONE, AND ON ITS OWN COUNTER, for #200's ninth user story read one step
 * further: a vendor that has changed its payload shape spends neither the warn
 * budget nor the outage budget (#226).
 */
const MALFORMED_BUDGET = 1;

/** `MalformedReply`'s own name, matched the same way as the SDK's below. */
const MALFORMED_REPLY_NAME = "JevMalformedReply";

/**
 * The error names that mean THE BODY ARRIVED AND COULD NOT BE READ, matched
 * anywhere in a rejection's `cause` chain. The SDK exports none of these
 * classes, so the name is what there is to match on.
 *
 *   - `AI_InvalidResponseDataError` — parsed, and answered a different set of
 *     questions than were asked;
 *   - `AI_TypeValidationError` — parsed, and a field was the wrong type;
 *   - `AI_JSONParseError` — did not parse at all;
 *   - `MalformedReply` — this file's own.
 */
const UNREADABLE_NAMES = new Set([
	MALFORMED_REPLY_NAME,
	"AI_InvalidResponseDataError",
	"AI_TypeValidationError",
	"AI_JSONParseError",
]);

/**
 * How far down a `cause` chain the names above are looked for. Twice the
 * deepest chain measured at #226, and a ceiling rather than a `while` because a
 * cycle in a vendor's error chain would hang the Stop hook.
 */
const CAUSE_DEPTH = 8;

/**
 * `askJev`'s own shape rejection, for a reply the SDK passed and this file
 * cannot use. Named so `isMalformedReply` discriminates it the one way it
 * already discriminates the SDK's — on `name` — rather than on a second
 * mechanism.
 *
 * ALL BUT UNREACHABLE, and kept anyway: the SDK validates the payload first, so
 * a reply missing the probability rejects inside `evaluate` before this throws.
 * Without it a non-finite probability getting past a future SDK would read
 * `false` at the 0.5 comparison and log `clear`.
 */
class MalformedReply extends Error {
	/**
	 * @param {string} why
	 * @param {Served} served what answered, which a reply this file cannot use
	 *   still names
	 */
	constructor(why, served) {
		super(why);
		this.name = MALFORMED_REPLY_NAME;
		this.served = served;
	}
}

/**
 * What answered a call, as far as the reply says.
 * @typedef {{model?: string, provider?: string}} Served
 */

/**
 * Read `Served` off an `evaluate` result.
 *
 * THE MODEL COMES FROM THE BODY, NOT `response.modelId`: the gateway provider
 * sets that to the id it was asked for. `provider` is the routing's final
 * hop, which can change under an unchanged alias (#702).
 * @param {any} result untyped because the SDK is `require`d lazily, and a
 *   reply's `body` is the gateway's own JSON, which the SDK does not type
 * @returns {Served}
 */
function servedBy(result) {
	const model = result?.response?.body?.model ?? result?.response?.modelId;
	const provider = result?.providerMetadata?.gateway?.routing?.finalProvider;
	return {
		...(typeof model === "string" ? { model } : {}),
		...(typeof provider === "string" ? { provider } : {}),
	};
}

/** The gateway credential, read from the environment or the gitignored `.env`. */
const KEY_VAR = "AI_GATEWAY_API_KEY";

/**
 * The stub's address in the suite, unset everywhere else — the spike's
 * `SPIKE_BASE_URL` under this repo's naming. Nothing in a real session sets it,
 * and with it unset the gateway resolves its own production URL.
 */
const BASE_URL_VAR = "WFC_JEV_BASE_URL";

/**
 * The packages, `require`d lazily so a worktree with no node_modules skips.
 *
 * IN `devDependencies` THOUGH A HOOK REQUIRES THEM AT RUN TIME, which looks
 * wrong and is not: hooks run on a developer's machine and never in the
 * deployed Next app, which imports neither. #200 settled it that way to keep
 * them out of Vercel's production install.
 */
const SDK_MODULE = "ai";
const GATEWAY_MODULE = "@ai-sdk/gateway";

/**
 * The redaction binary, injected at one named var rather than found on PATH —
 * `docs/code-standards-base.md` §N7, the convention `WFC_GH` and `WFC_CLAUDE_BIN`
 * already follow. Read per call, not frozen at load, so a suite can re-point it
 * between tests.
 *
 * THE SHELL HALF IS NOT CONVERTED. `.husky/pre-commit` and `.husky/pre-applypatch`
 * still spell `gitleaks` bare, so this var reaches the sweep below and nothing
 * else; §N7 wants one var per binary repo-wide, and #224 owns finishing it.
 * @returns {string}
 */
const gitleaksBinary = () => process.env.WFC_GITLEAKS || "gitleaks";

/**
 * A ceiling on the sweep, so a hung gitleaks cannot stall the turn to the hook
 * timeout. Generous against the ~200 ms a scan of one short message measures.
 */
const SWEEP_MS = 5000;

/**
 * The evaluation model #174 measured and #175 adopted.
 *
 * AN UNPINNED ALIAS, BECAUSE THE GATEWAY ACCEPTS NO VERSIONED ID (#702).
 */
const MODEL_ID = "typesafe-ai/jev";

/**
 * Above #174's measured p95 of 1.6 s with headroom, and far below the 15 s hook
 * timeout every sibling registration carries.
 */
const ABORT_MS = 3000;

/**
 * The abort budget a turn runs under: `ABORT_MS`, unless `WFC_JEV_ABORT_MS`
 * names a positive whole number of milliseconds no larger than it, so it can
 * never push a turn past the hook timeout. A TEST KNOB for the suite's hang
 * cases, injected the way `WFC_GITLEAKS` is and read per call for the reason
 * `gitleaksBinary` gives (#1024).
 * @returns {number}
 */
function abortBudget() {
	const raw = process.env.WFC_JEV_ABORT_MS?.trim() ?? "";
	const ms = /^[1-9]\d*$/.test(raw) ? Number(raw) : ABORT_MS;
	return Math.min(ms, ABORT_MS);
}

/**
 * How many times a turn re-asks after the abort fired. ONE, and only on the
 * abort (#255).
 *
 * WHY A RETRY IS SAFE HERE WHEN `maxRetries: 0` IS NOT. The SDK's own ladder
 * retries 408, 429 and 500-599 with exponential backoff to `backoff_max` 5 s,
 * which https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/jev-commercial-terms.md §3 puts at a ~40 s worst case
 * inside a hook — unusable, and why the ladder is off. This re-ask is a
 * different thing: no backoff, a fresh `ABORT_MS` budget, and a 6 s worst case
 * against the 15 s hook timeout. A 429 or a 529 — the codes that want a delay
 * this has no room for — answers fast and so is not re-asked at all, unless
 * one happens to arrive at the ceiling.
 *
 * Why one and not two: the trial's 6.9% hang rate, 4 of 58 calls (#255).
 */
const ABORT_RETRIES = 1;

/**
 * THE SPIKE'S WORDING, UNCHANGED AND NOT TO BE PARAPHRASED (#200).
 */
const QUESTION_KEY = "puts_choice";
const QUESTIONS = {
	[QUESTION_KEY]: {
		type: "boolean",
		instructions:
			"This is a message an assistant is sending to the project founder. Does it put a choice to the founder — two or more alternative courses of action offered for the founder to pick between?",
		criteria: {
			true: "the message offers two or more alternatives and asks or expects the founder to choose one",
			false:
				"the message reports, records a decision already taken, lists findings, or asks a question with no alternatives offered",
		},
	},
};

/**
 * Past this the live log is ROTATED, not truncated and not sealed: #175's stop
 * condition is counted from these lines, so losing them silently is the one
 * failure that would matter.
 */
const LOG_CAP_BYTES = 2_097_152;

/**
 * Every outcome this file can log, which is #200's vocabulary entire.
 *
 * @typedef {"skipped-marker"|"skipped-disabled"|"skipped-budget"|
 *   "skipped-no-sdk"|"skipped-redaction"|
 *   "flagged"|"clear"|"outage"|"malformed"} Outcome
 */
const OUTCOMES = [
	"skipped-marker",
	"skipped-disabled",
	"skipped-budget",
	"skipped-no-sdk",
	"skipped-redaction",
	"flagged",
	"clear",
	"outage",
	"malformed",
];

/** The outcomes that reached the vendor, and so carry `questionHash`. */
const VENDOR_OUTCOMES = new Set(
	OUTCOMES.filter((o) => !o.startsWith("skipped-")),
);

/**
 * How a turn is named, in the log and in the advisory alike — the two have to
 * agree or `jev-verdict.js` cannot join one to the other (#253).
 * @param {string} message
 * @returns {string}
 */
function digest(message) {
	return crypto.createHash("sha256").update(message).digest("hex").slice(0, 12);
}

/**
 * The question set, digested, so a line records which wording it was asked
 * under.
 */
const QUESTION_HASH = digest(JSON.stringify(QUESTIONS));

/**
 * What the founder reads when a turn is flagged.
 *
 * IT CARRIES THE HASH AND THE COMMAND so the flag can be judged while it is
 * still on screen. IT IS NOT THE ONLY MOMENT (#285): the text is stored
 * beside the digest, and `check-jev-flags.js` quotes it back at the next
 * `npm run status` with the same command.
 *
 * @param {string} hash
 */
function advisory(hash) {
	return (
		"JEV ADVISORY — this turn looks like it put a choice to you in plain prose " +
		"rather than a lettered ❓ **Qn** round, so it carries no options and no " +
		"prices. Nothing was refused, and the session was not told: ask it for the " +
		"lettered priced form if you want one.\n" +
		`  Right or wrong? node ${scriptPath("jev-verdict.js")} ${hash} right|wrong ["why"]\n` +
		"  Judging now is easiest, the turn being on screen; the text is kept, so " +
		`node ${scriptPath("status-report.js")} will quote it back with the same command.`
	);
}

/** What the founder reads, once a session, when the vendor cannot be reached. */
const OUTAGE_NOTICE =
	"JEV ADVISORY — the plain-prose choice check could not reach its vendor this " +
	"session, so silence from it is not a clean bill of health. Said once; " +
	"nothing is refused, and the turn stands.";

/** What the founder reads, once a session, on a reply the check cannot read. */
const MALFORMED_NOTICE =
	"JEV ADVISORY — the plain-prose choice check's vendor answered this session " +
	"in a shape it cannot read, so the check is not running and its silence is " +
	"not a clean bill of health. This is a repo fix, not an outage, and it does " +
	"not count toward the adoption's reversal (#175). Said once; nothing is refused.";

/**
 * The master switch, in the two spellings this file can see. Fails OPEN, in
 * the sense that an unreadable config leaves the guard running: `guardDisabled`
 * swallows its own faults and answers false.
 * @param {string} root
 * @returns {boolean}
 */
function switchedOff(root) {
	const declared = process.env[ENV_SWITCH];
	if (declared !== undefined && OFF_VALUES.has(declared.trim().toLowerCase()))
		return true;
	return guardDisabled(CHECK_NAME, { root });
}

/**
 * The gateway key, from the process environment or the gitignored repo-root
 * `.env` (lib/env-file.js).
 *
 * THE RETURN VALUE IS THE SECRET. It reaches `createGateway` and nothing else:
 * no caller below puts it in a log line, a breadcrumb or a message, and the
 * gate reports only whether it was found.
 * @param {string} root
 * @returns {string|null}
 */
function readKey(root) {
	const fromEnv = process.env[KEY_VAR]?.trim();
	if (fromEnv) return fromEnv;
	try {
		return envFileValue(path.join(root, ".env"), KEY_VAR);
	} catch {
		/* No `.env`, or one that cannot be read: both are "no key", which skips
		 * the turn. */
		return null;
	}
}

/**
 * Is either package unresolvable? The ordinary case in a worktree, which has
 * no `node_modules` at all.
 * @returns {boolean}
 */
function sdkMissing() {
	try {
		require.resolve(SDK_MODULE);
		require.resolve(GATEWAY_MODULE);
	} catch {
		return true;
	}
	return false;
}

/**
 * One `gitleaks stdin` run over `input`, returning spawnSync's result. The
 * message never reaches disk: gitleaks reads it from the pipe (#227).
 * @param {string} input
 * @returns {ReturnType<typeof spawnSync>}
 */
function runSweep(input) {
	return spawnSync(
		gitleaksBinary(),
		["stdin", "--no-banner", "--log-level", "error"],
		{
			input,
			/* THE EXIT CODE IS THE WHOLE ANSWER, so neither output stream is
			 * captured: a pipe would materialise gitleaks' own finding text — the
			 * secret, quoted — into this process's heap for no reader at all.
			 * Discarding it is why `--redact` is absent above rather than forgotten.
			 *
			 * A ceiling, for the same reason `ABORT_MS` is one: a hung sweep would
			 * stall the turn to the 15 s hook timeout, and a sweep that cannot
			 * finish is not a clean scan. spawnSync reports the kill as `error`,
			 * which the caller already reads as "do not send". */
			stdio: ["pipe", "ignore", "ignore"],
			timeout: SWEEP_MS,
		},
	);
}

/**
 * Why gitleaks' own rule set says this message must not be sent, or null where
 * it is clean.
 *
 * A NON-NULL ANSWER MEANS "DO NOT SEND", and it covers more than a hit:
 * gitleaks absent from the machine, gitleaks hanging and a binary too old to
 * carry the `stdin` subcommand all answer non-null, because an unswept payload
 * is not sendable (#200).
 *
 * @param {{message: string}} spec
 * @returns {"finding"|"unswept"|null}
 */
function sweepRefusal({ message }) {
	let res;
	try {
		res = runSweep(message);
	} catch {
		return "unswept";
	}
	/* `error` is ENOENT on a machine with no gitleaks, or the timeout above; a
	 * null status is a signal. */
	if (res.error) return "unswept";
	if (res.status === 0) return null;
	/* A non-zero status is a finding on any gitleaks carrying `stdin`, and an
	 * "unknown command" on one predating it — indistinguishable without reading
	 * stderr, which is the one thing this function must not pull into memory. So
	 * ask the binary the same question with nothing in it: empty input is clean
	 * on a working `stdin`, and still unknown-command on a binary without it.
	 * Two sweeps is the ceiling, 2 × SWEEP_MS against the 15 s hook timeout. */
	let probe;
	try {
		probe = runSweep("");
	} catch {
		return "unswept";
	}
	return probe.error || probe.status !== 0 ? "unswept" : "finding";
}

/**
 * Ask Jev one boolean question, this guard's unless another caller passes its
 * own. Resolves to the probability it returned and what served it; REJECTS
 * on a timeout, an unreachable host, an error status and a reply the SDK
 * could not read.
 * `isMalformedReply` sorts the last of those from the rest.
 *
 * @param {{key: string, message: string, questions?: Record<string, unknown>,
 *   questionKey?: string, abortMs?: number}} spec
 * @returns {Promise<{probability: number, served: Served}>}
 */
async function askJev({
	key,
	message,
	questions = QUESTIONS,
	questionKey = QUESTION_KEY,
	abortMs = ABORT_MS,
}) {
	const { createGateway } = require(GATEWAY_MODULE);
	const { experimental_evaluate: evaluate } = require(SDK_MODULE);
	const baseURL = process.env[BASE_URL_VAR]?.trim();
	const gateway = createGateway({
		apiKey: key,
		...(baseURL ? { baseURL } : {}),
	});
	const result = await evaluate({
		model: gateway.evaluationModel(MODEL_ID),
		state: message,
		questions,
		/* The SDK's own retry ladder, off: see `ABORT_RETRIES` for why, and for
		 * the bounded re-ask that replaces it. */
		maxRetries: 0,
		abortSignal: AbortSignal.timeout(abortMs),
	});
	const served = servedBy(result);
	const probability = result?.answers?.[questionKey]?.probability;
	if (typeof probability !== "number" || !Number.isFinite(probability))
		throw new MalformedReply("no probability in the gateway's answer", served);
	return { probability, served };
}

/**
 * Did the vendor answer in a shape the check cannot read, rather than fail to
 * answer? Both limbs must hold, and both were measured against a local stub
 * (#226):
 *
 *   - the `cause` chain names one of `UNREADABLE_NAMES`, which is positive
 *     evidence that a body arrived and could not be read; AND
 *   - the status is absent or 2xx, so the HTTP exchange itself succeeded.
 *
 * NEITHER LIMB ALONE WOULD DO, and each catches a case the other lets past.
 * A socket dropping mid-body after 200 headers surfaces as a REAL 200 (#226
 * tabulates the measured error chain), so a bare 2xx test would file a
 * transport failure as an answer and stop counting it toward #175's limb. And
 * a gateway 500 returning an HTML error page could carry a parse failure in
 * its chain, so a bare name test could file a real outage as an answer.
 *
 * Everything else is an outage, INCLUDING a 500 the SDK SYNTHESISED for a
 * refused connection or an abort: that conflation is the guard's existing
 * residual, and neither limb here widens it.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
function isMalformedReply(e) {
	const top = /** @type {Record<string, unknown>} */ (e);
	if (!top) return false;
	const status = top.statusCode;
	if (typeof status === "number" && (status < 200 || status >= 300))
		return false;
	let link = top;
	for (let depth = 0; link && depth < CAUSE_DEPTH; depth++) {
		if (UNREADABLE_NAMES.has(String(link.name))) return true;
		link = /** @type {Record<string, unknown>} */ (link.cause);
	}
	return false;
}

/**
 * The local pre-flight gate, in #200's order, first hit wins.
 *
 * Returns the outcome to log, or a null outcome and the key to call with where
 * every gate passed.
 *
 * NO RATE GATE (#703). The one-call-a-minute window was sized for the free
 * tier; on paid credits the gateway sets no limit, and a 429 from upstream
 * logs as an `outage` like any other failure.
 * @param {{message: string, sessionId: string, root: string}} ctx
 * @returns {{outcome: Outcome|null, why?: string, key?: string}}
 */
function preflight({ message, sessionId, root }) {
	if (hasRoundMarker(message)) return { outcome: "skipped-marker" };
	if (switchedOff(root)) return { outcome: "skipped-disabled" };
	if (hookBlock.capSpent({ prefix: WARN_PREFIX, sessionId, max: WARN_BUDGET }))
		return { outcome: "skipped-budget" };
	/* `why` tells the two halves apart in the log without widening #200's
	 * outcome vocabulary. */
	if (sdkMissing()) return { outcome: "skipped-no-sdk", why: "sdk" };
	const key = readKey(root);
	if (!key) return { outcome: "skipped-no-sdk", why: "key" };
	const refusal = sweepRefusal({ message });
	if (refusal) return { outcome: "skipped-redaction", why: refusal };
	return { outcome: null, key };
}

/**
 * What a turn's log line carries beyond who wrote it and about what.
 * @typedef {{outcome: Outcome, why?: string, confidence?: number,
 *   latencyMs?: number, retries?: number, served?: Served}} LineFields
 */

/**
 * One self-contained JSON line per turn, appended. Most turns are recorded as
 * a length and a short digest and never as text: these files are gitignored,
 * so assistant prose here is a leak waiting for a pathspec-less commit.
 *
 * A `flagged` LINE IS THE ONE EXCEPTION, AND ONLY IT (#285). A flag that
 * cannot be read back cannot be judged right or wrong, and #175's first limb
 * counts nothing else. `messageText` carries the outgoing text on exactly
 * those lines, capped at `TEXT_CAP`. Reaching `flagged` means the gitleaks
 * sweep in `sweepRefusal` already returned clean on this very text, so what is
 * stored is swept text, and every other outcome — the unswept ones among
 * them — still stores none.
 *
 * `messageHash` STAYS AND STAYS THE JOIN KEY. The verdict store keys on it, so
 * nothing on disk needs migrating.
 *
 * `confidence` is a NUMBER and is spelled that way deliberately:
 * `check-jev-flags.js`'s `describeTurn` keys its `p=` suffix on that name and
 * that type, and renders nothing at all for a string or for `probability`
 * (#204's review finding).
 *
 * `retries` is dropped where it is zero, so it appears only on a line a
 * re-ask produced (#255) — the callers pass their counter bare. ON SUCH A LINE
 * `latencyMs` IS THE WHOLE TURN, both attempts: read it against
 * `ABORT_MS * (retries + 1)`, not against `ABORT_MS`.
 *
 * `model` and `provider` appear where a reply named them, and `questionHash`
 * on every line that reached the vendor (#702), so a figure measured off this
 * log can be tied to what answered and to what was asked.
 *
 * @param {{root: string, sessionId: string, message: string} & LineFields} spec
 * @returns {void}
 */
function logGate({
	root,
	sessionId,
	outcome,
	why,
	message,
	confidence,
	latencyMs,
	retries,
	served,
}) {
	/* Keeps an outcome nobody has declared out of the audit vocabulary #175's
	 * stop condition is counted in. Unreachable from `review`, whose every
	 * literal is listed. */
	if (!OUTCOMES.includes(outcome)) return;
	const file = jevLog.logPath(root);
	try {
		let size = 0;
		try {
			size = fs.statSync(file).size;
		} catch {
			/* Absent counts as empty, which is what a first write wants. */
		}
		if (size >= LOG_CAP_BYTES)
			fs.renameSync(file, jevLog.previousLogPath(root));
		const line = {
			at: new Date().toISOString(),
			session: sessionId,
			outcome,
			...(why ? { why } : {}),
			...(confidence === undefined ? {} : { confidence }),
			...(latencyMs === undefined ? {} : { latencyMs }),
			...(retries ? { retries } : {}),
			...served,
			...(VENDOR_OUTCOMES.has(outcome) ? { questionHash: QUESTION_HASH } : {}),
			messageLen: message.length,
			messageHash: digest(message),
			...(outcome === "flagged"
				? { messageText: message.slice(0, TEXT_CAP) }
				: {}),
		};
		fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
	} catch {
		/* Fail open, as everywhere here: a guard whose log cannot be written
		 * still refuses nothing, which is its real job. */
	}
}

/**
 * The advisory channel: `systemMessage` alone, with NO `decision` field. That
 * is what makes this guard incapable of refusing a turn.
 * @param {string} text
 */
function say(text) {
	process.stdout.write(JSON.stringify({ systemMessage: text }));
}

/**
 * @typedef {{log: (rest: LineFields) => void, sessionId: string,
 *   latencyMs: number, retries: number}} FailCtx
 */

/* The two `charge` calls, in failMalformed() and failOutage(), are spelled out
 * rather than shared with a prefix passed in: `lib/hook-block.test.ts` reads
 * counter prefixes off literal call sites, and a prefix built at run time is a
 * counter it cannot sweep. */

/**
 * A malformed reply: logged, and noticed within its budget.
 * @param {unknown} e
 * @param {FailCtx} ctx
 */
function failMalformed(e, { log, sessionId, latencyMs, retries }) {
	log({
		outcome: "malformed",
		latencyMs,
		retries,
		served: e instanceof MalformedReply ? e.served : undefined,
	});
	if (
		hookBlock.charge({
			prefix: ".jev-advisory-malformed-",
			sessionId,
			max: MALFORMED_BUDGET,
		})
	)
		say(MALFORMED_NOTICE);
}

/**
 * An outage: logged, and noticed within its budget.
 * @param {FailCtx} ctx
 */
function failOutage({ log, sessionId, latencyMs, retries }) {
	log({ outcome: "outage", latencyMs, retries });
	if (
		hookBlock.charge({
			prefix: ".jev-advisory-outage-",
			sessionId,
			max: OUTAGE_BUDGET,
		})
	)
		say(OUTAGE_NOTICE);
}

/**
 * Jev's answer, re-asking an attempt the abort killed; null where the turn
 * failed, which is then already logged.
 * @param {{key: string, message: string, abortMs: number, sessionId: string,
 *   log: (rest: LineFields) => void, started: number}} ctx
 * @returns {Promise<{probability: number, served: Served, retries: number}|null>}
 */
async function askWithRetries({
	key,
	message,
	abortMs,
	sessionId,
	log,
	started,
}) {
	let retries = 0;
	for (;;) {
		const attemptAt = Date.now();
		try {
			const { probability, served } = await askJev({ key, message, abortMs });
			return { probability, served, retries };
		} catch (e) {
			const latencyMs = Date.now() - started;
			if (isMalformedReply(e)) {
				failMalformed(e, { log, sessionId, latencyMs, retries });
				return null;
			}
			/* THE CLOCK TELLS THE ABORT FROM EVERY OTHER FAILURE, not the error:
			 * the SDK synthesises a 500 for a refused connection and for an abort
			 * alike (§RESIDUALS), so there is nothing on the error to read. A call
			 * the abort killed cannot have returned before its own budget ran out.
			 *
			 * The comparison has no tolerance, so clock granularity costs a
			 * missed re-ask rather than one fired at a real 500 — the safe
			 * direction. */
			if (retries < ABORT_RETRIES && Date.now() - attemptAt >= abortMs) {
				retries++;
				continue;
			}
			failOutage({ log, sessionId, latencyMs, retries });
			return null;
		}
	}
}

/**
 * One turn, judged. Writes exactly one log line, and at most one
 * `systemMessage`.
 * @param {{sessionId: string, message: string, root: string}} ctx
 * @returns {Promise<void>}
 */
async function review({ sessionId, message, root }) {
	/* The three fields every line this review logs carries — here and in the
	 * helpers `log` is passed to — bound once. */
	const log = (/** @type {LineFields} */ rest) =>
		logGate({ root, sessionId, message, ...rest });

	const { outcome, why, key } = preflight({ message, sessionId, root });
	if (outcome !== null || !key)
		return log({ outcome: outcome ?? "skipped-no-sdk", why });

	const abortMs = abortBudget();
	const started = Date.now();
	const answer = await askWithRetries({
		key,
		message,
		abortMs,
		sessionId,
		log,
		started,
	});
	if (!answer) return;
	const { probability, served, retries } = answer;

	const latencyMs = Date.now() - started;
	/* NO THRESHOLD GATES THIS (#171, #200). A boolean question answers as a
	 * probability and nothing else, so 0.5 is how the answer is READ OUT (#174),
	 * not a tuned number; there is nothing here to tune it against, which is
	 * why #171 was deferred.
	 *
	 * READ OUT BEFORE ROUNDING, so a p of 0.495 is `clear` rather than rounded
	 * up into a flag by the log's own two decimals. */
	const flagged = probability >= 0.5;
	log({
		outcome: flagged ? "flagged" : "clear",
		confidence: Number(probability.toFixed(2)),
		latencyMs,
		retries,
		served,
	});
	if (
		flagged &&
		hookBlock.charge({ prefix: WARN_PREFIX, sessionId, max: WARN_BUDGET })
	)
		say(advisory(digest(message)));
}

/** @returns {Promise<void>} */
async function main() {
	await stopGuard.onMessageAsync({ review });
}

module.exports = {
	main,
	/* The route to the vendor, borrowed whole by `audit-escape-lines.js` (#671)
	 * so a second caller cannot reach it unswept or under another model. */
	gateway: {
		readKey,
		sdkMissing,
		sweepRefusal,
		askJev,
		isMalformedReply,
	},
};

if (require.main === module)
	main().catch(() => {
		/* Belt to onMessageAsync's braces: fail open (#200's seventeenth story). */
	});
