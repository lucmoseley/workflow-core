#!/usr/bin/env node
/*
 * guard-inventory.js — Stop hook. Refuses a background job's ending when what
 * waits on the founder is missing, misshapen or carried by no open issue
 * (#988, under the #958 spec; ruled at #913).
 *
 * THE INVENTORY (#904) is the shape `PLACEMENT` prints. The status-line tail
 * exists because the job list shows that line's text alone.
 *
 * WHERE IT IS OWED: a background job (`CLAUDE_JOB_DIR` set) ending on
 * `result:` or `needs input:`. Never at `waiting:`, never in an interactive
 * session — but a block written on any turn, in any session, is checked for
 * shape and carriers. The status-line tail is checked only where the block is
 * owed.
 *
 * FIVE LIMBS, ONE COUNTER of its own, so guard-priced-options.js's refusals
 * earlier in a session cannot silence it:
 *   missing — owed and absent, or sitting below the status line.
 *   shape — the block grammar of lib/outstanding-line.js, the header holding
 *     nothing or the word `nothing` alone; and the tail lists
 *     exactly the block's issues, or says nothing waits where the block does.
 *   open — every leading ref an open issue, through the same module. The
 *     ticket the session just closed is refused as any closed issue is.
 *   posted round — a `needs input:` ending carrying a `❓ **Qn**` round: some
 *     cited issue holds, among its newest five comments, one opening a round
 *     and carrying the round's first question title, from the same batched
 *     read; and this session holds an arbiter claim on one such issue in the
 *     tracker (#1066), else `/pick-next` lists it as free work and a second
 *     session re-asks the round. A claim another live session holds does not
 *     count: the refusal's `claim-issue.js` then refuses, surfacing the
 *     collision. And a comment holding the round carries a well-formed
 *     `**Hand-off:**` block (lib/hand-off.js, #2391).
 *   park — every `needs input:` ending: the hand-off above, or, where it asks
 *     no round (a pointer to a standing round, a founder hand-over), the
 *     newest comment carrying a `**Hand-off:**` header among the cited
 *     issues' newest five, its `Blocked on:` naming what the park waits on,
 *     posted no earlier than this session began or last resumed where that
 *     can be read (#2944, #2950).
 *     Either way no file this session's write ledger names sits uncommitted
 *     in the tree — a file its diff carries is owed its restore to HEAD too —
 *     a live neighbour's claimed files aside.
 *
 * DRAFT AND ACT (#989), ON A SECOND COUNTER, `max: 1`: where an owed block
 * reads `waits on you: nothing`, the session's main-chain transcript is
 * scanned for one response holding a draft — a fence, or three quoted lines
 * running — and a sentence outside it, carrying `you`/`your`, that tells the founder to
 * send, upload, forward, reply to, email, submit or sign something, or check
 * it by eye. A send back to the session ("send back the output", "send me",
 * `send "done"`, "paste what you saw") does not count, nor a send the session
 * itself makes ("I'd send"), each judged on the words beside that act. A draft
 * in one response and the act in a later one are never paired. A hit refuses
 * once, quoting the newest such sentence; ending the same way again passes,
 * since nothing lexical tells a draft already filed or sent from one still
 * owed.
 *
 * FAILS OPEN on any internal error (lib/stop-guard.js). An unreachable GitHub
 * or an unreadable repo leaves the shape check alone, logged by
 * lib/outstanding-line.js, and passes the posted-round limb, as does an
 * unreadable or partly torn claim store, or no session id. It passes the park
 * limb where a cited issue is unread and no read one holds a hand-off. A
 * transcript whose start cannot be read passes the park limb's freshness test,
 * unlogged: a passing Stop hook's output reaches no one.
 *
 * IMPLICIT:  reads the session's ending message at every Stop and blocks the turn where a background job's `result:` or `needs input:` carries no `waits on you:` inventory, or where any session's inventory is misshapen, cites an issue that is not open, disagrees with its status-line tail, or leaves a `needs input:` round posted on no cited issue, on none this session claims, or with no well-formed hand-off in its comment, or parks at `needs input:` with no round and no well-formed hand-off posted on a cited issue since it began or last resumed, or parks while its ledgered files sit uncommitted; and, once a session, where a background job's owed `waits on you: nothing` follows a turn that handed the founder a draft to act on.
 * JUSTIFIED: fail-safe — work left waiting on the founder in chat or a closed issue is lost when the conversation scrolls away (#958), and the ending is the last moment it can still be filed.
 * DEFEAT:    the block clears by writing the inventory the refusal names, or the hand-off into the round comment — or, at a park asking no round, a comment on a cited issue — and committing or restoring the session's files, or by its own cap of 3 a session; the draft-and-act block by ending a second time, its cap being 1.
 *
 * WHAT IT CAN NEVER SEE: founder-facing work the session never put in a
 * draft-and-act turn; a gist that misstates the act; an open issue under the
 * wrong `takes:` label; an interactive session's final turn, no hook telling
 * it from any other; an issue another session closes after the Stop; a round
 * posted by a route that leaves no comment. A dispatch between the round's
 * posting and this Stop, seconds apart, finds the issue unclaimed (#1066).
 * And `check-duplicate-dispatch.js` still reads issue numbers from session
 * names alone, so a hand-named session working its own issues stays
 * invisible there — moot for a round this limb makes claimed, unchanged for
 * any other work. And an item gist using one of the
 * `APPROVAL_SEEKING` phrases trips that limb of guard-priced-options.js at
 * `result:`.
 */

