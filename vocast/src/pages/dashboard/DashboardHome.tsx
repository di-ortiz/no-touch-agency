import { useAuth } from '@/hooks/useAuth'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { getGreeting, formatDate } from '@/lib/utils'
import { demoVideos, demoScripts, demoConnectedAccounts, demoActivityLog } from '@/lib/seed-data'
import { Video, Clock, Link2, Calendar, CheckCircle, XCircle } from 'lucide-react'

export default function DashboardHome() {
  const { profile } = useAuth()

  const postedThisMonth = demoVideos.filter(v => v.status === 'posted').length
  const pendingApproval = demoVideos.filter(v => v.status === 'ready').length
  const platformsConnected = demoConnectedAccounts.length
  const nextScheduled = demoScripts.find(s => s.status === 'approved' && new Date(s.scheduled_date) >= new Date())

  const pendingVideos = demoVideos
    .filter(v => v.status === 'ready')
    .map(v => ({ ...v, script: demoScripts.find(s => s.id === v.script_id) }))
    .slice(0, 3)

  const stats = [
    { label: 'Videos Posted This Month', value: postedThisMonth, icon: Video },
    { label: 'Pending Approval', value: pendingApproval, icon: Clock },
    { label: 'Platforms Connected', value: platformsConnected, icon: Link2 },
    { label: 'Next Scheduled Post', value: nextScheduled ? formatDate(nextScheduled.scheduled_date) : 'None', icon: Calendar },
  ]

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">
        {getGreeting()}, {profile?.full_name?.split(' ')[0] || 'there'} 👋
      </h1>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(stat => (
          <Card key={stat.label} className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
              <stat.icon size={18} />
            </div>
            <div>
              <p className="text-2xl font-bold">{stat.value}</p>
              <p className="text-xs text-muted">{stat.label}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Pending Approval */}
      {pendingVideos.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Videos Pending Your Approval</h2>
          <div className="space-y-3">
            {pendingVideos.map(video => (
              <Card key={video.id} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="w-16 h-16 bg-background rounded-lg flex items-center justify-center shrink-0">
                    <Video size={24} className="text-muted" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{video.script?.title || 'Untitled'}</p>
                    <p className="text-sm text-muted truncate">{video.script?.body?.slice(0, 80)}...</p>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge status={video.status} />
                      {video.platforms.map(p => (
                        <span key={p} className="text-xs text-muted capitalize">{p}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="outline" className="gap-1">
                    <CheckCircle size={14} /> Approve
                  </Button>
                  <Button size="sm" variant="ghost" className="gap-1 text-muted">
                    <XCircle size={14} /> Reject
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Activity */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Recent Activity</h2>
        <Card className="divide-y divide-border">
          {demoActivityLog.map(log => (
            <div key={log.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
              <div>
                <p className="text-sm font-medium">
                  {log.event.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </p>
                <p className="text-xs text-muted">
                  {Object.values(log.metadata).join(' - ')}
                </p>
              </div>
              <span className="text-xs text-muted">{formatDate(log.created_at)}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}
