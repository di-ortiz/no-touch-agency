// Supabase Edge Function: POST /publish-video
// Input: { video_id, platforms[] }
// Would call Publer API to publish across platforms
// Stub: sets video status to 'posted', logs to activity_log

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const { video_id, platforms } = await req.json()

  if (!video_id || !platforms?.length) {
    return new Response(JSON.stringify({ error: 'video_id and platforms are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // In production: call Publer API for each platform
  // For now: return mock success
  return new Response(JSON.stringify({
    success: true,
    video_id,
    platforms,
    posted_at: new Date().toISOString(),
    message: `Video published to ${platforms.join(', ')}.`,
  }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
