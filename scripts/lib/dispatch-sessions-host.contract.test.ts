// @vitest-environment node
/*
 * Holds the testkit's `node` and `sleep` ports (lib/dispatch-sessions-testkit.ts's
 * corePorts: each helper run in process, each stagger recorded) to the
 * production ones (lib/dispatch-sessions-host.js) on one case list (§G7,
 * #5145). Break it and every module case of the dispatcher passes on a helper
 * answer, or a stagger, the real dispatch never sees.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostPorts } from "./dispatch-sessions-host.js";
import { dispatchFixture } from "./dispatch-sessions-testkit";

const fx = dispatchFixture();

const USAGE =
	"Current session: 40% used · resets 5pm\nCurrent week (all models): 20% used · resets Mon\n";

const adapters = {
	production: () => hostPorts(),
	testkit: () => fx.corePorts(),
};

describe.each(Object.entries(adapters))("the %s ports", (_name, ports) => {
	const at = () => ({
		env: fx.baseEnv({ CLAUDE_CONFIG_DIR: path.join(fx.dir, "cfg") }),
		cwd: fx.dir,
	});

	it("answers a helper with its stdout and exit 0", async () => {
		const r = await ports().node("lib/model-table.js", ["alias", "opus"], at());
		expect(r).toEqual({ status: 0, stdout: "opus\n", stderr: "" });
	});

	it("carries a helper's refusal as its exit code", async () => {
		const r = await ports().node("lib/model-table.js", ["bogus"], at());
		expect(r.status).toBe(2);
	});

	it("hands the helper its stdin", async () => {
		const r = await ports().node(
			"allowance.js",
			[
				"--json",
				"--cap",
				"1",
				"--session-threshold",
				"90",
				"--week-threshold",
				"90",
			],
			{ ...at(), stdin: USAGE },
		);
		expect(r.status, r.stderr).toBe(0);
		expect(JSON.parse(r.stdout)).toMatchObject({
			session: { percent: 40, trust: "fresh" },
		});
	});

	it("returns from a stagger of no length", async () => {
		await expect(ports().sleep("0")).resolves.toBeUndefined();
	});
});
