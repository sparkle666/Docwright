import OpenAI from 'openai';

let client = null;

export function getOpenAIClient() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}
