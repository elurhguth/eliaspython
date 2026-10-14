import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { authRoutes, ensureAdminFromEnv } from "./auth.js";
import { coreRoutes } from "./routes/core.js";
import { adminRoutes } from "./routes/admin.js";
import { seedBots } from "./seed.js";
import { redactString } from "./redact.js";

async function main() {
  await migrate();
  await ensureAdminFromEnv();
  await seedBots();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      serializers: {
        req: (req) => ({ method: req.method, url: redactString(req.url.replace(/\/api\/hooks\/([^/]+)\/[^/?]+/, "/api/hooks/$1/••••")) }),
      },
    },
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: any, req, reply) => {
    req.log.error({ err: redactString(String(err?.stack ?? err)) }, "request failed");
    reply.code(err.statusCode && err.statusCode < 600 ? err.statusCode : 500).send({ error: redactString(err.message ?? "Internal error") });
  });

  authRoutes(app);
  coreRoutes(app);
  adminRoutes(app);

  await app.listen({ host: "0.0.0.0", port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
