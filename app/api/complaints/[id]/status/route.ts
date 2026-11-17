import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query, withTransaction, setAuditContext, isClientDbError } from '@/lib/db';
import { updateComplaintStatusInMongo, getComplaintCollection } from '@/lib/mongo';

const STATUSES = ['SUBMITTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'];
// Statuses a field technician may set on a complaint assigned to them.
const STAFF_TARGETS = ['IN_PROGRESS', 'RESOLVED', 'REJECTED'];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Reporters cannot change workflow status; only staff (own assignments) and admins can.
  const auth = await requireAuth(['STAFF', 'ADMIN']);
  if (auth instanceof NextResponse) return auth;
  const session = auth;

  try {
    const { id } = await params;
    const complaintId = Number(id);
    const { status, remarks } = await req.json();
    const cleanRemarks = typeof remarks === 'string' ? remarks.trim().slice(0, 1000) : '';

    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return NextResponse.json({ error: 'Invalid complaint ID' }, { status: 400 });
    }
    if (!STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    const result = await withTransaction(async (tx) => {
      const cur = await tx.query(
        `SELECT c.status, c.reporter_id, c.title,
                (SELECT a.staff_id FROM assignments a WHERE a.complaint_id = c.complaint_id AND a.ended_at IS NULL) AS staff_id
         FROM complaints c WHERE c.complaint_id = $1 FOR UPDATE`,
        [complaintId]
      );
      if (cur.rows.length === 0) return { error: 'Complaint not found', code: 404 as const };
      const row = cur.rows[0];

      if (row.status === status) {
        return { error: `Complaint is already ${status}`, code: 400 as const };
      }
      if (session.role_name === 'STAFF') {
        if (Number(row.staff_id) !== session.user_id) {
          return { error: 'You can only update complaints assigned to you', code: 403 as const };
        }
        if (!STAFF_TARGETS.includes(status)) {
          return { error: `Technicians can only set: ${STAFF_TARGETS.join(', ')}`, code: 403 as const };
        }
      }

      // The trigger validates the transition, maintains resolved_at and writes ONE audit row
      // attributed to this user with these remarks.
      await setAuditContext(tx, session.user_id, cleanRemarks);
      await tx.query(`UPDATE complaints SET status = $1 WHERE complaint_id = $2`, [status, complaintId]);

      await tx.query(
        `INSERT INTO notifications (user_id, complaint_id, message)
         VALUES ($1, $2, $3)`,
        [row.reporter_id, complaintId, `Complaint #${complaintId} (${row.title}) was updated to ${status}`]
      );
      return { ok: true as const, reporterId: Number(row.reporter_id), title: row.title as string };
    });

    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.code });
    }

    await updateComplaintStatusInMongo(complaintId, status, cleanRemarks);

    // Notify citizens who upvoted this issue (their ids live in MongoDB affected_users).
    try {
      const col = await getComplaintCollection();
      const doc = await col.findOne({ complaint_id: complaintId });
      const others = (doc?.metadata?.affected_users || []).filter(
        (u) => u !== result.reporterId && u !== session.user_id
      );
      if (others.length > 0) {
        await query(
          `INSERT INTO notifications (user_id, complaint_id, message)
           SELECT u.user_id, $2, $3 FROM users u WHERE u.user_id = ANY($1::bigint[])`,
          [others, complaintId, `The issue you upvoted #${complaintId} (${result.title}) has been updated to ${status}`]
        );
      }
    } catch (err: any) {
      console.warn('Upvoter notifications skipped:', err.message);
    }

    return NextResponse.json({ success: true, complaint_id: complaintId, status });
  } catch (err: any) {
    console.error('Error updating status:', err);
    const client = isClientDbError(err);
    return NextResponse.json({ error: client ? err.message : 'Failed to update status' }, { status: client ? 400 : 500 });
  }
}
