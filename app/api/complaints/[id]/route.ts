import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getSession, requireAuth } from '@/lib/auth';
import { deleteComplaintFromMongo, getComplaintCollection } from '@/lib/mongo';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const complaintId = Number(id);
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return NextResponse.json({ error: 'Invalid complaint ID' }, { status: 400 });
    }
    const session = await getSession();
    const privileged = session?.role_name === 'ADMIN' || session?.role_name === 'STAFF';

    const compRes = await query(
      `SELECT
        c.complaint_id, c.title, c.description, c.location_text, c.priority, c.status,
        c.created_at, c.resolved_at,
        cat.category_name, cat.target_hours,
        d.department_name,
        rep.user_id AS reporter_id,
        rep.full_name AS reporter_name,
        ${privileged ? 'rep.email' : 'NULL'} AS reporter_email,
        staff.user_id AS staff_id,
        staff.full_name AS staff_name,
        ${privileged ? 'staff.email' : 'NULL'} AS staff_email,
        a.assigned_at,
        f.rating AS feedback_rating,
        f.comment AS feedback_comment,
        f.created_at AS feedback_time
       FROM complaints c
       JOIN categories cat ON c.category_id = cat.category_id
       JOIN departments d ON cat.department_id = d.department_id
       JOIN users rep ON c.reporter_id = rep.user_id
       LEFT JOIN assignments a ON c.complaint_id = a.complaint_id AND a.ended_at IS NULL
       LEFT JOIN users staff ON a.staff_id = staff.user_id
       LEFT JOIN feedback f ON c.complaint_id = f.complaint_id
       WHERE c.complaint_id = $1`,
      [complaintId]
    );
    if (compRes.rows.length === 0) {
      return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });
    }

    // The audit trigger writes exactly one row per transition, so no de-duplication is needed.
    const histRes = await query(
      `SELECT sh.history_id,
              COALESCE(sh.old_status, 'INITIAL') AS old_status,
              sh.new_status,
              u.full_name AS changed_by,
              sh.changed_at,
              sh.remarks
       FROM status_history sh
       JOIN users u ON sh.changed_by = u.user_id
       WHERE sh.complaint_id = $1
       ORDER BY sh.history_id ASC`,
      [complaintId]
    );

    let mongoMeta: any = { upvote_count: 1, locations: [compRes.rows[0].location_text] };
    try {
      const col = await getComplaintCollection();
      const doc = await col.findOne({ complaint_id: complaintId });
      if (doc?.metadata) mongoMeta = doc.metadata;
    } catch {
      /* MongoDB optional for reads */
    }

    return NextResponse.json({ complaint: compRes.rows[0], history: histRes.rows, mongo_metadata: mongoMeta });
  } catch (err: any) {
    console.error('Error fetching complaint details:', err);
    return NextResponse.json({ error: 'Failed to fetch complaint' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(['ADMIN']);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const complaintId = Number(id);
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return NextResponse.json({ error: 'Invalid complaint ID' }, { status: 400 });
    }

    // ON DELETE CASCADE removes assignments, embeddings, feedback, history and notifications.
    const res = await query(`DELETE FROM complaints WHERE complaint_id = $1`, [complaintId]);
    if (!res.rowCount) {
      return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });
    }
    await deleteComplaintFromMongo(complaintId);
    return NextResponse.json({ success: true, message: 'Complaint deleted from PostgreSQL & MongoDB' });
  } catch (err: any) {
    console.error('Error deleting complaint:', err);
    return NextResponse.json({ error: 'Failed to delete complaint' }, { status: 500 });
  }
}
