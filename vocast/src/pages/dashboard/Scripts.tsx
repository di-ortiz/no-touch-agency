import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { demoScripts } from '@/lib/seed-data'
import { formatDate } from '@/lib/utils'
import type { Script } from '@/lib/database.types'
import { FileText, Plus, Sparkles, Check, X } from 'lucide-react'

export default function Scripts() {
  const [scripts, setScripts] = useState(demoScripts)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatedScripts, setGeneratedScripts] = useState<{ title: string; body: string }[]>([])
  const [topic, setTopic] = useState('')
  const [count, setCount] = useState('3')
  const [tone, setTone] = useState('Professional')

  const handleGenerate = async () => {
    setGenerating(true)
    // Mock API call — simulate Claude response
    await new Promise(r => setTimeout(r, 1500))
    const mockGenerated = Array.from({ length: parseInt(count) }, (_, i) => ({
      title: `${topic || 'Business Growth'} Tip #${i + 1}`,
      body: `Here's a powerful insight about ${topic || 'business growth'} that most people miss. The key is consistency and authenticity. When you show up every day with real value, your audience notices. Stop trying to be perfect and start being present. That's how you build a brand that lasts. Take action today — not tomorrow.`,
    }))
    setGeneratedScripts(mockGenerated)
    setGenerating(false)
  }

  const handleSaveScripts = () => {
    const newScripts: Script[] = generatedScripts.map((s, i) => ({
      id: `gen-${Date.now()}-${i}`,
      user_id: 'demo',
      title: s.title,
      body: s.body,
      status: 'pending' as const,
      scheduled_date: new Date(Date.now() + (i + 1) * 86400000).toISOString().split('T')[0],
      created_at: new Date().toISOString(),
    }))
    setScripts(prev => [...newScripts, ...prev])
    setGenerateOpen(false)
    setGeneratedScripts([])
    setTopic('')
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Scripts</h1>
        <Button className="gap-2" onClick={() => setGenerateOpen(true)}>
          <Plus size={16} /> Generate New Scripts
        </Button>
      </div>

      {/* Table */}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted border-b border-border">
              <th className="pb-3 font-medium">Title</th>
              <th className="pb-3 font-medium">Scheduled Date</th>
              <th className="pb-3 font-medium">Status</th>
              <th className="pb-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {scripts.map(script => (
              <tr key={script.id}>
                <td className="py-3 pr-4">
                  <p className="font-medium">{script.title}</p>
                  <p className="text-xs text-muted mt-0.5 truncate max-w-md">{script.body.slice(0, 80)}...</p>
                </td>
                <td className="py-3 pr-4 text-muted">{formatDate(script.scheduled_date)}</td>
                <td className="py-3 pr-4"><Badge status={script.status} /></td>
                <td className="py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {script.status === 'pending' && (
                      <>
                        <Button size="sm" variant="outline" className="gap-1">
                          <Check size={12} /> Approve
                        </Button>
                        <Button size="sm" variant="ghost" className="text-muted gap-1">
                          <X size={12} /> Reject
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {scripts.length === 0 && (
        <div className="text-center py-20 text-muted">
          <FileText size={48} className="mx-auto mb-4 opacity-30" />
          <p>No scripts yet. Generate your first batch!</p>
        </div>
      )}

      {/* Generate Modal */}
      <Modal open={generateOpen} onClose={() => { setGenerateOpen(false); setGeneratedScripts([]) }} title="Generate New Scripts">
        {generatedScripts.length === 0 ? (
          <div className="space-y-4">
            <Input id="topic" label="Topic / Theme" placeholder="e.g., LinkedIn growth tips" value={topic} onChange={e => setTopic(e.target.value)} />
            <Select id="count" label="Number of Scripts" value={count} onChange={e => setCount(e.target.value)} options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
            <Select id="tone" label="Tone" value={tone} onChange={e => setTone(e.target.value)} options={[
              { value: 'Professional', label: 'Professional' },
              { value: 'Friendly', label: 'Friendly' },
              { value: 'Bold', label: 'Bold' },
            ]} />
            <Button className="w-full gap-2" onClick={handleGenerate} disabled={generating}>
              <Sparkles size={16} />
              {generating ? 'Generating with AI...' : 'Generate Scripts'}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted">Preview generated scripts before saving:</p>
            {generatedScripts.map((s, i) => (
              <Card key={i} className="bg-background">
                <h4 className="font-medium text-sm">{s.title}</h4>
                <p className="text-xs text-muted mt-1 leading-relaxed">{s.body}</p>
              </Card>
            ))}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setGeneratedScripts([])}>
                Regenerate
              </Button>
              <Button className="flex-1" onClick={handleSaveScripts}>
                Save All Scripts
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
