import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query, withTransaction, isClientDbError } from '@/lib/db';
import { updateComplaintStatusInMongo } from '@/lib/mongo';

// List active maintenance staff (used by the admin assignment dialog).
export async function GET() {
  const auth = await requireAuth(['ADMIN']);
  if (auth instanceof NextResponse) return auth;
  try {
    const res = await query(
      `SELECT u.user_id, u.full_name, u.email
       FROM users u
       JOIN roles r ON u.role_id = r.role_id
       WHERE r.role_name = 'STAFF' AND u.is_active = TRUE
       ORDER BY u.full_name ASC`
    );
    return NextResponse.json({ staff: res.rows });
  } catch (err: any) {
    console.error('Error listing staff:', err);
    return NextResponse.json({ error: 'Failed to list staff' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(['ADMIN']);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const complaintId = Number(id);
    const { staff_id } = await req.json();
    const staffId = Number(staff_id);

    if (!Number.isInteger(complaintId) || complaintId <= 0 || !Number.isInteger(staffId) || staffId <= 0) {
      return NextResponse.json({ error: 'Valid complaint ID and staff ID are required' }, { status: 400 });
    }

    // sp_assign_staff validates the complaint/staff, ends the previous assignment, creates the new
    // one, moves SUBMITTED -> ASSIGNED (audited by the trigger) and notifies the technician.
    const newStatus = await withTransaction(async (tx) => {
      await tx.query(`CALL sp_assign_staff($1, $2, $3)`, [complaintId, staffId, auth.user_id]);
      const s = await tx.query(`SELECT status FROM complaints WHERE complaint_id = $1`, [complaintId]);
      return s.rows[0].status as string;
    });

    await updateComplaintStatusInMongo(complaintId, newStatus, 'Assigned to maintenance technician');
    return NextResponse.json({ success: true, complaint_id: complaintId, staff_id: staffId, status: newStatus });
  } catch (err: any) {
    console.error('Error assigning staff:', err);
    const client = isClientDbError(err);
    return NextResponse.json({ error: client ? err.message : 'Failed to assign staff' }, { status: client ? 400 : 500 });
  }
}
