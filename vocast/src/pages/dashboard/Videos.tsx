import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { demoVideos, demoScripts } from '@/lib/seed-data'
import { formatDate, cn } from '@/lib/utils'
import { Video, CheckCircle, XCircle, Eye, Linkedin, Instagram } from 'lucide-react'
import type { Video as VideoType } from '@/lib/database.types'

const TABS = ['All', 'Pending', 'Approved', 'Posted', 'Failed'] as const

function statusForTab(tab: string) {
  switch (tab) {
    case 'Pending': return ['generating', 'ready']
    case 'Approved': return ['approved']
    case 'Posted': return ['posted']
    case 'Failed': return ['failed']
    default: return null
  }
}

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform) {
    case 'linkedin': return <Linkedin size={14} />
    case 'instagram': return <Instagram size={14} />
    case 'tiktok': return <span className="text-[10px] font-bold">Tk</span>
    default: return null
  }
}

export default function Videos() {
  const [activeTab, setActiveTab] = useState<string>('All')
  const [previewVideo, setPreviewVideo] = useState<(VideoType & { script?: typeof demoScripts[0] }) | null>(null)

  const videos = demoVideos.map(v => ({
    ...v,
    script: demoScripts.find(s => s.id === v.script_id),
  }))

  const filtered = activeTab === 'All' ? videos : videos.filter(v => {
    const statuses = statusForTab(activeTab)
    return statuses?.includes(v.status)
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">My Videos</h1>
      </div>

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

      {/* Grid */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map(video => (
          <Card key={video.id} className="flex flex-col">
            {/* Thumbnail */}
            <div className="bg-background rounded-lg h-40 flex items-center justify-center mb-4">
              <Video size={40} className="text-muted/30" />
            </div>

            <h3 className="font-medium text-sm truncate">{video.script?.title || 'Untitled Video'}</h3>

            <div className="flex items-center gap-2 mt-2">
              <Badge status={video.status} />
              <span className="text-xs text-muted">{formatDate(video.created_at)}</span>
            </div>

            <div className="flex items-center gap-1.5 mt-2">
              {video.platforms.map(p => (
                <span key={p} className="w-6 h-6 rounded bg-border flex items-center justify-center text-muted">
                  <PlatformIcon platform={p} />
                </span>
              ))}
            </div>

            <div className="flex gap-2 mt-4 pt-4 border-t border-border">
              <Button size="sm" variant="ghost" className="flex-1 gap-1" onClick={() => setPreviewVideo(video)}>
                <Eye size={14} /> Preview
              </Button>
              {(video.status === 'ready' || video.status === 'generating') && (
                <>
                  <Button size="sm" variant="outline" className="flex-1 gap-1">
                    <CheckCircle size={14} /> Approve
                  </Button>
                  <Button size="sm" variant="ghost" className="gap-1 text-muted">
                    <XCircle size={14} />
                  </Button>
                </>
              )}
            </div>
          </Card>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-20 text-muted">
          <Video size={48} className="mx-auto mb-4 opacity-30" />
          <p>No videos in this category yet.</p>
        </div>
      )}

      {/* Preview Modal */}
      <Modal open={!!previewVideo} onClose={() => setPreviewVideo(null)} title={previewVideo?.script?.title || 'Video Preview'}>
        <div className="space-y-4">
          <div className="bg-background rounded-lg h-48 flex items-center justify-center">
            <Video size={48} className="text-muted/30" />
          </div>
          <div>
            <h4 className="font-medium mb-2">Script</h4>
            <p className="text-sm text-muted leading-relaxed">{previewVideo?.script?.body}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">Platforms:</span>
            {previewVideo?.platforms.map(p => (
              <span key={p} className="capitalize text-sm">{p}</span>
            ))}
          </div>
          <Badge status={previewVideo?.status || ''} />
        </div>
      </Modal>
    </div>
  )
}
