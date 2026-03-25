exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'ANTHROPIC_API_KEY is not configured. Add it in Netlify → Site Settings → Environment Variables.'
      })
    };
  }

  try {
    const { messages, context } = JSON.parse(event.body);

    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = `You are RH Assist, an AI analytics helper built into the Redesign Health Workforce Analytics Dashboard. You help HR teams and people leaders understand their workforce data quickly.

Answer questions concisely and accurately using ONLY the workforce data provided below. Format responses clearly — use bullet points for lists, bold key numbers.

Rules:
- Only answer from the provided data; if something isn't there say "That information isn't in the dashboard"
- Keep answers brief and scannable
- Be specific with numbers — don't guess or estimate
- Today's date: ${today}

--- WORKFORCE DATA ---
${context}
--- END DATA ---`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: messages.slice(-8) // last 4 exchanges max
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: data.content[0].text })
    };
  } catch (err) {
    console.error('ai-chat error:', err.message);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