const { readDeliverableRule } = require("./lib/founder-deliverable");
const { INVENTORY } = require("./lib/inventory-format");
const hookBlock = require("./lib/hook-block");
const stopGuard = require("./lib/stop-guard");
const {
	readCanonicalRef,
	isNothing,
	judge,
	buildRefusalText,
	trackerOf,
} = require("./lib/outstanding-line");
const { Q_MARKER, hasRoundMarker, roundNumber } = require("./lib/round-marker");
const { scriptPath } = require("./lib/script-path");
const { requiredGroup } = require("./lib/regex-group");
const {
	HAND_OFF_SHAPE,
	handOffFaults,
	parseHandOff,
} = require("./lib/hand-off");
const { listIssueClaims } = require("./lib/arbiter-store");
const { readOwnJob } = require("./lib/claude-stop");
const { readStrandedFiles } = require("./lib/neighbour-dirt");
const sessionTranscript = require("./lib/session-transcript");
const { governingMarker } = require("./lib/status-marker");
const { isSubagentTranscript, mainChainRecords } = require("./lib/transcript");

/* Case-sensitive: the form is the plain lower-case line (#904), and prose
 * opening "Waits on you: nothing urgent" is no block. */
const HEADER_RE = /^[ \t]*waits on you:(.*)$/;
const FENCE_RE = /^[ \t]{0,3}(```|~~~)/;
const TAIL_NOTHING_RE = /[—–-][ \t]*nothing waits on you\.?[ \t]*$/i;
const TAIL_REFS_RE = /[—–-][ \t]*waits on you:[ \t]*(.*?)\.?[ \t]*$/i;
const OWED = new Set(["result:", "needs input:"]);

const DRAFT_FENCE_RE = /^\s*(```|~~~)/;
const QUOTE_LINE_RE = /^[ \t]*>/;
/* #913's ruling: a draft is a fence or at least three quoted lines. */
const QUOTED_RUN = 3;
const YOU_RE = /\b(?:you|your)\b/i;
/* "email" and "sign" count as verbs only where one stands: after a subject, a
 * modal, `to` or `please`, or ("email") before its object — so "your Dad's
 * email" and "an early sign" are no act, nor is "sign in". The 40-character
 * reach of "check … by eye" is the pattern #913 measured. */
