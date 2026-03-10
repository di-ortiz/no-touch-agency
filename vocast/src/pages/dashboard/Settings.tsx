import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/utils'

const TABS = ['Profile', 'Notifications', 'Billing', 'Danger Zone'] as const

export default function Settings() {
  const { profile, updateProfile } = useAuth()
  const [activeTab, setActiveTab] = useState<string>('Profile')
  const [fullName, setFullName] = useState(profile?.full_name || '')
  const [companyName, setCompanyName] = useState(profile?.company_name || '')
  const [industry, setIndustry] = useState(profile?.industry || '')
  const [tone, setTone] = useState(profile?.tone || 'Professional')
  const [saved, setSaved] = useState(false)

  const handleSaveProfile = async () => {
    await updateProfile({ full_name: fullName, company_name: companyName, industry, tone })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-4 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap cursor-pointer',
              activeTab === tab ? 'bg-primary text-white' : 'bg-surface text-muted hover:text-white',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Profile */}
      {activeTab === 'Profile' && (
        <Card className="space-y-4 max-w-xl">
          <h3 className="font-semibold">Edit Profile</h3>
          <Input id="fullName" label="Full Name" value={fullName} onChange={e => setFullName(e.target.value)} />
          <Input id="companyName" label="Company Name" value={companyName} onChange={e => setCompanyName(e.target.value)} />
          <Input id="industry" label="Industry" value={industry} onChange={e => setIndustry(e.target.value)} />
          <Select id="tone" label="Tone Preference" value={tone} onChange={e => setTone(e.target.value)} options={[
            { value: 'Professional', label: 'Professional' },
            { value: 'Friendly', label: 'Friendly' },
            { value: 'Bold', label: 'Bold' },
          ]} />

          <div className="pt-2 space-y-3">
            <div>
              <label className="block text-sm font-medium text-muted mb-1.5">Re-upload Photo</label>
              <input type="file" accept="image/*" className="text-sm text-muted" />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted mb-1.5">Re-upload Voice Sample</label>
              <input type="file" accept="audio/*" className="text-sm text-muted" />
            </div>
          </div>

          <Button onClick={handleSaveProfile}>
            {saved ? 'Saved!' : 'Save Changes'}
          </Button>
        </Card>
      )}

      {/* Notifications */}
      {activeTab === 'Notifications' && (
        <Card className="space-y-4 max-w-xl">
          <h3 className="font-semibold">Notification Preferences</h3>
          {['Email when video is ready for approval', 'Email when video is posted', 'Weekly performance summary', 'Script generation complete'].map(item => (
            <label key={item} className="flex items-center justify-between py-2 cursor-pointer">
              <span className="text-sm">{item}</span>
              <input type="checkbox" defaultChecked className="w-4 h-4 accent-primary" />
            </label>
          ))}
        </Card>
      )}

      {/* Billing */}
      {activeTab === 'Billing' && (
        <Card className="space-y-4 max-w-xl">
          <h3 className="font-semibold">Billing</h3>
          <div className="flex items-center justify-between py-3 border-b border-border">
            <span className="text-muted">Current Plan</span>
            <span className="font-semibold capitalize">{profile?.plan || 'growth'}</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-border">
            <span className="text-muted">Next Billing Date</span>
            <span>April 15, 2026</span>
          </div>
          <div className="flex items-center justify-between py-3">
            <span className="text-muted">Monthly Cost</span>
            <span className="font-semibold">
              {profile?.plan === 'starter' ? '$297' : profile?.plan === 'enterprise' ? '$1,497' : '$597'}
            </span>
          </div>
          <div className="flex gap-2 pt-2">
            <Button>Upgrade Plan</Button>
            <Button variant="ghost" className="text-muted">Manage Billing</Button>
          </div>
        </Card>
      )}

      {/* Danger Zone */}
      {activeTab === 'Danger Zone' && (
        <Card className="space-y-4 max-w-xl border-red-500/30">
          <h3 className="font-semibold text-red-400">Danger Zone</h3>
          <div className="flex items-center justify-between py-3 border-b border-border">
            <div>
              <p className="font-medium">Cancel Subscription</p>
              <p className="text-sm text-muted">Your account will remain active until the end of the billing period.</p>
            </div>
            <Button variant="danger" size="sm">Cancel</Button>
          </div>
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="font-medium">Delete Account</p>
              <p className="text-sm text-muted">Permanently delete your account and all data. This action cannot be undone.</p>
            </div>
            <Button variant="danger" size="sm">Delete</Button>
          </div>
        </Card>
      )}
    </div>
  )
}
