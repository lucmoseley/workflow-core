// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { remoteRewindRule, rewindReason } = require("./main-rewind.js");
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

interface Needle {
	id?: string;
	text?: string | string[];
}

const needles: Needle[] = [];
(function walk(node: unknown) {
	if (Array.isArray(node)) node.forEach(walk);
	else if (node && typeof node === "object") {
		if ("id" in node) needles.push(node as Needle);
		Object.values(node).forEach(walk);
	}
})(
	JSON.parse(
		fs.readFileSync(
			path.resolve(__dirname, "..", "guard-fire-needles.json"),
			"utf8",
		),
	),
);

const textOf = (id: string) => {
	const text = needles.find((n) => n.id === id)?.text;
	expect(text, `no needle ${id}`).toBeDefined();
	return Array.isArray(text) ? text : [text as string];
};

const ports = (stored: boolean) => ({
	ruleText: (id: string) => {
		if (!stored) throw new Error(`rule-text: no fragment for ${id}`);
		return readRuleText(id);
	},
	docPath: (name: string) => `docs/${name}`,
});

describe("guard-fire-needles.json keys on main-rewind.js's refusals", () => {
	it.each([
		["main-rewind", (stored: boolean) => rewindReason(ports(stored), "x")],
		[
			"main-remote-rewind",
			(stored: boolean) => remoteRewindRule(ports(stored)),
		],
	])(
		"%s's refusal carries its needle's text, from the rule store and from its fallback",
		(id, refusal) => {
			for (const part of textOf(id)) expect(refusal(true)).toContain(part);
			for (const part of textOf(`${id}-fallback`))
				expect(refusal(false)).toContain(part);
		},
	);
});
