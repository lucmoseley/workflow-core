#!/usr/bin/env node
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const crypto = require("node:crypto");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { isNeighbours } = require("./lib/echo-chain.js");
const { parseJsonl } = require("./lib/jsonl.js");
const { corpusDirs, listTranscripts } = require("./lib/project-dirs");

const { flags } = parseOrExit(process.argv.slice(2), {
	usage:
		"usage: node scripts/measure-echo-chain.js [--root <dir>] [--read-chains]",
	flags: { "--root": "value", "--read-chains": "boolean" },
});
const given = flagValue(flags, "--root");
const ROOTS = corpusDirs(
	given,
	path.join(process.env.HOME || path.join(path.sep, "root"), ".claude"),
);
const listing = listTranscripts(ROOTS);
const missed = [...listing.absent, ...listing.unreadable];
if (missed.length > 0) {
	writeFd(2, `no corpus at ${missed.join(", ")} — pass --root <dir>\n`);
	process.exit(1);
}

/** @param {string} s */
const hash = (s) =>
	crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
/** @param {unknown} v */
const norm = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const TOOLS = new Set(["Bash", "Read"]);
const WRITERS = new Set(["Edit", "Write"]);

const SHORT_CIRCUIT =
	"Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";

const ECHO_REFUSAL =
	/^(PreToolUse:\w+ hook error: )?This exact call has already run twice in a row/;

/**
 * @param {string} tool
 * @param {{ command?: unknown }} input
 */
const skipped = (tool, input) =>
	isNeighbours(tool, String(input?.command ?? ""));

/** @param {string} file */
function readTranscript(file) {
	const rows = readRows(file);
	if (rows === null) return null;
	/** @type {Map<string, string>} */
	const results = new Map();
	/** @type {Set<string>} */
	const shortCircuits = new Set();
	/** @type {Map<string, number[]>} */
	const edits = new Map();
	/** @type {{ turn: number, sig: string, id: string, path?: string }[]} */
	const calls = [];
	let turn = 0;
	for (const row of rows) {
		const d = mainThreadRecord(row);
		if (!d || !Array.isArray(d.message.content)) continue;
		if (d.type === "assistant") turn++;
		recordBlocks(d, turn, { calls, results, shortCircuits, edits });
	}
	return { calls, results, shortCircuits, edits, turns: turn };
}

/**
 * @typedef {import("./lib/transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./lib/transcript.js").TranscriptBlock} TranscriptBlock
 */

/**
 * @param {TranscriptRecord} d
 * @param {number} turn
 * @param {{ calls: { turn: number, sig: string, id: string, path?: string }[], results: Map<string, string>, shortCircuits: Set<string>, edits: Map<string, number[]> }} into
 */
function recordBlocks(d, turn, into) {
	if (d.type === "assistant")
		for (const b of d.message.content) recordToolUse(b, turn, into);
	else if (d.type === "user")
		for (const b of d.message.content) recordToolResult(b, into);
}

/**
 * @param {string} file
 * @returns {TranscriptRecord[] | null}
 */
function readRows(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	return parseJsonl(text).rows;
}

/**
 * @param {TranscriptRecord} d
 * @returns {TranscriptRecord | null}
 */
function mainThreadRecord(d) {
	if (d.isSidechain) return null;
	const m = d.message;
	if (!m || typeof m !== "object") return null;
	return d;
}

/**
 * @param {TranscriptBlock} b
 * @param {number} turn
 * @param {{ edits: Map<string, number[]>, calls: { turn: number, sig: string, id: string, path?: string }[] }} into
 */
function recordToolUse(b, turn, { edits, calls }) {
	if (b.type !== "tool_use") return;
	const filePath =
		typeof b.input?.file_path === "string" ? b.input.file_path : undefined;
	if (WRITERS.has(b.name) && filePath)
		edits.set(filePath, [...(edits.get(filePath) ?? []), turn]);
	if (TOOLS.has(b.name) && !skipped(b.name, b.input))
		calls.push({
			turn,
			sig: `${b.name} ${norm(b.input)}`,
			id: b.id,
			path: filePath,
		});
}

