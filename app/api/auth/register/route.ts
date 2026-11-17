import { NextRequest, NextResponse } from 'next/server';
import { registerReporter, setSession } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const { full_name, email, password } = await req.json();

    if (!full_name || !email || !password) {
      return NextResponse.json({ error: 'Full name, email and password are required.' }, { status: 400 });
    }
    if (String(full_name).trim().length < 2 || String(full_name).length > 100) {
      return NextResponse.json({ error: 'Full name must be 2-100 characters.' }, { status: 400 });
    }
    if (String(password).length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    }

    // Self-registration can only create REPORTER accounts. STAFF/ADMIN accounts are provisioned
    // by the database administrator (see scripts/setup-db.ts); otherwise anyone could make
    // themselves an admin.
    const user = await registerReporter(String(full_name), String(email), String(password));
    await setSession(user);
    return NextResponse.json({ success: true, user });
  } catch (err: any) {
    console.error('Registration error:', err);
    return NextResponse.json({ error: err.message || 'Registration failed' }, { status: 400 });
  }
}
