import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const complaintId = Number(id);
    const { rating, comment } = await req.json();

    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return NextResponse.json({ error: 'Rating must be an integer between 1 and 5' }, { status: 400 });
    }
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return NextResponse.json({ error: 'Invalid complaint ID' }, { status: 400 });
    }

    const check = await query(`SELECT status, reporter_id FROM complaints WHERE complaint_id = $1`, [complaintId]);
    if (check.rows.length === 0) {
      return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });
    }
    // Only the person who filed the complaint may rate the service.
    if (check.rows[0].reporter_id !== auth.user_id) {
      return NextResponse.json({ error: 'Only the reporter of this complaint can submit feedback' }, { status: 403 });
    }
    if (check.rows[0].status !== 'RESOLVED') {
      return NextResponse.json({ error: 'Feedback can only be submitted for resolved complaints' }, { status: 400 });
    }

    await query(
      `INSERT INTO feedback (complaint_id, rating, comment, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (complaint_id)
       DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = CURRENT_TIMESTAMP`,
      [complaintId, r, typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 1000) : null]
    );
    return NextResponse.json({ success: true, complaint_id: complaintId, rating: r });
  } catch (err: any) {
    console.error('Error submitting feedback:', err);
    return NextResponse.json({ error: 'Failed to submit feedback' }, { status: 500 });
  }
}
