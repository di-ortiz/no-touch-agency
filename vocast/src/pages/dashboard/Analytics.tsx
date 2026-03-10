import { Card } from '@/components/ui/Card'
import { demoVideos } from '@/lib/seed-data'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Video, Send, CheckCircle, BarChart3 } from 'lucide-react'

// Mock weekly data for last 12 weeks
const weeklyData = [
  { week: 'W1', videos: 2 },
  { week: 'W2', videos: 3 },
  { week: 'W3', videos: 5 },
  { week: 'W4', videos: 4 },
  { week: 'W5', videos: 6 },
  { week: 'W6', videos: 5 },
  { week: 'W7', videos: 7 },
  { week: 'W8', videos: 4 },
  { week: 'W9', videos: 8 },
  { week: 'W10', videos: 6 },
  { week: 'W11', videos: 7 },
  { week: 'W12', videos: 5 },
]

const platformData = [
  { platform: 'LinkedIn', count: 12 },
  { platform: 'Instagram', count: 8 },
  { platform: 'TikTok', count: 5 },
]

export default function Analytics() {
  const totalGenerated = demoVideos.length
  const totalPosted = demoVideos.filter(v => v.status === 'posted').length
  const approvalRate = Math.round((demoVideos.filter(v => ['approved', 'posted'].includes(v.status)).length / totalGenerated) * 100)
  const mostActive = 'LinkedIn'

  const stats = [
    { label: 'Total Videos Generated', value: totalGenerated, icon: Video },
    { label: 'Total Videos Posted', value: totalPosted, icon: Send },
    { label: 'Approval Rate', value: `${approvalRate}%`, icon: CheckCircle },
    { label: 'Most Active Platform', value: mostActive, icon: BarChart3 },
  ]

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Analytics</h1>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(stat => (
          <Card key={stat.label}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                <stat.icon size={18} />
              </div>
              <div>
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-xs text-muted">{stat.label}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <h3 className="font-semibold mb-4">Videos Posted Per Week</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={weeklyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2A2A2A" />
              <XAxis dataKey="week" stroke="#A0A0A0" fontSize={12} />
              <YAxis stroke="#A0A0A0" fontSize={12} />
              <Tooltip
                contentStyle={{ backgroundColor: '#141414', border: '1px solid #2A2A2A', borderRadius: 8 }}
                labelStyle={{ color: '#A0A0A0' }}
              />
              <Line type="monotone" dataKey="videos" stroke="#D9232D" strokeWidth={2} dot={{ fill: '#D9232D', r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <h3 className="font-semibold mb-4">Posts by Platform</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={platformData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2A2A2A" />
              <XAxis dataKey="platform" stroke="#A0A0A0" fontSize={12} />
              <YAxis stroke="#A0A0A0" fontSize={12} />
              <Tooltip
                contentStyle={{ backgroundColor: '#141414', border: '1px solid #2A2A2A', borderRadius: 8 }}
                labelStyle={{ color: '#A0A0A0' }}
              />
              <Bar dataKey="count" fill="#D9232D" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  )
}
