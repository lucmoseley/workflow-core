#!/usr/bin/env node

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
const { trimRun } = require("./lib/trim-run");
const {
	HAND_OFF_SHAPE,
	handOffFaults,
	parseHandOff,
} = require("./lib/hand-off");
const { listIssueClaims } = require("./lib/arbiter-store");
const { readOwnJob } = require("./lib/claude-stop");
const { isBackgroundJob } = require("./lib/job-paths");
const { readStrandedFiles } = require("./lib/neighbour-dirt");
const { sessionTree } = require("./lib/host-root.js");
const { findOwnHold } = require("./lib/repo-holds");
const sessionTranscript = require("./lib/session-transcript");
const { shareChecklist } = require("./lib/needs-input-shape");
const { governingMarker } = require("./lib/status-marker");
const { sinceTime } = require("./lib/tool-calls-since");
const { isSubagentTranscript, mainChainRecords } = require("./lib/transcript");

// #904
const HEADER_RE = /^[ \t]*waits on you:(.*)$/;
const FENCE_RE = /^[ \t]{0,3}(```|~~~)/;
const TAIL_NOTHING_RE = /[—–-][ \t]*nothing waits on you\.?[ \t]*$/i;
const TAIL_REFS_RE = /[—–-][ \t]*waits on you:(.*)/i;
const OWED = new Set(["result:", "needs input:"]);

const DRAFT_FENCE_RE = /^\s*(```|~~~)/;
const QUOTE_LINE_RE = /^[ \t]*>/;
const QUOTED_RUN = 3;
const YOU_RE = /\b(?:you|your)\b/i;
const VERB_LEAD = String.raw`(?:\b(?:you|please|to|then|and|could|should|can|must|will|would|might)\s+|['’]ll\s+|^)`;
const ACT_RE = new RegExp(
	String.raw`\b(?:send|upload|forward|reply to|submit)\b|${VERB_LEAD}e-?mail\b|\be-?mail\s+(?:him|her|them|it|this|that)\b|${VERB_LEAD}sign\b(?!\s*(?:in|up|on|out)\b|-)|\bcheck\b[^.\n]{0,40}\bby eye\b`,
	"gi",
);
const SESSION_SENDS_RE =
	/\b(?:I|I'd|I'll|I will|I would|we|we'd|we'll)\s+(?:\w+\s+)?$/i;
const SEND_BACK_RE =
	/^\s+(?:(?:it|them|this|that|the \w+(?: \w+)?)\s+)?back\b(?!\s+to\s+(?!me\b|us\b|here\b|#\d))|^\s+(?:(?:it|them|this)\s+)?(?:to\s+)?(?:me|us)\b|^\s+["“`'][^"”`']{1,20}["”`']|^\s+(?:\w+\s+)?here\b/i;

/** @param {string} sentence */
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

/** @param {string[]} turns */
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
		for (const record of mainChainRecords(readTranscriptText(file), tier))
			addResponseText(turns, record);
	}
	return [...[...turns.values()].map((t) => t.join("\n\n")), message];
}

/**
 * @param {string} file
 * @returns {string}
 */
function readTranscriptText(file) {
	try {
		return sessionTranscript.read(file);
	} catch {
		return "";
	}
}

/**
 * @param {Map<unknown, string[]>} turns
 * @param {import("./lib/transcript.js").TranscriptRecord} record
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

/** @param {string} message */
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
		nothing: isNothing(rest) && !below.some((l) => l.trim()),
	};
}

/**
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
 * @param {import("./lib/outstanding-line").Item[]} holders
 * @param {string} sessionId
 * @returns {{numbers: number[], mine: number[]}|null}
 */
