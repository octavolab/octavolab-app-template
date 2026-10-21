import type { FastifyReply, FastifyRequest } from "fastify";
import { verifySession, issueSession, needsRotation, type Session } from "./session.js";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest { user?: Session }
}

export const SESSION_COOKIE = "sid";
export const cookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: env.SESSION_TTL_SECONDS,
});

/** preHandler: requires a valid session and, optionally, one of the roles. Rotates the cookie after half its life. */
export function requireAuth(roles?: Session["role"][]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const s = verifySession(req.cookies[SESSION_COOKIE], env.SESSION_SECRET);
    if (!s) throw new AppError("UNAUTHENTICATED", "Sign in required", 401);
    if (roles && !roles.includes(s.role)) throw new AppError("FORBIDDEN", "Not allowed", 403);
    if (needsRotation(s, env.SESSION_TTL_SECONDS)) {
      reply.setCookie(SESSION_COOKIE, issueSession({ uid: s.uid, role: s.role, tid: s.tid }, env.SESSION_SECRET, env.SESSION_TTL_SECONDS), cookieOptions());
    }
    req.user = s;
  };
}
