import { cn, getStatusColor } from '@/lib/utils'

interface BadgeProps {
  status: string
  className?: string
}

export function Badge({ status, className }: BadgeProps) {
  return (
    <span className={cn('px-2.5 py-1 rounded-full text-xs font-medium capitalize', getStatusColor(status), className)}>
      {status}
    </span>
  )
}
