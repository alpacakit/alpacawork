/** The wordings of observed work, shared by coordinator and Task Run displays. */
import { i18n } from '@alpacawork/i18n';
import type { WorkCommand, WorkName } from '@alpacawork/contract/run';

export function workWords(command: WorkCommand): string {
  switch (command) {
    case 'task.new': return i18n.t('ui:work.taskNew');
    case 'task.update': return i18n.t('ui:work.taskUpdate');
    case 'task.move': return i18n.t('ui:work.taskMove');
    case 'task.request': return i18n.t('ui:work.taskRequest');
    case 'task.report': return i18n.t('ui:work.taskReport');
    case 'task.comment': return i18n.t('ui:work.taskComment');
    case 'task.get':
    case 'task.list':
    case 'task.returns': return i18n.t('ui:work.taskRead');
    case 'agent.assign': return i18n.t('ui:work.agentAssign');
    case 'agent.handover': return i18n.t('ui:work.agentHandover');
    case 'agent.release': return i18n.t('ui:work.agentRelease');
    case 'run.get': return i18n.t('ui:work.runRead');
    case 'run.stop': return i18n.t('ui:work.runStop');
    case 'field.get': return i18n.t('ui:work.fieldRead');
  }
}

/** A recent piece of work named as a noun; it never claims the work is still going. */
export function workNameWords(name: WorkName): string {
  switch (name) {
    case 'task.new': return i18n.t('ui:workName.taskNew');
    case 'task.update': return i18n.t('ui:workName.taskUpdate');
    case 'task.move': return i18n.t('ui:workName.taskMove');
    case 'task.request': return i18n.t('ui:workName.taskRequest');
    case 'task.report': return i18n.t('ui:workName.taskReport');
    case 'task.comment': return i18n.t('ui:workName.taskComment');
    case 'task.get':
    case 'task.list':
    case 'task.returns': return i18n.t('ui:workName.taskRead');
    case 'agent.assign': return i18n.t('ui:workName.agentAssign');
    case 'agent.handover': return i18n.t('ui:workName.agentHandover');
    case 'agent.release': return i18n.t('ui:workName.agentRelease');
    case 'run.get': return i18n.t('ui:workName.runRead');
    case 'run.stop': return i18n.t('ui:workName.runStop');
    case 'field.get': return i18n.t('ui:workName.fieldRead');
    case 'command': return i18n.t('ui:workName.command');
    case 'file': return i18n.t('ui:workName.file');
    case 'search': return i18n.t('ui:workName.search');
    case 'edit': return i18n.t('ui:workName.edit');
    case 'web': return i18n.t('ui:workName.web');
    case 'tool': return i18n.t('ui:workName.tool');
  }
}
