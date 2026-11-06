// "Signed out" banner for an expired Cloudflare Access session, with the only
// way back in from a home-screen app: a full navigation through Access's login.
import { LogIn } from 'lucide-react';
import { signInUrl } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function SignedOutBanner({ detail, next, className }: {
  detail: string;
  /** where to land after signing in */
  next: string;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border bg-card px-4 py-3 flex items-center justify-between gap-3', className)} role="alert">
      <p className="text-sm">
        <span className="font-semibold">Signed out</span>
        <span className="text-muted-foreground"> · {detail}</span>
      </p>
      <Button size="sm" onClick={() => { window.location.href = signInUrl(next); }}>
        <LogIn aria-hidden="true" /> Sign in again
      </Button>
    </div>
  );
}
