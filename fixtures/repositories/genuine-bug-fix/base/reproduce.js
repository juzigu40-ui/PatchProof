import { add } from "./math.js";

if (add(2, 2) !== 4) {
  console.error("bug reproduced");
  console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status: "assertion_failed" }));
  process.exit(1);
}

console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status: "assertion_passed" }));
