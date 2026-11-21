/*
 * install-probe.js — a stand-in plugin install of the core, for reading text
 * as an adopter receives it (#5439, #5447).
 *
 * An install respells each `scripts/x` and `docs/x` a message names at the
 * plugin root and qualifies each bare `#N` (script-path.js, rule-text.js). The
 * probe is a tree with no package.json, which script-path.js reads as an
 * install.
 *
 * Its path is padded to the root a 32-character user name — the useradd limit
 * — gives under `~/.claude/plugins/cache/`, at a version of two digits a part,
 * a guess at the longest the plugin will ship.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { coreRoot, inCheckout } = require("./script-path.js");
const { isCoreRoot } = require("./core-hooks.js");
const {
	CORE_RULES,
	RULES_DIR,
	withHostRootSpelling,
	withRuleStore,
} = require("./rule-text.js");

const INSTALL_ROOT_CHARS =
	`/home/${"u".repeat(32)}/.claude/plugins/cache/workflow-core/workflow-core/10.10.10`
		.length;

/* #5475: guess. */
const HOST_ROOT_STANDIN = `/${"h".repeat(INSTALL_ROOT_CHARS - 1)}`;

/**
 * @param {string} root
 * @returns {{ dir: string, fallback: string }}
 */
function installStore(root) {
	const dir = path.join(root, RULES_DIR);
	return { dir, fallback: isCoreRoot(root) ? dir : CORE_RULES };
}

/**
 * @param {string} core the core tree the probe's `scripts/` and `docs/` point at
 * @returns {{ root: string, remove: () => void }}
 */
function makeInstallProbe(core) {
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
 * @template T
 * @param {string} root
 * @param {() => T} read
 * @returns {T}
 */
function asInstall(root, read) {
	if (!inCheckout()) return read();
	const store = installStore(root);
	const probe = makeInstallProbe(coreRoot());
	const before = process.env.WFC_SCRIPT_ROOT;
	process.env.WFC_SCRIPT_ROOT = probe.root;
	try {
		return withRuleStore(store.dir, store.fallback, () =>
			withHostRootSpelling(HOST_ROOT_STANDIN, read),
		);
	} finally {
		if (before === undefined) delete process.env.WFC_SCRIPT_ROOT;
		else process.env.WFC_SCRIPT_ROOT = before;
		probe.remove();
	}
}

module.exports = { asInstall, installStore };
