// @vitest-environment node
/*
 * Pins that the dispatcher still launches where the interop-probe library
 * will not load (mantahostels#3111). Loosen it and a broken library refuses
 * every dispatch rather than failing open.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { interopProbe } from "./lib/dispatch-sessions-host.js";
import { dispatchFixture } from "./lib/dispatch-sessions-testkit";

const fx = dispatchFixture();

describe("the interop-bridge probe (mantahostels#3111)", () => {
	it("fails open where the probe library will not load", async () => {
		fx.stubClaude({});
		// A library the shell cannot parse leaves `claude_interop_wedged`
		// undefined, on a bridge that would otherwise read wedged.
		const broken = path.join(fx.dir, "interop-probe.sh");
		fs.writeFileSync(broken, "if then fi\n");
		const r = await fx.runCore(
			["sonnet", "/implement 341"],
			{ CLAUDE_INTEROP_REG: fx.regWedged() },
			{ interop: interopProbe(broken) },
		);
		expect(r.code).toBe(0);
		expect(fx.launchArgv()).toContain("--bg");
	});
});
