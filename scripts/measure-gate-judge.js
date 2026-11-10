#!/usr/bin/env node
/*
 * measure-gate-judge.js — the gate judge (lib/gate-judge.js, #4964) held to
 * account: its rates on the labelled set, and its reading of every issue body
 * in the tracker.
 *
 *   node scripts/measure-gate-judge.js validate [--part held-out|development]
 *        [--runs <n>] [--jobs <n>] [--bound-ms <n>] [--dir <dir>]
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
 *           An inherited basis naming no other issue is refused by rule and
 *           counted apart. `--dir` names the rows' directory, a fresh one
 *           under .claude/tmp unless given; one that holds rows is re-scored.
 *           The held-out part is run against a frozen prompt; re-run it after
 *           a prompt change and compare by the prompt's printed hash.
 * corpus    fetches every issue body, open and closed, into <dir>/all.json
 *           and sends each through the judge once, appending to
 *           <dir>/results-*.jsonl. Re-run, it takes up where it stopped. Run
 *           it detached (scripts/bg-run.sh). <dir> is scratch: the corpus is
 *           never committed.
 * tally     prints the corpus run's counts and latency, and writes the lists
 *           to classify by hand beside the results.
 * worker    judgeAll's own child, one per job: not for the command line.
 *
 * A row stores the model's reply as given, so a re-run of `tally`, or of
 * `validate --dir`, re-scores it under the code's present checks at no call.
 *
 * Every call spends a Haiku turn on this session's seat, each a child of
 * about 260 MB for about 6 s (measured on 2.1.322); `--jobs` is how many run
 * at once, 2 unless given, to be sized from MemAvailable at the time.
 *
 * In no family (§N3): it measures, gates nothing and files nothing.
 */

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { readText } = require("./lib/file-read.js");
const { buildPrompt, judgedBasisFaults } = require("./lib/gate-judge.js");
const {
	compareReadings,
	judgeRow,
	quantile,
	scoreCase,
	wilson,
} = require("./lib/gate-judge-score.js");
const { ghJson } = require("./lib/gh.js");
const { readJsonl } = require("./lib/jsonl.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

const SELF = scriptPath("measure-gate-judge.js");
const USAGE = [
	`usage: node ${SELF} validate [--part held-out|development] [--runs <n>] [--jobs <n>] [--bound-ms <n>] [--dir <dir>]`,
	`       node ${SELF} corpus --dir <dir> [--jobs <n>] [--bound-ms <n>]`,
	`       node ${SELF} tally --dir <dir>`,
].join("\n");

const CASES = path.join(__dirname, "fixtures", "gate-judge-cases.json");
/* Under the create guard's 60 s hook limit, so the latency measured is not cut
 * short of what a route could ever wait. */
const MEASURING_BOUND_MS = 55_000;
/* A guess that fits any machine able to run a suite. */
const DEFAULT_JOBS = 2;
const DEFAULT_RUNS = 3;
/* GitHub's list ceiling here is far over the tracker's ~5,000 issues. */
const CORPUS_LIMIT = 20_000;
/* A guess: often enough to show a detached run is alive. */
const PROGRESS_MS = 60_000;

/**
 * @typedef {{key: string, body: string, own: number|null}} Item
 * @typedef {import("./lib/gate-judge-score.js").Row} Row
 */

/** @param {string} text */
const out = (text) => writeFd(1, `${text}\n`);

/**
 * @param {string} file
 * @returns {Record<string, unknown>[]} none where the file is absent
 */
const readRows = (file) => readJsonl(file)?.rows ?? [];

/**
 * Every row `dir` holds, the last written for each key.
 * @param {string} dir
 * @returns {Row[]}
 */
function readResults(dir) {
	const rows = /** @type {Row[]} */ (
		/** @type {unknown} */ (
			fs
				.readdirSync(dir)
				.filter((f) => /^results-\d+\.jsonl$/.test(f))
				.flatMap((f) => readRows(path.join(dir, f)))
		)
	);
	return [...new Map(rows.map((r) => [r.key, r])).values()];
}

const harnessVersion = () =>
	(
		spawnSync(claudeBin(), ["--version"], { encoding: "utf8" }).stdout ?? ""
	).trim() || "an unknown harness";

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
		const { ms, fallback, reading } = judgedBasisFaults(item.body, {
			own: item.own ?? undefined,
			boundMs,
		});
		/** @type {Row} */
		const row = { key: item.key, ms, fallback, reading };
		fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
	}
	return 0;
}

