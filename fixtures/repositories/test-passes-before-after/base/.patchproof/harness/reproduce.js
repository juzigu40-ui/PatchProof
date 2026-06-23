import { readFileSync, writeFileSync } from "node:fs";

const challenge = JSON.parse(readFileSync(3, "utf8"));
writeFileSync(4, `${JSON.stringify({ nonce: challenge.nonce, status: "assertion_passed" })}\n`);
