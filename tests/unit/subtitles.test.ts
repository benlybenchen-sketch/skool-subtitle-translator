import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSrt, parseSubtitleFile, parseTimestamp, parseVtt } from '../../src/subtitles/parse';
import { cleanCueText, normalizeCues } from '../../src/subtitles/normalize';
import { segmentCues } from '../../src/subtitles/segmenter';
import { Timeline } from '../../src/subtitles/timeline';
import type { Cue } from '../../src/shared/types';

const fixture = (f: string) => readFileSync(resolve(__dirname, '../fixtures', f), 'utf8');
const cue = (start: number, end: number, text: string, id = `${start}`): Cue => ({ id, start, end, text });

describe('timestamp & file parsing', () => {
  it('parses VTT and SRT timestamps', () => {
    expect(parseTimestamp('00:01:02.500')).toBeCloseTo(62.5);
    expect(parseTimestamp('01:02.25')).toBeCloseTo(62.25);
    expect(parseTimestamp('1:00:00,001')).toBeCloseTo(3600.001);
    expect(parseTimestamp('garbage')).toBeNaN();
  });

  it('parses a WebVTT file, skipping header/NOTE blocks', () => {
    const cues = parseVtt(fixture('lesson.vtt'));
    expect(cues).toHaveLength(5);
    expect(cues[0]).toMatchObject({ start: 1, end: 3, text: 'Welcome back to the course.' });
    expect(cues[2].text).toContain('<v Instructor>');
  });

  it('parses SRT and auto-detects format', () => {
    expect(parseSrt(fixture('lesson.srt'))).toHaveLength(3);
    expect(parseSubtitleFile(fixture('lesson.srt'))).toHaveLength(3);
    expect(parseSubtitleFile(fixture('lesson.vtt'))).toHaveLength(5);
  });

  it('ignores malformed cues', () => {
    expect(parseVtt('WEBVTT\n\n00:00:05.000 --> 00:00:01.000\nbackwards\n\nnot a cue')).toEqual([]);
  });
});

describe('normalization & dedupe', () => {
  it('strips markup, speaker tags and entities', () => {
    expect(cleanCueText('<v Instructor>set up <b>Facebook Ads</b>')).toBe('set up Facebook Ads');
    expect(cleanCueText('Let&apos;s go &amp; win')).toBe("Let's go & win");
    expect(cleanCueText('[Music]')).toBe('');
    expect(cleanCueText('<00:00:01.000><c>hello</c>')).toBe('hello');
  });

  it('merges identical touching cues (HLS segment boundaries)', () => {
    const out = normalizeCues([cue(0, 2, 'Hello there', 'a'), cue(2, 4, 'Hello there', 'b'), cue(4, 5, 'Next', 'c')]);
    expect(out.map((c) => [c.start, c.end, c.text])).toEqual([
      [0, 4, 'Hello there'],
      [4, 5, 'Next'],
    ]);
  });

  it('removes rolling-caption repetition', () => {
    const out = normalizeCues([cue(0, 2, 'hello everyone'), cue(2, 4, 'hello everyone welcome to'), cue(4, 6, 'the course')]);
    expect(out.map((c) => c.text)).toEqual(['hello everyone', 'welcome to', 'the course']);
  });

  it('drops empty cues and sorts by start', () => {
    const out = normalizeCues([cue(5, 6, 'b'), cue(1, 2, '   '), cue(0, 1, 'a')]);
    expect(out.map((c) => c.text)).toEqual(['a', 'b']);
  });
});

describe('segmenter', () => {
  const cues = normalizeCues(parseVtt(fixture('lesson.vtt')));

  it('combines short fragments into sentence units with stable cue mapping', () => {
    const units = segmentCues(cues);
    expect(units.map((u) => u.text)).toEqual([
      'Welcome back to the course.',
      "Today we're going to set up our first Facebook Ads campaign with a $50 daily budget and a 2.5% CTR target.",
      "Let's open Shopify.",
    ]);
    expect(units[1].cueIds).toHaveLength(3);
    expect(units[1].start).toBe(3.2);
    expect(units[1].end).toBe(9);
    // IDs are deterministic
    expect(segmentCues(cues).map((u) => u.id)).toEqual(units.map((u) => u.id));
  });

  it('does not merge across long gaps or when disabled', () => {
    expect(segmentCues(cues, { merge: false })).toHaveLength(5);
    expect(segmentCues([cue(0, 1, 'and so'), cue(5, 6, 'later')]).length).toBe(2);
  });

  it('respects max duration', () => {
    const many = Array.from({ length: 10 }, (_, i) => cue(i, i + 1, `word${i}`, `x${i}`));
    const units = segmentCues(many, { maxDuration: 3 });
    expect(units.every((u) => u.end - u.start <= 3)).toBe(true);
  });
});

describe('timeline lookup', () => {
  const units = segmentCues(normalizeCues(parseVtt(fixture('lesson.vtt'))));
  const tl = new Timeline(units);

  it('finds the active unit at a time (binary search)', () => {
    expect(tl.activeAt(0.5)).toBeNull();
    expect(tl.activeAt(2)?.text).toBe('Welcome back to the course.');
    expect(tl.activeAt(5)?.cueIds.length).toBe(3);
    expect(tl.activeAt(10)).toBeNull(); // gap
    expect(tl.activeAt(13)?.text).toBe("Let's open Shopify.");
    expect(tl.activeAt(100)).toBeNull();
  });

  it('keeps translations when rebuilt with the same units', () => {
    tl.units[0].vi = 'Chào mừng trở lại khóa học.';
    tl.units[0].status = 'done';
    const tl2 = new Timeline(units, tl);
    expect(tl2.units[0].vi).toBe('Chào mừng trở lại khóa học.');
    expect(tl2.counts()).toEqual({ total: 3, done: 1, failed: 0 });
  });
});
