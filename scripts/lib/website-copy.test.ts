// @vitest-environment node
/*
 * The two halves of the §11 gate: where copy lives, and what is banned in it.
 * Almost every false positive this gate could produce is an extraction bug, so
 * that half carries the bulk. Both run in-process on source strings through
 * scanSource, the one function the checker calls (mantahostels#858, #47).
 *
 * `check-website-copy.js` refuses on it in `.husky/pre-commit`; loosen a case
 * and a banned tell reaches the live site's copy unrefused, or correct copy is
 * refused on a misread literal.
 */

import { describe, expect, it } from "vitest";

const { scanSource } = require("./website-copy.js");

/** The copy runs an em dash was found in. A hit's context is its whole run
 *  while the run is short, as every fixture here is, so this reads back
 *  exactly which text was taken as copy. */
const dashed = (src: string) =>
	scanSource(src)
		.filter((h: { tag: string }) => h.tag === "EM-DASH")
		.map((h: { context: string }) => h.context);
const tags = (src: string) =>
	scanSource(src).map((h: { tag: string }) => h.tag);

describe("what counts as copy", () => {
	it("takes a double- and single-quoted string literal", () => {
		expect(dashed('const a = "a sentence — of copy";')).toEqual([
			"a sentence — of copy",
		]);
		expect(dashed("const a = 'a sentence — of copy';")).toEqual([
			"a sentence — of copy",
		]);
	});

	it("takes JSX text between tags", () => {
		expect(dashed("<p>The better way — to find hostels.</p>")).toEqual([
			"The better way — to find hostels.",
		]);
	});

	it("takes both halves of a template literal around an interpolation", () => {
		// Assembled rather than written out, so this fixture's own `${` is not read
		// as an interpolation by the file it lives in.
		const D = "$";
		expect(
			dashed(`const t = \`Best hostels — in ${D}{place.name} today — now\`;`),
		).toEqual(["Best hostels — in", "today — now"]);
	});

	// Comments are repo prose, not website copy, and keep their em dash.
	it("ignores line and block comments", () => {
		expect(dashed("// a comment — with an em dash\n")).toEqual([]);
		expect(dashed("/* a comment — with an em dash */")).toEqual([]);
	});

	// An apostrophe in a comment must not open a string literal that then runs to
	// the end of the file and drags the whole tail in as copy.
	it("does not let an apostrophe in a comment swallow the file", () => {
		expect(
			dashed("// don't panic — it's fine\nconst c = \"clean — copy\";\n"),
		).toEqual(["clean — copy"]);
	});

	// A JSX block comment sits between two tags, exactly where JSX text sits.
	it("ignores a JSX block comment between two elements", () => {
		expect(
			dashed("<p>a copy — line</p>{/* a note — with a dash */}<p>b — c</p>"),
		).toEqual(["a copy — line", "b — c"]);
	});

	// The `//` inside a URL must not swallow the rest of the line.
	it("does not read a comment marker inside a string literal", () => {
		expect(
			dashed('const s = "https://x.test"; const c = "real — copy here";'),
		).toEqual(["real — copy here"]);
	});

	it("ignores import and require specifiers", () => {
		expect(
			dashed('import { Manta } from "@/app/_components/Manta — x";'),
		).toEqual([]);
		expect(dashed('const p = require("./showcase — helper");')).toEqual([]);
	});

	// The value is multi-word, so only the attribute name keeps it out of scope.
	it("ignores identifier-carrying attributes", () => {
		expect(
			dashed('<a className="btn — coral" href="/best — hostels">x — y</a>'),
		).toEqual(["x — y"]);
	});

	// A module specifier may legally carry a space, and then only knowing it is a
	// specifier keeps it out of scope.
	it("ignores an import specifier that is not token-shaped", () => {
		expect(dashed('import "./brand — notes.css";')).toEqual([]);
	});

	// A <meta content="…"> is copy, which is why `content` is not on that list.
	it("keeps a content attribute", () => {
		expect(dashed('<meta content="Find hostels — in Ostria." />')).toEqual([
			"Find hostels — in Ostria.",
		]);
	});

	// A slug spelling a cliche is an identifier, not prose.
	it("ignores a token-shaped string wherever it sits", () => {
		expect(tags('const slug = "must-visit";')).toEqual([]);
		expect(tags('const c = "a must-visit";')).toEqual(["TRAVEL-CLICHE"]);
	});

	// A regex literal's body is neither code nor copy, and `/"/` left unread
	// swallows the next real string whole (mantahostels#858).
	it("does not let a regex literal swallow the string after it", () => {
		expect(dashed('const re = /"/;\nconst c = "Busy — cheap";\n')).toEqual([
			"Busy — cheap",
		]);
	});

	// A regex whose body holds a balanced pair of quotes closes on its own line, so
	// the unterminated-quote rule cannot rescue this one — only reading the regex can.
	it("does not read a regex body as copy", () => {
		expect(dashed('const re = /"a — b"/;')).toEqual([]);
	});

	// `</p>` must not read as a regex opening, which would eat the rest of the line.
	it("does not read a JSX closing tag as a regex", () => {
		expect(dashed("<p>a copy — line</p><p>and another — here</p>")).toEqual([
			"a copy — line",
			"and another — here",
		]);
	});

	// A JS string cannot span a raw newline, so an unclosed quote opened no string.
	// A raw apostrophe in JSX text is legal TSX and is the common case.
	it("does not let an apostrophe in JSX text swallow the file", () => {
		expect(
			dashed('<p>don\'t miss — it</p>\nconst c = "Busy — cheap";\n'),
		).toEqual(["don't miss — it", "Busy — cheap"]);
	});

	// places.ts holds every place blurb as an object VALUE under a key that doubles
	// as a JSX attribute name, so the attribute test must not disqualify on the `:`.
	it("keeps an object value whose key shares a JSX attribute name", () => {
		expect(dashed('const p = { name: "Velmora — the hub" };')).toEqual([
			"Velmora — the hub",
		]);
	});

	// The shape test must not swallow a one-word string carrying a tell.
	it("keeps a one-word string containing a curly apostrophe", () => {
		expect(tags("const s = 'don’t';")).toEqual(["CURLY-QUOTE"]);
	});
});

