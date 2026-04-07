import axios from 'axios';
import logger from '../logger.js';

const BASE_URL = 'https://image.pollinations.ai/prompt';

function buildImageUrl(prompt) {
  const seed = Math.floor(Math.random() * 999999);
  const url = `${BASE_URL}/${encodeURIComponent(prompt)}?width=1200&height=630&seed=${seed}&nologo=true&enhance=true&model=flux`;
  return { url, seed };
}

// Downloads the image from Pollinations and returns it as a Buffer.
// Throws on failure so callers can handle it.
async function downloadImage(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(response.data);
}

export { buildImageUrl, downloadImage };