/**
 * `items` through `jobs` workers at once, into `<dir>/results-<i>.jsonl`. An
 * item the directory already holds a row for, a fallen-back call included, is
 * not sent again.
 *
 * @param {Item[]} items
 * @param {{dir: string, jobs: number, boundMs: number}} opts
 * @returns {Promise<Row[]>} every row the directory now holds for `items`
 */
async function judgeAll(items, { dir, jobs, boundMs }) {
	fs.mkdirSync(dir, { recursive: true });
	const done = new Set(readResults(dir).map((r) => r.key));
	const left = items.filter((item) => !done.has(item.key));
	const ticker = setInterval(
		() => out(`  ${readResults(dir).length} of ${items.length} judged`),
		PROGRESS_MS,
	);
	try {
		await Promise.all(
			Array.from({ length: left.length > 0 ? jobs : 0 }, (_, i) => {
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
						path.join(dir, `results-${i}.jsonl`),
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
	return readResults(dir).filter((r) => keys.has(r.key));
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

/** @param {number[]} ms */
function latency(ms) {
	const s = [...ms].sort((a, b) => a - b);
	const sec = (/** @type {number} */ v) => (v / 1000).toFixed(1);
	return `min ${sec(s[0] ?? 0)} s, median ${sec(quantile(s, 0.5))} s, p90 ${sec(quantile(s, 0.9))} s, p95 ${sec(quantile(s, 0.95))} s, p99 ${sec(quantile(s, 0.99))} s, p99.9 ${sec(quantile(s, 0.999))} s, max ${sec(s.at(-1) ?? 0)} s`;
}

/**
 * @param {{part: string, runs: number, jobs: number, boundMs: number, dir?: string}} opts
 */
async function validate({ part, runs, jobs, boundMs, dir: given }) {
	/** @type {(import("./lib/gate-judge-score.js").Case & {part: string})[]} */
	const cases = JSON.parse(fs.readFileSync(CASES, "utf8")).cases.filter(
		(/** @type {{part: string}} */ c) => c.part === part,
	);
	const prompt = crypto
		.createHash("sha256")
		.update(buildPrompt(""))
		.digest("hex")
		.slice(0, 12);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir =
		given ?? path.join(".claude", "tmp", `gate-judge-validation-${stamp}`);
	const harness = harnessVersion();
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
	const scored = cases.map((c) =>
		scoreCase(
			c,
			rows.filter((r) => r.key.startsWith(`${c.id}#`)),
		),
	);
	/**
	 * @param {string} title
	 * @param {string[]} groups
	 * @param {boolean} wantFlagged whether a flag is the right answer
	 */
	const line = (title, groups, wantFlagged) => {
		const of = scored.filter((c) => groups.includes(c.group) && c.ran > 0);
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
	line(
		"Inherited bases naming no other issue, refused by rule",
		["inherited-unsourced"],
		true,
	);
	out(
		`Cases whose runs agree: ${rate(scored.filter((c) => c.agree).length, scored.length)}`,
	);
	const replies = cases.flatMap((c) =>
		rows
			.filter((r) => r.key.startsWith(`${c.id}#`))
			.flatMap((r) => judgeRow(c.text, c.own, r) ?? []),
	);
	out(
		`Replies with a dropped quote: ${rate(replies.filter((j) => j.dropped > 0).length, replies.length)}`,
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
		`${JSON.stringify({ part, runs, prompt, harness, cases: scored }, null, "\t")}\n`,
	);
	return 0;
}

/**
 * The corpus: every issue body, fetched into `<dir>/all.json` the first time
 * and read from there after.
 * @param {string} dir
 * @returns {{number: number, state: string, body: string}[]}
 */
function fetchCorpusOnce(dir) {
	const file = path.join(dir, "all.json");
	const read = readText(file);
	if (read.state === "unreadable") throw read.error;
	if (read.state === "read") return JSON.parse(read.data);
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
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(issues));
	return issues;
}

/** @param {{body: string|null}} issue */
const bodyOf = (issue) => (issue.body ?? "").replace(/\r\n/g, "\n");

/** @param {{dir: string, jobs: number, boundMs: number}} opts */
async function corpus(opts) {
	const issues = fetchCorpusOnce(opts.dir);
	out(`${issues.length} bodies, ${opts.jobs} at once; rows in ${opts.dir}`);
	const rows = await judgeAll(
		issues.map((i) => ({
			key: String(i.number),
			body: bodyOf(i),
			own: i.number,
		})),
		opts,
	);
	out(`${rows.length} of ${issues.length} judged`);
	return 0;
}

/** @param {string} dir */
function tally(dir) {
	const issues = fetchCorpusOnce(dir);
	const rows = readResults(dir);
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const read = issues.flatMap((issue) => {
		const row = byKey.get(String(issue.number));
		const judged = row && judgeRow(bodyOf(issue), issue.number, row);
		return judged
			? [{ judged, lists: compareReadings(issue, bodyOf(issue), judged) }]
			: [];
	});
	/** @param {"modelOnly"|"patternOnly"|"basesFlagged"|"bodyFlagged"} list */
	const all = (list) => read.flatMap((r) => r.lists[list]);
	const lists = /** @type {[string, string, string[]][]} */ ([
		[
			"model-only-waits.md",
			"| Issue | State | Sentence the judge read as a wait, the patterns did not | Wait? |\n|---|---|---|---|",
			all("modelOnly"),
		],
		[
			"pattern-only-waits.md",
			"| Issue | State | Wait the patterns read, the judge did not | Wait? |\n|---|---|---|---|",
			all("patternOnly"),
		],
		[
			"bases-flagged.md",
			"| Issue | State | Class | Patterns too | Basis the judge would refuse | Rightly? |\n|---|---|---|---|---|---|",
			all("basesFlagged"),
		],
		[
			"bodies-flagged.md",
			"| Issue | State | Faults only the judge raises | Rightly? |\n|---|---|---|---|",
			all("bodyFlagged"),
		],
	]);
	for (const [name, head, lines] of lists)
		fs.writeFileSync(path.join(dir, name), `${head}\n${lines.join("\n")}\n`);
	out(`Bodies in the corpus: ${issues.length}`);
	out(`Bodies read by the judge: ${read.length}`);
	out(`Calls that fell back: ${rows.length - read.length}`);
	for (const why of new Set(
		rows.flatMap((r) => (r.fallback ? [r.fallback] : [])),
	))
		out(`    ${rows.filter((r) => r.fallback === why).length} x ${why}`);
	out(
		`Waits both readings found: ${read.reduce((n, r) => n + r.lists.both, 0)}`,
	);
	out(
		`Waits the judge found that the patterns missed: ${all("modelOnly").length} (model-only-waits.md)`,
	);
	out(
		`Pattern waits the judge missed: ${all("patternOnly").length} (pattern-only-waits.md)`,
	);
	out(
		`Bases the judge classed: ${read.reduce((n, r) => n + r.judged.bases.length, 0)}; would refuse: ${all("basesFlagged").length} (bases-flagged.md)`,
	);
	out(
		`Bodies carrying a fault only the judge raises: ${all("bodyFlagged").length} (bodies-flagged.md)`,
	);
	out(
		`Replies with a dropped quote: ${rate(read.filter((r) => r.judged.dropped > 0).length, read.length)}`,
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
				flags: {
					"--part": "value",
					"--runs": "value",
					"--dir": "value",
					...bounds,
				},
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
			dir: flags["--dir"] === undefined ? undefined : text("--dir"),
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