/**
 * @param {TranscriptBlock} b
 * @param {{ results: Map<string, string>, shortCircuits: Set<string> }} into
 */
function recordToolResult(b, { results, shortCircuits }) {
	if (b.type !== "tool_result") return;
	const text = norm(b.content);
	if (b.is_error && ECHO_REFUSAL.test(text)) return;
	results.set(b.tool_use_id, hash(text));
	if (text.trim() === SHORT_CIRCUIT) shortCircuits.add(b.tool_use_id);
}

/**
 * @param {{ hash: string }} st
 * @param {string} res
 * @param {boolean} same
 */
const extendsChain = (st, res, same) => st.hash === res || same;

/**
 * @param {{ file: string, calls: { turn: number, sig: string, id: string, path?: string }[], results: Map<string, string>, shortCircuits: Set<string>, edits: Map<string, number[]> }[]} corpus
 * @param {number} n
 * @param {number} gap
 * @param {{ only?: string, fold?: boolean }} [opts]
 */
function score(corpus, n, gap, opts = {}) {
	const { only, fold } = opts;
	/** @type {Tally} */
	const tally = {
		right: 0,
		wrong: 0,
		ownEdit: 0,
		unscored: 0,
		sessions: new Set(),
	};
	for (const t of corpus) scoreTranscript(t, { n, gap, only, fold }, tally);
	const { right, wrong, ownEdit, unscored, sessions } = tally;
	const denies = right + wrong;
	return {
		denies,
		right,
		wrong,
		ownEdit,
		unscored,
		pct: denies ? (100 * right) / denies : 0,
		sessions: sessions.size,
	};
}

/**
 * @typedef {{ right: number, wrong: number, ownEdit: number, unscored: number,
 *   sessions: Set<string> }} Tally
 * @typedef {{ hash: string, run: number, turn: number, from: number }} Chain
 * @typedef {{ turn: number, sig: string, id: string, path?: string }} Call
 */

/**
 * @param {{ file: string, calls: Call[], results: Map<string, string>, shortCircuits: Set<string>, edits: Map<string, number[]> }} transcript
 * @param {{ n: number, gap: number, only?: string, fold?: boolean }} rule
 * @param {Tally} tally
 */
function scoreTranscript(transcript, rule, tally) {
	const { file, calls, results, shortCircuits, edits } = transcript;
	const { n, gap, only, fold } = rule;
	/** @type {Map<string, Chain>} */
	const state = new Map();
	for (const c of calls) {
		if (only && !c.sig.startsWith(`${only} `)) continue;
		const res = results.get(c.id);
		const same = Boolean(fold) && shortCircuits.has(c.id);
		const st = liveChain(state, c, gap);
		if (st && st.run >= n) {
			scoreRefusal(tally, { st, c, res, same, edits });
			tally.sessions.add(file);
			state.delete(c.sig);
			continue;
		}
		if (res === undefined) continue;
		if (st && extendsChain(st, res, same)) {
			st.run++;
			st.turn = c.turn;
		} else state.set(c.sig, { hash: res, run: 1, turn: c.turn, from: c.turn });
	}
}

/**
 * @param {Map<string, Chain>} state
 * @param {Call} c
 * @param {number} gap
 * @returns {Chain | undefined}
 */
function liveChain(state, c, gap) {
	const st = state.get(c.sig);
	if (st && c.turn - st.turn > gap) {
		state.delete(c.sig);
		return;
	}
	return st;
}

/**
 * @param {Tally} tally
 * @param {{ st: Chain, c: Call, res: string | undefined, same: boolean, edits: Map<string, number[]> }} refusal
 */
function scoreRefusal(tally, { st, c, res, same, edits }) {
	if (res === undefined) tally.unscored++;
	else if (extendsChain(st, res, same)) tally.right++;
	else {
		tally.wrong++;
		if (
			(edits.get(c.path ?? "") ?? []).some((t) => t >= st.from && t <= c.turn)
		)
			tally.ownEdit++;
	}
}

