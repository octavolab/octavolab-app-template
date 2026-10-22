import { prisma } from "@octavolab/db";
import { buildApp } from "./app.js";
import { bootstrapIfRequested } from "./bootstrap.js";
import { env } from "./config/env.js";

const app = await buildApp();
// First access to a fresh environment (see bootstrap.ts): a no-op unless BOOTSTRAP_OWNER_* are set.
await bootstrapIfRequested(prisma as never, process.env, app.log);
app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
