const { cpSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

for (const service of ["coordinator", "participant"]) {
  const source = join("packages", service, "src", "generated");
  const destination = join("dist", "packages", service, "src", "generated");
  if (!existsSync(source)) {
    throw new Error(`Generated Prisma client not found at ${source}. Run prisma generate first.`);
  }
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}
