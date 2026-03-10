-- Vocast Database Schema
-- Run this in your Supabase SQL Editor

-- Users table
create table public.users (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null default '',
  email text not null default '',
  company_name text not null default '',
  avatar_photo_url text,
  voice_sample_url text,
  heygen_avatar_id text,
  elevenlabs_voice_id text,
  plan text not null default 'starter' check (plan in ('starter', 'growth', 'enterprise')),
  stripe_customer_id text,
  stripe_subscription_id text,
  onboarding_completed boolean not null default false,
  auto_approve boolean not null default false,
  industry text,
  tone text,
  created_at timestamptz not null default now()
);

-- Scripts table
create table public.scripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  title text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  scheduled_date date,
  created_at timestamptz not null default now()
);

-- Videos table
create table public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  script_id uuid not null references public.scripts on delete cascade,
  video_url text,
  status text not null default 'generating' check (status in ('generating', 'ready', 'approved', 'posted', 'failed')),
  platforms text[] not null default '{}',
  posted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Connected accounts table
create table public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  platform text not null check (platform in ('linkedin', 'instagram', 'tiktok')),
  access_token text not null,
  refresh_token text,
  account_name text not null default '',
  connected_at timestamptz not null default now()
);

-- Activity log table
create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  event text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Indexes
create index idx_scripts_user_id on public.scripts(user_id);
create index idx_scripts_status on public.scripts(status);
create index idx_videos_user_id on public.videos(user_id);
create index idx_videos_status on public.videos(status);
create index idx_connected_accounts_user_id on public.connected_accounts(user_id);
create index idx_activity_log_user_id on public.activity_log(user_id);
create index idx_activity_log_created_at on public.activity_log(created_at desc);

-- Row Level Security
alter table public.users enable row level security;
alter table public.scripts enable row level security;
alter table public.videos enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.activity_log enable row level security;

-- RLS Policies: users can only access their own data
create policy "Users can view own profile" on public.users for select using (auth.uid() = id);
create policy "Users can update own profile" on public.users for update using (auth.uid() = id);
create policy "Users can insert own profile" on public.users for insert with check (auth.uid() = id);

create policy "Users can view own scripts" on public.scripts for select using (auth.uid() = user_id);
create policy "Users can insert own scripts" on public.scripts for insert with check (auth.uid() = user_id);
create policy "Users can update own scripts" on public.scripts for update using (auth.uid() = user_id);
create policy "Users can delete own scripts" on public.scripts for delete using (auth.uid() = user_id);

create policy "Users can view own videos" on public.videos for select using (auth.uid() = user_id);
create policy "Users can insert own videos" on public.videos for insert with check (auth.uid() = user_id);
create policy "Users can update own videos" on public.videos for update using (auth.uid() = user_id);

create policy "Users can view own connected accounts" on public.connected_accounts for select using (auth.uid() = user_id);
create policy "Users can insert own connected accounts" on public.connected_accounts for insert with check (auth.uid() = user_id);
create policy "Users can update own connected accounts" on public.connected_accounts for update using (auth.uid() = user_id);
create policy "Users can delete own connected accounts" on public.connected_accounts for delete using (auth.uid() = user_id);

create policy "Users can view own activity" on public.activity_log for select using (auth.uid() = user_id);
create policy "Users can insert own activity" on public.activity_log for insert with check (auth.uid() = user_id);

-- Trigger to create user profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Seed data for demo user
insert into public.users (id, full_name, email, company_name, plan, onboarding_completed, auto_approve, industry, tone, heygen_avatar_id, elevenlabs_voice_id, stripe_customer_id, stripe_subscription_id)
values ('00000000-0000-0000-0000-000000000001', 'Alex Rivera', 'alex@vocast.demo', 'Rivera Digital', 'growth', true, false, 'Digital Marketing', 'Professional', 'hg_demo_avatar', 'el_demo_voice', 'cus_demo', 'sub_demo');

insert into public.scripts (id, user_id, title, body, status, scheduled_date) values
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', '5 LinkedIn Mistakes Killing Your Reach', 'Stop making these five LinkedIn mistakes...', 'approved', '2026-03-10'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'Why Your Competitors Are Beating You Online', 'Here''s why your competitors are beating you...', 'pending', '2026-03-11'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'The ROI of Video Content in 2026', 'Let me share something that changed my perspective...', 'approved', '2026-03-12'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'How I Grew My Business 3x With Content', 'Three years ago I was struggling to get clients...', 'pending', '2026-03-13'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'Stop Selling, Start Helping', 'The biggest shift in my marketing career...', 'rejected', '2026-03-14');
