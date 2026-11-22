#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const cache = require("./lib/write-set-cache");
const { hostRoot } = require("./lib/host-root.js");
const { CliExit, flagValue, parse, printExit } = require("./lib/cli-args");
const { requiredGroup } = require("./lib/regex-group");
const { caught } = require("./lib/caught.js");
const { execGit } = require("./lib/git.js");

const REPO_ROOT = process.env.WFC_REPO_ROOT || hostRoot();
const CARRIED_HASH = /<!-- body-hash: ([0-9a-f]{64}) -->/;

const PUT_USAGE = `usage: node ${scriptPath("pick-next-cache.js")} put <n> (--body-hash <hex> | --body-file <f>) [--write-set "a.js,b.ts"] [--size <s>] [--gist "<one line>"]`;
const GET_USAGE = `usage: node ${scriptPath("pick-next-cache.js")} get <n>`;
const LIST_USAGE = `usage: node ${scriptPath("pick-next-cache.js")} list`;

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
	process.exit(printExit(e) === 0 ? 0 : 1);
}
/**
 * @param {string} msg
 * @returns {never}
 */
function die(msg) {
	writeFd(2, `FAILED: ${msg}\n`);
	process.exit(1);
}

function readTrackedFiles() {
	try {
		return execGit(["ls-files", "-z"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
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
		const carried = CARRIED_HASH.exec(text);
		hash = carried
			? requiredGroup(carried, 1, CARRIED_HASH)
			: cache.bodyHash(text);
	}
	if (!hash) die("put needs --body-hash <hex> or --body-file <path>");
	if (!/^[0-9a-f]{64}$/.test(hash))
		die(`--body-hash must be the 64-hex key the script printed, not "${hash}"`);

	const writeSet = list(flagValue(parsed.flags, "--write-set"));
	const tracked = readTrackedFiles();
	const trackedAtDerive = tracked
		? writeSet.filter((p) => tracked.includes(p))
		: [];

	const r = cache.writeEntry(REPO_ROOT, {
		issue: n,
		bodyHash: hash,
		writeSet,
		trackedAtDerive,
		// #1494
		sizeBand: flagValue(parsed.flags, "--size"),
		gist: flagValue(parsed.flags, "--gist"),
	});
	if (!r.ok) die(`could not write the entry: ${r.error}`);
	writeFd(
		1,
		`stored #${n}: ${writeSet.length} path${writeSet.length === 1 ? "" : "s"} -> ${r.path}\n`,
	);
}

/** @param {number} n */
function get(n) {
	const entry = cache.readEntry(REPO_ROOT, n);
	if (!entry) {
		writeFd(1, `no entry for #${n}\n`);
		return;
	}
	writeFd(1, `${JSON.stringify(entry, null, 2)}\n`);
}

function listAll() {
	let names;
	try {
		names = fs.readdirSync(cache.cacheDir(REPO_ROOT));
	} catch {
		writeFd(1, "no store yet — nothing has been derived.\n");
		return;
	}
	const entries = names
		.map((f) => /^(\d+)\.json$/.exec(f))
		.filter((m) => m !== null)
		.map((m) => cache.readEntry(REPO_ROOT, Number(m[1])))
		.filter((e) => e !== null)
		.sort((a, b) => a.issue - b.issue);
	writeFd(1, `${entries.length} cached write-set(s):\n`);
	for (const e of entries)
		writeFd(
			1,
			`  #${e.issue}  ${e.writeSet.length} path(s)  ${e.sizeBand ?? "-"}  ${e.derivedAt}  ${e.gist ?? ""}\n`,
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
