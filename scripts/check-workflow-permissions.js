#!/usr/bin/env node
/*
 * check-workflow-permissions.js — the workflow half of the timer-triggered
 * autonomy cap: no job in .github/workflows/ may reach past R1.
 *
 * Usage:
 *   node scripts/check-workflow-permissions.js [<workflows-dir>] [--warn] [--json]
 *   (default: .github/workflows)
 *
 * THE RULE IT BACKS. docs/agents/autonomy-ceiling.md caps timer-triggered work
 * at **R1 — file or refresh a GitHub issue** (ruled at mantahostels#1169, written at mantahostels#1208).
 * R2 is committing and pushing to `main` here. Everything in .github/ runs on a
 * timer or a dispatch and never in a driven session, so R1 is the whole ceiling
 * for this directory: `issues: write` is the one write scope a job may hold, and
 * a step may not commit or push.
 *
 * WHAT FAILS (mantahostels#1169, mantahostels#1209):
 *
 *   NO-PERMISSIONS      a job with no effective `permissions:` block, which runs
 *                       on whatever the REPOSITORY SETTINGS make the default
 *                       token. That default is unreadable from an agent session
 *                       — HTTP 403 on actions/permissions/workflow — so do not
 *                       try to look it up.
 *   WRITE-SCOPE         `write` granted to any scope but `issues`, `write-all`
 *                       included.
 *   UNKNOWN-VALUE       a level that is not read/write/none, or a shorthand that
 *                       is not read-all/write-all: `contents: WRITE` reads as
 *                       clean to anything matching on `write`.
 *   GIT-WRITE           a `run:` step invoking `git commit` or `git push`.
 *                       Either needs `contents: write`, which WRITE-SCOPE
 *                       already catches; this one names the step that
 *                       acquired the intent before the permission.
 *   TRACKER-SCOPE       where the host's `codeRepo` is not its `tracker`, a job
 *                       granted `issues` at any level but `none`, or `read-all`
 *                       or `write-all`, which carry it (workflow-core#1963).
 *   SECRET              where the same holds, a job reading `secrets.` or
 *                       passing `secrets:` to a called workflow (workflow-core#1963).
 *   NO-JOBS             a workflow file declaring no jobs.
 *   NOTHING-INSPECTED   zero jobs across the whole directory — the vacuous pass
 *                       mantahostels#915 and mantahostels#1024 turned on.
 *
 * NOT CHECKED. The other half of the cap — *nothing on a timer may start a
 * Claude Code session or a Claude routine* — is unreadable from here, and
 * docs/agents/autonomy-ceiling.md carries it as **Unenforceable**. Three
 * narrower residuals, each of which WRITE-SCOPE still catches by the permission
 * it needs: a third-party action that writes on the job's behalf
 * (`peter-evans/create-pull-request` and its kin — an allowlist of action names
 * would go stale the day a new one is published); a step running a repo script
 * that pushes; and a push reached through a shell variable.
 *
 * A `run:` script is read with `#` comment tails dropped, so a `git push` a
 * comment merely discusses is not a finding. The residual is a `#` inside a
 * quoted string, which ends the scan of that line early.
 *
 * Unparseable YAML is BROKEN, not FAIL: the checker could not read its subject.
 * A file that parses but declares no jobs is a fact about the repo instead, so it
 * is a NO-JOBS finding. `actionlint` (npm run check:actions) is what says whether
 * the YAML is valid WORKFLOW YAML; this only needs it to load.
 *
 * A missing default directory is SKIP in an adopter, which may keep no
 * workflows, and BROKEN in workflow-core, which keeps them (workflow-core#1722).
 *
 * js-yaml rather than a line scanner: a scanner reading `permissions:` by
 * indentation cannot tell a job-level block from a workflow-level one. Why the
 * pin is exact: package.json's comments["devDependencies.js-yaml"]. It ships,
 * so js-yaml comes from the host repo's own install (lib/host-package.js,
 * workflow-core#1380); where that has none, a repo with workflows to read is BROKEN.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { hostPackage } = require("./lib/host-package.js");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { isCoreHost } = require("./lib/plugin-state");
const { isCodeApartFromTracker } = require("./lib/workflow-core-config.js");

/* The host repository's own `.github/workflows` (workflow-core#1) — never `__dirname`,
 * which in a plugin install names the plugin cache, not the repo whose
 * workflows are under the ceiling. */
