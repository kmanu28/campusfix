import { NextResponse } from 'next/server';
import { getAllUsers, isDemoMode } from '@/lib/auth';

// Powers the one-click "Select Profile" demo picker on the login page.
// Listing every account is only acceptable for demos, so it is gated behind DEMO_MODE=true.
export async function GET() {
  if (!isDemoMode()) {
    return NextResponse.json({ success: true, demo_mode: false, users: [] });
  }
  try {
    const users = await getAllUsers();
    return NextResponse.json({ success: true, demo_mode: true, users });
  } catch (err: any) {
    console.error('Error fetching users:', err);
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}
