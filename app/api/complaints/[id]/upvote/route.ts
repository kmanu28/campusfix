import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import {
  upvoteComplaintInMongo,
  syncComplaintToMongo,
  updateComplaintPriorityInMongo,
} from '@/lib/mongo';

const LADDER = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
// Community escalation: one priority level up when the upvote count reaches each threshold.
const ESCALATION_THRESHOLDS = [3, 6];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const session = auth;

  try {
    const { id } = await params;
    const complaintId = Number(id);
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return NextResponse.json({ error: 'Invalid complaint ID' }, { status: 400 });
    }
    const body = await req.json().catch(() => ({}));
    const location = String(body.location || 'Reported from same block').slice(0, 200);

    const found = await query(
      `SELECT c.complaint_id, c.title, c.description, c.location_text, c.priority, c.status, c.reporter_id, c.created_at,
              cat.category_name, d.department_name
       FROM complaints c
       JOIN categories cat ON c.category_id = cat.category_id
       JOIN departments d ON cat.department_id = d.department_id
       WHERE c.complaint_id = $1`,
      [complaintId]
    );
    if (found.rows.length === 0) {
      return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });
    }
    const c = found.rows[0];
    if (['RESOLVED', 'REJECTED'].includes(c.status)) {
      return NextResponse.json({ error: `This complaint is already ${c.status} and can no longer be upvoted` }, { status: 409 });
    }
    if (c.reporter_id === session.user_id) {
      return NextResponse.json({ error: 'You filed this complaint, so it already counts as your report' }, { status: 409 });
    }

    // MongoDB holds the upvote counters. Make sure the document exists (it may be missing if an
    // earlier sync failed), then apply an atomic, once-per-user upvote.
    let result;
    try {
      await syncComplaintToMongo({
        complaint_id: c.complaint_id, title: c.title, description: c.description,
        category: c.category_name, department: c.department_name, location: c.location_text,
        priority: c.priority, status: c.status, reporter_id: c.reporter_id, created_at: c.created_at,
      });
      result = await upvoteComplaintInMongo(complaintId, session.user_id, location);
    } catch (err: any) {
      console.error('Upvote failed (MongoDB):', err.message);
      return NextResponse.json({ error: 'Upvoting is temporarily unavailable (document store offline)' }, { status: 503 });
    }

    const upvoteCount = result.doc?.metadata?.upvote_count ?? 1;
    const affectedCount = result.doc?.metadata?.affected_users?.length ?? 1;

    if (!result.added) {
      return NextResponse.json(
        { error: 'You have already upvoted this complaint', upvote_count: upvoteCount, affected_count: affectedCount },
        { status: 409 }
      );
    }

    // Escalate exactly one level when a threshold is crossed (not on every later upvote).
    let escalated = false;
    let newPriority: string = c.priority;
    if (ESCALATION_THRESHOLDS.includes(upvoteCount)) {
      const idx = LADDER.indexOf(c.priority);
      if (idx >= 0 && idx < LADDER.length - 1) {
        newPriority = LADDER[idx + 1];
        await query(`UPDATE complaints SET priority = $1 WHERE complaint_id = $2`, [newPriority, complaintId]);
        await updateComplaintPriorityInMongo(complaintId, newPriority);
        escalated = true;
      }
    }

    await query(
      `INSERT INTO notifications (user_id, complaint_id, message) VALUES ($1, $2, $3)`,
      [session.user_id, complaintId, `You are now following Complaint #${complaintId} (community upvotes: ${upvoteCount})`]
    );

    return NextResponse.json({
      success: true,
      complaint_id: complaintId,
      upvote_count: upvoteCount,
      affected_count: affectedCount,
      priority_escalated: escalated,
      priority: newPriority,
      message: 'Upvoted the existing complaint instead of creating a duplicate.',
    });
  } catch (err: any) {
    console.error('Error upvoting complaint:', err);
    return NextResponse.json({ error: 'Failed to upvote complaint' }, { status: 500 });
  }
}
