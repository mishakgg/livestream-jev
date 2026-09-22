import type { FastifyInstance } from "fastify";
import { DemoLoginRequestSchema } from "@livestream/contracts";
import { demoLogin } from "../auth.js";
import { demoEnabled, sendError } from "../errors.js";

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  // Development-only demo login. In production this route does not exist.
  app.post("/api/demo/login", async (req, reply) => {
    if (!demoEnabled()) return sendError(reply, "not_found", "Not found.");
    const parsed = DemoLoginRequestSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, "bad_request", "Invalid login request.");
    const session = await demoLogin(parsed.data.username);
    if (!session) return sendError(reply, "unauthorized", "Unknown demo user.");
    return reply.send({
      token: session.token,
      userId: session.userId,
      displayName: session.displayName,
      workspaceId: session.workspaceId,
      role: session.role,
    });
  });
}
