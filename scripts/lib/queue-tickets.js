// measured median suite run 1987 s, x3.6, #2672
const STALL_MS = 2 * 60 * 60 * 1000;

const STALL_TITLE = "Landing queue stalled: main has not moved for 2 h";

const ALARM_TITLE =
	"Landing alarm red: an off-machine queue alarm failed since main last moved";

const QUEUE_ALERT_TITLES = {
	age: "Landing queue slow: a queue ref has waited past its limit",
	depth: "Landing queue deep: more queue refs wait than its limit",
};

module.exports = {
	ALARM_TITLE,
	QUEUE_ALERT_TITLES,
	STALL_MS,
	STALL_TITLE,
};
