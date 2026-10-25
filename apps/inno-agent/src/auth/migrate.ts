import { readAuthRuntimeConfig } from "./config.js";
import { migrateAuthDatabase } from "./migration.js";

await migrateAuthDatabase(readAuthRuntimeConfig(process.env), process.argv.includes("--print"));
if (!process.argv.includes("--print")) console.log("Better Auth schema is up to date.");
