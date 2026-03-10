import type { User, Script, Video, ConnectedAccount, ActivityLog } from './database.types'

export const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001'

export const demoUser: User = {
  id: DEMO_USER_ID,
  full_name: 'Alex Rivera',
  email: 'alex@vocast.demo',
  company_name: 'Rivera Digital',
  avatar_photo_url: null,
  voice_sample_url: null,
  heygen_avatar_id: 'hg_demo_avatar',
  elevenlabs_voice_id: 'el_demo_voice',
  plan: 'growth',
  stripe_customer_id: 'cus_demo',
  stripe_subscription_id: 'sub_demo',
  onboarding_completed: true,
  auto_approve: false,
  industry: 'Digital Marketing',
  tone: 'Professional',
  created_at: '2026-01-15T10:00:00Z',
}

export const demoScripts: Script[] = [
  {
    id: 's1',
    user_id: DEMO_USER_ID,
    title: '5 LinkedIn Mistakes Killing Your Reach',
    body: "Stop making these five LinkedIn mistakes that are killing your reach. Number one: posting without a hook. Your first line needs to stop the scroll. Number two: not engaging before you post. Spend 15 minutes commenting on others' posts first. Number three: using too many hashtags. Three to five is the sweet spot. Number four: only posting text. Carousels and videos get 3x more reach. Number five: being inconsistent. Post at least three times a week. Fix these and watch your impressions explode.",
    status: 'approved',
    scheduled_date: '2026-03-10',
    created_at: '2026-03-08T09:00:00Z',
  },
  {
    id: 's2',
    user_id: DEMO_USER_ID,
    title: 'Why Your Competitors Are Beating You Online',
    body: "Here's why your competitors are beating you online — and it's not what you think. It's not their budget. It's not their team size. It's consistency. They show up every single day with valuable content while you post once a month and wonder why nobody engages. The algorithm rewards consistency. Period. Start with one post a day for 30 days and I guarantee you'll see a difference. Your audience is waiting to hear from you.",
    status: 'pending',
    scheduled_date: '2026-03-11',
    created_at: '2026-03-09T09:00:00Z',
  },
  {
    id: 's3',
    user_id: DEMO_USER_ID,
    title: 'The ROI of Video Content in 2026',
    body: "Let me share something that changed my perspective on content. Video content generates 1200% more shares than text and images combined. Think about that. If you're not creating video, you're leaving money on the table. And no, you don't need expensive equipment. Your phone and good lighting are enough. The brands winning right now are the ones showing up authentically on camera every day. Start today. Not tomorrow. Today.",
    status: 'approved',
    scheduled_date: '2026-03-12',
    created_at: '2026-03-09T10:00:00Z',
  },
  {
    id: 's4',
    user_id: DEMO_USER_ID,
    title: 'How I Grew My Business 3x With Content',
    body: "Three years ago, I was struggling to get clients. Cold outreach wasn't working. Ads were expensive. Then I started creating daily content. Just sharing what I knew. Three years later, my business has tripled. Not because of some magic strategy. Because I showed up consistently and provided value. Content marketing isn't a sprint. It's a marathon. But it's the marathon worth running.",
    status: 'pending',
    scheduled_date: '2026-03-13',
    created_at: '2026-03-09T11:00:00Z',
  },
  {
    id: 's5',
    user_id: DEMO_USER_ID,
    title: 'Stop Selling, Start Helping',
    body: "The biggest shift in my marketing career was when I stopped selling and started helping. Every piece of content I create now answers one question: how can I help my audience today? When you lead with value, trust follows. And when trust is there, sales become effortless. Stop pushing products. Start solving problems. Your revenue will thank you.",
    status: 'rejected',
    scheduled_date: '2026-03-14',
    created_at: '2026-03-09T12:00:00Z',
  },
]

export const demoVideos: Video[] = [
  {
    id: 'v1', user_id: DEMO_USER_ID, script_id: 's1',
    video_url: null, status: 'posted',
    platforms: ['linkedin', 'instagram'], posted_at: '2026-03-08T12:00:00Z', created_at: '2026-03-08T10:00:00Z',
  },
  {
    id: 'v2', user_id: DEMO_USER_ID, script_id: 's1',
    video_url: null, status: 'posted',
    platforms: ['tiktok'], posted_at: '2026-03-07T12:00:00Z', created_at: '2026-03-07T10:00:00Z',
  },
  {
    id: 'v3', user_id: DEMO_USER_ID, script_id: 's2',
    video_url: null, status: 'ready',
    platforms: ['linkedin', 'instagram', 'tiktok'], posted_at: null, created_at: '2026-03-09T10:00:00Z',
  },
  {
    id: 'v4', user_id: DEMO_USER_ID, script_id: 's3',
    video_url: null, status: 'approved',
    platforms: ['linkedin'], posted_at: null, created_at: '2026-03-09T11:00:00Z',
  },
  {
    id: 'v5', user_id: DEMO_USER_ID, script_id: 's3',
    video_url: null, status: 'generating',
    platforms: ['instagram', 'tiktok'], posted_at: null, created_at: '2026-03-10T08:00:00Z',
  },
  {
    id: 'v6', user_id: DEMO_USER_ID, script_id: 's4',
    video_url: null, status: 'ready',
    platforms: ['linkedin', 'instagram'], posted_at: null, created_at: '2026-03-10T09:00:00Z',
  },
  {
    id: 'v7', user_id: DEMO_USER_ID, script_id: 's5',
    video_url: null, status: 'failed',
    platforms: ['linkedin'], posted_at: null, created_at: '2026-03-06T10:00:00Z',
  },
  {
    id: 'v8', user_id: DEMO_USER_ID, script_id: 's2',
    video_url: null, status: 'posted',
    platforms: ['linkedin', 'tiktok'], posted_at: '2026-03-05T12:00:00Z', created_at: '2026-03-05T10:00:00Z',
  },
]

export const demoConnectedAccounts: ConnectedAccount[] = [
  { id: 'ca1', user_id: DEMO_USER_ID, platform: 'linkedin', access_token: 'mock', refresh_token: null, account_name: 'Alex Rivera', connected_at: '2026-01-15T10:00:00Z' },
  { id: 'ca2', user_id: DEMO_USER_ID, platform: 'instagram', access_token: 'mock', refresh_token: null, account_name: '@riveradigital', connected_at: '2026-01-15T10:05:00Z' },
]

export const demoActivityLog: ActivityLog[] = [
  { id: 'a1', user_id: DEMO_USER_ID, event: 'video_posted', metadata: { platform: 'linkedin', script_title: '5 LinkedIn Mistakes' }, created_at: '2026-03-08T12:00:00Z' },
  { id: 'a2', user_id: DEMO_USER_ID, event: 'script_approved', metadata: { script_title: 'The ROI of Video Content' }, created_at: '2026-03-09T10:30:00Z' },
  { id: 'a3', user_id: DEMO_USER_ID, event: 'video_generated', metadata: { script_title: 'Why Competitors Are Beating You' }, created_at: '2026-03-09T11:00:00Z' },
  { id: 'a4', user_id: DEMO_USER_ID, event: 'video_posted', metadata: { platform: 'tiktok', script_title: '5 LinkedIn Mistakes' }, created_at: '2026-03-07T12:00:00Z' },
  { id: 'a5', user_id: DEMO_USER_ID, event: 'account_connected', metadata: { platform: 'instagram' }, created_at: '2026-01-15T10:05:00Z' },
]
