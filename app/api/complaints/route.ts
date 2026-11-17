import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { query, withTransaction, isClientDbError } from '@/lib/db';
import { getSession, requireAuth } from '@/lib/auth';
import { generateEmbedding, toVectorString, EMBEDDING_MODEL_NAME } from '@/lib/vector';
import { trySyncComplaintToMongo, getComplaintCollection } from '@/lib/mongo';

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const STATUSES = ['SUBMITTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'];

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    const privileged = session?.role_name === 'ADMIN' || session?.role_name === 'STAFF';

    const { searchParams } = new URL(req.url);
    const reporterId = searchParams.get('reporter_id');
    const staffId = searchParams.get('staff_id');
    const status = searchParams.get('status');
    const search = searchParams.get('search');

    if (status && !STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 });
    }

    let sql = `
      SELECT
        c.complaint_id, c.title, c.description, c.location_text, c.priority, c.status,
        c.created_at, c.resolved_at,
        cat.category_id, cat.category_name, cat.target_hours,
        d.department_id, d.department_name,
        rep.user_id AS reporter_id,
        rep.full_name AS reporter_name,
        ${privileged ? 'rep.email' : 'NULL'} AS reporter_email,
        staff.user_id AS staff_id,
        staff.user_id AS assigned_staff_id,
        staff.full_name AS staff_name,
        staff.full_name AS assigned_staff_name,
        a.assigned_at,
        f.rating AS feedback_rating,
        f.comment AS feedback_comment
      FROM complaints c
      JOIN categories cat ON c.category_id = cat.category_id
      JOIN departments d ON cat.department_id = d.department_id
      JOIN users rep ON c.reporter_id = rep.user_id
      LEFT JOIN assignments a ON c.complaint_id = a.complaint_id AND a.ended_at IS NULL
      LEFT JOIN users staff ON a.staff_id = staff.user_id
      LEFT JOIN feedback f ON c.complaint_id = f.complaint_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (reporterId) {
      params.push(Number(reporterId));
      sql += ` AND c.reporter_id = $${params.length}`;
    }
    if (staffId) {
      params.push(Number(staffId));
      sql += ` AND a.staff_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      sql += ` AND c.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (c.title ILIKE $${params.length} OR c.description ILIKE $${params.length} OR c.location_text ILIKE $${params.length})`;
    }
    sql += ` ORDER BY c.complaint_id DESC`;

    const res = await query(sql, params);

    // Enrich with live community metadata from MongoDB (degrades gracefully if Mongo is down).
    try {
      const col = await getComplaintCollection();
      const ids = res.rows.map((r) => r.complaint_id);
      const docs = await col.find({ complaint_id: { $in: ids } }).toArray();
      const byId = new Map(docs.map((d) => [d.complaint_id, d]));
      const enriched = res.rows.map((r) => {
        const d = byId.get(r.complaint_id);
        return {
          ...r,
          upvote_count: d?.metadata?.upvote_count ?? 1,
          affected_count: d?.metadata?.affected_users?.length ?? 1,
        };
      });
      return NextResponse.json({ success: true, complaints: enriched });
    } catch {
      return NextResponse.json({ success: true, complaints: res.rows.map((r) => ({ ...r, upvote_count: 1, affected_count: 1 })) });
    }
  } catch (err: any) {
    console.error('Error fetching complaints:', err);
    return NextResponse.json({ error: 'Failed to fetch complaints' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const session = auth;

  try {
    const body = await req.json();
    const categoryId = Number(body.category_id);
    const title = String(body.title ?? '').trim();
    const description = String(body.description ?? '').trim();
    const locationText = String(body.location_text ?? '').trim();
    const priority = String(body.priority ?? '').toUpperCase();

    if (!Number.isInteger(categoryId) || categoryId <= 0 || !title || !description || !locationText) {
      return NextResponse.json(
        { error: 'Category, title, description and location are all required.' },
        { status: 400 }
      );
    }
    if (title.length > 200 || locationText.length > 200) {
      return NextResponse.json({ error: 'Title and location must be at most 200 characters.' }, { status: 400 });
    }
    if (!PRIORITIES.includes(priority)) {
      return NextResponse.json({ error: `Priority must be one of ${PRIORITIES.join(', ')}.` }, { status: 400 });
    }

    const fullText = `${title} ${description} ${locationText}`;
    const vecStr = toVectorString(generateEmbedding(fullText));
    const contentHash = crypto.createHash('sha256').update(fullText).digest('hex');

    // One real ACID transaction: complaint + initial history + admin notifications (via the stored
    // procedure) and the vector embedding either all commit or all roll back.
    const { complaintId, meta } = await withTransaction(async (tx) => {
      const proc = await tx.query(
        `CALL sp_create_complaint($1, $2, $3, $4, $5, $6, NULL::bigint)`,
        [session.user_id, categoryId, title, description, locationText, priority]
      );
      const id = Number(proc.rows[0].p_complaint_id);

      await tx.query(
        `INSERT INTO complaint_embeddings (complaint_id, embedding, model_name, content_hash)
         VALUES ($1, $2::vector, $3, $4)`,
        [id, vecStr, EMBEDDING_MODEL_NAME, contentHash]
      );

      const m = await tx.query(
        `SELECT c.created_at, cat.category_name, d.department_name
         FROM complaints c
         JOIN categories cat ON c.category_id = cat.category_id
         JOIN departments d ON cat.department_id = d.department_id
         WHERE c.complaint_id = $1`,
        [id]
      );
      return { complaintId: id, meta: m.rows[0] };
    });

    // Mirror into MongoDB after commit (PostgreSQL is the system of record).
    const mongoOk = await trySyncComplaintToMongo({
      complaint_id: complaintId,
      title,
      description,
      category: meta.category_name,
      department: meta.department_name,
      location: locationText,
      priority,
      status: 'SUBMITTED',
      reporter_id: session.user_id,
      created_at: meta.created_at,
    });

    return NextResponse.json({ success: true, complaint_id: complaintId, mongo_synced: mongoOk });
  } catch (err: any) {
    console.error('Error creating complaint:', err);
    if (err.code === '23503') {
      return NextResponse.json({ error: 'Selected category does not exist.' }, { status: 400 });
    }
    return NextResponse.json(
      { error: isClientDbError(err) ? err.message : 'Failed to create complaint' },
      { status: isClientDbError(err) ? 400 : 500 }
    );
  }
}
