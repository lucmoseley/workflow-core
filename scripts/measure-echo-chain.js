#!/usr/bin/env node
/*
 * measure-echo-chain.js — re-derives the accuracy figures behind
 * scripts/lib/echo-chain.js's chain rule (mantahostels#2570), whose rows are on
 * mantahostels#2616, and with --read-chains the Read rows #1090 ruled on.
 *
 * HAND-ONLY, and not a checker: it reads the founder's transcript corpus, which
 * exists on this machine and on no runner, and it reaches no verdict — it
 * prints numbers a human compares against those rows.
 *
 *   node scripts/measure-echo-chain.js [--root <dir>] [--read-chains]
 *
 * WHAT IT SIMULATES. For each transcript, every Bash and Read tool call in the
 * main thread, paired with the tool_result that answered it. The rule under
 * test denies a call whose signature has already returned the same response
 * hash on each of its last N runs; the deny is then scored against what the
 * response ACTUALLY was — identical means a wasted call correctly refused, a
 * different one means real information refused. A deny the transcript never
 * answers, or answers with the live guard's own refusal, is UNSCORED, not
 * counted wrong: whether it would have repeated is unknowable, and calling it
 * wrong would bias every figure downward.
 *
 * THE POPULATION IS TOP-LEVEL TRANSCRIPTS ONLY. `<session>.jsonl` directly
 * under the root, never the `<session>/subagents/agent-*.jsonl` beneath it —
 * there are thousands of those and this reads none of them. A subagent is its
 * own session with its own chain, so its calls are not this session's cost;
 * `isSidechain` records inside a top-level file are dropped for the same
 * reason.
 *
 * IT IS A SIMULATION, NOT THE GUARD. Six deliberate differences, none of which
 * this can measure the size of:
 *   * a transcript records the tool_result the SESSION saw, which is not
 *     byte-for-byte the PostToolUse `tool_response` the guard hashes;
 *   * no volatile-field projection, because a transcript's result is text;
 *   * the escalation (a first deny clears the chain, a second does not) is
 *     modelled as a plain reset — scoring a deny the session never reached
 *     would count one refusal twice;
 *   * no MAX_AGE_S and no MAX_LINES, so this scores refusals the guard's
 *     hour-old and 200-record bounds would have dropped the chain for;
 *   * signatures are `JSON.stringify` in insertion order where the guard's
 *     sort keys, so two inputs the guard treats as one may split here;
 *   * the headline rows score a Read on its input alone, with no file-state
 *     signature (#1058) and the short circuit resetting rather than folding
 *     in (#1090): only the --read-chains rows model the deployed Read rule.
 *
 * THE FIGURES DRIFT. The corpus grows by a few dozen transcripts a day, so a
 * re-run months later will not reproduce the printed numbers exactly.
 * mantahostels#2616 states the population it was measured over; compare shape,
 * not digits.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { isNeighbours } = require("./lib/echo-chain.js");
const { slugForRepo } = require("./lib/project-slug");

/* Derived, never spelled: scripts/lib/project-slug-scan.test.ts scans this tree for
 * the founder's own slug written out (mantahostels#2008). */
const DEFAULT_ROOT = path.join(
	process.env.HOME || path.join(path.sep, "root"),
	".claude",
	"projects",
	slugForRepo(),
);

const { flags } = parseOrExit(process.argv.slice(2), {
	usage:
		"usage: node scripts/measure-echo-chain.js [--root <dir>] [--read-chains]",
	flags: { "--root": "value", "--read-chains": "boolean" },
});
const ROOT = flagValue(flags, "--root") ?? DEFAULT_ROOT;
if (!fs.existsSync(ROOT)) {
	console.error(`no corpus at ${ROOT} — pass --root <dir>`);
	process.exit(1);
}

/** @param {string} s */
const hash = (s) =>
	crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
/** @param {unknown} v */
const norm = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const TOOLS = new Set(["Bash", "Read"]);
/* The file-writing tools, tracked only to attribute a wrong refusal: a Read the
 * fold refuses whose file THIS SESSION edited since is a different failure from
 * one changed by a route the transcript cannot show. A Bash-route write is one
 * of the latter here, deliberately — matching a path out of a command line is
 * guesswork. These two and no others, on a census of the corpus (mantahostels#2637): a
 * `NotebookEdit` would arrive under `notebook_path` rather than the `file_path`
 * read below, and the corpus holds none. */
const WRITERS = new Set(["Edit", "Write"]);

/* What the SESSION is shown when the harness short-circuits a re-read of an
 * unchanged file — the transcript's counterpart of the PostToolUse
 * `type: "file_unchanged"` payload the guard sees (mantahostels#2637). One wording across
 * the corpus, exactly this; a reworded one upstream reads as an ordinary answer
 * and quietly stops --read-chains modelling anything. */
const SHORT_CIRCUIT =
	"Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";

