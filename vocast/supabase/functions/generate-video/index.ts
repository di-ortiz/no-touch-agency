// Supabase Edge Function: POST /generate-video
// Input: { script_id }
// Would call HeyGen API with avatar_id + script audio
// Stub: sets video status to 'generating', then mock-updates to 'ready'

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const { script_id } = await req.json()

  if (!script_id) {
    return new Response(JSON.stringify({ error: 'script_id is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // In production: call HeyGen API to generate video
  // For now: return mock response
  const video_id = crypto.randomUUID()

  // Simulate async video generation
  // In production, HeyGen would webhook back when complete
  return new Response(JSON.stringify({
    video_id,
    status: 'generating',
    message: 'Video generation started. Expected completion in 3-5 minutes.',
  }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
