const { scriptPrompt } = require("./loop-prompts.js");

const PROMPT = "Reply with the single word ok. Use no tools.";
const SCRIPTED_PROMPT = scriptPrompt(PROMPT);
const ASK =
	"Ask me one question, whether I prefer red or blue, with the AskUserQuestion tool. Use no other tool.";
const PERMISSION_ASK =
	"Run exactly this Bash command and nothing else: touch /tmp/wfc-permission-probe. Use no other tool.";

module.exports = { ASK, PERMISSION_ASK, PROMPT, SCRIPTED_PROMPT };
