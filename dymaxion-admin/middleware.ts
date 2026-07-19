import { NextRequest, NextResponse } from 'next/server';
import { authenticateAdminApprover } from './lib/approval-auth';

export function middleware(request: NextRequest): NextResponse {
  const auth = authenticateAdminApprover(
    request.headers,
    process.env.DYMAXION_ADMIN_IDENTITIES,
  );
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'],
};
