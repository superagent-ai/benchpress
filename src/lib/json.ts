import { readFile } from 'node:fs/promises';

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(stripJsonComments(text)) as T;
  } catch {
    return fallback;
  }
}

export async function readJsonRequired<T>(file: string): Promise<T> {
  const text = await readFile(file, 'utf8');
  return JSON.parse(stripJsonComments(text)) as T;
}

/** Strip // and /* *\/ comments from JSONC for config files. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

export function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'item';
}
