#!/usr/bin/env node
/*
 * measure-gate-judge.js — the gate judge (lib/gate-judge.js, #4964) held to
 * account: its rates on the labelled set, and its reading of every issue body
 * in the tracker.
 *
 *   node scripts/measure-gate-judge.js validate [--part held-out|development]
 *        [--runs <n>] [--jobs <n>] [--bound-ms <n>]
 *   node scripts/measure-gate-judge.js corpus --dir <dir> [--jobs <n>] [--bound-ms <n>]
 *   node scripts/measure-gate-judge.js tally --dir <dir>
 *
 * validate  runs each case of one part of scripts/fixtures/gate-judge-cases.json
 *           `--runs` times (3: the plugin-evals default,
 *           docs/practice/llm-agent-design.md) and prints, each with its count
 *           and Wilson 95% interval over cases: the hit rate on waits, the
 *           false-flag rate on non-waits, the share of restated and asserted
 *           bases flagged, the false-refusal rate on derived and inherited
 *           ones, the share of cases whose runs agree and the share of replies
 *           with a dropped quote. A case counts by the majority of its runs.
 *           The held-out part is run against a frozen prompt; re-run it after
 *           a prompt change and compare by the prompt's printed hash.
 * corpus    fetches every issue body, open and closed, into <dir>/all.json
 *           and sends each through the judge once, appending to
 *           <dir>/results-*.jsonl. Re-run, it takes up where it stopped. Run
 *           it detached (scripts/bg-run.sh). <dir> is scratch: the corpus is
 *           never committed.
 * tally     prints the corpus run's counts and latency, and writes the lists
 *           to classify by hand beside the results.
 *
 * Every call spends a Haiku turn on this session's seat, each a child of
 * about 260 MB for about 6 s (measured on 2.1.322); `--jobs` is how many run
 * at once, 2 unless given, to be sized from MemAvailable at the time.
 *
 * In no family (§N3): it measures, gates nothing and files nothing. No suite
 * or gate runs it.
 */

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { parseOrCode } = require("./lib/cli-args.js");
const {
	buildPrompt,
	mergeFaults,
	readJudge,
	readingFaults,
} = require("./lib/gate-judge.js");
const { ghJson } = require("./lib/gh.js");
const { basisFaults } = require("./lib/issue-gate.js");
const { parseJsonl } = require("./lib/jsonl.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

const SELF = scriptPath("measure-gate-judge.js");
const USAGE = [
	`usage: node ${SELF} validate [--part held-out|development] [--runs <n>] [--jobs <n>] [--bound-ms <n>]`,
	`       node ${SELF} corpus --dir <dir> [--jobs <n>] [--bound-ms <n>]`,
	`       node ${SELF} tally --dir <dir>`,
].join("\n");

const CASES = path.join(__dirname, "fixtures", "gate-judge-cases.json");
/* Under the create guard's 60 s hook limit, so the latency measured is not cut
 * short of what a route could ever wait. */
const MEASURING_BOUND_MS = 55_000;
const DEFAULT_JOBS = 2;
const DEFAULT_RUNS = 3;
/* GitHub's list ceiling here is far over the tracker's ~5,000 issues. */
const CORPUS_LIMIT = 20_000;
const PROGRESS_MS = 60_000;

/**
 * @typedef {{key: string, body: string, own: number|null}} Item
 * @typedef {import("./lib/gate-judge.js").JudgedFault} JudgedFault
 * @typedef {{key: string, ms: number, fallback: string|null, dropped: number,
 *   replied: number, waits: string[], bases: {basis: string, class: string}[],
 *   model: JudgedFault[], added: JudgedFault[]}} Row
 *   `replied`: the quotes the model gave; `waits` and `bases`: those kept;
 *   `model`: the faults they raise; `added`: those the patterns do not
 *   already raise
 */

/** @param {string} text */
const out = (text) => writeFd(1, `${text}\n`);

/**
 * @param {string} file
 * @returns {Record<string, unknown>[]}
 */
function readRows(file) {
	return fs.existsSync(file)
		? parseJsonl(fs.readFileSync(file, "utf8")).rows
		: [];
}

/**
 * One item through the judge.
 * @param {Item} item
 * @param {number} boundMs
 * @returns {Row}
 */
function judgeItem(item, boundMs) {
	const own = item.own ?? undefined;
	const startedAt = Date.now();
	const read = readJudge(item.body, { boundMs });
	const ms = Date.now() - startedAt;
	const empty = {
		dropped: 0,
		replied: 0,
		waits: [],
		bases: [],
		model: [],
		added: [],
	};
	if ("why" in read) return { key: item.key, ms, fallback: read.why, ...empty };
	const judged = readingFaults(item.body, read.reading, own);
	const patterns = basisFaults(item.body, own);
	return {
		key: item.key,
		ms,
		fallback: null,
		dropped: judged.dropped,
		replied: read.reading.waits.length + read.reading.bases.length,
		waits: judged.waits.map((w) => w.sentence),
		bases: judged.bases,
		model: judged.faults,
		added: mergeFaults(patterns, judged.faults).filter((f) => f.by === "model"),
	};
}

/**
 * The worker: each item of `--in` not yet in `--out`, judged and appended.
 * @param {string} inFile
 * @param {string} outFile
 * @param {number} boundMs
 */
function runWorker(inFile, outFile, boundMs) {
	const done = new Set(readRows(outFile).map((r) => r.key));
	for (const item of /** @type {Item[]} */ (
		/** @type {unknown} */ (readRows(inFile))
	)) {
		if (done.has(item.key)) continue;
		fs.appendFileSync(outFile, `${JSON.stringify(judgeItem(item, boundMs))}\n`);
	}
	return 0;
}

/**
 * `items` through `jobs` workers at once, into `<dir>/results-<i>.jsonl`.
 * @param {Item[]} items
 * @param {{dir: string, jobs: number, boundMs: number}} opts
 * @returns {Promise<Row[]>} every row the directory now holds for `items`
 */
async function judgeAll(items, { dir, jobs, boundMs }) {
	fs.mkdirSync(dir, { recursive: true });
	const results = (/** @type {number} */ i) =>
		path.join(dir, `results-${i}.jsonl`);
	const readAll = () =>
		/** @type {Row[]} */ (
			/** @type {unknown} */ (
				Array.from({ length: jobs }, (_, i) => readRows(results(i))).flat()
			)
		);
	const done = new Set(readAll().map((r) => r.key));
	const left = items.filter((item) => !done.has(item.key));
	const ticker = setInterval(
		() => out(`  ${readAll().length} of ${items.length} judged`),
		PROGRESS_MS,
	);
	try {
		await Promise.all(
			Array.from({ length: jobs }, (_, i) => {
				const inFile = path.join(dir, `items-${i}.jsonl`);
				fs.writeFileSync(
					inFile,
					left
						.filter((_item, at) => at % jobs === i)
						.map((item) => `${JSON.stringify(item)}\n`)
						.join(""),
				);
				const child = spawn(
					process.execPath,
					[
						__filename,
						"worker",
						"--in",
						inFile,
						"--out",
						results(i),
						"--bound-ms",
						String(boundMs),
					],
					{ stdio: ["ignore", "inherit", "inherit"] },
				);
				return new Promise((resolve, reject) => {
					child.on("error", reject);
					child.on("exit", (code) =>
						code === 0
							? resolve(code)
							: reject(new Error(`worker ${i} exited ${code}`)),
					);
				});
			}),
		);
	} finally {
		clearInterval(ticker);
	}
	const keys = new Set(items.map((item) => item.key));
	return readAll().filter((r) => keys.has(r.key));
}

/**
 * The Wilson 95% interval of `k` in `n`, as shares.
 * @param {number} k
 * @param {number} n
 * @returns {[number, number]}
 */
function wilson(k, n) {
	if (n === 0) return [0, 1];
	const z = 1.959_964;
	const p = k / n;
	const mid = p + (z * z) / (2 * n);
	const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	const denom = 1 + (z * z) / n;
	return [Math.max(0, (mid - half) / denom), Math.min(1, (mid + half) / denom)];
}

/** @param {number} share */
const pct = (share) => `${Math.round(share * 100)}%`;

/**
 * @param {number} k
 * @param {number} n
 */
function rate(k, n) {
	if (n === 0) return "no cases";
	const [lo, hi] = wilson(k, n);
	return `${k} of ${n} = ${pct(k / n)} (${pct(lo)} - ${pct(hi)})`;
}

/**
 * @param {number[]} sorted ascending
 * @param {number} q
 */
const quantile = (sorted, q) =>
	sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** @param {number[]} ms */
function latency(ms) {
	const s = [...ms].sort((a, b) => a - b);
	const sec = (/** @type {number} */ v) => (v / 1000).toFixed(1);
	return `min ${sec(s[0] ?? 0)} s, median ${sec(quantile(s, 0.5))} s, p90 ${sec(quantile(s, 0.9))} s, p95 ${sec(quantile(s, 0.95))} s, p99 ${sec(quantile(s, 0.99))} s, max ${sec(s.at(-1) ?? 0)} s`;
}

const GATE_OR_BASIS_LINE =
	/^[ \t]{0,3}\*\*(?:Gated until|Gated on|Gate basis):\*\*.*$/gim;

/**
 * The prose waits the patterns read in `body`, whatever basis it carries.
 * @param {string} body
 */
const patternWaits = (body) =>
	basisFaults(body.replace(GATE_OR_BASIS_LINE, "")).map((f) => f.text);

const WAIT_LABELS = ["wait", "non-wait"];

/**
 * Whether a reading flags a case: a wait read, for a wait or non-wait case; a
 * basis refused, for a basis case.
 * @param {{label: string}} c
 * @param {Row} row
 */
const isFlagged = (c, row) =>
	WAIT_LABELS.includes(c.label)
		? row.waits.length > 0
		: row.model.some((f) => f.kind === "no-warrant");

/**
 * The same question put to the patterns alone.
 * @param {{label: string, text: string, own: number|null}} c
 */
const isPatternFlagged = (c) =>
	WAIT_LABELS.includes(c.label)
		? patternWaits(c.text).length > 0
		: basisFaults(c.text, c.own ?? undefined).some(
				(f) => f.kind === "no-warrant",
			);

/**
 * @param {{part: string, runs: number, jobs: number, boundMs: number}} opts
 */
async function validate({ part, runs, jobs, boundMs }) {
	/** @type {{id: string, label: string, kind: string, part: string, text: string, own: number|null}[]} */
	const cases = JSON.parse(fs.readFileSync(CASES, "utf8")).cases.filter(
		(/** @type {{part: string}} */ c) => c.part === part,
	);
	const prompt = crypto
		.createHash("sha256")
		.update(buildPrompt(""))
		.digest("hex")
		.slice(0, 12);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = path.join(".claude", "tmp", `gate-judge-validation-${stamp}`);
	const harness = spawnSync(claudeBin(), ["--version"], {
		encoding: "utf8",
	}).stdout.trim();
	out(
		`${cases.length} ${part} cases x ${runs} runs, ${jobs} at once, prompt ${prompt}, ${harness}; rows in ${dir}`,
	);
	const rows = await judgeAll(
		cases.flatMap((c) =>
			Array.from({ length: runs }, (_, r) => ({
				key: `${c.id}#${r}`,
				body: c.text,
				own: c.own,
			})),
		),
		{ dir, jobs, boundMs },
	);
	const scored = cases.map((c) => {
		const mine = rows.filter(
			(r) => r.key.startsWith(`${c.id}#`) && r.fallback === null,
		);
		const flags = mine.filter((r) => isFlagged(c, r)).length;
		return {
			...c,
			ran: mine.length,
			flags,
			flagged: mine.length > 0 && flags * 2 > mine.length,
			agree: flags === 0 || flags === mine.length,
			patterns: isPatternFlagged(c),
		};
	});
	/**
	 * @param {string} title
	 * @param {string[]} labels
	 * @param {boolean} wantFlagged whether a flag is the right answer
	 */
	const line = (title, labels, wantFlagged) => {
		const of = scored.filter((c) => labels.includes(c.label) && c.ran > 0);
		const wrong = of.filter((c) => c.flagged !== wantFlagged);
		out(`${title}: ${rate(of.filter((c) => c.flagged).length, of.length)}`);
		out(
			`    by run ${of.reduce((n, c) => n + c.flags, 0)} of ${of.reduce((n, c) => n + c.ran, 0)}; the patterns alone ${of.filter((c) => c.patterns).length} of ${of.length}`,
		);
		if (wrong.length > 0)
			out(
				`    on the wrong side: ${wrong.map((c) => `${c.id} (${c.flags}/${c.ran})`).join(", ")}`,
			);
	};
	out("");
	line("Hit rate on waits", ["wait"], true);
	line("False-flag rate on non-waits", ["non-wait"], false);
	line("Restated and asserted bases flagged", ["restated", "asserted"], true);
	line("  restated alone", ["restated"], true);
	line("  asserted alone", ["asserted"], true);
	line(
		"False-refusal rate on derived and inherited bases",
		["derived", "inherited"],
		false,
	);
	line("  derived alone", ["derived"], false);
	line("  inherited alone", ["inherited"], false);
	const ran = scored.filter((c) => c.ran > 0);
	out(
		`Cases whose runs agree: ${rate(ran.filter((c) => c.agree).length, ran.length)}`,
	);
	const replies = rows.filter((r) => r.fallback === null);
	out(
		`Replies with a dropped quote: ${rate(replies.filter((r) => r.dropped > 0).length, replies.length)}`,
	);
	out(
		`Calls that fell back: ${rows.length - replies.length} of ${rows.length}`,
	);
	out(`Latency: ${latency(rows.map((r) => r.ms))}`);
	const escapes = scored.filter((c) =>
		["probe-4963", "uncaught-4949"].includes(c.kind),
	);
	if (escapes.length > 0)
		out(
			`The #4963 and #4949 escapes: ${escapes.map((c) => `${c.id} ${c.flags}/${c.ran}`).join(", ")}`,
		);
	fs.writeFileSync(
		path.join(dir, "scored.json"),
		`${JSON.stringify({ part, runs, prompt, harness, cases: scored.map(({ text: _text, ...c }) => c) }, null, "\t")}\n`,
	);
	return 0;
}

/** @param {string} dir */
function readCorpus(dir) {
	const file = path.join(dir, "all.json");
	if (!fs.existsSync(file)) {
		fs.mkdirSync(dir, { recursive: true });
		const issues = ghJson([
			"issue",
			"list",
			"--state",
			"all",
			"--limit",
			String(CORPUS_LIMIT),
			"--json",
			"number,state,body",
		]);
		fs.writeFileSync(file, JSON.stringify(issues));
	}
	return /** @type {{number: number, state: string, body: string}[]} */ (
		JSON.parse(fs.readFileSync(file, "utf8"))
	);
}

/** @param {{dir: string, jobs: number, boundMs: number}} opts */
async function corpus(opts) {
	const issues = readCorpus(opts.dir);
	out(`${issues.length} bodies, ${opts.jobs} at once; rows in ${opts.dir}`);
	const rows = await judgeAll(
		issues.map((i) => ({
			key: String(i.number),
			body: (i.body ?? "").replace(/\r\n/g, "\n"),
			own: i.number,
		})),
		opts,
	);
	out(`${rows.length} of ${issues.length} judged`);
	return 0;
}

/**
 * Whether two quotes are one finding: either holds the other.
 * @param {string} a
 * @param {string} b
 */
const overlaps = (a, b) => {
	const [x, y] = [a.toLowerCase(), b.toLowerCase()];
	return x.includes(y) || y.includes(x);
};

/** @param {string} text */
const cell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * One body's two readings set side by side, as the rows of the three lists to
 * classify by hand.
 * @param {{number: number, state: string, body: string}} issue
 * @param {Row} row
 */
function compareReadings(issue, row) {
	const body = (issue.body ?? "").replace(/\r\n/g, "\n");
	const patterns = patternWaits(body);
	const at = `| #${issue.number} | ${issue.state} |`;
	const patternBases = basisFaults(body, issue.number)
		.filter((f) => f.kind === "no-warrant")
		.map((f) => f.text);
	return {
		both: row.waits.filter((w) => patterns.some((p) => overlaps(p, w))).length,
		modelOnly: row.waits
			.filter((w) => !patterns.some((p) => overlaps(p, w)))
			.map((w) => `${at} ${cell(w)} | |`),
		patternOnly: patterns
			.filter((p) => !row.waits.some((w) => overlaps(p, w)))
			.map((p) => `${at} ${cell(p)} | |`),
		flagged: row.model
			.filter((m) => m.kind === "no-warrant")
			.map(
				(f) =>
					`${at} ${row.bases.find((b) => b.basis === f.text)?.class ?? "?"} | ${patternBases.includes(f.text) ? "yes" : "no"} | ${cell(f.text)} | |`,
			),
	};
}

/** @param {string} dir */
function tally(dir) {
	const issues = readCorpus(dir);
	const rows = /** @type {Row[]} */ (
		/** @type {unknown} */ (
			fs
				.readdirSync(dir)
				.filter((f) => /^results-\d+\.jsonl$/.test(f))
				.flatMap((f) => readRows(path.join(dir, f)))
		)
	);
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const replies = rows.filter((r) => r.fallback === null);
	const compared = issues.flatMap((issue) => {
		const row = byKey.get(String(issue.number));
		return row && row.fallback === null ? [compareReadings(issue, row)] : [];
	});
	const modelOnly = compared.flatMap((c) => c.modelOnly);
	const patternOnly = compared.flatMap((c) => c.patternOnly);
	const flagged = compared.flatMap((c) => c.flagged);
	const bothWaits = compared.reduce((n, c) => n + c.both, 0);
	const basesRead = replies.reduce((n, r) => n + r.bases.length, 0);
	const bodiesFlagged = replies.filter((r) => r.added.length > 0);
	const lists = [
		[
			"model-only-waits.md",
			"| Issue | State | Sentence the judge read as a wait, the patterns did not | Wait? |\n|---|---|---|---|",
			modelOnly,
		],
		[
			"pattern-only-waits.md",
			"| Issue | State | Wait the patterns read, the judge did not | Wait? |\n|---|---|---|---|",
			patternOnly,
		],
		[
			"bases-flagged.md",
			"| Issue | State | Class | Patterns too | Basis the judge would refuse | Rightly? |\n|---|---|---|---|---|---|",
			flagged,
		],
	];
	for (const [
		name,
		head,
		lines,
	] of /** @type {[string, string, string[]][]} */ (lists))
		fs.writeFileSync(path.join(dir, name), `${head}\n${lines.join("\n")}\n`);
	out(`Bodies in the corpus: ${issues.length}`);
	out(`Bodies read by the judge: ${replies.length}`);
	out(`Calls that fell back: ${rows.length - replies.length}`);
	for (const why of new Set(
		rows.flatMap((r) => (r.fallback ? [r.fallback] : [])),
	))
		out(`    ${rows.filter((r) => r.fallback === why).length} x ${why}`);
	out(`Waits both readings found: ${bothWaits}`);
	out(
		`Waits the judge found that the patterns missed: ${modelOnly.length} (model-only-waits.md)`,
	);
	out(
		`Pattern waits the judge missed: ${patternOnly.length} (pattern-only-waits.md)`,
	);
	out(
		`Bases the judge classed: ${basesRead}; would refuse: ${flagged.length} (bases-flagged.md)`,
	);
	out(`Bodies carrying a fault only the judge raises: ${bodiesFlagged.length}`);
	out(
		`Replies with a dropped quote: ${rate(replies.filter((r) => r.dropped > 0).length, replies.length)}`,
	);
	out(`Latency over ${rows.length} calls: ${latency(rows.map((r) => r.ms))}`);
	return 0;
}

/**
 * @param {string | true | undefined} given
 * @param {number} fallback
 * @param {string} flag
 */
function wholeNumber(given, fallback, flag) {
	if (given === undefined) return fallback;
	if (typeof given !== "string" || !/^[1-9]\d*$/.test(given))
		throw new Error(`${flag} is a whole number, 1 or more.\n${USAGE}`);
	return Number(given);
}

async function main() {
	/** @type {Record<string, import("./lib/cli-args.js").FlagType>} */
	const bounds = { "--jobs": "value", "--bound-ms": "value" };
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: USAGE,
		commands: {
			validate: {
				usage: USAGE,
				flags: { "--part": "value", "--runs": "value", ...bounds },
			},
			corpus: { usage: USAGE, flags: { "--dir": "value", ...bounds } },
			tally: { usage: USAGE, flags: { "--dir": "value" } },
			worker: {
				usage: USAGE,
				flags: { "--in": "value", "--out": "value", "--bound-ms": "value" },
			},
		},
	});
	if (typeof parsed === "number") return parsed;
	const { command, flags } = parsed;
	try {
		const boundMs = wholeNumber(
			flags["--bound-ms"],
			MEASURING_BOUND_MS,
			"--bound-ms",
		);
		const jobs = wholeNumber(flags["--jobs"], DEFAULT_JOBS, "--jobs");
		const text = (/** @type {string} */ flag) => {
			const v = flags[flag];
			if (typeof v !== "string")
				throw new Error(`${flag} is required.\n${USAGE}`);
			return v;
		};
		if (command === "worker")
			return runWorker(text("--in"), text("--out"), boundMs);
		if (command === "tally") return tally(text("--dir"));
		if (command === "corpus")
			return await corpus({ dir: text("--dir"), jobs, boundMs });
		const part = flags["--part"] ?? "held-out";
		if (part !== "held-out" && part !== "development")
			throw new Error(`--part is held-out or development.\n${USAGE}`);
		return await validate({
			part,
			runs: wholeNumber(flags["--runs"], DEFAULT_RUNS, "--runs"),
			jobs,
			boundMs,
		});
	} catch (e) {
		writeFd(2, `${caught(e).message}\n`);
		return 2;
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(e) => {
		writeFd(2, `${caught(e).message}\n`);
		process.exitCode = 1;
	},
);
