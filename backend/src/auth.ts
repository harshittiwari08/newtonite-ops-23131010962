import { Request, Response, NextFunction } from 'express';
import { PrismaClient, Role } from '@prisma/client';

export const prisma = new PrismaClient();

export interface AuthUser {
    id: string;
    email: string;
    name: string;
    memberships: { teamId: string; role: Role; teamName: string }[];
}

declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
        }
    }
}

// Middleware: Identifies the logged-in user and loads their team roles
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const userId = req.header('x-user-id');
    if (!userId) {
        return res.status(401).json({ error: 'Authentication required. Missing x-user-id header.' });
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { memberships: { include: { team: true } } },
    });

    if (!user) {
        return res.status(401).json({ error: 'Invalid user ID.' });
    }

    req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        memberships: user.memberships.map((m) => ({
            teamId: m.teamId,
            role: m.role,
            teamName: m.team.name,
        })),
    };

    next();
}

// Helper: Gets the user's role in a specific team (or null if they aren't in that team)
export function getRoleInTeam(user: AuthUser, teamId: string): Role | null {
    const isGlobalAdmin = user.memberships.some((m) => m.role === Role.ADMIN);
    if (isGlobalAdmin) return Role.ADMIN;

    const membership = user.memberships.find((m) => m.teamId === teamId);
    return membership ? membership.role : null;
}

// Helper: Checks if the user's role meets the minimum required level
const ROLE_RANK: Record<Role, number> = {
    VIEWER: 1,
    MEMBER: 2,
    LEAD: 3,
    ADMIN: 4,
};

export function hasMinRole(user: AuthUser, teamId: string, minRole: Role): boolean {
    const role = getRoleInTeam(user, teamId);
    if (!role) return false;
    return ROLE_RANK[role] >= ROLE_RANK[minRole];
}