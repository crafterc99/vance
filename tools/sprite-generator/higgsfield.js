/**
 * Higgsfield API client for sprite generation.
 * Uses Nano Banana Pro model via the Higgsfield Cloud API.
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://cloud.higgsfield.ai/v1';

class HiggsFieldClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey || process.env.HF_API_KEY || process.env.HIGGSFIELD_API_KEY;
    this.apiSecret = apiSecret || process.env.HF_API_SECRET || process.env.HIGGSFIELD_API_SECRET;

    // Support combined key format: "key:secret"
    if (!this.apiSecret && this.apiKey && this.apiKey.includes(':')) {
      [this.apiKey, this.apiSecret] = this.apiKey.split(':');
    }

    if (!this.apiKey) {
      throw new Error(
        'Higgsfield API key required. Set HF_API_KEY env var or pass to constructor.\n' +
        'Get your key at: https://cloud.higgsfield.ai/'
      );
    }
  }

  get authHeader() {
    const combined = this.apiSecret ? `${this.apiKey}:${this.apiSecret}` : this.apiKey;
    return `Bearer ${combined}`;
  }

  /**
   * Submit a generation request to Higgsfield.
   * @param {string} prompt - The image generation prompt
   * @param {object} opts - { model, resolution, aspectRatio }
   * @returns {object} - { id, status }
   */
  async submit(prompt, opts = {}) {
    const model = opts.model || 'nano-banana-pro';
    const resolution = opts.resolution || '2K';

    const body = {
      model,
      arguments: {
        prompt,
        resolution,
        ...(opts.aspectRatio && { aspect_ratio: opts.aspectRatio }),
      },
    };

    const res = await fetch(`${API_BASE}/generations`, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Higgsfield API error (${res.status}): ${text}`);
    }

    return res.json();
  }

  /**
   * Check the status of a generation request.
   * @param {string} id - Generation request ID
   * @returns {object} - { id, status, images?, error? }
   */
  async status(id) {
    const res = await fetch(`${API_BASE}/generations/${id}`, {
      headers: { 'Authorization': this.authHeader },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Higgsfield status error (${res.status}): ${text}`);
    }

    return res.json();
  }

  /**
   * Submit and wait for completion (polling).
   * @param {string} prompt - The generation prompt
   * @param {object} opts - { model, resolution, pollInterval, maxWait, onStatus }
   * @returns {object} - { images: [{ url }] }
   */
  async generate(prompt, opts = {}) {
    const pollInterval = opts.pollInterval || 3000;
    const maxWait = opts.maxWait || 120000; // 2 minutes
    const onStatus = opts.onStatus || (() => {});

    const submission = await this.submit(prompt, opts);
    const id = submission.id;
    onStatus({ phase: 'submitted', id });

    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));

      const result = await this.status(id);
      onStatus({ phase: result.status, id });

      if (result.status === 'completed' || result.status === 'succeeded') {
        return result;
      }

      if (result.status === 'failed' || result.status === 'error') {
        throw new Error(`Generation failed: ${result.error || 'unknown error'}`);
      }
    }

    throw new Error(`Generation timed out after ${maxWait / 1000}s`);
  }

  /**
   * Download a generated image to a local file.
   * @param {string} url - Image URL from Higgsfield
   * @param {string} outputPath - Local file path to save to
   */
  async downloadImage(url, outputPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const buffer = await res.buffer();
    fs.writeFileSync(outputPath, buffer);
    return outputPath;
  }
}

module.exports = { HiggsFieldClient };
