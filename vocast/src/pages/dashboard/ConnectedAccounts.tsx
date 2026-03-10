import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/useAuth'
import { demoConnectedAccounts } from '@/lib/seed-data'
import type { Platform, ConnectedAccount } from '@/lib/database.types'
import { Linkedin, Instagram, Check, Unplug } from 'lucide-react'
import { cn } from '@/lib/utils'

const PLATFORMS: { platform: Platform; name: string; icon: React.ReactNode; color: string }[] = [
  { platform: 'linkedin', name: 'LinkedIn', icon: <Linkedin size={24} />, color: 'text-blue-400' },
  { platform: 'instagram', name: 'Instagram', icon: <Instagram size={24} />, color: 'text-pink-400' },
  { platform: 'tiktok', name: 'TikTok', icon: <span className="text-lg font-bold">Tk</span>, color: 'text-white' },
]

export default function ConnectedAccounts() {
  const { profile, updateProfile } = useAuth()
  const [accounts, setAccounts] = useState<ConnectedAccount[]>(demoConnectedAccounts)
  const [autoApprove, setAutoApprove] = useState(profile?.auto_approve || false)

  const isConnected = (platform: Platform) => accounts.some(a => a.platform === platform)
  const getAccount = (platform: Platform) => accounts.find(a => a.platform === platform)

  const toggleConnection = (platform: Platform) => {
    if (isConnected(platform)) {
      setAccounts(prev => prev.filter(a => a.platform !== platform))
    } else {
      setAccounts(prev => [...prev, {
        id: `ca-${Date.now()}`,
        user_id: 'demo',
        platform,
        access_token: 'mock',
        refresh_token: null,
        account_name: platform === 'linkedin' ? 'Alex Rivera' : platform === 'instagram' ? '@riveradigital' : '@riveradigital',
        connected_at: new Date().toISOString(),
      }])
    }
  }

  const handleAutoApprove = () => {
    const newValue = !autoApprove
    setAutoApprove(newValue)
    updateProfile({ auto_approve: newValue })
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Connected Accounts</h1>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {PLATFORMS.map(({ platform, name, icon, color }) => {
          const connected = isConnected(platform)
          const account = getAccount(platform)
          return (
            <Card key={platform} className={cn(connected && 'border-primary/30')}>
              <div className="flex items-center gap-3 mb-4">
                <div className={cn('w-12 h-12 rounded-xl bg-border flex items-center justify-center', color)}>
                  {icon}
                </div>
                <div>
                  <h3 className="font-semibold">{name}</h3>
                  {connected ? (
                    <p className="text-xs text-muted">{account?.account_name}</p>
                  ) : (
                    <p className="text-xs text-muted">Not connected</p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className={cn('text-sm flex items-center gap-1', connected ? 'text-green-400' : 'text-muted')}>
                  {connected ? <><Check size={14} /> Connected</> : 'Disconnected'}
                </span>
                <Button
                  size="sm"
                  variant={connected ? 'ghost' : 'primary'}
                  onClick={() => toggleConnection(platform)}
                  className={cn(connected && 'text-red-400 hover:text-red-300')}
                >
                  {connected ? <><Unplug size={14} className="mr-1" /> Disconnect</> : 'Connect'}
                </Button>
              </div>
            </Card>
          )
        })}
      </div>

      {/* Auto-approve toggle */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Auto-Approve Videos</h3>
            <p className="text-sm text-muted mt-1">
              Vocast will never post without your approval unless you enable this setting.
            </p>
          </div>
          <button
            onClick={handleAutoApprove}
            className={cn(
              'w-12 h-6 rounded-full transition-colors relative cursor-pointer',
              autoApprove ? 'bg-primary' : 'bg-border',
            )}
          >
            <div className={cn(
              'absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform',
              autoApprove ? 'translate-x-6' : 'translate-x-0.5',
            )} />
          </button>
        </div>
      </Card>
    </div>
  )
}