describe("scanSource", () => {
	const copy = (s: string) => `const c = ${JSON.stringify(s)};`;

	it.each([
		["Velmora is a tapestry of surf culture.", "AI-VOCAB"],
		["The interplay of surf and cafes.", "AI-VOCAB"],
		["Velmora serves as Ostria's hub.", "COPULA"],
		["The hostel boasts a pool.", "COPULA"],
		["A pool and a bar, ensuring a good stay.", "ING-TAIL"],
		["It is not just a hostel, it's a home.", "NEG-PARALLEL"],
		["Experts believe Ostria is crowded.", "VAGUE-ATTRIBUTION"],
		["Book now \u{1F30A}", "EMOJI"],
		["Don’t miss it.", "CURLY-QUOTE"],
		["Busy and social — and cheap.", "EM-DASH"],
		["Here's the thing about Velmora.", "FILLER"],
		["It turns out the beach is closer.", "FILLER"],
		["When it comes to price, we are direct.", "FILLER"],
		["In today's market, book direct.", "FILLER"],
		["Direct booking is a game-changer.", "FILLER"],
		["We lean into honest reviews.", "FILLER"],
		["We double down on honest reviews.", "FILLER"],
		["A paradise for beginner surfers.", "TRAVEL-CLICHE"],
		["A hostel nestled above the beach.", "TRAVEL-CLICHE"],
		["A vibrant, bustling street.", "TRAVEL-CLICHE"],
		["A hidden gem in Tavrin.", "TRAVEL-CLICHE"],
		["A must-visit surf break.", "TRAVEL-CLICHE"],
		["In the heart of Velmora.", "TRAVEL-CLICHE"],
	])("flags %j as %s", (line, tag) => {
		expect(tags(copy(line as string))).toContain(tag);
	});

	it.each([
		// The house cadence §11 keeps on purpose.
		"Surf, sleep and repeat.",
		// An arrow is not an emoji.
		"Best hostels →",
		// A hyphen and an en dash are not the banned character.
		"A long-stay, budget-friendly base.",
		// Deliberately out of scope: "features" as a noun.
		"The hostel features you actually care about.",
		// Excluded from the jargon tell: both are literal on a hostel page.
		"Navigate to your booking.",
		"Unpack and head straight out.",
		// The adverb ban stop-slop applies to prose is not adopted (§11 item 12).
		"Just five minutes from the beach.",
		// An obligation, not the compound cliche.
		"Guests must visit reception on arrival.",
		// §11 item 12 lists here's thing/what/why; "how" titles a live page.
		"Here's how we rank hostels.",
		// A room type and a corridor, not the jargon (mantahostels#2812).
		"Private doubles down the hall.",
		// Ordinary English mid-sentence; the cliche is an opener (mantahostels#2812).
		"Check in today's guests.",
		// Capitalised, these are hostel names (mantahostels#2812).
		"Paradise Hostel, Brennick.",
		"The Oasis, South Quellan.",
		// "the truth is" needs its trailing word boundary (mantahostels#2812).
		"The truth island tour leaves at nine.",
	])("leaves %j alone", (line) => {
		expect(tags(copy(line))).toEqual([]);
	});

	// A footer's copyright mark is Extended_Pictographic and is never decoration.
	it.each(["© 2026 MantaHostels", "MantaHostels®", "Manta™"])(
		"does not call %j an emoji",
		(line) => {
			expect(tags(copy(line))).toEqual([]);
		},
	);

	// JSX copy is written with entities as often as with the character itself.
	it.each([
		["Busy &mdash; and cheap.", "EM-DASH"],
		["Don&rsquo;t miss it.", "CURLY-QUOTE"],
		// #47: the decimal and hex numeric-entity alternatives.
		["Don&#8217;t miss it.", "CURLY-QUOTE"],
		["Don&#x2019;t miss it.", "CURLY-QUOTE"],
	])("flags the entity spelling %j as %s", (line, tag) => {
		expect(tags(copy(line as string))).toContain(tag);
	});

	/* One sample per tell, said twice. A tag may repeat: one §11 item can need
	 * several patterns with different fixes, and two identical ones would report
	 * each hit twice. A pattern without the global flag throws instead. A tell
	 * with no sample here goes unchecked for both (#1368). */
	it.each([
		["Velmora is a tapestry of surf.", "AI-VOCAB"],
		["The hostel boasts a pool.", "COPULA"],
		["A pool, ensuring calm.", "ING-TAIL"],
		["It is not just a hostel, it's a home.", "NEG-PARALLEL"],
		["Experts believe it.", "VAGUE-ATTRIBUTION"],
		["It turns out fine.", "FILLER"],
		["When it comes to price.", "FILLER"],
		["A real game-changer.", "FILLER"],
		["A hostel nestled above.", "TRAVEL-CLICHE"],
		["A surf paradise.", "TRAVEL-CLICHE"],
		["Book now \u{1F30A}", "EMOJI"],
		["Don’t.", "CURLY-QUOTE"],
		["Busy — cheap.", "EM-DASH"],
	])("reports %j said twice as two %s hits, each with a fix", (line, tag) => {
		const hits = scanSource(copy(`${line} ${line}`));
		expect(hits.map((h: { tag: string }) => h.tag)).toEqual([tag, tag]);
		for (const h of hits) expect(h.fix.length).toBeGreaterThan(10);
	});

	it("reports the line the tell sits on, not the line the file starts at", () => {
		const src = `const a = "clean";\nconst b = "clean";\nconst c = "surf — sleep";\n`;
		expect(scanSource(src)).toEqual([
			expect.objectContaining({ tag: "EM-DASH", line: 3 }),
		]);
	});

	it("reports every hit on one line, not just the first", () => {
		expect(
			tags(copy("Reef breaks — Saltreach and Quellan — for the confident.")),
		).toEqual(["EM-DASH", "EM-DASH"]);
	});

	it("carries a fix and enough context to recognise the hit", () => {
		const [hit] = scanSource(copy("Saltreach boasts a clifftop view."));
		expect(hit.fix).toMatch(/is.+has/);
		expect(hit.context).toContain("clifftop");
	});
});
