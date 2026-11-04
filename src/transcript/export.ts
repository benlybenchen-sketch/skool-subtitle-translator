import type { Transcript, TranscriptSegment } from './model';
import { fmtClock } from './model';

export type ExportLang = 'en' | 'vi' | 'bi';
export type ExportFormat = 'srt' | 'vtt' | 'txt' | 'md';

/** Timestamp formats use only genuine segment times — nothing is ever synthesised. */
function ts(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

/** Text of a segment for a language; null = nothing to export for it. */
function textFor(s: TranscriptSegment, lang: ExportLang): string | null {
  const en = s.en.trim();
  const vi = s.vi?.trim();
  if (lang === 'en') return en || null;
  if (lang === 'vi') return vi || null;
  return vi ? `${en}\n${vi}` : en || null;
}

/**
 * Timed cues in order: sorted by start, exact duplicates dropped, zero/negative durations made
 * valid by clamping to the next start (never extending past real time), overlapping cues kept
 * (valid in SRT/VTT).
 */
function timedCues(segments: TranscriptSegment[], lang: ExportLang): { start: number; end: number; text: string }[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number; text: string }[] = [];
  const seen = new Set<string>();
  for (const s of sorted) {
    const text = textFor(s, lang);
    if (!text) continue;
    const key = `${s.start}|${s.end}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(s.end > s.start)) continue; // no valid genuine timing → skip rather than invent one
    out.push({ start: s.start, end: s.end, text: text.replace(/\r/g, '').replace(/\n{2,}/g, '\n') });
  }
  return out;
}

export function toSrt(t: Transcript, lang: ExportLang): string {
  return timedCues(t.segments, lang)
    .map((c, i) => `${i + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(t: Transcript, lang: Exclude<ExportLang, 'bi'> | 'bi'): string {
  const body = timedCues(t.segments, lang)
    .map((c) => `${ts(c.start, '.')} --> ${ts(c.end, '.')}\n${c.text.replace(/-->/g, '→')}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** Text lessons: keep headings, lists, quotes and code blocks (Markdown-ish structure). */
function textLessonDoc(t: Transcript, lang: ExportLang, md: boolean): string {
  const out: string[] = md ? [`# ${t.title}`, ''] : [];
  let n = 0;
  for (const s of t.segments) {
    const kind = s.block ?? 'p';
    if (kind !== 'oli') n = 0;
    if (kind === 'code') {
      out.push(md ? '```\n' + s.en.replace(/\n+$/, '') + '\n```' : s.en, '');
      continue;
    }
    const en = s.en.trim();
    const vi = s.vi?.trim();
    const texts = lang === 'en' ? [en] : lang === 'vi' ? (vi ? [vi] : []) : vi ? [en, vi] : [en];
    if (!texts.length || !texts[0]) continue;
    const prefix = /^h[1-6]$/.test(kind) ? (md ? '#'.repeat(Math.min(6, Number(kind[1]) + (md ? 1 : 0))) + ' ' : '') : kind === 'li' ? '- ' : kind === 'oli' ? `${++n}. ` : kind === 'quote' ? '> ' : '';
    const indent = kind === 'li' || kind === 'oli' ? '   ' : '';
    out.push(prefix + texts[0], ...texts.slice(1).map((x) => (md && !indent && !prefix ? `> ${x}` : indent + x)));
    if (!(kind === 'li' || kind === 'oli')) out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function toTxt(t: Transcript, lang: ExportLang): string {
  if (t.kind === 'text' && t.segments.some((s) => s.block)) return textLessonDoc(t, lang, false);
  const lines: string[] = [];
  for (const s of [...t.segments].sort((a, b) => a.start - b.start)) {
    const text = textFor(s, lang);
    if (!text) continue;
    lines.push(t.kind === 'video' ? `[${fmtClock(s.start)}] ${text.replace(/\n/g, '\n    ')}` : text);
  }
  return lines.join(t.kind === 'video' ? '\n' : '\n\n') + '\n';
}

export function toMarkdown(t: Transcript, lang: ExportLang = 'bi'): string {
  if (t.kind === 'text' && t.segments.some((s) => s.block)) return textLessonDoc(t, lang, true);
  const out = [`# ${t.title}`, ''];
  if (t.coverage.state !== 'complete') out.push(`> ⚠️ PARTIAL — chỉ gồm phần nội dung truy cập được (${t.coverage.segments} đoạn).`, '');
  for (const s of [...t.segments].sort((a, b) => a.start - b.start)) {
    const en = s.en.trim();
    const vi = s.vi?.trim();
    const stamp = t.kind === 'video' ? `**[${fmtClock(s.start)}]** ` : '';
    if (lang === 'en' && en) out.push(`${stamp}${en}`, '');
    else if (lang === 'vi' && vi) out.push(`${stamp}${vi}`, '');
    else if (lang === 'bi' && en) out.push(`${stamp}${en}`, vi ? `> ${vi}` : '> _(chưa dịch)_', '');
  }
  return out.join('\n');
}

export function exportTranscript(t: Transcript, format: ExportFormat, lang: ExportLang): { name: string; mime: string; content: string } {
  if ((format === 'srt' || format === 'vtt') && t.kind !== 'video') throw new Error('Bài viết không có mốc thời gian — không thể xuất SRT/VTT.');
  const content = format === 'srt' ? toSrt(t, lang) : format === 'vtt' ? toVtt(t, lang) : format === 'txt' ? toTxt(t, lang) : toMarkdown(t, lang);
  return { name: exportFileName(t, format, lang), mime: format === 'md' ? 'text/markdown' : format === 'vtt' ? 'text/vtt' : 'text/plain', content };
}

export function exportFileName(t: Transcript, format: ExportFormat, lang: ExportLang): string {
  const base = (t.title || 'skool-lesson')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'skool-lesson';
  const partial = t.coverage.state === 'complete' ? '' : '-PARTIAL';
  return `${base}-${lang === 'bi' ? 'bilingual' : lang}${partial}.${format}`;
}

/** Local download only (no upload): Blob + object URL + anchor; UTF-8 with BOM for TXT/SRT. */
export function downloadText(doc: Document, name: string, mime: string, content: string): void {
  const bom = mime === 'text/plain' ? '﻿' : '';
  const url = URL.createObjectURL(new Blob([bom + content], { type: `${mime};charset=utf-8` }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  (doc.body ?? doc.documentElement).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
