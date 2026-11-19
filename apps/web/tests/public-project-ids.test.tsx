import { beforeAll, describe, expect, it } from 'vitest';
import { i18n, startI18n } from '@alpacawork/i18n';
import { formatTask, splitMessage, taskTokens } from '../src/features/coordinator/editor/wire';
import { taskIdAtAddress } from '../src/domain/local-path';
import { ProjectOptions } from '../src/features/panels/ProjectOptions';
import { SentMessage as MessageParts, useMessageParts } from '../src/features/coordinator/SentMessage';
import { TestWorkspace, PROJECT_TASK } from './fixtures';
import { render } from '@testing-library/react';

function SentMessage({ text }: { text: string }) {
  return <MessageParts parts={useMessageParts(text, [])} />;
}

describe('public project IDs at browser boundaries', () => {
  beforeAll(() => startI18n());
  it('reads a sent project wire label back as a project reference', () => {
    const { container } = render(<TestWorkspace><SentMessage text={formatTask(PROJECT_TASK, 'default')} /></TestWorkspace>);
    expect(container.querySelector('button[data-label="task"]')?.textContent).toBe(PROJECT_TASK + 'default');
  });
  it('serializes project chips using their public ID and reads the same wire label', () => {
    const tasks = new Map([['P273', 'alpacawork'], ['T417', 'ID work']]);
    const wire = formatTask('P273', 'alpacawork') + ' T417（ID work）';
    expect(wire).toBe('P273（alpacawork） T417（ID work）');
    expect(splitMessage(wire, new Set(), tasks).filter(part => part.kind === 'task').map(part => part.id)).toEqual(['P273', 'T417']);
    expect(taskTokens(wire, id => tasks.has(id) ? { id, title: tasks.get(id)! } : undefined).map(part => part.id)).toEqual(['P273', 'T417']);
    expect(taskIdAtAddress('P273')).toBe('P273');
    expect(taskIdAtAddress('P273junk')).toBeNull();
  });
  it('always disambiguates project choices by name and P number, spaced as the language spaces them', async () => {
    const projects = [
      { id: 'P273', title: 'same', parentId: null, color: '#39659b', cwd: null, depth: 0, counts: { turn: 0, running: 0 } },
      { id: 'P276', title: 'same', parentId: 'P273', color: '#5a8649', cwd: null, depth: 1, counts: { turn: 0, running: 0 } },
    ];
    const options = () => {
      const { container, unmount } = render(<select><ProjectOptions projects={projects} /></select>);
      const shown = [...container.querySelectorAll('option')].map(option => [option.value, option.textContent]);
      unmount();
      return shown;
    };
    await i18n.changeLanguage('en');
    expect(options()).toEqual([['P273', 'same P273'], ['P276', '\u00a0\u00a0same P276']]);
    // Japanese sets the pair apart with an ideographic space (U+3000), compared exactly.
    await i18n.changeLanguage('ja');
    try { expect(options()).toEqual([['P273', 'same\u3000P273'], ['P276', '\u00a0\u00a0same\u3000P276']]); }
    finally { await i18n.changeLanguage('en'); }
  });
});
