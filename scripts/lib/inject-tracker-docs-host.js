const fs = require("node:fs");
const path = require("node:path");
const { ignoreFailure } = require("./caught.js");
const { trimEndRun } = require("./trim-run.js");

// guess, #2268
const TAKES_GH_TIMEOUT_S = 4;

// guess, #5151
const TIER_HOOK_TIMEOUT_S = 8;

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
		reviewTier: ({ payload, cwd }) => {
			const hook =
				process.env.WFC_REVIEW_TIER_HOOK ||
				path.join(__dirname, "..", "guard-dispatch.js");
			if (!fs.statSync(hook, { throwIfNoEntry: false })?.isFile()) return "";
			const r = require("node:child_process").spawnSync(
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
		now: () => Math.floor(require("./clock.js").now() / 1000),
		log,
		env: process.env,
	};
}

/**
 * @param {string} what
 * @param {string} [detail]
 */
function logFailOpen(what, detail) {
	ignoreFailure(() =>
		require("./arbiter-core.js").logError("inject-tracker-docs", what, detail),
	);
}

module.exports = {
	buildHostPorts,
	logFailOpen,
};
