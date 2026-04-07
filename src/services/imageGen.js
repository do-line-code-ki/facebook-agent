import axios from 'axios';
import logger from '../logger.js';

const BASE_URL = 'https://image.pollinations.ai/prompt';

function buildImageUrl(prompt) {
  const seed = Math.floor(Math.random() * 999999);
  const url = `${BASE_URL}/${encodeURIComponent(prompt)}?width=1200&height=630&seed=${seed}&nologo=true&enhance=true&model=flux`;
  return { url, seed };
}

// Fetches the image to force Pollinations to generate + cache it.
// Returns the same URL (Pollinations serves cached result on subsequent fetches with same seed).
async function warmImage(url) {
  try {
    await axios.get(url, { responseType: 'arraybuffer', timeout: 45000 });
    return { success: true };
  } catch (err) {
    logger.warn('Image warm-up fetch failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

export { buildImageUrl, warmImage };
