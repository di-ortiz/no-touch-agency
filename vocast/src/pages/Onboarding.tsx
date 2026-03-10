import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Card } from '@/components/ui/Card'
import { Check, Upload, Mic, MicOff, Linkedin, Instagram } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Platform } from '@/lib/database.types'

const STEPS = ['Welcome', 'Photo', 'Voice', 'Accounts', 'Plan']

const SAMPLE_TEXT = `Hi, I'm [name] from [company]. I help businesses grow with smart digital marketing. Every day I share insights to help you scale. Whether you're just starting out or looking to take things to the next level, consistency is the key to building a brand that people trust and follow.`

const PLANS = [
  { id: 'starter' as const, name: 'Starter', price: '$297/mo', desc: '3 videos/week, 2 platforms' },
  { id: 'growth' as const, name: 'Growth', price: '$597/mo', desc: 'Daily videos, all platforms', popular: true },
  { id: 'enterprise' as const, name: 'Enterprise', price: '$1,497/mo', desc: 'Unlimited videos, white-glove' },
]

export default function Onboarding() {
  const [step, setStep] = useState(0)
  const [formData, setFormData] = useState({
    full_name: '',
    company_name: '',
    industry: '',
    tone: 'Professional',
  })
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const [connectedPlatforms, setConnectedPlatforms] = useState<Platform[]>([])
  const [selectedPlan, setSelectedPlan] = useState<string>('growth')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const { updateProfile } = useAuth()
  const navigate = useNavigate()

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => setPhotoPreview(reader.result as string)
      reader.readAsDataURL(file)
    }
  }

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop()
      setIsRecording(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data)
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/mp3' })
        setAudioBlob(blob)
        stream.getTracks().forEach(t => t.stop())
      }
      recorder.start()
      mediaRecorderRef.current = recorder
      setIsRecording(true)
    } catch {
      // Microphone access denied — set mock blob for demo
      setAudioBlob(new Blob(['mock'], { type: 'audio/mp3' }))
    }
  }, [isRecording])

  const connectPlatform = (platform: Platform) => {
    setConnectedPlatforms(prev =>
      prev.includes(platform) ? prev.filter(p => p !== platform) : [...prev, platform]
    )
  }

  const handleFinish = async () => {
    await updateProfile({
      ...formData,
      plan: selectedPlan as 'starter' | 'growth' | 'enterprise',
      onboarding_completed: true,
    })
    navigate('/dashboard')
  }

  const canProceed = () => {
    switch (step) {
      case 0: return formData.full_name && formData.company_name
      case 1: return !!photoPreview
      case 2: return !!audioBlob
      case 3: return connectedPlatforms.length >= 1
      case 4: return !!selectedPlan
      default: return true
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-12">
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold"><span className="text-primary">Vo</span>cast</h2>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-2 mb-12 w-full max-w-md">
        {STEPS.map((s, i) => (
          <div key={s} className="flex-1 flex flex-col items-center gap-1">
            <div className={cn(
              'w-full h-1.5 rounded-full transition-colors',
              i <= step ? 'bg-primary' : 'bg-border',
            )} />
            <span className={cn('text-xs', i <= step ? 'text-white' : 'text-muted')}>{s}</span>
          </div>
        ))}
      </div>

      <div className="w-full max-w-lg">
        {/* Step 1: Welcome */}
        {step === 0 && (
          <Card>
            <h2 className="text-2xl font-bold mb-2">Let's set up your AI avatar in 5 minutes</h2>
            <p className="text-muted mb-6">Tell us about yourself and your business.</p>
            <div className="space-y-4">
              <Input id="name" label="Full Name" placeholder="Alex Rivera" value={formData.full_name} onChange={e => setFormData(p => ({ ...p, full_name: e.target.value }))} />
              <Input id="company" label="Company Name" placeholder="Rivera Digital" value={formData.company_name} onChange={e => setFormData(p => ({ ...p, company_name: e.target.value }))} />
              <Input id="industry" label="Industry" placeholder="Digital Marketing" value={formData.industry} onChange={e => setFormData(p => ({ ...p, industry: e.target.value }))} />
              <Select id="tone" label="Tone of Voice" value={formData.tone} onChange={e => setFormData(p => ({ ...p, tone: e.target.value }))} options={[
                { value: 'Professional', label: 'Professional' },
                { value: 'Friendly', label: 'Friendly' },
                { value: 'Bold', label: 'Bold' },
              ]} />
            </div>
          </Card>
        )}

        {/* Step 2: Photo */}
        {step === 1 && (
          <Card>
            <h2 className="text-2xl font-bold mb-2">Upload Your Photo</h2>
            <p className="text-muted mb-6">This will be used to create your AI avatar.</p>
            <div className="space-y-4">
              <div className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:border-primary/50 transition-colors">
                {photoPreview ? (
                  <img src={photoPreview} alt="Preview" className="w-32 h-32 rounded-full mx-auto object-cover" />
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <Upload size={40} className="text-muted" />
                    <p className="text-muted">Click to upload your headshot</p>
                  </div>
                )}
                <input type="file" accept="image/*" className="absolute inset-0 opacity-0 cursor-pointer" onChange={handlePhotoUpload} style={{ position: 'relative' }} />
              </div>
              <div className="bg-background rounded-lg p-4 text-sm text-muted">
                <p className="font-medium text-white mb-2">Photo Guidelines:</p>
                <ul className="space-y-1 list-disc list-inside">
                  <li>Plain background, facing forward</li>
                  <li>Good lighting, no shadows</li>
                  <li>Professional headshot preferred</li>
                </ul>
              </div>
            </div>
          </Card>
        )}

        {/* Step 3: Voice */}
        {step === 2 && (
          <Card>
            <h2 className="text-2xl font-bold mb-2">Record Your Voice</h2>
            <p className="text-muted mb-6">Read the text below to clone your voice. Minimum 30 seconds.</p>
            <div className="bg-background rounded-lg p-4 mb-6 text-sm text-muted italic leading-relaxed">
              "{SAMPLE_TEXT.replace('[name]', formData.full_name || 'your name').replace('[company]', formData.company_name || 'your company')}"
            </div>
            <div className="flex flex-col items-center gap-4">
              <button
                onClick={toggleRecording}
                className={cn(
                  'w-20 h-20 rounded-full flex items-center justify-center transition-all cursor-pointer',
                  isRecording ? 'bg-red-600 animate-pulse' : 'bg-primary hover:bg-primary-hover',
                )}
              >
                {isRecording ? <MicOff size={32} /> : <Mic size={32} />}
              </button>
              <p className="text-sm text-muted">
                {audioBlob ? 'Recording saved!' : isRecording ? 'Recording... Click to stop' : 'Click to start recording'}
              </p>
              {!audioBlob && !isRecording && (
                <Button variant="ghost" size="sm" onClick={() => setAudioBlob(new Blob(['mock'], { type: 'audio/mp3' }))}>
                  Skip (use demo voice)
                </Button>
              )}
            </div>
          </Card>
        )}

        {/* Step 4: Connect Accounts */}
        {step === 3 && (
          <Card>
            <h2 className="text-2xl font-bold mb-2">Connect Social Accounts</h2>
            <p className="text-muted mb-6">Connect at least one platform where you want videos posted.</p>
            <div className="space-y-3">
              {[
                { platform: 'linkedin' as Platform, name: 'LinkedIn', icon: <Linkedin size={20} /> },
                { platform: 'instagram' as Platform, name: 'Instagram', icon: <Instagram size={20} /> },
                { platform: 'tiktok' as Platform, name: 'TikTok', icon: <span className="text-sm font-bold">Tk</span> },
              ].map(({ platform, name, icon }) => (
                <button
                  key={platform}
                  onClick={() => connectPlatform(platform)}
                  className={cn(
                    'w-full flex items-center justify-between p-4 rounded-xl border transition-all cursor-pointer',
                    connectedPlatforms.includes(platform) ? 'border-primary bg-primary/10' : 'border-border hover:border-muted',
                  )}
                >
                  <div className="flex items-center gap-3">
                    {icon}
                    <span className="font-medium">{name}</span>
                  </div>
                  {connectedPlatforms.includes(platform) ? (
                    <span className="flex items-center gap-1 text-primary text-sm"><Check size={16} /> Connected</span>
                  ) : (
                    <span className="text-muted text-sm">Connect</span>
                  )}
                </button>
              ))}
            </div>
          </Card>
        )}

        {/* Step 5: Plan */}
        {step === 4 && (
          <Card>
            <h2 className="text-2xl font-bold mb-2">Choose Your Plan</h2>
            <p className="text-muted mb-6">Start your free trial. Cancel anytime.</p>
            <div className="space-y-3">
              {PLANS.map(plan => (
                <button
                  key={plan.id}
                  onClick={() => setSelectedPlan(plan.id)}
                  className={cn(
                    'w-full flex items-center justify-between p-4 rounded-xl border transition-all text-left cursor-pointer',
                    selectedPlan === plan.id ? 'border-primary bg-primary/10' : 'border-border hover:border-muted',
                  )}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{plan.name}</span>
                      {plan.popular && <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full">Popular</span>}
                    </div>
                    <p className="text-sm text-muted mt-1">{plan.desc}</p>
                  </div>
                  <span className="font-bold text-lg">{plan.price}</span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <Button variant="ghost" onClick={() => setStep(s => s - 1)} disabled={step === 0}>
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(s => s + 1)} disabled={!canProceed()}>
              Continue
            </Button>
          ) : (
            <Button onClick={handleFinish} disabled={!canProceed()}>
              Start Your Trial
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
