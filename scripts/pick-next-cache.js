#!/usr/bin/env node
/*
 * pick-next-cache.js — the BAND READ's writer into the write-set cache (mantahostels#385).
 *
 * The store, the key and why one file per issue is safe all live in
 * `lib/write-set-cache.js`.
 *
 * IT IS NOT THE ONLY WRITER. `pick-next.js` writes a PROVISIONAL entry for
 * every miss it finds, off a grep over the body (mantahostels#1001). Every `put` here stores
 * a band read, which is the better answer, and clears that flag by writing over
 * it — so an agent that has read an issue never has to know predictions exist.
 * There is deliberately no `--provisional` flag: a prediction is the run's to
 * make, and a hand-written one would be indistinguishable from a judged answer.
 *
 * Usage:
 *   node scripts/pick-next-cache.js put <n> (--body-hash <hex> | --body-file <f>)
 *        [--write-set "a.js,b.ts"] [--size <s>] [--gist "<one line>"]
 *   node scripts/pick-next-cache.js get  <n>
 *   node scripts/pick-next-cache.js list
 *
 * Exit codes: 0 done; 1 bad invocation or the store could not be written.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const cache = require("./lib/write-set-cache");
const { hostRoot } = require("./lib/host-root.js");
const { CliExit, flagValue, parse, printExit } = require("./lib/cli-args");
const { requiredGroup } = require("./lib/regex-group");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { caught } = require("./lib/caught.js");

const REPO_ROOT = process.env.WFC_REPO_ROOT || hostRoot();
const CARRIED_HASH = /<!-- body-hash: ([0-9a-f]{64}) -->/;

const PUT_USAGE =
	'usage: node scripts/pick-next-cache.js put <n> (--body-hash <hex> | --body-file <f>) [--write-set "a.js,b.ts"] [--size <s>] [--gist "<one line>"]';
const GET_USAGE = "usage: node scripts/pick-next-cache.js get <n>";
const LIST_USAGE = "usage: node scripts/pick-next-cache.js list";

/** @type {import("./lib/cli-args").Parsed} */
let parsed;
try {
	parsed = parse(process.argv.slice(2), {
		usage: [PUT_USAGE, GET_USAGE, LIST_USAGE].join("\n"),
		commands: {
			put: {
				usage: PUT_USAGE,
				flags: {
					"--body-hash": "value",
					"--body-file": "value",
					"--write-set": "value",
					"--size": "value",
					"--gist": "value",
				},
				max: 1,
			},
			get: { usage: GET_USAGE, max: 1 },
			list: { usage: LIST_USAGE },
		},
	});
} catch (e) {
	if (!(e instanceof CliExit)) throw e;
	// A bad invocation exits 1 here, as the header says, not cli-args' 2.
	process.exit(printExit(e) === 0 ? 0 : 1);
}
/**
 * @param {string} msg
 * @returns {never}
 */
const die = (msg) => {
	console.error(`FAILED: ${msg}`);
	process.exit(1);
};

/** Tracked paths, or null where git could not answer. */
function trackedFiles() {
	try {
		return execFileSync("git", ["ls-files", "-z"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		})
			.split("\0")
			.filter(Boolean);
	} catch {
		return null;
	}
}

const list = (/** @type {unknown} */ v) =>
	String(v || "")
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean);

/** @param {number} n */
function put(n) {
	const fromFile = flagValue(parsed.flags, "--body-file");
	let hash = flagValue(parsed.flags, "--body-hash");
	if (hash && fromFile) die("give --body-hash or --body-file, not both");
	if (fromFile) {
		/** @type {string} */
		let text;
		try {
			text = fs.readFileSync(fromFile, "utf8");
		} catch (e) {
			die(`could not read ${fromFile}: ${caught(e).message}`);
		}
		/*
		 * A `--dump-bodies` file is the body plus a title line and the key itself,
		 * so hashing the whole thing yields a key that can never match and a miss
		 * that reports success.
		 */
		const carried = CARRIED_HASH.exec(text);
		hash = carried
			? requiredGroup(carried, 1, CARRIED_HASH)
			: cache.bodyHash(text);
	}
	if (!hash) die("put needs --body-hash <hex> or --body-file <path>");
	// An invented key is a permanently-missing entry that reports as stored.
	if (!/^[0-9a-f]{64}$/.test(hash))
		die(`--body-hash must be the 64-hex key the script printed, not "${hash}"`);

	const writeSet = list(flagValue(parsed.flags, "--write-set"));
	/*
	 * Which of those paths git tracks *now* is recorded alongside them, because
	 * that is what lets a later lookup tell a rename from an issue that has yet
	 * to create its file. Where git cannot answer, none is recorded: claiming a
	 * path was tracked when that is unknown would re-derive the entry the moment
	 * git works again.
	 */
	const tracked = trackedFiles();
	const trackedAtDerive = tracked
		? writeSet.filter((p) => tracked.includes(p))
		: [];

	const r = cache.writeEntry(REPO_ROOT, {
		issue: n,
		bodyHash: hash,
		writeSet,
		trackedAtDerive,
		// The flag keeps its pre-workflow-core#1494 name: band-read briefs pass `--size`.
		sizeBand: flagValue(parsed.flags, "--size"),
		gist: flagValue(parsed.flags, "--gist"),
	});
	if (!r.ok) die(`could not write the entry: ${r.error}`);
	console.log(
		`stored #${n}: ${writeSet.length} path${writeSet.length === 1 ? "" : "s"} -> ${r.path}`,
	);
}

/** @param {number} n */
function get(n) {
	const entry = cache.readEntry(REPO_ROOT, n);
	if (!entry) {
		console.log(`no entry for #${n}`);
		return;
	}
	console.log(JSON.stringify(entry, null, 2));
}

function listAll() {
	let names;
	try {
		names = fs.readdirSync(cache.cacheDir(REPO_ROOT));
	} catch {
		console.log("no store yet — nothing has been derived.");
		return;
	}
	const entries = names
		.map((f) => /^(\d+)\.json$/.exec(f))
		.filter((m) => m !== null)
		.map((m) => cache.readEntry(REPO_ROOT, Number(m[1])))
		.filter((e) => e !== null)
		.sort((a, b) => a.issue - b.issue);
	console.log(`${entries.length} cached write-set(s):`);
	for (const e of entries)
		console.log(
			`  #${e.issue}  ${e.writeSet.length} path(s)  ${e.sizeBand ?? "-"}  ${e.derivedAt}  ${e.gist ?? ""}`,
		);
}

const { command } = parsed;
const number = Number(parsed.positionals[0]);
if (command === "list") listAll();
else if (!Number.isInteger(number) || number <= 0)
	die(`${command || "no command"}: needs an issue number — see the header.`);
else if (command === "put") put(number);
else if (command === "get") get(number);
else die(`unknown command ${command} — put, get or list.`);
