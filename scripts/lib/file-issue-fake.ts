/*
 * The shared file-issue.js fake (§G7, #5148): a script filer's port, lib/file-through.js's
 * `fileThrough(argv, body, root)` with the root bound, answered in-process
 * through a gh port. It files what file-issue.js files for a script's argv
 * (lib/script-filer-argv.js) whose body carries its own Standalone line and
 * whose fault is `--no-fault`. file-issue.contract.test.ts
 * holds it to the real file-issue.js on a landed create and a failed one.
 * What it does not model: file-issue.js's refusals before the create (a
 * label the tracker lacks, a similar open title, a `takes:` rule), so a case
 * that needs one runs the real filer.
 */

const { gh: realGh } = require("./gh.js");
const { buildFiledLine } = require("./filed-line.js");

export interface FiledAnswer {
	status: number | null;
	stdout: string;
	stderr: string;
}

const valuesOf = (argv: string[], flag: string) =>
	argv.flatMap((x, i) => (argv[i - 1] === flag ? [x] : []));

/**
 * @param gh lib/gh.js's `gh(args, opts)`, or a module test's port standing in for it
 */
export function fileIssueFake(gh: typeof realGh, repo: string) {
	return (argv: string[], body: string): FiledAnswer => {
		const [title = ""] = valuesOf(argv, "--title");
		const labels = [
			...valuesOf(argv, "--label"),
			...valuesOf(argv, "--origin").map((o) => `origin:${o}`),
		];
		const args = [
			"issue",
			"create",
			"--repo",
			repo,
			"--title",
			title,
			"--body-file",
			"-",
			...labels.flatMap((l) => ["--label", l]),
		];
		let created: string;
		try {
			created = gh(args, { input: body });
		} catch (e) {
			const { stderr = "" } = e as { stderr?: string };
			const reason = String(stderr).trim().split("\n").pop() ?? "";
			return {
				status: 1,
				stdout: "",
				stderr: `file-issue: gh issue create failed (${reason}).\n`,
			};
		}
		const url = /https:\/\/\S+\/issues\/(\d+)/.exec(created);
		if (!url)
			return {
				status: 1,
				stdout: "",
				stderr: "file-issue: gh issue create printed no issue URL.\n",
			};
		return {
			status: 0,
			stdout: `${buildFiledLine(Number(url[1]), url[0])}\nlabels: ${labels.join(", ")}\n`,
			stderr: "",
		};
	};
}
