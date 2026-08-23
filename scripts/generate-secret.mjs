import { randomBytes } from "node:crypto";

const length = Number(process.argv[2] ?? 32);
if (!Number.isInteger(length) || length < 32 || length > 128) {
  console.error("Secret length must be an integer between 32 and 128 bytes");
  process.exitCode = 1;
} else {
  console.log(randomBytes(length).toString("base64url"));
}
