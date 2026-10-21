import { prisma } from "@octavolab/db";

export const usersRepo = {
  byEmail: (email: string) => prisma.user.findUnique({ where: { email: email.toLowerCase() } }),
  byId: (id: string) => prisma.user.findUnique({ where: { id } }),
};
