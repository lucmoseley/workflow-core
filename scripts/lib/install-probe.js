/*
 * install-probe.js — a stand-in plugin install of the core, for reading text
 * as an adopter receives it (#5439, #5447).
 *
 * An install respells each `scripts/x` and `docs/x` a message names at the
 * plugin root and qualifies each bare `#N` (script-path.js, rule-text.js), so
 * a checkout measures fewer bytes than an adopter pays. The probe is a tree
 * with no package.json, which script-path.js reads as an install, whose
 * `scripts/` and `docs/` are symlinks to the running core's.
 *
 * Its path is padded to the root a 32-character user name — the useradd limit
 * — gives under `~/.claude/plugins/cache/`, at a version of two digits a part,
 * a guess at the longest the plugin will ship.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { coreRoot, inCheckout } = require("./script-path.js");

const INSTALL_ROOT_CHARS =
	`/home/${"u".repeat(32)}/.claude/plugins/cache/workflow-core/workflow-core/10.10.10`
		.length;

/**
 * @param {string} [core] the core tree the probe's `scripts/` and `docs/` point at
 * @returns {{ root: string, remove: () => void }}
 */
function makeInstallProbe(core = coreRoot()) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-install-"));
	const root = path.join(
		base,
		"p".repeat(Math.max(1, INSTALL_ROOT_CHARS - base.length - 1)),
	);
	fs.mkdirSync(root);
	for (const dir of ["scripts", "docs"])
		fs.symlinkSync(path.join(core, dir), path.join(root, dir));
	return {
		root,
		remove: () => fs.rmSync(base, { recursive: true, force: true }),
	};
}

/**
 * `read`'s result with a checkout's core read as the probe install. An
 * install already spells text as one, so there `read` runs as it stands.
 *
 * @template T
 * @param {() => T} read
 * @returns {T}
 */
function asInstall(read) {
	if (!inCheckout()) return read();
	const probe = makeInstallProbe();
	const before = process.env.WFC_SCRIPT_ROOT;
	process.env.WFC_SCRIPT_ROOT = probe.root;
	try {
		return read();
	} finally {
		if (before === undefined) delete process.env.WFC_SCRIPT_ROOT;
		else process.env.WFC_SCRIPT_ROOT = before;
		probe.remove();
	}
}

module.exports = { makeInstallProbe, asInstall };
