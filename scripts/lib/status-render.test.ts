// @vitest-environment node

import { describe, expect, it } from "vitest";
import { render } from "./status-render.js";

const result = (name: string, out: string) => ({
	name,
	code: 0,
	signal: null,
	out,
});

describe("the STANDINGS print rule (#4107)", () => {
	it.each([
		"escape-audit",
		"primitives",
		"wsl-currency",
		"compaction-backstop",
		"release-lag",
	])("prints %s's body under its OK", (name) => {
		const text = render([result(name, "the standing\nOK: read")]);
		expect(text).toContain(`▸ ${name}  — OK\nthe standing`);
		expect(text).not.toContain("nothing to report from");
	});

	it("files a standing's SKIP with the clean list", () => {
		const text = render([result("wsl-currency", "SKIP: not WSL")]);
		expect(text).not.toContain("▸");
		expect(text).toContain("nothing to report from: wsl-currency (SKIP)");
	});

	it("files any other checker's OK with the clean list", () => {
		const text = render([result("gates", "the body\nOK: fine")]);
		expect(text).not.toContain("the body");
		expect(text).toContain("nothing to report from: gates (OK)");
	});
});
