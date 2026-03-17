-- Content Queue: scheduled content with approval + day-before confirmation flow
CREATE TABLE IF NOT EXISTS content_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL,
  client_whatsapp TEXT NOT NULL,

  -- What to publish
  content_type TEXT NOT NULL,       -- 'social_post', 'meta_ad', 'blog', 'email'
  platform TEXT,                    -- 'instagram', 'facebook', 'linkedin', 'meta_ads', 'wordpress', 'mailchimp'
  content_text TEXT,                -- the post copy / ad copy / blog draft
  image_url TEXT,                   -- Cloudinary URL if an image was generated
  headline TEXT,                    -- for ads: headline
  cta_url TEXT,                     -- for ads/emails: destination URL
  target_audience TEXT,             -- for ads: targeting notes

  -- Scheduling
  scheduled_at TIMESTAMPTZ NOT NULL,
  timezone TEXT DEFAULT 'America/Sao_Paulo',

  -- Status machine
  -- States: pending_approval → approved → confirmed → published
  --                          → rejected (client said no)
  --                          → cancelled (day-before not confirmed)
  status TEXT DEFAULT 'pending_approval',

  -- Confirmation tracking
  confirmation_sent_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,

  -- Raw conversation
  client_original_request TEXT,     -- what the client typed
  sofia_preview_message TEXT,       -- what SOFIA showed the client

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for the confirmation cron
CREATE INDEX IF NOT EXISTS idx_content_queue_status_scheduled
  ON content_queue(status, scheduled_at);

-- Index for lookups by client
CREATE INDEX IF NOT EXISTS idx_content_queue_client_whatsapp
  ON content_queue(client_whatsapp, status);
