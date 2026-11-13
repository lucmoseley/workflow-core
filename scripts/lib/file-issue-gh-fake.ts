/*
 * file-issue's gh fake (#5150): one routing source, served in-process as the
 * core's `gh` port and as the WFC_GH stub the program cases run, the way
 * gh-fake.ts serves its computed answers both ways. It reads the sandbox
 * files a case writes — `issues`, `issues-open`, `list-fails`,
 * `create-silent`, `assign-fails`, `post-err`, `api/` — and logs every argv
 * to `gh-calls`. Each JSON answer goes through RECORDED_SHAPES, which
 * gh.contract.test.ts holds to the real gh; lib/link-writer.js's reads answer
 * from LINK_READS.
 */

import fs from "node:fs";
import {
	type GhAnswer,
	ghComputed,
	ghServe,
	LINK_READ_FAKE,
	RECORDED_SHAPES,
} from "./gh-fake";
import { stubGhScript } from "./gh-stub";

/** The number the create answers — nothing a caller could guess. */
export const NEW = 561;
/** The sub-issue id the link reads answer for #NEW. */
export const NEW_ID = 987_654;

/*
 * `routeFileIssueGh(argv, input, fs, dir)`: the answer to one gh call, its
 * side effects written under `dir`. The similar-title list's open read takes
 * `issues-open`; every other `issue list` takes `issues`. The link reads
 * list #NEW as a child once the POST has landed.
 */
const ROUTE = String.raw`function routeFileIssueGh(argv, input, fs, dir) {
	const at = (name) => dir + "/" + name;
	const has = (name) => fs.existsSync(at(name));
	const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
	const failed = (stderr) => ({ status: 1, stdout: "", stderr });
	const joined = argv.join(" ");
	fs.appendFileSync(at("gh-calls"), joined + "\n");
	if (joined.startsWith("issue create")) {
		fs.writeFileSync(at("body-seen"), input);
		return ok(has("create-silent") ? "" : buildCreateAnswer("acme/widgets", ${NEW}));
	}
	if (joined.startsWith("issue list")) {
		if (has("list-fails")) return failed("HTTP 502: Bad Gateway\n");
		const f = joined.includes("--state open --json number,title,state") ? at("issues-open") : at("issues");
		const rows = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
		return ok(asRecorded("issueListRows", rows.map((r) => askedFields(argv, r))) + "\n");
	}
	if (joined.startsWith("issue edit"))
		return has("assign-fails") ? failed("HTTP 403: no\n") : ok("");
	if (joined.includes("--method POST")) {
		if (has("post-err")) return failed(fs.readFileSync(at("post-err"), "utf8"));
		fs.writeFileSync(at("linked"), "");
		return ok("");
	}
	const read = answerLinkRead(argv, {
		id: buildJqLines(${NEW_ID}),
		children: has("linked") ? buildJqLines(${NEW}) : ok(""),
	});
	if (read) return read;
	if (argv[0] === "api") {
		const f = at("api/" + argv[1].replaceAll("/", "_"));
		if (!fs.existsSync(f)) return failed("HTTP 404: Not Found\n");
		const value = JSON.parse(fs.readFileSync(f, "utf8"));
		if (/^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(argv[1])) return ok(asRecorded("issue", value));
		if (argv[1].endsWith("/sub_issues")) return ok(asRecorded("subIssuesPage", value));
		if (argv[1].endsWith("/labels")) return ok(asRecorded("labelsPage", [value]));
		return ok(JSON.stringify(value));
	}
	return ok("");
}`;

const SOURCE = `${RECORDED_SHAPES}\n${LINK_READ_FAKE}\n${ROUTE}`;

const route = ghComputed<
	(argv: string[], input: string, fsys: typeof fs, dir: string) => GhAnswer
>(SOURCE, "routeFileIssueGh");

/** The core's `gh` port over the sandbox at `dir`. */
export const fileIssueGh =
	(dir: string) =>
	(args: string[], opts: { input?: unknown } = {}): string =>
		ghServe(route(args, String(opts.input ?? ""), fs, dir))(args);

/** The same routes as the WFC_GH stub executable, for the program cases. */
export const stubFileIssueGh = (dir: string) =>
	stubGhScript(
		dir,
		`#!/usr/bin/env node
const fs = require("node:fs");
${SOURCE}
const argv = process.argv.slice(2);
const input = argv[0] === "issue" && argv[1] === "create" ? fs.readFileSync(0, "utf8") : "";
const a = routeFileIssueGh(argv, input, fs, ${JSON.stringify(dir)});
process.stdout.write(a.stdout);
process.stderr.write(a.stderr);
process.exitCode = a.status;
`,
	);
