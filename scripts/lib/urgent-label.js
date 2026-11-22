const URGENT_LABEL = "urgent";

/** @param {{state: string}} issue */
const isPassingDown = (issue) => issue.state === "open";

module.exports = { URGENT_LABEL, isPassingDown };
