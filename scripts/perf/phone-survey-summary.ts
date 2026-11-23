#!/usr/bin/env node
/** Collect every valid latency window, retaining partial runs and outliers. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const series: Record<string, string> = {
  detail: 'perf', chat: 'perf+40-turn conversation', catalog: 'perf+empty project',
  'catalog-v2': 'perf+empty project', 'list-scene': 'perf+17 questions',
  'questions-small-v3': 'small+4 questions/fake coordinator',
  'questions-small-v4': 'small+4 questions/fake coordinator', 'messages-small': 'small+4 questions/fake coordinator',
};
const labels: Record<string, string> = {
  'detail-open': 'Open details from the list', 'detail-close-button': 'Close details with the close button',
  'detail-close-back': 'Close details with browser Back', 'detail-handle-resize': 'Drag the handle down 100px',
  'detail-handle-close': 'Close by dragging the handle', 'detail-body-resize': 'Drag the body down 100px',
  'detail-body-close': 'Close by dragging the body', 'input-open': 'Open the conversation input',
  'input-close': 'Close the input (alone/after conversation; Escape)', 'input-fold': 'Close the input after closing the conversation',
  'chat-open': 'Open the conversation', 'chat-close': 'Close the conversation', 'history-open': 'Expand 39 earlier conversations',
  'history-close': 'Collapse earlier conversations', 'chat-scroll': 'Touch-scroll the conversation',
  'task-next': 'Next task in details', 'task-previous': 'Previous task in details',
  'timeline-show': 'Show the timeline', 'timeline-hide': 'Hide the timeline', 'search-open': 'Open search',
  'search-query': 'Type a search query and show results', 'search-close': 'Close search and return to the list',
  'project-menu': 'Open the project menu', 'project-select': 'Switch from all projects to the sample project',
  'settings-open': 'Open settings', 'settings-draft-tab': 'Open the settings tab with the config.yaml draft',
  'settings-close': 'Close settings (Escape)', 'finished-expand': 'Expand Done',
  'finished-collapse': 'Collapse Done', 'list-more': 'Expand the question list with More',
  'list-scroll': 'Touch-scroll the expanded list', 'list-less': 'Collapse the question list',
  'question-choice': 'Select blue option A in the question', 'input-text': 'Type into the conversation input',
  'answer-send': 'Send and save a question choice and text', 'conversation-send': 'Send and save an ordinary conversation',
};

interface Window {
  name: string;
  hostLoad: unknown;
  completion?: string;
  [key: string]: unknown;
}
interface Sample extends Window { file: string; fixtureLabel: string; browser: unknown }
interface Statistics { median: number; min: number; max: number }
function statistic(rows: Sample[], key: string): Statistics | null {
  // bool is a subclass of int in the original collector.
  const values = rows.flatMap(row => typeof row[key] === 'number' || typeof row[key] === 'boolean' ? [Number(row[key])] : [])
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return { median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    min: values[0], max: values.at(-1)! };
}

// Match Python's .0f formatting (ties to even) in the Markdown table.
function integer(value: number): string {
  const floor = Math.floor(value);
  const rounded = value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
  return rounded === 0 && (value < 0 || Object.is(value, -0)) ? '-0' : String(rounded);
}

export function summarize(root: string): void {
  const groups = new Map<string, Sample[]>(), warm: Sample[] = [], supplementary: unknown[] = [];
  for (const [directory, fixture] of Object.entries(series)) {
    const path = join(root, directory, 'results.json');
    if (!existsSync(path)) continue;
    const input = JSON.parse(readFileSync(path, 'utf8'));
    assert(input.width === 390 && input.height === 900 && input.throttle === 4 && !input.profile);
    for (const original of input.results as Window[]) {
      const row: Sample = { ...original, file: relative(root, path), fixtureLabel: fixture, browser: input.browser };
      if (row.name.startsWith('warm-')) { warm.push(row); continue; }
      let name = row.name.replace(/-\d+$/, '');
      if (name === 'input-fold') name = 'input-close';
      const rows = groups.get(name) ?? [];
      rows.push(row); groups.set(name, rows);
    }
  }
  for (const directory of ['questions', 'questions-small', 'questions-small-v2']) {
    const path = join(root, directory, 'results.json');
    if (!existsSync(path)) continue;
    supplementary.push(...JSON.parse(readFileSync(path, 'utf8')).results.map((row: Window) => ({ ...row,
      file: relative(root, path), reason: 'Incomplete fixture/bootstrap attempt; different load from the accepted small fixture.',
    })));
  }
  const summary = [...groups].map(([name, rows]) => ({
    operation: name, label: labels[name] ?? name, n: rows.length, complete: rows.length >= 4,
    fixtures: [...new Set(rows.map(row => row.fixtureLabel))].sort(),
    elapsedMs: statistic(rows, 'elapsedMs'), maxRafGapMs: statistic(rows, 'frameMaxMs'),
    releaseToEndMs: statistic(rows, 'releaseToEndMs'), scriptMs: statistic(rows, 'scriptMs'),
    layoutMs: statistic(rows, 'layoutMs'), styleMs: statistic(rows, 'styleMs'), semanticMs: statistic(rows, 'semanticMs'),
    loafBlockingMs: statistic(rows, 'blockingMs'), hostLoad: rows.map(row => row.hostLoad),
    completionConditions: [...new Set(rows.map(row => row.completion ?? name))].sort(), samples: rows,
  }));
  summary.sort((a, b) => b.elapsedMs!.median - a.elapsedMs!.median);
  const result = {
    baselineSha: 'a01167d8f1b700c0ab28975c19aae9e33d5fd1b5',
    conditions: { viewport: [390, 900], touch: true, mobile: true, cpuThrottle: 4, physicalDevice: false,
      profileExcluded: true,
      stopRule: 'native pointerdown/keydown/beforeinput (Back command excepted) to semantic completion + finite motion complete + 3 quiet rAF; at least 80ms instrument floor',
      outlierPolicy: 'None removed; preparatory warm-ups separate; valid partial-run windows retained.',
    }, summary, warmups: warm, supplementary,
  };
  writeFileSync(join(root, 'latency-summary.json'), JSON.stringify(result, null, 2));
  const md = ['Mobile interaction baseline (ms), measured with 4x CPU throttling in emulation, not on a physical device.', '',
    '|Operation|n|Median [min–max] ms|Max RAF gap median / worst ms|Fixture|', '|---|---:|---:|---:|---|'];
  for (const row of summary) {
    const time = row.elapsedMs!, gap = row.maxRafGapMs!;
    md.push(`|${row.label}|${row.n}|${integer(time.median)} [${integer(time.min)}–${integer(time.max)}]|${integer(gap.median)} / ${integer(gap.max)}|${row.fixtures.join(' / ')}|`);
  }
  md.push('', 'All valid windows are retained. Drag and scroll totals include scripted finger movement and pauses. Also see releaseToEndMs and RAF gaps when assessing waits. This instrument cannot reliably rank responses below 80ms.', '',
    `Operations: ${summary.length}. Regular windows: ${summary.reduce((count, row) => count + row.n, 0)}. Preparatory warm-ups: ${warm.length}. Supplementary windows from different incomplete fixtures: ${supplementary.length}.`);
  writeFileSync(join(root, 'latency-table.md'), md.join('\n') + '\n');
  console.log(md.join('\n'));
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/perf/phone-survey-summary.ts <results-directory>');
  summarize(process.argv[2]);
}