const DEFAULT_DIR = path.join(hostRoot(), ".github", "workflows");

/* Widening this set is a change to the ceiling and belongs to the founder, via
 * docs/agents/autonomy-ceiling.md. */
const ALLOWED_WRITE = new Set(["issues"]);

const LEVELS = new Set(["read", "write", "none"]);
const SHORTHANDS = new Set(["read-all", "write-all"]);

const CEILING =
	"Timer-triggered work is capped at R1 (file or refresh an issue), so issues: write is the only write scope permitted — docs/agents/autonomy-ceiling.md.";

/* `git` then any run of flags, then the subcommand — so `git -c user.email=x
 * commit` is caught and `git log --format=%h` is not. */
const GIT_WRITE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*(commit|push)\b/;

const uncommented = (/** @type {string} */ line) =>
	line.replace(/(^|\s)#.*$/, "$1");

/**
 * Where a job's permissions are declared, and what they say.
 *
 * `null` means nothing declares any — neither the job nor the workflow around
 * it. A declared key with NO VALUE is reported separately.
 *
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
 * Raise a finding for every way this job's permissions breach the cap.
 *
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
 * Raise TRACKER-SCOPE and SECRET for one job of a code repo kept apart from
 * its tracker.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} where
 * @param {any} job `any`: one job of the untyped js-yaml parse, as
 *   judgeSteps() takes it
 * @param {{ at: string, value: any } | null} declared `any`: the permissions
 *   value as the parse left it, narrowed below
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
 * The workflow files in `dir`, sorted; SKIP or BROKEN where it will not read.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} dir
 * @returns {string[]}
 */
function workflowFiles(ctx, dir) {
	/** @type {string[]} */
	let files = [];
	try {
		files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
			.sort();
	} catch (e) {
		// A named directory that is missing is a wrong invocation; the default
		// one missing is an adopter with no workflows (workflow-core#2, workflow-core#33) — unless the host
		// root itself is missing, a wrong CLAUDE_PROJECT_DIR (workflow-core#43), or the host is
		// workflow-core, which keeps workflows (workflow-core#1722).
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
 * Raise GIT-WRITE on one `run:` step's first committing or pushing line.
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
			/* The line, not the step's name: an unnamed step is named by its
			 * position, which moves when a step is added above it (workflow-core#1591). */
			`GIT-WRITE\t${where}\t${line.trim()}`,
		);
		break;
	}
}

/**
 * Judge every `run:` step of one job.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} where
 * @param {any} job `any`: one job of the untyped js-yaml parse, narrowed by
 *   hand here as declaredPermissions() narrows it
 * @returns {number} the run steps inspected
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
 * Judge one workflow file's jobs.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} dir
 * @param {string} file
 * @param {{ yaml: any, apart: boolean }} how `yaml` is js-yaml, which ships
 *   no types; @types/js-yaml was declined as a second package for one
 *   `load`, so this file narrows the result by hand. `apart`: whether
 *   TRACKER-SCOPE and SECRET apply
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
	const dir = ctx.args[0] ? path.resolve(ctx.args[0]) : DEFAULT_DIR;

	const files = workflowFiles(ctx, dir);
	/* Loaded only where there is a workflow to parse. */
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

	/* A finding rather than a SKIP: an empty .github/workflows is a fact about
	 * this repo, not an outage. */
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

runCheck({
	name: "check-workflow-permissions",
	usage:
		"node scripts/check-workflow-permissions.js [<workflows-dir>] [--warn] [--json]",
	run,
});