const files = listing.found;
const transcripts = [];
let unreadable = 0;
for (const f of files) {
	const t = readTranscript(f);
	if (t === null) unreadable++;
	else if (t.turns) transcripts.push({ file: path.basename(f), ...t });
}

/** @param {string} label @param {ReturnType<typeof score>} r */
const line = (label, r) =>
	`${label.padEnd(34)} denies=${String(r.denies).padStart(5)}  right=${String(r.right).padStart(5)} (${r.pct.toFixed(1)}%)  wrong=${String(r.wrong).padStart(4)}  unscored=${String(r.unscored).padStart(3)}  sessions=${r.sessions}`;

writeFd(1, `corpus root : ${ROOTS.join(", ")}\n`);
writeFd(
	1,
	`transcripts : ${files.length} top-level (${transcripts.length} with a main-thread turn, ${unreadable} unreadable)\n`,
);
writeFd(1, `measured    : ${new Date().toISOString().slice(0, 10)}\n`);
writeFd(1, "tools       : Bash + Read, the poll guard's two shapes skipped\n");
writeFd(1, "\n");
for (const n of [1, 2, 3])
	writeFd(
		1,
		`${line(
			`N=${n} identical responses`,
			score(transcripts, n, Number.POSITIVE_INFINITY),
		)}\n`,
	);
writeFd(1, "\n");
writeFd(
	1,
	`${line("N=2, 5-turn proximity window", score(transcripts, 2, 5))}\n`,
);

if (flags["--read-chains"]) {
	/** @param {string} label @param {ReturnType<typeof score>} r */
	const readRow = (label, r) =>
		writeFd(
			1,
			`${line(`  ${label}`, r)}  (${r.ownEdit} of the wrong ones follow this session's own edit)\n`,
		);
	writeFd(1, "\n");
	writeFd(1, "Read only, N=2 — the limb mantahostels#2637 moves:\n");
	for (const fold of [false, true]) {
		readRow(
			`short circuit ${fold ? "folded in (mantahostels#2637)" : "resets (before #1058)"}`,
			score(transcripts, 2, Number.POSITIVE_INFINITY, { only: "Read", fold }),
		);
	}

	const keyed = transcripts.map((t) => {
		/** @type {Map<string, { ver: number, full?: string }>} */
		const seen = new Map();
		const calls = t.calls.map((c) => {
			if (!c.sig.startsWith("Read ")) return c;
			const res = t.results.get(c.id);
			const st = seen.get(c.sig) ?? { ver: 0 };
			if (res !== undefined && !t.shortCircuits.has(c.id) && st.full !== res) {
				st.ver++;
				st.full = res;
			}
			seen.set(c.sig, st);
			return { ...c, sig: `${c.sig}\x1f${st.ver}` };
		});
		return { ...t, calls };
	});
	for (const fold of [false, true]) {
		readRow(
			`file state signed, ${fold ? "folded in (deployed, #1090)" : "resets"}`,
			score(keyed, 2, Number.POSITIVE_INFINITY, { only: "Read", fold }),
		);
	}

	/** @type {Map<number, number>} */
	const hist = new Map();
	/** @param {number} r */
	const record = (r) => {
		if (r > 1) hist.set(r, (hist.get(r) ?? 0) + 1);
	};
	for (const { calls, results, shortCircuits } of transcripts) {
		/** @type {Map<string, { hash: string, run: number }>} */
		const state = new Map();
		for (const c of calls) {
			if (!c.sig.startsWith("Read ")) continue;
			const res = results.get(c.id);
			if (res === undefined) continue;
			const st = state.get(c.sig);
			if (st && extendsChain(st, res, shortCircuits.has(c.id))) st.run++;
			else {
				if (st) record(st.run);
				state.set(c.sig, { hash: res, run: 1 });
			}
		}
		for (const st of state.values()) record(st.run);
	}
	const lengths = [...hist.keys()].sort((a, b) => a - b);
	writeFd(1, "\n");
	writeFd(1, "Read chain lengths, short circuit folded in:\n");
	for (const l of lengths)
		writeFd(
			1,
			`  ${String(l).padStart(4)} identical answers in a row : ${hist.get(l)}\n`,
		);
}
