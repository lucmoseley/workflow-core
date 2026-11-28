// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const gateway = createRequire(__filename)("./jev-gateway.js");

describe("isMalformedReply", () => {
	it.each([
		["its own rejection", { name: "JevMalformedReply" }],
		["the SDK's answer-set check", { name: "AI_InvalidResponseDataError" }],
		[
			"a 2xx whose body failed to parse",
			{
				name: "GatewayResponseError",
				statusCode: 200,
				cause: { name: "AI_JSONParseError" },
			},
		],
	])("classifies %s as an answer, not an outage", (_name, err) => {
		expect(gateway.isMalformedReply(err)).toBe(true);
	});

	it.each([
		[
			"a 500 whose error page failed to parse",
			{
				name: "GatewayResponseError",
				statusCode: 500,
				cause: { name: "AI_JSONParseError" },
			},
		],
		[
			"a 200 whose socket dropped",
			{
				name: "GatewayResponseError",
				statusCode: 200,
				cause: { name: "AI_APICallError", cause: { name: "SocketError" } },
			},
		],
		["a rate limit", { name: "GatewayInternalServerError", statusCode: 429 }],
		["nothing at all", undefined],
	])("classifies %s as an outage", (_name, err) => {
		expect(gateway.isMalformedReply(err)).toBe(false);
	});

	it("does not hang on an error whose cause chain loops", () => {
		const err: Record<string, unknown> = { name: "GatewayResponseError" };
		err.cause = err;
		expect(gateway.isMalformedReply(err)).toBe(false);
	});
});
