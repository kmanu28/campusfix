import { NextRequest, NextResponse } from 'next/server';
import { authenticateUser, setSession } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const { email, password, expected_role } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const user = await authenticateUser(String(email), String(password));
    if (!user) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    // Enforce the role chosen on the login screen BEFORE a session is created.
    if (expected_role && user.role_name !== expected_role) {
      return NextResponse.json(
        {
          error: `This account has role '${user.role_name}'. Please select the '${user.role_name}' role on the login screen.`,
        },
        { status: 403 }
      );
    }

    await setSession(user);
    return NextResponse.json({ success: true, user });
  } catch (err: any) {
    console.error('Login error:', err);
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}
