import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const challenge = JSON.parse(readFileSync(3, "utf8"));
const target = readFileSync(".github/patchproof-pr-target.txt", "utf8").trim();
const status = target === "fixed" ? "assertion_passed" : "assertion_failed";

writeFileSync(4, `${JSON.stringify({ nonce: challenge.nonce, status })}\n`, "utf8");
process.exit(status === "assertion_passed" ? 0 : 1);
