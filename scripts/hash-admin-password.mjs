import { pbkdf2Sync, randomBytes } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const terminal = createInterface({ input: stdin, output: stdout });
const password = await terminal.question("Admin password: ");
terminal.close();

if (password.length < 12) {
  throw new Error("Use an admin password with at least 12 characters");
}

const iterations = 310_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
stdout.write(`pbkdf2-sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}\n`);