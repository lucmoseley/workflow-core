#!/usr/bin/env node
/*
 * arm-gh-stub.js — the `gh` a before/after test sandbox puts first on PATH
 * (#2042). It reaches nothing: every call is logged to `<sandbox>/gh.log`, a
 * write answers success, and a read answers only from a frozen fixture in
 * `<sandbox>/gh-fixtures/`, failing where there is none.
 *
 * `build-arm-sandbox.js task` copies it to `<sandbox>/bin/gh`, so the
 * sandbox root is two levels above this file's own path.
 *
 * A read the stub cannot answer as real `gh` would — a `--jq` filter, a
 * fixture missing — fails rather than printing something plausible.
 */

const fs = require("node:fs");
const path = require("node:path");

const WRITE_VERBS = new Set([
	"create",
	"edit",
	"comment",
	"close",
	"reopen",
	"delete",
	"merge",
	"lock",
	"unlock",
	"pin",
	"unpin",
	"transfer",
	"develop",
	"review",
	"ready",
	"run",
	"cancel",
	"rerun",
]);

/**
 * @param {string[]} argv
 * @returns {boolean}
 */
function isWrite(argv) {
	const [cmd, verb] = argv;
	if (cmd !== "api") return verb !== undefined && WRITE_VERBS.has(verb);
	const method = argv.findIndex((a) => a === "-X" || a === "--method");
	if (method !== -1) return String(argv[method + 1]).toUpperCase() !== "GET";
	// A graphql query rides on `-f query=…` like a write; only a mutation is one.
	if (verb === "graphql")
		return argv.some((a) => /^query=\s*mutation\b/.test(a));
	return argv.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
}

/**
 * The fixture with only the `--json` fields asked for, as `gh` prints them.
 * @param {Record<string, unknown>} issue
 * @param {string} fields comma-separated
 */
function pick(issue, fields) {
	return Object.fromEntries(
		fields.split(",").map((f) => [f, issue[f] ?? null]),
	);
}

/**
 * @param {string[]} argv
 * @param {string} root the sandbox root
 * @returns {{code: number, out: string, err: string}}
 */
function answer(argv, root) {
	if (isWrite(argv)) {
		const n = fs
			.readFileSync(path.join(root, "gh.log"), "utf8")
			// jsonl-read-exempt: counts write lines by text and parses none
			.split("\n")
			.filter((l) => l.includes('"write":true')).length;
		const out =
			argv[1] === "create" ? `https://github.com/stub/stub/issues/${n}\n` : "";
		return { code: 0, out, err: "" };
	}
	const [cmd, verb, n] = argv;
	const filtered = argv.some((a) => /^(-q|--jq|-t|--template)(=|$)/.test(a));
	if (cmd === "issue" && verb === "view" && !filtered) {
		const fixture = path.join(root, "gh-fixtures", `issue-${n}.json`);
		if (fs.existsSync(fixture)) {
			const issue = JSON.parse(fs.readFileSync(fixture, "utf8"));
			const json = argv.indexOf("--json");
			const out =
				json === -1
					? `${issue.title ?? ""}\n\n${issue.body ?? ""}`
					: JSON.stringify(pick(issue, String(argv[json + 1])));
			return { code: 0, out: `${out}\n`, err: "" };
		}
	}
	return {
		code: 1,
		out: "",
		err: `gh stub: no fixture answers \`gh ${argv.join(" ")}\`; this sandbox reaches nothing.\n`,
	};
}

if (require.main === module) {
	const root = path.dirname(path.dirname(fs.realpathSync(__filename)));
	const argv = process.argv.slice(2);
	fs.appendFileSync(
		path.join(root, "gh.log"),
		`${JSON.stringify({ at: new Date().toISOString(), cwd: process.cwd(), argv, write: isWrite(argv) })}\n`,
	);
	const { code, out, err } = answer(argv, root);
	process.stdout.write(out);
	process.stderr.write(err);
	process.exitCode = code;
}
