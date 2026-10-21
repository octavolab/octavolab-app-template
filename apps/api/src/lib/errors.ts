export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}
export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`, 404);
export const forbidden = () => new AppError("FORBIDDEN", "Not allowed", 403);
export const conflict = (msg: string) => new AppError("CONFLICT", msg, 409);
