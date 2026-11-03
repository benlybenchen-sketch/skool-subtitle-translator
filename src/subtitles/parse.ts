import type { Cue } from '../shared/types';
import { cueId } from './normalize';

/** Parse "hh:mm:ss.mmm", "mm:ss.mmm" or SRT-style "hh:mm:ss,mmm" into seconds. */
export function parseTimestamp(ts: string): number {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return h * 3600 + min * 60 + s + ms / 1000;
}

const TIMING_RE = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;

function parseBlocks(input: string, isVtt: boolean): Cue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i) => i > 0 || l.trim() !== '');
    if (!lines.length) continue;
    if (isVtt && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const timingIdx = lines.findIndex((l) => TIMING_RE.test(l));
    if (timingIdx < 0 || timingIdx > 1) continue;
    const m = lines[timingIdx].match(TIMING_RE)!;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = lines.slice(timingIdx + 1).join('\n').trim();
    if (!body) continue;
    cues.push({ id: cueId(start, end, body), start, end, text: body });
  }
  return cues;
}

export function parseVtt(input: string): Cue[] {
  return parseBlocks(input, true);
}

export function parseSrt(input: string): Cue[] {
  return parseBlocks(input, false);
}

/** Detect the format from content and parse. */
export function parseSubtitleFile(input: string): Cue[] {
  return /^﻿?WEBVTT/.test(input.trimStart()) ? parseVtt(input) : parseSrt(input);
}
