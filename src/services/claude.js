import Anthropic from '@anthropic-ai/sdk';
import config from '../config.js';
import logger from '../logger.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';
const MAX_RETRIES = 3;

async function callClaude(systemPrompt, userPrompt, retryCount = 0) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return response.content[0].text;
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warn(`Claude API error, retrying in ${delay}ms`, { error: err.message, attempt: retryCount + 1 });
      await new Promise((r) => setTimeout(r, delay));
      return callClaude(systemPrompt, userPrompt, retryCount + 1);
    }
    logger.error('Claude API failed after max retries', { error: err.message });
    throw err;
  }
}

function parseJSON(text) {
  // Strip markdown code fences if present
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(clean);
}

async function generateIdeasFromContext(pageContext, winnerPatterns) {
  const systemPrompt = `You are an expert social media strategist for a Facebook page. You understand what performs well based on data and page context.`;

  const userPrompt = `Based on this Facebook page, generate 8 diverse post ideas that would perform well right now.

Page Context: ${JSON.stringify(pageContext)}
Past Winner Patterns: ${JSON.stringify(winnerPatterns)}

Create ideas spanning all the page's content pillars and multiple post types. Each idea must specify:
- post_type: one of "educational", "story", "poll", "tip", "behind-the-scenes", "promotional", "user-generated"
- idea_title: catchy, specific title for the post
- idea_description: 1-2 sentences describing the post concept
- why_it_will_work: brief explanation based on page context and data
- predicted_engagement: "low", "medium", or "high"

${winnerPatterns.length === 0 ? 'Note: No historical winner data yet — base predictions on page context and general best practices.' : ''}

Return a JSON array of exactly 8 idea objects. No extra text.`;

  const text = await callClaude(systemPrompt, userPrompt);
  return parseJSON(text);
}

async function generatePostIdeas(topic, winnerPatterns, pageContext) {
  const systemPrompt = `You are an expert social media strategist for a Facebook page. You understand what performs well based on data.`;

  const userPrompt = `Given the topic "${topic}", the page context ${JSON.stringify(pageContext)}, and these past winner patterns ${JSON.stringify(winnerPatterns)}, generate 5 diverse post ideas.

Each idea must specify:
- post_type: one of "educational", "story", "poll", "tip", "behind-the-scenes", "promotional", "user-generated"
- idea_title: catchy title for the post
- idea_description: 1-2 sentences describing the post concept
- why_it_will_work: brief explanation based on winner data (or page context if no winner data)
- predicted_engagement: "low", "medium", or "high"

${winnerPatterns.length === 0 ? 'Note: No historical winner data yet — base predictions purely on page context and general best practices.' : ''}

Return a JSON array of exactly 5 idea objects. No extra text.`;

  const text = await callClaude(systemPrompt, userPrompt);
  return parseJSON(text);
}

async function generateGatheringQuestions(postType, ideaTitle, ideaDescription) {
  const systemPrompt = `You are helping a social media manager create a great Facebook post.`;

  const userPrompt = `For a "${postType}" post titled "${ideaTitle}" described as: "${ideaDescription}", generate 3-5 specific questions to gather the information needed to write this post. Questions should be concrete and actionable — ask for real content, facts, stories, or details.

Return a JSON array of question strings only. No extra text.`;

  const text = await callClaude(systemPrompt, userPrompt);
  return parseJSON(text);
}

async function generatePostDraft(postType, ideaTitle, answers, winnerPatterns, pageContext) {
  const systemPrompt = `You are an expert Facebook copywriter. Write engaging, human posts that get real engagement.`;

  const userPrompt = `Write a complete Facebook post draft using this information:
Post type: ${postType}
Idea: ${ideaTitle}
Information gathered: ${JSON.stringify(answers)}
Page context: ${JSON.stringify(pageContext)}
Past winner patterns to emulate: ${JSON.stringify(winnerPatterns)}

Return JSON with these exact fields:
- caption: the full post text, ready to publish (conversational, engaging, ends with a question or CTA)
- hashtags: array of 5-8 relevant hashtags (without # prefix)
- call_to_action: one clear CTA sentence
- pre_publish_actions: array of 3-5 things to do before publishing (e.g. "Create a striking image showing X")
- post_publish_actions: array of 3-5 things to do after publishing (e.g. "Reply to first 5 comments within 1 hour")
- image_suggestions: array of 3 concrete image or graphic ideas for this post

Return only the JSON object. No extra text.`;

  const text = await callClaude(systemPrompt, userPrompt);
  return parseJSON(text);
}

