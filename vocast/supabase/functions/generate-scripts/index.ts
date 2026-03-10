// Supabase Edge Function: POST /generate-scripts
// Input: { user_id, topic, count, tone }
// Calls Claude API to generate video scripts
// Returns: array of { title, body } objects

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const { user_id, topic, count = 3, tone = 'Professional' } = await req.json()

  if (!user_id || !topic) {
    return new Response(JSON.stringify({ error: 'user_id and topic are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // Call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: `You are a LinkedIn/Instagram/TikTok content expert. Generate short video scripts (60–90 seconds when read aloud, ~150 words) for a business owner. Scripts should be conversational, confident, and end with a soft CTA. Return only a JSON array of objects with fields: title (string) and body (string). No markdown, no preamble.`,
        messages: [{
          role: 'user',
          content: `Generate ${count} video scripts about "${topic}" in a ${tone.toLowerCase()} tone.`,
        }],
      }),
    })

    const data = await response.json()
    const content = data.content?.[0]?.text || '[]'
    const scripts = JSON.parse(content)

    return new Response(JSON.stringify({ scripts }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    // Fallback: return mock scripts if API call fails
    const scripts = Array.from({ length: count }, (_, i) => ({
      title: `${topic} — Insight #${i + 1}`,
      body: `Here's what most people get wrong about ${topic}. The truth is, success comes from consistency, not perfection. Show up every day, provide real value, and the results will follow. Stop overthinking and start creating. Your audience is waiting for exactly what you have to share.`,
    }))

    return new Response(JSON.stringify({ scripts }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