const VERB_LEAD = String.raw`(?:\b(?:you|please|to|then|and|could|should|can|must|will|would|might)\s+|['’]ll\s+|^)`;
const ACT_RE = new RegExp(
	String.raw`\b(?:send|upload|forward|reply to|submit)\b|${VERB_LEAD}e-?mail\b|\be-?mail\s+(?:him|her|them|it|this|that)\b|${VERB_LEAD}sign\b(?!\s*(?:in|up|on|out)\b|-)|\bcheck\b[^.\n]{0,40}\bby eye\b`,
	"gi",
);
const SESSION_SENDS_RE =
	/\b(?:I|I'd|I'll|I will|I would|we|we'd|we'll)\s+(?:\w+\s+)?$/i;
/* Back to the session: "send back the output", "send me", "send it here", or
 * a reply word in quotes — `send "done"`, at most 20 characters, a guess past
 * the longest measured ("charted"). "Back to #N" is to an issue, never to
 * another person. */
const SEND_BACK_RE =
	/^\s+(?:(?:it|them|this|that|the \w+(?: \w+)?)\s+)?back\b(?!\s+to\s+(?!me\b|us\b|here\b|#\d))|^\s+(?:(?:it|them|this)\s+)?(?:to\s+)?(?:me|us)\b|^\s+["“`'][^"”`']{1,20}["”`']|^\s+(?:\w+\s+)?here\b/i;

/**
 * Whether a sentence tells the founder to act on something outside this
 * session.
 * @param {string} sentence
 */
function foundersAct(sentence) {
	if (!YOU_RE.test(sentence)) return false;
	for (const m of sentence.matchAll(ACT_RE)) {
		const before = sentence.slice(0, m.index);
		const after = sentence.slice(m.index + m[0].length);
		if (!SESSION_SENDS_RE.test(before) && !SEND_BACK_RE.test(after))
			return true;
	}
	return false;
}

/**
 * One response split: whether it carries a draft — a fence, or a run of
 * quoted lines — and its prose lines outside both.
 * @param {string} text
 * @returns {{drafted: boolean, prose: string[]}}
 */
function draftAndProse(text) {
	let fenced = false;
	let drafted = false;
	let quoted = 0;
	/** @type {string[]} */
	const prose = [];
	for (const line of text.split(/\r?\n/)) {
		if (DRAFT_FENCE_RE.test(line)) {
			fenced = !fenced;
			drafted = true;
		} else if (fenced) continue;
		else if (QUOTE_LINE_RE.test(line)) {
			quoted += 1;
			if (quoted >= QUOTED_RUN) drafted = true;
			continue;
		} else prose.push(line);
		quoted = 0;
	}
	return { drafted, prose };
}

/**
 * The newest sentence that hands the founder a draft to act on, or "".
 * @param {string[]} turns  the session's assistant responses, oldest first
 */
function draftActSentence(turns) {
	for (const text of [...turns].reverse()) {
		const { drafted, prose } = draftAndProse(text);
		if (!drafted) continue;
		const sentences = prose
			.join("\n")
			.replace(/`[^`\n]*`/g, "``")
			.split(/(?<=[.!?])\s+|\n+/);
		const hit = sentences.reverse().find(foundersAct);
		if (hit) return squash(hit.replace(/^[\s*\-+]+/, ""));
	}
	return "";
}

/**
 * The session's main-chain assistant responses, each its text blocks joined —
 * one response is written as several records — then this turn's message,
 * which the transcript may not hold yet.
 * @param {import("./lib/stop-guard").StopPayload|null} payload
 * @param {string} sessionId
 * @param {string} message
 */
function sessionTurns(payload, sessionId, message) {
	const file = payload && sessionTranscript.resolve(payload, sessionId);
	/** @type {Map<unknown, string[]>} */
	const turns = new Map();
	if (file) {
		const tier = isSubagentTranscript(file) ? "subagent" : "main";
		for (const record of mainChainRecords(sessionTranscript.read(file), tier))
			addResponseText(turns, record);
	}
	return [...[...turns.values()].map((t) => t.join("\n\n")), message];
}

/**
 * Add one record's text blocks to its response's entry in `turns`, where it
 * is an assistant record.
 * @param {Map<unknown, string[]>} turns accumulator: the record's text blocks are appended under its response's key
 * @param {Record<string, any>} record as `mainChainRecords` yields it — a
 *   transcript is an external format this repo does not define
 */
function addResponseText(turns, record) {
	if (record.type !== "assistant") return;
	const content = record.message?.content;
	if (!Array.isArray(content)) return;
	const key =
		record.message?.id ??
		record.requestId ??
		record.uuid ??
		Symbol("unkeyed response");
	const texts = turns.get(key) ?? [];
	for (const block of content)
		if (block?.type === "text" && typeof block.text === "string")
			texts.push(block.text);
	turns.set(key, texts);
}

const LEAD =
	"THIS ENDING'S FOUNDER INVENTORY IS REFUSED (`rule:founder-deliverable`, below): everything that waits on the founder is listed, and an open issue carries each item.";
const PLACEMENT = `It sits ${INVENTORY.placement}: the plain line \`waits on you:\` and its items, or ${INVENTORY.nothingLine}. In a background job the status line itself ends ${INVENTORY.statusTail}.`;

/**
 * The block and the status line, located. The block is the LAST
 * `waits on you:` line outside a fence, running to the status line below it
 * or, with none, to the message's end.
 * @param {string} message
 */
function ending(message) {
	const lines = message.split(/\r?\n/);
	const marker = governingMarker(message);
	const markerLine =
		marker.at < 0 ? -1 : message.slice(0, marker.at).split(/\r?\n/).length - 1;
	let header = -1;
	let rest = "";
	let fenced = false;
	lines.forEach((line, i) => {
		if (FENCE_RE.test(line)) {
			fenced = !fenced;
			return;
		}
		const m = fenced ? null : HEADER_RE.exec(line);
		if (m) {
			header = i;
			rest = requiredGroup(m, 1, HEADER_RE);
		}
	});
	const end = markerLine > header ? markerLine : lines.length;
	const below = header < 0 ? [] : lines.slice(header + 1, end);
	return {
		marker: marker.name,
		payload: marker.payload,
		markerLine,
		header,
		rest: rest.trim(),
		body: [rest, ...below].join("\n"),
		/* The empty block, exactly: `waits on you: nothing` and no item below. */
		nothing: isNothing(rest) && !below.some((l) => l.trim()),
	};
}

/**
 * The round's first question: its number, and its title — the text after its
 * `❓ **Qn**`, or the next non-blank line where that is empty. Null where no
 * round opens.
 * @param {string} message
 * @returns {{number: string, title: string}|null}
 */
function firstQuestion(message) {
	const lines = message.split(/\r?\n/);
	const at = lines.findIndex((l) => roundNumber(l) !== null);
	const line = lines[at];
	if (line === undefined) return null;
	const own = line
		.replace(Q_MARKER, "")
		.replace(/^[\s:.\-—–]+/, "")
		.trim();
	return {
		number: roundNumber(line) ?? "1",
		title: own || (lines.slice(at + 1).find((l) => l.trim()) ?? "").trim(),
	};
}

/** @param {string} s */
const squash = (s) => s.replace(/\s+/g, " ").trim();

/**
 * The tracker issues among `holders`, and those of them this session claims.
 * Null where the claim store, the session id or the tracker cannot be read
 * (#1066: fail open). No liveness read: the session asking is the live one.
 * @param {import("./lib/outstanding-line").Item[]} holders
 * @param {string} sessionId
 * @returns {{numbers: number[], mine: number[]}|null}
 */
function trackerClaims(holders, sessionId) {
	const tracker = trackerOf();
	if (!sessionId || !tracker) return null;
	/* claim-issue.js claims in the tracker alone, so only its issues count. */
	const numbers = holders
		.filter((i) => `${i.owner}/${i.repo}` === tracker)
		.map((i) => i.number);
	if (numbers.length === 0) return { numbers, mine: [] };
	const listed = listIssueClaims();
	if (!listed || listed.why) return null;
	const mine = numbers.filter((n) =>
		listed.claims.some((c) => c?.sessionId === sessionId && c.issue === n),
	);
	return { numbers, mine };
}

/**
 * The tracker issues among `holders` a claim is owed on: all of them where
 * this session claims none, else [] — [] too where `trackerClaims` cannot read.
 * @param {import("./lib/outstanding-line").Item[]} holders
 * @param {string} sessionId
 * @returns {number[]}
 */
function claimOwedOn(holders, sessionId) {
	const claims = trackerClaims(holders, sessionId);
	return claims && claims.mine.length === 0 ? claims.numbers : [];
}

/**
 * The block's items whose newest comments hold the round.
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {{title: string}} question
 */
const roundHolders = (verdict, { title }) =>
	verdict.items.filter((item) =>
		(verdict.comments[item.ref] ?? []).some((c) => holdsRound(c, title)),
	);

/**
 * Whether a comment opens the round whose first question is titled `title`.
 * @param {{body: string}} comment
 * @param {string} title
 */
const holdsRound = (comment, title) =>
	hasRoundMarker(comment.body) && squash(comment.body).includes(squash(title));

/**
 * The hand-off fault on a park (#2391): `body`, the comment the park leaves
 * on its ticket, carries no well-formed `**Hand-off:**` block, or this
 * session's ledgered files sit uncommitted — the block's diff carries a named
 * file, so that file is still owed its restore.
 * @param {string} body
 * @param {string|undefined} question  the round's first question number,
 *   which `Blocked on:` must name; undefined where the park asks no round
 * @param {string} sessionId
 * @returns {string} the fault, or ""
 */
function handOffFault(body, question, sessionId) {
	const faults = handOffFaults(body, question);
	const remedy = question
		? "Edit the round comment to end"
		: "Post a comment on the issue the park waits on, ending";
	if (faults.length > 0)
		return `this \`needs input:\` park leaves no well-formed hand-off on its ticket (#2391): ${faults.join("; ")}. ${remedy} with the block a fresh session picks up from:\n\n${HAND_OFF_SHAPE}`;
	const named = new Set(parseHandOff(body)?.uncommitted ?? []);
	const stranded = readStrandedFiles(sessionId, hookBlock.repoRoot());
	if (stranded.length === 0) return "";
	const list = (/** @type {string[]} */ ps) =>
		ps.map((p) => `\`${p}\``).join(", ");
	const loose = stranded.filter((p) => !named.has(p));
	const parts = [];
	if (loose.length > 0)
		parts.push(
			`${list(loose)} ${loose.length === 1 ? "is" : "are"} uncommitted and unnamed in the hand-off: commit what stands alone; otherwise add its \`git diff HEAD\` to the hand-off (\`git add -N\` a new file first) and name it on the \`Uncommitted:\` line`,
		);
	parts.push(
		`${loose.length > 0 ? "then " : ""}\`git restore\` ${list(stranded)} to HEAD, deleting a new file, so no neighbour overwrites it once your claims lapse`,
	);
	return `this session's own files sit uncommitted at a park (#2391): ${parts.join("; ")}`;
}

/**
 * The question number a pointer park names — `Qn` in its block or status
 * line — or undefined where it names none.
 * @param {ReturnType<typeof ending>} end
 */
const pointedQuestion = (end) =>
	/\bQ(\d+)\b/.exec(`${end.body}\n${end.payload}`)?.[1];

/**
 * The newest comment `keep` passes among `items`' read comments, or undefined.
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {import("./lib/outstanding-line").Item[]} items
 * @param {(c: {body: string}) => boolean} keep
 */
const newestComment = (verdict, items, keep) =>
	items
		.flatMap((item) => verdict.comments[item.ref] ?? [])
		.filter(keep)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.at(-1);

/** @param {import("./lib/outstanding-line").Verdict} verdict */
const hasUnchecked = (verdict) =>
	verdict.items.some((item) => verdict.statuses[item.ref] === "unchecked");

/**
 * When this session's job was created; null where its record does not read.
 * A `claude --bg --resume` starts a new job and copies the conversation into a
 * new transcript with each record's old timestamp, writing no resume mark
 * there, so the job alone dates the resume (#2950).
 * @param {string} sessionId
 * @returns {number | null} epoch milliseconds
 */
function readJobCreatedAt(sessionId) {
	const t = Date.parse(String(readOwnJob(sessionId)?.job.createdAt));
	return Number.isNaN(t) ? null : t;
}

/**
 * When this session began or last resumed, to the second GitHub stamps a
 * comment at; null where neither its transcript nor its job record reads.
 * @param {import("./lib/stop-guard").StopPayload|null} payload
 * @param {string} sessionId
 */
function readSessionStart(payload, sessionId) {
	const file = sessionTranscript.resolve(payload ?? {}, sessionId);
	const marks = [
		file ? sessionTranscript.readStartedAt(file) : null,
		readJobCreatedAt(sessionId),
	].filter((t) => t !== null);
	return marks.length === 0
		? null
		: Math.floor(Math.max(...marks) / 1000) * 1000;
}

/**
 * The hand-off fault on a park that asks no round: judged on the newest comment
 * carrying a `**Hand-off:**` header among the cited issues' newest five,
 * whose `Blocked on:` names the pointer's `Qn` where it names one. A round
 * park needs no freshness test: its comment is matched by the round's title.
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {string|undefined} pointed  the pointer's question number
 * @param {string} sessionId
 * @param {number|null} start  this session's start, null where unread
 * @returns {string} the fault, or ""
 */
function parkFault(verdict, pointed, sessionId, start) {
	if (verdict.items.length === 0)
		return `this \`needs input:\` park cites no issue, so no hand-off can sit on its ticket (#2391) — list the issue the park waits on, and post the hand-off there:\n\n${HAND_OFF_SHAPE}`;
	const newest = newestComment(
		verdict,
		verdict.items,
		(c) => parseHandOff(c.body) !== null,
	);
	/* An issue whose comments could not be read may hold the hand-off (#958:
	 * fail open); one a read issue holds is judged on its merits (#2965).
	 * Residual: a newer good hand-off on the unread issue cannot save a stale
	 * or malformed one on a read issue, so that park is refused. */
	if (!newest && hasUnchecked(verdict)) return "";
	if (newest && start !== null && Date.parse(newest.createdAt) < start)
		return `this \`needs input:\` park's newest hand-off on its ticket was posted at ${newest.createdAt}, before this session began or last resumed at ${new Date(start).toISOString()}, so it carries none of the Done and Left since (#2944, #2950) — post this session's own hand-off on the issue the park waits on:\n\n${HAND_OFF_SHAPE}`;
	return handOffFault(newest?.body ?? "", pointed, sessionId);
}

/**
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {{number: string, title: string}} question
 * @param {string} sessionId
 * @returns {string} the fault, or "" where the round is posted on an issue
 *   this session claims, or either is unreadable
 */
function roundFault(verdict, question, sessionId) {
	const { number, title } = question;
	const holders = roundHolders(verdict, question);
	if (holders.length > 0) {
		const unclaimed = claimOwedOn(holders, sessionId);
		if (unclaimed.length === 0)
			return handOffFault(
				newestComment(verdict, holders, (c) => holdsRound(c, title))?.body ??
					"",
				number,
				sessionId,
			);
		return `this \`needs input:\` ending's round sits on #${unclaimed.join(", #")}, which this session holds no claim on, so \`/pick-next\` lists it as free work and a second session re-asks the round (#1066) — run \`node ${scriptPath("claim-issue.js")} ${unclaimed[0]}\`, then end again. Where it refuses on a live holder, that session is already asking: stop and report the collision`;
	}
	/* An issue whose comments could not be read may hold it (#958: fail open). */
	if (hasUnchecked(verdict)) return "";
	return `this \`needs input:\` ending asks a question round, but no issue the block cites holds it among its newest five comments — post the round (\`❓ **Q${number}** ${title}\` through its options) as a comment on the issue that carries the decision, and list that issue: \`- #N (answer Q${number}, round posted on the issue)\``;
}

/**
 * The status line's tail against the block's items.
 * @param {string} payload  the status line after its marker
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @returns {string[]}
 */
function tailFaults(payload, verdict) {
	const listed = verdict.items.map((i) => i.ref).join(", ");
	if (TAIL_NOTHING_RE.test(payload))
		return verdict.items.length > 0
			? [
					`the status line says nothing waits on you, but the block lists ${listed}`,
				]
			: [];
	const m = TAIL_REFS_RE.exec(payload);
	if (!m) return [`the status line ends with no tail: ${INVENTORY.statusTail}`];
	/* A block that failed its grammar has no item list worth comparing. */
	if (verdict.refusals.some((r) => !r.ref)) return [];
	const tail = requiredGroup(m, 1, TAIL_REFS_RE);
	const tokens = tail.split(/[\s,;]+/).filter((t) => t && !/^and$/i.test(t));
	const refs = tokens.map((t) => readCanonicalRef(t));
	if (refs.length === 0 || refs.includes(null))
		return [
			`the status line's tail lists issue refs only, \`— waits on you: #N, owner/repo#M\` — read: \`${tail}\``,
		];
	const want = new Set(verdict.items.map((i) => i.ref));
	const got = new Set(refs);
	if (want.size === got.size && [...want].every((r) => got.has(r))) return [];
	return [
		`the status line's tail lists ${[...got].join(", ")} where the block lists ${listed || "nothing"} — both name the same issues`,
	];
}

/**
 * The block's placement and header faults, before its items are judged.
 * @param {ReturnType<typeof ending>} end
 * @returns {import("./lib/outstanding-line").Refusal[]}
 */
function placementFaults(end) {
	/** @type {import("./lib/outstanding-line").Refusal[]} */
	const mine = [];
	if (end.markerLine >= 0 && end.header > end.markerLine)
		mine.push({ reason: "the block sits below the status line, not above it" });
	if (end.rest && !isNothing(end.rest))
		mine.push({
			reason:
				"`waits on you:` holds nothing or the word `nothing` on its own line; each item goes below it, one per line",
		});
	else if (!end.rest && isNothing(end.body))
		mine.push({
			reason: `the empty block is ${INVENTORY.nothingLine}`,
		});
	return mine;
}

/**
 * Every fault this ending carries, rendered — "" where it passes — with the
 * verdict and the round's first question it was judged on, null where none.
 * @param {string} message
 * @param {ReturnType<typeof ending>} end  the message's block and status line
 * @param {string} sessionId
 * @param {import("./lib/stop-guard").StopPayload|null} payload  null where
 *   the caller holds none: the transcript is then looked up by session id
 * @returns {{faults: string, verdict: import("./lib/outstanding-line").Verdict|null, question: ReturnType<typeof firstQuestion>}}
 */
function assess(message, end, sessionId, payload) {
	const owed = isOwed(end);
	if (end.header < 0) {
		if (!owed) return { faults: "", verdict: null, question: null };
		const faults = buildRefusalText({
			...judge("", { grammar: "block", shapeOnly: true }),
			refusals: [
				{
					reason: `this \`${end.marker}\` ending in a background job carries no \`waits on you:\` block (plain, never bold or quoted)`,
				},
			],
		});
		return { faults, verdict: null, question: null };
	}
	const mine = placementFaults(end);
	const parks = owed && end.marker === "needs input:";
	const question = parks ? firstQuestion(message) : null;
	const verdict = judge(end.body, { grammar: "block", comments: parks });
	if (owed)
		for (const reason of tailFaults(end.payload, verdict))
			mine.push({ reason });
	if (parks && verdict.refusals.length === 0) {
		const reason =
			question === null
				? parkFault(
						verdict,
						pointedQuestion(end),
						sessionId,
						readSessionStart(payload, sessionId),
					)
				: roundFault(verdict, question, sessionId);
		if (reason) mine.push({ reason });
	}
	const refusals = [...mine, ...verdict.refusals];
	return {
		faults:
			refusals.length > 0 ? buildRefusalText({ ...verdict, refusals }) : "",
		verdict,
		question,
	};
}

/**
 * @param {string} message
 * @param {ReturnType<typeof ending>} end
 * @param {string} sessionId
 * @param {import("./lib/stop-guard").StopPayload|null} payload
 */
const refusal = (message, end, sessionId, payload) =>
	assess(message, end, sessionId, payload).faults;

/** @param {ReturnType<typeof ending>} end */
const isOwed = (end) =>
	Boolean(process.env.CLAUDE_JOB_DIR) && OWED.has(end.marker);

/**
 * Whether `message` carries a block this guard passes, judged by the same
 * rules its refusal applies — the draft-and-act limb aside, which refuses on
 * its own. guard-session-ceiling.js stands down on one (#1786).
 * @param {string} message
 * @param {string} sessionId
 */
function hasPassingInventory(message, sessionId) {
	const end = ending(message);
	return end.header >= 0 && refusal(message, end, sessionId, null) === "";
}

/** @param {{sessionId: string, message: string, payload: import("./lib/stop-guard").StopPayload|null}} ctx */
function review({ sessionId, message, payload }) {
	const end = ending(message);
	const owed = isOwed(end);
	const faults = refusal(message, end, sessionId, payload);
	if (
		faults &&
		hookBlock.blockStop({
			prefix: ".inventory-nagged-",
			sessionId,
			reason: `${LEAD}\n\n${faults}\n${PLACEMENT}\n\n${readDeliverableRule("guard-inventory")}`,
		})
	)
		return;
	if (!owed || !end.nothing) return;
	const act = draftActSentence(sessionTurns(payload, sessionId, message));
	if (!act) return;
	hookBlock.blockStop({
		prefix: ".inventory-draft-nagged-",
		sessionId,
		reason: `${LEAD}\n\nThis ending says ${INVENTORY.nothingText}, but this session handed the founder a draft and told them to act on it:\n\n> ${act}\n\nIf it is still the founder's to do, list the open issue that carries it, in the block and the status-line tail, filing one now with the draft verbatim where none does. If it is done, end again: this refuses once a session.\n\n${readDeliverableRule("guard-inventory")}`,
		max: 1,
	});
}

/**
 * The tracker issues a passing `needs input:` ending in a background job
 * posted its round on and this session claims — the issues park-on-round.js
 * labels `parked` (#2000). [] for any other ending, or where any read fails.
 * @param {string} message
 * @param {string} sessionId
 * @returns {number[]}
 */
function parkTargets(message, sessionId) {
	const end = ending(message);
	if (!isOwed(end) || end.marker !== "needs input:") return [];
	const { faults, verdict, question } = assess(message, end, sessionId, null);
	if (faults || !verdict || !question) return [];
	return trackerClaims(roundHolders(verdict, question), sessionId)?.mine ?? [];
}

module.exports = { hasPassingInventory, parkTargets };

if (require.main === module) stopGuard.onMessage({ review });
