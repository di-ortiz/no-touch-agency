export type Plan = 'starter' | 'growth' | 'enterprise'
export type ScriptStatus = 'pending' | 'approved' | 'rejected'
export type VideoStatus = 'generating' | 'ready' | 'approved' | 'posted' | 'failed'
export type Platform = 'linkedin' | 'instagram' | 'tiktok'

export interface User {
  id: string
  full_name: string
  email: string
  company_name: string
  avatar_photo_url: string | null
  voice_sample_url: string | null
  heygen_avatar_id: string | null
  elevenlabs_voice_id: string | null
  plan: Plan
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  onboarding_completed: boolean
  auto_approve: boolean
  industry: string | null
  tone: string | null
  created_at: string
}

export interface Script {
  id: string
  user_id: string
  title: string
  body: string
  status: ScriptStatus
  scheduled_date: string
  created_at: string
}

export interface Video {
  id: string
  user_id: string
  script_id: string
  video_url: string | null
  status: VideoStatus
  platforms: Platform[]
  posted_at: string | null
  created_at: string
  script?: Script
}

export interface ConnectedAccount {
  id: string
  user_id: string
  platform: Platform
  access_token: string
  refresh_token: string | null
  account_name: string
  connected_at: string
}

export interface ActivityLog {
  id: string
  user_id: string
  event: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface Database {
  public: {
    Tables: {
      users: { Row: User; Insert: Partial<User> & { id: string; email: string }; Update: Partial<User> }
      scripts: { Row: Script; Insert: Omit<Script, 'id' | 'created_at'>; Update: Partial<Script> }
      videos: { Row: Video; Insert: Omit<Video, 'id' | 'created_at'>; Update: Partial<Video> }
      connected_accounts: { Row: ConnectedAccount; Insert: Omit<ConnectedAccount, 'id'>; Update: Partial<ConnectedAccount> }
      activity_log: { Row: ActivityLog; Insert: Omit<ActivityLog, 'id' | 'created_at'>; Update: Partial<ActivityLog> }
    }
  }
}