/* lib/echo-call.js's own refusal, which a transcript records as the refused
 * call's tool_result: an error result opening with this, behind the harness's
 * `PreToolUse:<tool> hook error: ` where it adds one. The call never ran, so it
 * is dropped as unanswered (#1087). Anchored and error-only because a file or
 * diff that quotes the guard, read in an ordinary result, is a real answer.
 *
 * RESIDUAL: the guard's wording and the harness's prefix, copied and checked
 * by nothing. A reworded one, or a refusal recorded as an array of content
 * blocks (none of the corpus's 80 is), reads as an answer again and counts
 * wrong. */
const ECHO_REFUSAL =
	/^(PreToolUse:\w+ hook error: )?This exact call has already run twice in a row/;

/**
 * The deployed rule's two skipped shapes: the timed beat and the bare no-op
 * belong to lib/agent-poll.js and this rule never sees them. Measuring
 * without the skip inflates every arm below.
 *
 * @param {string} tool
 * @param {{ command?: unknown }} input
 */
const skipped = (tool, input) =>
	isNeighbours(tool, String(input?.command ?? ""));

/**
 * Every (call, response hash) pair in one transcript, in order — or null where
 * the file could not be read at all, which the caller counts rather than
 * folding silently into the population.
 *
 * @param {string} file
 */
function readTranscript(file) {
	const lines = readLines(file);
	if (lines === null) return null;
	/** @type {Map<string, string>} */
	const results = new Map();
	/** @type {Set<string>} */
	const shortCircuits = new Set();
	/** Turns on which this session edited a path through a file-writing tool.
	 * @type {Map<string, number[]>} */
	const edits = new Map();
	/** @type {{ turn: number, sig: string, id: string, path?: string }[]} */
	const calls = [];
	let turn = 0;
	for (const line of lines) {
		const d = mainThreadRecord(line);
		if (!d || !Array.isArray(d.message.content)) continue;
		if (d.type === "assistant") turn++;
		recordBlocks(d, turn, { calls, results, shortCircuits, edits });
	}
	return { calls, results, shortCircuits, edits, turns: turn };
}

/**
 * @typedef {any} TranscriptRecord One parsed transcript line. `any` because
 * JSON.parse types nothing and each field is read and guarded where it is used.
 * @typedef {any} ContentBlock One block of a record's `message.content`,
 * `any` for the same reason: its shape varies by `type`, checked before use.
 */

/**
 * One main-thread record's content blocks: an assistant's tool calls, or a
 * user's tool results.
 *
 * @param {TranscriptRecord} d the record, its `message.content` an array
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
 * @returns {string[] | null}
 */
function readLines(file) {
	try {
		return fs.readFileSync(file, "utf8").split("\n");
	} catch {
		return null;
	}
}

/**
 * One transcript line's record where it belongs to the main thread and carries
 * a message, else null — a blank or unparseable line included.
 *
 * @param {string} jsonLine
 * @returns {TranscriptRecord}
 */
function mainThreadRecord(jsonLine) {
	if (!jsonLine) return null;
	let d;
	try {
		d = JSON.parse(jsonLine);
	} catch {
		return null;
	}
	if (d.isSidechain) return null;
	const m = d.message;
	if (!m || typeof m !== "object") return null;
	return d;
}

/**
 * One assistant content block: a file-writing call into `edits`, a measured
 * Bash or Read call into `calls`.
 *
 * @param {ContentBlock} b
 * @param {number} turn
 * @param {{ edits: Map<string, number[]>, calls: { turn: number, sig: string, id: string, path?: string }[] }} into accumulator: the edit's turn and the measured call are added
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
 * One user content block: a tool_result's response hash, and whether it was
 * the harness's short circuit. The echo guard's own refusal is dropped.
 *
 * @param {ContentBlock} b
 * @param {{ results: Map<string, string>, shortCircuits: Set<string> }} into accumulator: the result's hash and any short circuit are added
 */
function recordToolResult(b, { results, shortCircuits }) {
	if (b.type !== "tool_result") return;
	const text = norm(b.content);
	if (b.is_error && ECHO_REFUSAL.test(text)) return;
	results.set(b.tool_use_id, hash(text));
	if (text.trim() === SHORT_CIRCUIT) shortCircuits.add(b.tool_use_id);
}

/**
 * Whether this answer continues the chain rather than starting a new one — the
 * same test on both sides of a refusal, and in the --read-chains walk below.
 *
 * @param {{ hash: string }} st
 * @param {string} res
 * @param {boolean} same the harness short-circuited this Read, and `fold` is on
 */
const extendsChain = (st, res, same) => st.hash === res || same;