async function reviseDraft(originalDraft, rejectionReason) {
  const systemPrompt = `You are an expert Facebook copywriter. Improve this draft based on feedback.`;

  const userPrompt = `Original draft: ${JSON.stringify(originalDraft)}
Feedback: ${rejectionReason}

Rewrite the draft addressing all feedback. Return the same JSON structure as the original draft with these exact fields:
- caption
- hashtags
- call_to_action
- pre_publish_actions
- post_publish_actions
- image_suggestions

Return only the JSON object. No extra text.`;

  const text = await callClaude(systemPrompt, userPrompt);
  return parseJSON(text);
}

async function analyzePostPerformance(posts, metrics) {
  const systemPrompt = `You are a social media analytics expert. Identify patterns in what works.`;

  const userPrompt = `Analyze these Facebook posts and their performance metrics: ${JSON.stringify({ posts, metrics })}

Identify:
1. Which post types perform best
2. Best days/times for posting
3. Common patterns in high-performing posts
4. What to do more and less of

Return JSON with fields:
- insights: string summary of key findings
- recommendations: array of actionable recommendation strings
- winner_patterns: object keyed by post_type, each with avg_engagement_rate, best_day_of_week (0=Sun..6=Sat), best_hour (0-23), top_keywords array

Return only the JSON object. No extra text.`;

  const text = await callClaude(systemPrompt, userPrompt);
  return parseJSON(text);
}

async function analyzeCommentSentiment(commentText) {
  const systemPrompt = `You are a social media community manager. Analyze comment sentiment and suggest replies.`;

  const userPrompt = `Analyze this Facebook comment: "${commentText}"

Return JSON with:
- sentiment: "positive", "neutral", or "negative"
- reply_suggestion: a friendly, on-brand reply suggestion

Return only the JSON object. No extra text.`;

  const text = await callClaude(systemPrompt, userPrompt);
  return parseJSON(text);
}

async function generateWeeklyReport(weekData) {
  const systemPrompt = `You are a social media performance analyst. Write clear, actionable reports.`;

  const userPrompt = `Generate a weekly Facebook page performance report based on this data: ${JSON.stringify(weekData)}

Write a human-readable markdown summary including:
- Overview of the week's performance (posts published, avg engagement)
- Key wins (best performing post, what worked)
- What underperformed and why
- 3 specific, actionable recommendations for next week

Format as clean markdown. Be concise and data-driven.`;

  return callClaude(systemPrompt, userPrompt);
}

async function generateImagePrompt(caption, postType) {
  const systemPrompt = `You are an expert at writing image generation prompts for Stable Diffusion / FLUX.
Write prompts that produce professional, photorealistic images suitable for a Facebook business page.
Never include text, watermarks, or logos in the description.`;

  const userPrompt = `Write a single image generation prompt (max 80 words) for this Facebook post.

Post type: ${postType || 'general'}
Caption: ${caption || 'professional business content'}

Requirements:
- Photorealistic style
- No text or words in the image
- Professional lighting and composition
- Relevant to the post topic
- High quality, suitable for a business page

Return ONLY the prompt text, nothing else.`;

  const result = await callClaude(systemPrompt, userPrompt);
  return result.trim();
}

export {
  generateIdeasFromContext,
  generatePostIdeas,
  generateGatheringQuestions,
  generatePostDraft,
  reviseDraft,
  analyzePostPerformance,
  analyzeCommentSentiment,
  generateWeeklyReport,
  generateImagePrompt,
};