function trackerClaims(holders, sessionId) {
	const tracker = trackerOf();
	if (!sessionId || !tracker) return null;
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
 * @param {import("./lib/outstanding-line").Item[]} holders
 * @param {string} sessionId
 * @returns {number[]}
 */
function claimOwedOn(holders, sessionId) {
	const claims = trackerClaims(holders, sessionId);
	return claims && claims.mine.length === 0 ? claims.numbers : [];
}

/**
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {{title: string}} question
 */
const roundHolders = (verdict, { title }) =>
	verdict.items.filter((item) =>
		(verdict.comments[item.ref] ?? []).some((c) => holdsRound(c, title)),
	);

/**
 * @param {{body: string}} comment
 * @param {string} title
 */
const holdsRound = (comment, title) =>
	hasRoundMarker(comment.body) && squash(comment.body).includes(squash(title));

/**
 * @param {string} body
 * @param {string|undefined} question
 * @param {string} sessionId
 * @param {string|null} tree
 * @returns {string}
 */
function handOffFault(body, question, sessionId, tree) {
	const faults = handOffFaults(body, question);
	const remedy = question
		? "Edit the round comment to end"
		: "Post a comment on the issue the park waits on, ending";
	if (faults.length > 0)
		return `this \`needs input:\` park leaves no well-formed hand-off on its ticket (#2391): ${faults.join("; ")}. ${remedy} with the block a fresh session picks up from:\n\n${HAND_OFF_SHAPE}`;
	const named = new Set(parseHandOff(body)?.uncommitted ?? []);
	const stranded = tree === null ? [] : readStrandedFiles(sessionId, tree);
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

/** @param {ReturnType<typeof ending>} end */
const pointedQuestion = (end) =>
	/\bQ(\d+)\b/.exec(`${end.body}\n${end.payload}`)?.[1];

/**
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
 * @param {string} sessionId
 * @returns {number | null}
 */
function readJobCreatedAt(sessionId) {
	const t = Date.parse(String(readOwnJob(sessionId)?.job.createdAt));
	return Number.isNaN(t) ? null : t;
}

/**
 * @param {string|null|undefined} file
 * @param {string} sessionId
 */
function readSessionStart(file, sessionId) {
	const marks = [
		file ? sessionTranscript.readStartedAt(file) : null,
		readJobCreatedAt(sessionId),
	].filter((t) => t !== null);
	return marks.length === 0
		? null
		: Math.floor(Math.max(...marks) / 1000) * 1000;
}

/**
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {string} payload
 * @returns {import("./lib/outstanding-line").Verdict}
 */
function buildHandOffVerdict(verdict, payload) {
	const hold = findOwnHold(payload);
	return hold
		? {
				...verdict,
				items: verdict.items.filter((item) => item.number !== hold.issue),
			}
		: verdict;
}

/**
 * @param {import("./lib/outstanding-line").Verdict} own
 * @param {string} sessionId
 * @returns {string}
 */
function holdClaimFault(own, sessionId) {
	const unclaimed = claimOwedOn(own.items, sessionId);
	return unclaimed.length === 0
		? ""
		: `this \`needs input:\` park on a repo hold cites #${unclaimed.join(", #")}, which this session holds no claim on, so nothing labels it \`parked\` and \`/pick-next\` lists it as free work (#3858) — run \`node ${scriptPath("claim-issue.js")} ${unclaimed[0]}\`, then end again`;
}

/**
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {import("./lib/outstanding-line").Verdict["items"]} items
 */
const newestHandOff = (verdict, items) =>
	newestComment(verdict, items, (c) => parseHandOff(c.body) !== null);

/**
 * @param {string} file
 * @param {number} start
 * @returns {number|null}
 */
function readToolCallCountSince(file, start) {
	try {
		return sinceTime(file, start);
	} catch {
		return null;
	}
}

/**
 * @param {ReturnType<typeof newestHandOff>} newest
 * @param {string} sessionId
 * @param {import("./lib/stop-guard").StopPayload|null} payload
 * @returns {string}
 */
function staleHandOffFault(newest, sessionId, payload) {
	if (!newest) return "";
	const file = sessionTranscript.resolve(payload ?? {}, sessionId);
	const start = readSessionStart(file, sessionId);
	if (start === null || Date.parse(newest.createdAt) >= start) return "";
	if (!file || !readToolCallCountSince(file, start)) return "";
	return `this \`needs input:\` park's newest hand-off on its ticket was posted at ${newest.createdAt}, before this session began or last resumed at ${new Date(start).toISOString()}, so it carries none of the Done and Left since (#2944, #2950) — post this session's own hand-off on the issue the park waits on:\n\n${HAND_OFF_SHAPE}`;
}

/**
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {string|undefined} pointed
 * @param {string} sessionId
 * @param {import("./lib/stop-guard").StopPayload|null} payload
 * @returns {string}
 */
function parkFault(verdict, pointed, sessionId, payload) {
	if (verdict.items.length === 0)
		return `this \`needs input:\` park cites no issue, so no hand-off can sit on its ticket (#2391) — list the issue the park waits on, and post the hand-off there:\n\n${HAND_OFF_SHAPE}`;
	const newest = newestHandOff(verdict, verdict.items);
	if (!newest && hasUnchecked(verdict)) return "";
	return (
		staleHandOffFault(newest, sessionId, payload) ||
		handOffFault(
			newest?.body ?? "",
			pointed,
			sessionId,
			sessionTree(payload ?? {}),
		)
	);
}

/** @typedef {{ piece: "posted" | "claimed" | "hand-off", reason: string }} ParkFault */

/** @typedef {{ fault: ParkFault|null, judgedIn: ParkFault["piece"][] }} ParkJudging */

/**
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {ReturnType<typeof ending>} end
 * @param {string} sessionId
 * @param {import("./lib/stop-guard").StopPayload|null} payload
 * @returns {ParkJudging}
 */
function roundlessParkFault(verdict, end, sessionId, payload) {
	const own = buildHandOffVerdict(verdict, end.payload);
	const onHold = own !== verdict;
	/** @type {ParkFault["piece"][]} */
	const judgedIn = onHold ? ["claimed", "hand-off"] : ["hand-off"];
	const claim = onHold && holdClaimFault(own, sessionId);
	if (claim) return { fault: { piece: "claimed", reason: claim }, judgedIn };
	const handOff = parkFault(own, pointedQuestion(end), sessionId, payload);
	return {
		fault: handOff ? { piece: "hand-off", reason: handOff } : null,
		judgedIn,
	};
}

/**
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {{number: string, title: string}} question
 * @param {string} sessionId
 * @param {import("./lib/stop-guard").StopPayload|null} payload
 * @returns {ParkFault|null}
 */
function roundFault(verdict, question, sessionId, payload) {
	const { number, title } = question;
	const holders = roundHolders(verdict, question);
	if (holders.length > 0) {
		const unclaimed = claimOwedOn(holders, sessionId);
		if (unclaimed.length === 0) {
			const reason =
				staleHandOffFault(
					newestHandOff(verdict, holders),
					sessionId,
					payload,
				) ||
				handOffFault(
					newestComment(verdict, holders, (c) => holdsRound(c, title))?.body ??
						"",
					number,
					sessionId,
					sessionTree(payload ?? {}),
				);
			return reason ? { piece: "hand-off", reason } : null;
		}
		return {
			piece: "claimed",
			reason: `this \`needs input:\` ending's round sits on #${unclaimed.join(", #")}, which this session holds no claim on, so \`/pick-next\` lists it as free work and a second session re-asks the round (#1066) — run \`node ${scriptPath("claim-issue.js")} ${unclaimed[0]}\`, then end again. Where it refuses on a live holder, that session is already asking: stop and report the collision`,
		};
	}
	if (hasUnchecked(verdict)) return null;
	return {
		piece: "posted",
		reason: `this \`needs input:\` ending asks a question round, but no issue the block cites holds it among its newest five comments — post the round (\`❓ **Q${number}** ${title}\` through its options) as a comment on the issue that carries the decision, and list that issue: \`- #N (answer Q${number}, round posted on the issue)\``,
	};
}

// #4035 guess
const TAIL_ECHO_MAX = 200;

/**
 * @param {string} text
 * @returns {string}
 */
function cappedForEcho(text) {
	const chars = [...text];
	return chars.length <= TAIL_ECHO_MAX
		? text
		: `${chars.slice(0, TAIL_ECHO_MAX).join("")}… (${chars.length - TAIL_ECHO_MAX} more characters)`;
}

/**
 * @param {string} payload
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
	const m = TAIL_REFS_RE.exec(payload.split(/[\n\r\u2028\u2029]/).pop() ?? "");
	if (!m) return [`the status line ends with no tail: ${INVENTORY.statusTail}`];
	if (verdict.refusals.some((r) => !r.ref)) return [];
	const refsText = trimRun(requiredGroup(m, 1, TAIL_REFS_RE), " \t");
	const tail = refsText.endsWith(".") ? refsText.slice(0, -1) : refsText;
	const tokens = tail.split(/[\s,;]+/).filter((t) => t && !/^and$/i.test(t));
	const refs = tokens.map((t) => readCanonicalRef(t));
	if (refs.length === 0 || refs.includes(null))
		return [
			`the status line's tail lists issue refs only, \`— waits on you: #N, owner/repo#M\` — read: \`${cappedForEcho(tail)}\``,
		];
	const want = new Set(verdict.items.map((i) => i.ref));
	const got = new Set(refs);
	if (want.size === got.size && [...want].every((r) => got.has(r))) return [];
	return [
		`the status line's tail lists ${cappedForEcho([...got].join(", "))} where the block lists ${cappedForEcho(listed) || "nothing"} — both name the same issues`,
	];
}

/**
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
 * @param {ReturnType<typeof ending>} end
 * @param {boolean} owed
 * @returns {ReturnType<typeof assess>}
 */
function blocklessAssessment(end, owed) {
	if (!owed) return { faults: "", verdict: null, question: null, judged: {} };
	const faults = buildRefusalText({
		...judge("", { grammar: "block", shapeOnly: true }),
		refusals: [
			{
				reason: `this \`${end.marker}\` ending in a background job carries no \`waits on you:\` block (plain, never bold or quoted)`,
			},
		],
	});
	return {
		faults,
		verdict: null,
		question: null,
		judged: { block: "missing" },
	};
}

/**
 * @param {string} message
 * @param {ReturnType<typeof ending>} end
 * @param {string} sessionId
 * @param {import("./lib/stop-guard").StopPayload|null} payload
 * @returns {{faults: string, verdict: import("./lib/outstanding-line").Verdict|null, question: ReturnType<typeof firstQuestion>, judged: Judgement}}
 */
function assess(message, end, sessionId, payload) {
	const owed = isOwed(end);
	if (end.header < 0) return blocklessAssessment(end, owed);
	/** @type {Judgement} */
	const judged = {};
	const mine = placementFaults(end);
	const parks = owed && end.marker === "needs input:";
	const question = parks ? firstQuestion(message) : null;
	const verdict = judge(end.body, { grammar: "block", comments: parks });
	judged.block =
		mine.length > 0 || verdict.refusals.length > 0 ? "missing" : "met";
	if (owed) {
		const tail = tailFaults(end.payload, verdict);
		for (const reason of tail) mine.push({ reason });
		judged.status = tail.length > 0 ? "missing" : "met";
	}
	if (parks && verdict.refusals.length === 0) {
		const judging = parkFaultOf(verdict, end, question, { sessionId, payload });
		const { fault } = judging;
		Object.assign(judged, parkJudgement(judging));
		if (fault) mine.push({ reason: fault.reason });
	}
	const refusals = [...mine, ...verdict.refusals];
	return {
		faults:
			refusals.length > 0 ? buildRefusalText({ ...verdict, refusals }) : "",
		verdict,
		question,
		judged,
	};
}

/** @typedef {import("./lib/needs-input-shape").Judgement} Judgement */

/**
 * @param {import("./lib/outstanding-line").Verdict} verdict
 * @param {ReturnType<typeof ending>} end
 * @param {ReturnType<typeof firstQuestion>} question
 * @param {{ sessionId: string, payload: import("./lib/stop-guard").StopPayload|null }} who
 * @returns {ParkJudging}
 */
const parkFaultOf = (verdict, end, question, { sessionId, payload }) =>
	question === null
		? roundlessParkFault(verdict, end, sessionId, payload)
		: {
				fault: roundFault(verdict, question, sessionId, payload),
				judgedIn: ["posted", "claimed", "hand-off"],
			};

/**
 * @param {ParkJudging} judging
 * @returns {Judgement}
 */
function parkJudgement({ fault, judgedIn }) {
	const at = fault ? judgedIn.indexOf(fault.piece) : judgedIn.length;
	/** @type {Judgement} */
	const judged = {};
	for (const piece of judgedIn.slice(0, at)) judged[piece] = "met";
	if (fault) judged[fault.piece] = "missing";
	return judged;
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
const isOwed = (end) => isBackgroundJob(process.env) && OWED.has(end.marker);

/**
 * @param {string} message
 * @param {string} sessionId
 */
function hasPassingInventory(message, sessionId) {
	const end = ending(message);
	return end.header >= 0 && refusal(message, end, sessionId, null) === "";
}

const INVENTORY_PREFIX = ".inventory-nagged-";
const DRAFT_PREFIX = ".inventory-draft-nagged-";

/**
 * @param {{ sessionId: string, message: string, end: ReturnType<typeof ending>,
 *   payload: import("./lib/stop-guard").StopPayload|null, judged: Judgement,
 *   prefix: string, max?: number }} turn
 * @returns {string}
 */
function checklistTail({
	sessionId,
	message,
	end,
	payload,
	judged,
	prefix,
	max,
}) {
	if (!isOwed(end) || end.marker !== "needs input:") return "";
	if (hookBlock.capSpent({ prefix, sessionId, max })) return "";
	const transcript =
		sessionTranscript.resolve(payload ?? {}, sessionId) ?? undefined;
	return shareChecklist({
		sessionId,
		message,
		payload: end.payload,
		transcript,
		judged,
	});
}

/** @param {{sessionId: string, message: string, payload: import("./lib/stop-guard").StopPayload|null}} ctx */
function review({ sessionId, message, payload }) {
	const end = ending(message);
	const owed = isOwed(end);
	const { faults, judged } = assess(message, end, sessionId, payload);
	const turn = { sessionId, message, end, payload, judged };
	if (
		faults &&
		hookBlock.blockStop({
			prefix: INVENTORY_PREFIX,
			sessionId,
			reason: `${LEAD}\n\n${faults}\n${PLACEMENT}\n\n${readDeliverableRule("guard-inventory")}${checklistTail({ ...turn, prefix: INVENTORY_PREFIX })}`,
		})
	)
		return;
	if (!owed || !end.nothing) return;
	const act = draftActSentence(sessionTurns(payload, sessionId, message));
	if (!act) return;
	hookBlock.blockStop({
		prefix: DRAFT_PREFIX,
		sessionId,
		reason: `${LEAD}\n\nThis ending says ${INVENTORY.nothingText}, but this session handed the founder a draft and told them to act on it:\n\n> ${act}\n\nIf it is still the founder's to do, list the open issue that carries it, in the block and the status-line tail, filing one now with the draft verbatim where none does. If it is done, end again: this refuses once a session.\n\n${readDeliverableRule("guard-inventory")}${checklistTail({ ...turn, prefix: DRAFT_PREFIX, max: 1 })}`,
		max: 1,
	});
}

/**
 * @param {string} message
 * @param {string} sessionId
 * @returns {number[]}
 */
function parkTargets(message, sessionId) {
	const end = ending(message);
	if (!isOwed(end) || end.marker !== "needs input:") return [];
	const { faults, verdict, question } = assess(message, end, sessionId, null);
	if (faults || !verdict) return [];
	if (question)
		return (
			trackerClaims(roundHolders(verdict, question), sessionId)?.mine ?? []
		);
	return findOwnHold(end.payload)
		? (trackerClaims(verdict.items, sessionId)?.mine ?? [])
		: [];
}

module.exports = { hasPassingInventory, parkTargets };

if (require.main === module) stopGuard.onMessage({ review });
