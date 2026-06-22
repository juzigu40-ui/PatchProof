import { add } from "./math.js";

if (add(2, 2) !== 4) {
  console.error("bug reproduced");
  process.exit(1);
}
