import type { FastifyReply } from "fastify";
import type { ApiErrorCode } from "@livestream/contracts";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stale_evidence: 409,
  policy_changed: 409,
  permission_required: 403,
  role_revoked: 403,
  preview_no_writes: 403,
  rate_limited: 429,
  outcome_unknown: 409,
  unsupported_capability: 400,
  missing_target: 400,
  paused: 409,
  expired: 410,
  idempotency_conflict: 409,
  gone: 410,
};

export function sendError(
  reply: FastifyReply,
  code: ApiErrorCode,
  message: string,
  current?: Record<string, unknown>
): FastifyReply {
  return reply.status(STATUS[code]).send({ code, message, ...(current ? { current } : {}) });
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Demo endpoints exist only in non-production with DEMO_ENABLED=true. */
export function demoEnabled(): boolean {
  return !isProduction() && process.env.DEMO_ENABLED !== "false";
}
