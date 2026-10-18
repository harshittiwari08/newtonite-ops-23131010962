import { Priority, WorkItemStatus, WorkItemType } from '@prisma/client';

// The workflow lives in this one file so it is easy to read, explain and change.
//
//   OPEN -> IN_PROGRESS -> AWAITING_APPROVAL -> RESOLVED -> CLOSED
//   (plus a few "go back" moves, see the table)

export const ALLOWED_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
    OPEN: ['IN_PROGRESS'],
    IN_PROGRESS: ['OPEN', 'AWAITING_APPROVAL', 'RESOLVED'],
    AWAITING_APPROVAL: ['IN_PROGRESS', 'RESOLVED'],
    RESOLVED: ['IN_PROGRESS', 'CLOSED'],
    CLOSED: ['IN_PROGRESS'], // reopen
};

export interface TransitionRequest {
    item: { status: WorkItemStatus; priority: Priority; type: WorkItemType; resolutionNote: string | null };
    targetStatus: WorkItemStatus;
    newNote?: string; // note sent with this request (falls back to the item's saved note)
    isLead: boolean; // caller is LEAD or ADMIN in the item's team
}

export type RuleFailure = { status: 400 | 403; error: string };

/** Returns the first broken rule, or null if the move is allowed. */
export function checkTransition({ item, targetStatus, newNote, isLead }: TransitionRequest): RuleFailure | null {
    // Rule A: only moves listed in ALLOWED_TRANSITIONS exist
    if (!ALLOWED_TRANSITIONS[item.status].includes(targetStatus)) {
        return { status: 400, error: `Invalid transition: cannot move from ${item.status} to ${targetStatus}.` };
    }

    // Rule B: risky work must be approved. HIGH/CRITICAL items and incidents cannot jump
    // IN_PROGRESS -> RESOLVED unless a lead does it.
    const isRisky = item.priority === 'HIGH' || item.priority === 'CRITICAL' || item.type === 'INCIDENT';
    if (item.status === 'IN_PROGRESS' && targetStatus === 'RESOLVED' && isRisky && !isLead) {
        return { status: 403, error: 'High/Critical items and incidents must go to AWAITING_APPROVAL for lead sign-off.' };
    }

    // Rule C: only a lead can approve (AWAITING_APPROVAL -> RESOLVED)
    if (item.status === 'AWAITING_APPROVAL' && targetStatus === 'RESOLVED' && !isLead) {
        return { status: 403, error: 'Only a team LEAD or ADMIN can approve and resolve this item.' };
    }

    // Rule D: asking for approval or resolving needs a written note (min 5 characters)
    const note = newNote !== undefined ? newNote : item.resolutionNote;
    if ((targetStatus === 'AWAITING_APPROVAL' || targetStatus === 'RESOLVED') && (!note || note.trim().length < 5)) {
        return { status: 400, error: 'A resolution note (min 5 characters) is required for AWAITING_APPROVAL or RESOLVED.' };
    }

    return null;
}
