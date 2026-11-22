import fs from "node:fs";
import path from "node:path";

interface FakeIssueBody {
	script: string;
	bodyFile: string;
	calls: () => string[];
	clearCalls: () => void;
	body: () => string;
}

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
