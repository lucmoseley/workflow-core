/*
 * inject-tracker-docs-host.js — the production ports lib/inject-tracker-docs.js
 * reads (#5151): the `gh` read of an issue's `takes:` label, the review-tier
 * core run on a typed /code-review, the clock and the fail-open log.
 *
 * The `gh` read runs through lib/gh.js, killed at its give-up; `gh` is one
 * process, so the kill frees the pipe. The tier read runs under coreutils
 * `timeout`, which signals the core's whole process group, so a hung core is
 * killed with its children and cannot hold the hook's stdout open.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { trimEndRun } = require("./trim-run.js");

/* The `gh` give-up. No reference, no `takes:` label, or a `gh` that fails or
 * outruns it adds nothing; past the hook's 10 s the harness would drop the
 * whole payload. 4 is a guess, leaving the rest of the hook 6 s;
 * WFC_TAKES_GH_TIMEOUT_S shortens it for a test only (#2268). */
const TAKES_GH_TIMEOUT_S = 4;

/* The hook's 10 s (self-plugin/hooks/hooks.json, hooks/hooks.json) less 2 for
 * the rest of the /code-review arm, a margin judged, not measured. A kill
 * skips the tier core's own fail-open record, so it is recorded here. */
const TIER_HOOK_TIMEOUT_S = 8;

/* coreutils `timeout`'s exit where the command outran it. */
const TIMED_OUT = 124;

/** @param {string} dir */
const isDir = (dir) =>
	dir !== "" &&
	(fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false);

/** @param {(what: string, detail?: string) => void} log
 * @returns {import("./inject-tracker-docs.js").Ports} */
function buildHostPorts(log) {
	return {
		takesLabel: ({ issue, repo, cwd }) => {
			if (cwd !== "" && !isDir(cwd)) return "";
			const giveUp =
				Number(process.env.WFC_TAKES_GH_TIMEOUT_S) || TAKES_GH_TIMEOUT_S;
			try {
				return trimEndRun(
					require("./gh.js").gh(
						[
							"issue",
							"view",
							issue,
							...(repo ? ["--repo", repo] : []),
							"--json",
							"labels",
							"-q",
							'[.labels[].name | select(startswith("takes:"))][0] // ""',
						],
						{
							cwd: cwd || undefined,
							stdio: ["ignore", "pipe", "ignore"],
							timeout: giveUp * 1000,
							killSignal: "SIGKILL",
						},
					),
					"\n",
				);
			} catch {
				return "";
			}
		},
		/* WFC_REVIEW_TIER_HOOK, the entry the tier core is run through, is the
		 * test seam, as WFC_GH is for the `takes:` read. */
		reviewTier: ({ payload, cwd }) => {
			const hook =
				process.env.WFC_REVIEW_TIER_HOOK ||
				path.join(__dirname, "..", "guard-dispatch.js");
			if (!fs.statSync(hook, { throwIfNoEntry: false })?.isFile()) return "";
			const r = spawnSync(
				"timeout",
				[
					String(TIER_HOOK_TIMEOUT_S),
					process.execPath,
					hook,
					"--only",
					"inject-review-tier",
				],
				{
					cwd: isDir(cwd) ? cwd : undefined,
					input: payload,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "ignore"],
				},
			);
			if (r.status === TIMED_OUT)
				log(
					`inject-review-tier outran ${TIER_HOOK_TIMEOUT_S} s — a typed /code-review went without its review tier`,
				);
			try {
				const c = JSON.parse(r.stdout ?? "")?.hookSpecificOutput
					?.additionalContext;
				return typeof c === "string" ? c : "";
			} catch {
				return "";
			}
		},
		now: () => Math.floor(Date.now() / 1000),
		log,
	};
}

/** The guard-errors.log writer, which check-guard-errors.js reads.
 * @param {string} what @param {string} [detail] */
function logFailOpen(what, detail) {
	try {
		require("./arbiter-core.js").logError("inject-tracker-docs", what, detail);
	} catch {
		/* logging this failure has the same failure mode */
	}
}

module.exports = {
	TAKES_GH_TIMEOUT_S,
	TIER_HOOK_TIMEOUT_S,
	buildHostPorts,
	logFailOpen,
};