/**
 * Score rule R(n, gap) over the corpus. `gap` is the proximity window in turns;
 * Infinity is the deployed rule, which has none.
 *
 * `only` restricts the population to one tool. `fold` is mantahostels#2637's change: a Read
 * the harness short-circuited counts as the same answer again rather than a new
 * one, both when a chain is extended and when a refusal is scored.
 *
 * A wrong refusal is attributed where it can be: `ownEdit` counts those whose
 * file this session edited while the chain was forming, the rest being a file
 * that changed by a route the transcript never shows. It is an UPPER BOUND and
 * turn-granular — an edit that failed still counts, and so does one sharing a
 * turn with the read at either end of the chain.
 *
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
 * One transcript's refusals under rule R(n, gap), into `tally` — `score`'s
 * docstring.
 *
 * @param {{ file: string, calls: Call[], results: Map<string, string>, shortCircuits: Set<string>, edits: Map<string, number[]> }} transcript
 * @param {{ n: number, gap: number, only?: string, fold?: boolean }} rule
 * @param {Tally} tally accumulator: refusals are scored and the session added
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
		// An unanswered call is no evidence and leaves the chain untouched,
		// exactly as lib/echo-chain.js's responseHash returning null does —
		// lib/echo-record.js stops before its store on that path.
		if (res === undefined) continue;
		if (st && extendsChain(st, res, same)) {
			st.run++;
			st.turn = c.turn;
		} else state.set(c.sig, { hash: res, run: 1, turn: c.turn, from: c.turn });
	}
}

/**
 * The call's signature's chain, cleared first where the call falls outside the
 * proximity window.
 *
 * @param {Map<string, Chain>} state accumulator: the walk's live chains, a stale one deleted
 * @param {Call} c
 * @param {number} gap
 * @returns {Chain | undefined}
 */
function liveChain(state, c, gap) {
	const st = state.get(c.sig);
	// Cleared, and the local with it — a stale `st` in `scoreTranscript`
	// would bump a record no longer in the map, losing the call entirely.
	if (st && c.turn - st.turn > gap) {
		state.delete(c.sig);
		return;
	}
	return st;
}

/**
 * @param {Tally} tally accumulator: counts the refusal as right, wrong or unscored
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

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".jsonl"));
const transcripts = [];
let unreadable = 0;
for (const f of files) {
	const t = readTranscript(path.join(ROOT, f));
	if (t === null) unreadable++;
	else if (t.turns) transcripts.push({ file: f, ...t });
}

/** @param {string} label @param {ReturnType<typeof score>} r */
const line = (label, r) =>
	`${label.padEnd(34)} denies=${String(r.denies).padStart(5)}  right=${String(r.right).padStart(5)} (${r.pct.toFixed(1)}%)  wrong=${String(r.wrong).padStart(4)}  unscored=${String(r.unscored).padStart(3)}  sessions=${r.sessions}`;

console.log(`corpus root : ${ROOT}`);
console.log(
	`transcripts : ${files.length} top-level (${transcripts.length} with a main-thread turn, ${unreadable} unreadable)`,
);
console.log(`measured    : ${new Date().toISOString().slice(0, 10)}`);
console.log("tools       : Bash + Read, the poll guard's two shapes skipped");
console.log("");
for (const n of [1, 2, 3])
	console.log(
		line(
			`N=${n} identical responses`,
			score(transcripts, n, Number.POSITIVE_INFINITY),
		),
	);
console.log("");
console.log(line("N=2, 5-turn proximity window", score(transcripts, 2, 5)));

/*
 * --read-chains: the Read limb alone, which is the question mantahostels#2637 asks. The
 * transcript records the short circuit as SHORT_CIRCUIT above, a different
 * answer from the file itself, so each pair of rows below differs only in
 * whether it folds into the chain.
 *
 * THE HISTOGRAM IS THE SHAPE BEHIND THE PRICE, and it is walked under the fold
 * with no refusal ever interrupting it, so it is NOT a count of refusals. A
 * chain of length 2 is one that armed the fold's guard and then ended — the
 * call after it was refused, and answered something new, or never came.
 */
if (flags["--read-chains"]) {
	/** @param {string} label @param {ReturnType<typeof score>} r */
	const readRow = (label, r) =>
		console.log(
			`${line(`  ${label}`, r)}  (${r.ownEdit} of the wrong ones follow this session's own edit)`,
		);
	console.log("");
	console.log("Read only, N=2 — the limb mantahostels#2637 moves:");
	for (const fold of [false, true]) {
		readRow(
			`short circuit ${fold ? "folded in (mantahostels#2637)" : "resets (before #1058)"}`,
			score(transcripts, 2, Number.POSITIVE_INFINITY, { only: "Read", fold }),
		);
	}

	/* #1058 signs a Read with the file's on-disk state, which no transcript
	 * records. Modelled from the answers: a full read differing from that
	 * signature's last full read means the file changed, so the call starts a
	 * new signature; a short circuit, an identical full read or no answer means
	 * it did not. So `wrong` is near zero by construction: these rows price the
	 * refusals kept, not the signature's accuracy. RESIDUALS, both ways: a file
	 * rewritten with identical bytes, or touched, is a new signature to the
	 * guard and the same one here, so the guard refuses less than these rows
	 * say; bytes changed with inode, size and both times unchanged is the
	 * reverse. */
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

	/* Maximal run lengths under the fold, uninterrupted by any refusal: how long
	 * a Read chain gets when nothing stops it. Chains of length 1 are dropped —
	 * they are every Read in the corpus that was never repeated, and they bury
	 * the counts that matter. */
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
	console.log("");
	console.log("Read chain lengths, short circuit folded in:");
	for (const l of lengths)
		console.log(
			`  ${String(l).padStart(4)} identical answers in a row : ${hist.get(l)}`,
		);
}
