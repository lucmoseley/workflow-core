import type { Register } from "claude-code";
import { register as delivery } from "../.claude/skills/wfc-delivery/hooks/register.ts";
import { register as liveness } from "../.claude/skills/wfc-liveness/hooks/register.tsx";

export const register: Register = (on, options) => {
	delivery(on, options);
	liveness(on, options);
};
