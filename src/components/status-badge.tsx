// Monochrome state grammar — hue is replaced by fill/border/icon:
//   solid gray fill   = it happened (used, spent)
//   solid outline     = terminal by choice (voided) or needs a look (expiring)
//   dashed outline    = transient/uncertain (pending, expired-by-time, shown)
// Icons disambiguate within each class; the text label always carries meaning.
import type { ReactNode } from 'react';
import { Ban, Check, Clock, Eye, RefreshCw, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type StatusKind =
  | 'used'
  | 'spent'
  | 'voided'
  | 'expired'
  | 'pending'
  | 'shown'
  | 'expiring';

const CONFIG: Record<StatusKind, {
  icon: typeof Check;
  variant: 'secondary' | 'outline';
  className?: string;
  spin?: boolean;
}> = {
  used: { icon: Check, variant: 'secondary' },
  spent: { icon: Check, variant: 'secondary' },
  voided: { icon: Ban, variant: 'outline' },
  expiring: { icon: TriangleAlert, variant: 'outline' },
  expired: { icon: Clock, variant: 'outline', className: 'border-dashed text-muted-foreground' },
  pending: { icon: RefreshCw, variant: 'outline', className: 'border-dashed text-muted-foreground', spin: true },
  shown: { icon: Eye, variant: 'outline', className: 'border-dashed text-muted-foreground' },
};

export function StatusBadge({ kind, children, className }: {
  kind: StatusKind;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, variant, className: kindClass, spin } = CONFIG[kind];
  return (
    <Badge variant={variant} className={cn(kindClass, className)}>
      <Icon aria-hidden="true" className={spin ? 'motion-safe:animate-spin' : undefined} />
      {children ?? kind}
    </Badge>
  );
}
