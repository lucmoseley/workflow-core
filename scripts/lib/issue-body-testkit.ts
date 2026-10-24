/*
 * issue-body-testkit.ts — a fake `issue-body.js` for a filer's test, the
 * script WFC_ISSUE_BODY names (scripts/lib/tracking-issue.js; #1424).
 */

import fs from "node:fs";
import path from "node:path";

interface FakeIssueBody {
	/** The fake writer — what WFC_ISSUE_BODY points at. */
	script: string;
	/** The issue's body as last written — what the gh stub's `issue view` cats. */
	bodyFile: string;
	/** Each call's argv, space-joined, oldest first; [] before any call. */
	calls: () => string[];
	/** Forget the calls so far, so a second run's calls read alone. Throws
	 * where none was made, so a first run that never wrote cannot pass. */
	clearCalls: () => void;
	body: () => string;
}

/** Write the fake under `dir`, the issue's body starting as `existingBody`. */
export function fakeIssueBody(dir: string, existingBody = ""): FakeIssueBody {
	const script = path.join(dir, "issue-body.js");
	const log = path.join(dir, "issue-body-argv.log");
	const bodyFile = path.join(dir, "body.txt");
	fs.writeFileSync(
		script,
		[
			"const fs = require('node:fs');",
			`fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
			"const file = process.argv[process.argv.indexOf('--file') + 1];",
			`fs.writeFileSync(${JSON.stringify(bodyFile)}, fs.readFileSync(file, 'utf8'));`,
		].join("\n"),
	);
	fs.writeFileSync(bodyFile, existingBody);
	return {
		script,
		bodyFile,
		calls: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
		clearCalls: () => fs.rmSync(log),
		body: () => fs.readFileSync(bodyFile, "utf8"),
	};
}
