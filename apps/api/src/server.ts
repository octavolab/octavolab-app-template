// The env schema is imported first: a misconfigured process lists every invalid variable and exits before anything else runs.
import { APP_VERSION, env } from "./config/env.js";
import { buildApp } from "./app.js";

const app = await buildApp();
app.listen({ port: env.PORT, host: "0.0.0.0" })
  .then(() => {
    // One line per start, same shape as the worker's: what is running, in which integrations mode (never any secret).
    app.log.info({ event: "startup", service: "api", version: APP_VERSION, integrationsMode: env.INTEGRATIONS_MODE, nodeEnv: env.NODE_ENV }, "api started");
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
