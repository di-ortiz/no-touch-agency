import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function getStatusColor(status: string) {
  switch (status) {
    case 'pending':
    case 'generating':
      return 'bg-yellow-500/20 text-yellow-400'
    case 'approved':
    case 'ready':
      return 'bg-green-500/20 text-green-400'
    case 'posted':
      return 'bg-blue-500/20 text-blue-400'
    case 'rejected':
    case 'failed':
      return 'bg-red-500/20 text-red-400'
    default:
      return 'bg-gray-500/20 text-gray-400'
  }
}

export function getPlatformIcon(platform: string) {
  switch (platform) {
    case 'linkedin': return 'Li'
    case 'instagram': return 'Ig'
    case 'tiktok': return 'Tk'
    default: return '?'
  }
}
