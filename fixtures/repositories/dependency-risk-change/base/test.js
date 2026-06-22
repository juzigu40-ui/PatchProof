import { answer } from "./index.js";

if (answer() !== 42) {
  throw new Error("wrong answer");
}
