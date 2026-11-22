#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { hostPackage } = require("./lib/host-package.js");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { isCoreHost } = require("./lib/plugin-state");
const { isCodeApartFromTracker } = require("./lib/workflow-core-config.js");
const { scriptPath } = require("./lib/script-path.js");

// #5195
const defaultDir = () => path.join(hostRoot(), ".github", "workflows");

const ALLOWED_WRITE = new Set(["issues"]);

const LEVELS = new Set(["read", "write", "none"]);
const SHORTHANDS = new Set(["read-all", "write-all"]);

const CEILING =
	"Timer-triggered work is capped at R1 (file or refresh an issue), so issues: write is the only write scope permitted — docs/agents/autonomy-ceiling.md.";

const GIT_WRITE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*(commit|push)\b/;

const uncommented = (/** @type {string} */ line) =>
	line.replace(/(^|\s)#.*$/, "$1");

/**
 * @param {any} job
 * @param {any} workflow
 * @returns {{ at: string, value: any } | null}
 */
function declaredPermissions(job, workflow) {
	if (job && Object.hasOwn(job, "permissions"))
		return { at: "job", value: job.permissions };
	if (workflow && Object.hasOwn(workflow, "permissions"))
		return { at: "workflow", value: workflow.permissions };
	return null;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} where
 * @param {{ at: string, value: any } | null} declared
 */
function judgePermissions(ctx, where, declared) {
	if (declared === null) {
		ctx.fail(
			"NO-PERMISSIONS",
			`${where} declares no permissions, and the workflow declares none either — so it runs on the repository's default token, which may carry contents: write. Add an explicit block; contents: read is the norm here.`,
			undefined,
			`NO-PERMISSIONS\t${where}`,
		);
		return;
	}
	const value = declared.value;
	if (value === null || value === undefined) {
		ctx.fail(
			"NO-PERMISSIONS",
			`${where} has a \`permissions:\` key at ${declared.at} level with no value, which names no scopes at all. Write \`permissions: {}\` to grant none explicitly, or list the scopes.`,
			undefined,
			`NO-PERMISSIONS\t${where}`,
		);
		return;
	}
	if (typeof value === "string") {
		if (!SHORTHANDS.has(value))
			ctx.fail(
				"UNKNOWN-VALUE",
				`${where} sets permissions to \`${value}\`, which is neither read-all nor write-all. This check cannot say what it grants, so it will not call it clean.`,
				undefined,
				`UNKNOWN-VALUE\t${where}`,
			);
		else if (value === "write-all")
			ctx.fail(
				"WRITE-SCOPE",
				`${where} grants write-all. ${CEILING}`,
				undefined,
				`WRITE-SCOPE\t${where}\twrite-all`,
			);
		return;
	}
	if (typeof value !== "object") {
		ctx.fail(
			"UNKNOWN-VALUE",
			`${where} sets permissions to \`${String(value)}\`, which is neither a mapping nor a recognised shorthand.`,
			undefined,
			`UNKNOWN-VALUE\t${where}`,
		);
		return;
	}
	for (const [scope, level] of Object.entries(value)) {
		if (!LEVELS.has(level))
			ctx.fail(
				"UNKNOWN-VALUE",
				`${where} grants ${scope}: \`${String(level)}\`, which is not read, write or none. This check cannot say what it grants, so it will not call it clean.`,
				undefined,
				`UNKNOWN-VALUE\t${where}\t${scope}`,
			);
		else if (level === "write" && !ALLOWED_WRITE.has(scope))
			ctx.fail(
				"WRITE-SCOPE",
				`${where} grants ${scope}: write. ${CEILING}`,
				undefined,
				`WRITE-SCOPE\t${where}\t${scope}`,
			);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} where
 * @param {any} job
 * @param {{ at: string, value: any } | null} declared
 */
function judgeApart(ctx, where, job, declared) {
	const value = declared?.value;
	const grantsIssues =
		value === "read-all" ||
		value === "write-all" ||
		(value !== null &&
			typeof value === "object" &&
			Object.hasOwn(value, "issues") &&
			value.issues !== "none");
	if (grantsIssues)
		ctx.fail(
			"TRACKER-SCOPE",
			`${where} is granted issues access, but this repo's code lives apart from its tracker and may be public, where the token reaches no private tracker. File issues from a session instead.`,
			undefined,
			`TRACKER-SCOPE\t${where}`,
		);
	if (
		Object.hasOwn(job ?? {}, "secrets") ||
		/\bsecrets\s*\./.test(JSON.stringify(job))
	)
		ctx.fail(
			"SECRET",
			`${where} reads a repository secret, but this repo's code lives apart from its tracker and may be public, where anyone reads its run logs and redaction is not guaranteed. Move the step that needs it into a session.`,
			undefined,
			`SECRET\t${where}`,
		);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} dir
 * @returns {string[]}
 */
function readWorkflowFiles(ctx, dir) {
	/** @type {string[]} */
	let files = [];
	try {
		files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
			.sort();
	} catch (e) {
		if (
			!ctx.args[0] &&
			caught(e).code === "ENOENT" &&
			fs.existsSync(hostRoot()) &&
			!isCoreHost(hostRoot())
		)
			ctx.skip("this repo has no .github/workflows — no workflows to check");
		ctx.broken(`cannot read ${dir}: ${errMessage(e)}`);
	}
	return files;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} where
 * @param {string} name
 * @param {string} script
 */
function judgeRunScript(ctx, where, name, script) {
	for (const line of script.split("\n")) {
		const hit = GIT_WRITE.exec(uncommented(line));
		if (!hit) continue;
		ctx.fail(
			"GIT-WRITE",
			`${where} ${name} runs \`git ${hit[1]}\`: ${line.trim()} — R2 (commit and push to main) is above the timer-triggered cap set by docs/agents/autonomy-ceiling.md.`,
			undefined,
			`GIT-WRITE\t${where}\t${line.trim()}`,
		);
		break;
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} where
 * @param {any} job
 * @returns {number}
 */
function judgeSteps(ctx, where, job) {
	let steps = 0;
	for (const [i, step] of (job?.steps || []).entries()) {
		if (!step || typeof step.run !== "string") continue;
		steps++;
		const name = step.name ? `"${step.name}"` : `step ${i + 1}`;
		judgeRunScript(ctx, where, name, step.run);
	}
	return steps;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} dir
 * @param {string} file
 * @param {{ yaml: any, apart: boolean }} how
 * @returns {{ jobs: number, steps: number }}
 */
function judgeWorkflow(ctx, dir, file, { yaml, apart }) {
	const rel = path.join(path.basename(dir), file);
	let doc;
	try {
		doc = yaml.load(fs.readFileSync(path.join(dir, file), "utf8"));
	} catch (e) {
		ctx.broken(`${rel} is not parseable YAML: ${errMessage(e)}`);
	}

	const jobMap = doc && typeof doc === "object" ? doc.jobs : null;
	if (!jobMap || typeof jobMap !== "object") {
		ctx.fail(
			"NO-JOBS",
			`${rel} declares no jobs, so nothing in it was inspected. Delete the file, or give it the jobs it is meant to run.`,
			undefined,
			`NO-JOBS\t${rel}`,
		);
		return { jobs: 0, steps: 0 };
	}

	let jobs = 0;
	let steps = 0;
	for (const [id, job] of Object.entries(jobMap)) {
		jobs++;
		const where = `${rel} job \`${id}\``;
		const declared = declaredPermissions(job, doc);
		judgePermissions(ctx, where, declared);
		if (apart) judgeApart(ctx, where, job, declared);
		steps += judgeSteps(ctx, where, job);
	}
	return { jobs, steps };
}

/** @param {import("./lib/check").Ctx} ctx */
function run(ctx) {
	const dir = ctx.args[0] ? path.resolve(ctx.args[0]) : defaultDir();

	const files = readWorkflowFiles(ctx, dir);
	/** @type {any} */
	let yaml = null;
	if (files.length > 0) {
		const loaded = hostPackage("js-yaml", __dirname);
		if (!loaded.ok) ctx.broken(loaded.message);
		yaml = loaded.module;
	}

	let jobs = 0;
	let steps = 0;
	const apart = isCodeApartFromTracker();

	for (const file of files) {
		const counted = judgeWorkflow(ctx, dir, file, { yaml, apart });
		jobs += counted.jobs;
		steps += counted.steps;
	}

	if (jobs === 0)
		ctx.fail(
			"NOTHING-INSPECTED",
			`no workflow jobs found under ${dir} — this check inspected nothing, which is not the same as finding nothing.`,
			undefined,
			"NOTHING-INSPECTED",
		);

	const census = `${jobs} job(s) across ${files.length} workflow file(s), ${steps} run step(s)`;
	ctx.say(`Inspected ${census}.`);

	return {
		okLine: `${census} — no job reaches past R1 (issues: write, no git commit or push).`,
		noun: "workflow autonomy finding(s)",
		data: { dir, files, jobs, steps },
	};
}

/** @type {import("./lib/check.js").CheckSpec} */
const SPEC = {
	name: "check-workflow-permissions",
	usage: `node ${scriptPath("check-workflow-permissions.js")} [<workflows-dir>] [--warn] [--json]`,
	run,
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
