import { answer } from "./index.js";

if (answer() === 42) {
  console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status: "assertion_passed" }));
  process.exit(0);
}

console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status: "assertion_failed" }));
process.exit(1);
