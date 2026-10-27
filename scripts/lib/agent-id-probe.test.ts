// @vitest-environment node
/*
 * Pins that the agent_id probe reads 2.1.310's two-argument builder calls as
 * "not fixed", a third argument or a named agent_id as "fixed", and an absent
 * anchor or unknown shape as unprobed, never "fixed" (#2819).
 *
 * The excerpts (scripts/fixtures/agent-id-2.1.310.txt) are 2.1.310's own
 * bytes around each anchor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeAgentId } from "./agent-id-probe.js";

/* Line 1 is PreCompact's, line 2 SessionStart's, line 3 their builder's
 * definition. */
const [
	PRE_COMPACT_2_1_310 = "",
	SESSION_START_2_1_310 = "",
	BUILDER_2_1_310 = "",
] = fs
	.readFileSync(
		path.join(__dirname, "..", "fixtures", "agent-id-2.1.310.txt"),
		"utf8",
	)
	.split("\n");

let dir: string;
let bin: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-id-probe-"));
	bin = path.join(dir, "claude");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const probeOn = (...excerpts: string[]) => {
	const bytes = [...excerpts, BUILDER_2_1_310].join("\0padding\0");
	fs.writeFileSync(bin, `\0\0binary\0${bytes}\0`);
	return probeAgentId(bin);
};

describe("probeAgentId", () => {
	it("is not fixed on 2.1.310's two-argument builder calls", () => {
		const f = probeOn(PRE_COMPACT_2_1_310, SESSION_START_2_1_310);
		expect(f.verdict).toBe("not fixed");
		expect(f.reasons).toEqual([
			"the PreCompact builder Vu gets 2 arguments, short of parameter 4, which carries agent_id",
			"the SessionStart builder Vu gets 2 arguments, short of parameter 4, which carries agent_id",
		]);
	});

	it("is fixed when a builder call takes a context argument, naming that builder", () => {
		const f = probeOn(
			PRE_COMPACT_2_1_310.replace("Vu(e,Cg())", "Vu(e,Cg(),void 0,r)"),
			SESSION_START_2_1_310,
		);
		expect(f.verdict).toBe("fixed");
		expect(f.reasons).toEqual([
			"the PreCompact builder Vu now gets 4 arguments, reaching parameter 4, which carries agent_id",
		]);
	});

	it("is fixed when the payload literal names agent_id itself", () => {
		const f = probeOn(
			PRE_COMPACT_2_1_310,
			SESSION_START_2_1_310.replace(
				"agent_type:h,",
				"agent_id:K?.agentId,agent_type:h,",
			),
		);
		expect(f.verdict).toBe("fixed");
		expect(f.reasons).toEqual([
			"the SessionStart payload literal names agent_id itself",
		]);
	});

	it("is not fixed on a third argument that stops short of the context parameter", () => {
		const f = probeOn(
			PRE_COMPACT_2_1_310.replace("Vu(e,Cg())", "Vu(e,Cg(),r)"),
			SESSION_START_2_1_310,
		);
		expect(f.verdict).toBe("not fixed");
	});

	it("is unprobed, not not-fixed, when no builder definition reads agent_id off a parameter", () => {
		const f = probeOn(
			PRE_COMPACT_2_1_310,
			SESSION_START_2_1_310.replaceAll("Vu(", "Xq("),
		);
		expect(f.verdict).toBe("unprobed");
		expect(f.reasons).toContain(
			"no definition of the SessionStart builder Xq reads agent_id off a parameter",
		);
	});

	it("is unprobed, not fixed, when an anchor is absent", () => {
		const f = probeOn(PRE_COMPACT_2_1_310);
		expect(f.verdict).toBe("unprobed");
		expect(f.reasons).toContain(
			'hook_event_name:"SessionStart" is not in the binary',
		);
	});

	it("is unprobed when the literal has no builder spread it knows", () => {
		const f = probeOn(
			PRE_COMPACT_2_1_310.replace("...Vu(e,Cg()),", "base:Vu(e,Cg()),"),
			SESSION_START_2_1_310,
		);
		expect(f.verdict).toBe("unprobed");
	});

	it("is unprobed where the binary cannot be found", () => {
		expect(probeAgentId(path.join(dir, "absent")).verdict).toBe("unprobed");
	});
});
