/*
 * seat-move.js — a session's transcript carried to another seat, so
 * `claude --bg --resume <id>` under that seat finds it (workflow-core#2159, workflow-core#3734). Resume
 * looks under `<seat>/projects/<slug of its cwd>/`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { projectSlug } = require("./project-slug.js");

/**
 * Copy session `sessionId`'s transcript from seat `from` into seat `to`, each
 * under its project directory for `cwd`, creating `to`'s where missing; null
 * once there, else why not. Never from the job record's `linkScanPath`, which
 * on a resumed session names the transcript it resumed from (mantahostels#655).
 * Through a temporary name, so a copy cut short never stands as the transcript.
 * @param {{from: string, to: string, sessionId: string, cwd: string}} move
 * @returns {string|null}
 */
function copyTranscript({ from, to, sessionId, cwd }) {
	const file = `${sessionId}.jsonl`;
	const slug = projectSlug(cwd);
	const source = path.join(from, "projects", slug, file);
	const dest = path.join(to, "projects", slug, file);
	const partial = `${dest}.moving`;
	try {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(source, partial);
		fs.renameSync(partial, dest);
		return null;
	} catch (e) {
		try {
			fs.rmSync(partial, { force: true });
		} catch {
			/* A `projects` path that is no directory refuses the rm too: the copy's
			 * own failure is the one to name. */
		}
		return `copying its transcript ${source} to ${to}: ${caught(e).message}`;
	}
}

module.exports = { copyTranscript };
