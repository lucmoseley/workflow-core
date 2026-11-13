// @vitest-environment node
/*
 * Pins that the dispatcher still launches where the interop-probe library
 * will not load (mantahostels#3111): a §N5 fail-open, so a program case
 * (§X11 (4)). Loosen it and a broken library refuses every dispatch rather
 * than failing open.
 *
 * Its own file because the shadow `scripts/` it builds links every file in
 * scripts/lib through installLib, which makes this file a reader of each one
 * in docs/test-read-edges.json: any lib change selects it rather than the
 * whole dispatch suite (#2423).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchFixture, SCRIPT } from "./lib/dispatch-sessions-testkit";
import { installLib } from "./lib/lib-install-testkit";

const fx = dispatchFixture();

describe("the interop-bridge probe (mantahostels#3111)", () => {
	it("fails open where the probe library will not load", () => {
		fx.stubClaude({});
		// A library the shell cannot parse leaves `claude_interop_wedged`
		// undefined, on a bridge that would otherwise read wedged. Driven
		// through a shadow `scripts/` whose every entry but `lib/` links to the
		// real one, and whose `lib/` links every non-`.ts` file but the probe
		// library; --preserve-symlinks keeps the host resolving its library
		// from the shadow.
		const shadow = path.join(fx.dir, "scripts");
		const realScripts = path.dirname(SCRIPT);
		fs.mkdirSync(shadow, { recursive: true });
		for (const e of fs.readdirSync(realScripts)) {
			if (e !== "lib")
				fs.symlinkSync(path.join(realScripts, e), path.join(shadow, e));
		}
		const shadowLib = path.join(shadow, "lib");
		installLib(shadowLib, {
			keep: (f) => f !== "interop-probe.sh",
			link: true,
		});
		fs.writeFileSync(path.join(shadowLib, "interop-probe.sh"), "if then fi\n");

		// spawn-kept: a §N5 fail-open, crossed through the entry from a shadow scripts tree
		const r = spawnSync(
			process.execPath,
			[
				"--preserve-symlinks",
				"--preserve-symlinks-main",
				path.join(shadow, "dispatch-sessions.js"),
				"sonnet",
				"/implement 341",
			],
			{
				cwd: fx.dir,
				encoding: "utf8",
				env: fx.baseEnv({ CLAUDE_INTEROP_REG: fx.regWedged() }),
			},
		);
		expect(r.status, r.stderr).toBe(0);
		expect(fx.launchArgv()).toContain("--bg");
	});
});
