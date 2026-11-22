import fs from "node:fs";
import {
	type GhAnswer,
	ghComputed,
	ghServe,
	LINK_READ_FAKE,
	RECORDED_SHAPES,
} from "./gh-fake";
import { stubGhScript } from "./gh-stub";

export const NEW = 561;
export const NEW_ID = 987_654;

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
		children: has("linked")
			? buildChildRows(/^repos\/(.+)\/issues\/\d+\/sub_issues$/.exec(argv[1])?.[1], ${NEW})
			: ok(""),
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

export const fileIssueGh =
	(dir: string) =>
	(args: string[], opts: { input?: unknown } = {}): string =>
		ghServe(route(args, String(opts.input ?? ""), fs, dir))(args);

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
