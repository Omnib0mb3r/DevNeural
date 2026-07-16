/**
 * Daily brief.
 *
 * Renders the latest whats-new digest plus a structured top-level
 * summary that the dashboard Home page hangs off. Generation of the
 * narrative brief itself happens via the lint cycle (the local LLM
 * writes whats-new.md weekly). This module surfaces what's there.
 */
import * as fs from 'node:fs';
import { wikiWhatsNewFile } from '../paths.js';
import { listProjects } from '../identity/registry.js';
import { listSessions } from './sessions.js';
import { unreadCount } from './notifications.js';

export interface DailyBriefSummary {
  generated_at: string;
  projects_total: number;
  active_sessions: number;
  unread_notifications: number;
  whats_new_present: boolean;
  whats_new_age_hours: number | null;
}

export interface DailyBriefResponse {
  summary: DailyBriefSummary;
  whats_new_markdown: string;
}

/* Staleness regeneration (2026-07-16 operator audit: the brief sat
 * stale for days because whats-new only regenerated on the weekly
 * lint cycle). Regeneration is cheap file aggregation, no LLM, so
 * the route re-runs it whenever the digest is missing or older than
 * this threshold. */
export const WHATS_NEW_REGEN_THRESHOLD_HOURS = 24;

export function shouldRegenerateWhatsNew(
  ageHours: number | null,
  thresholdHours: number = WHATS_NEW_REGEN_THRESHOLD_HOURS,
): boolean {
  if (ageHours === null) return true;
  return ageHours > thresholdHours;
}

export function getDailyBrief(): DailyBriefResponse {
  const projects = listProjects();
  const sessions = listSessions();
  const active = sessions.filter((s) => s.active).length;

  let whatsNewMarkdown = '';
  let ageHours: number | null = null;
  if (fs.existsSync(wikiWhatsNewFile())) {
    try {
      whatsNewMarkdown = fs.readFileSync(wikiWhatsNewFile(), 'utf-8');
      const stat = fs.statSync(wikiWhatsNewFile());
      ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    } catch {
      /* fall through */
    }
  }

  return {
    summary: {
      generated_at: new Date().toISOString(),
      projects_total: projects.length,
      active_sessions: active,
      unread_notifications: unreadCount(),
      whats_new_present: whatsNewMarkdown.length > 0,
      whats_new_age_hours: ageHours,
    },
    whats_new_markdown: whatsNewMarkdown,
  };
}
