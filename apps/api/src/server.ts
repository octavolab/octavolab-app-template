// The env schema is imported first so a misconfigured process reports every invalid variable at once and exits before
// any other module (the integrations package has its own, narrower import-time guard) is evaluated.
import { env } from "./config/env.js";
import { buildApp } from "./app.js";

const app = await buildApp();
app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
