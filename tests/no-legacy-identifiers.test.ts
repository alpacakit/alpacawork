/**
 * The names the v5 orchestration removed stay removed: the old projects' identifiers, and the checks and
 * writers whose facts now have one owner (resolveCaller, authorize, TaskTransition, the ball, ReturnLifecycle…). The
 * types cannot see a name kept alive as a thin wrapper, in SQL text or in the prose of a skill or a document, so the
 * tracked text of apps, packages, skills and docs is searched for them, as the stage gates searched it once.
 *
 * Not searched: build output (git-ignored) and tests/ and e2e/, which name the old flags on purpose to see them
 * refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const SEARCHED = ['apps', 'packages', 'skills', 'docs'];

/**
 * Old projects: a project is a Task of kind project, and a Task belongs to its nearest one. The workspace's global.md
 * is gone with them: its policies are the policy lines of the project bodies (the policy chain).
 */
const OLD_PROJECTS = [/ProjectScope/, /\binProject\b/, /projectOf\(/, /project_id/, /ALPACAWORK_PROJECT/, /--project(?!=)/,
  /parseTaskRef/, /shownTaskId/, /taskRefSchema/, /recordTaskIdSchema/, /projectKeySchema/, /PROJECT_KEY_PATTERN/,
  /project-contract/, /useShownTaskId/, /projects\/\$\{/, /waiting_intent/, /BUDGET\.global/, /PROJECT_GOAL_LAUNCH_LIMIT/,
  /legacy-drafts/, /migrate-project/, /migrate-screen/, /global\.md/, /WORKSPACE_GLOBAL/];
/** The coordinator before it ran as Runs, and the callers resolveCaller names now. */
const OLD_CALLERS = [/conversation\.json/, /hasSession/, /processUnit\(.coordinator/, /RUN_AUTHORIZATION/, /requestActor/,
  /actorOf\(/, /hasRunConnection/, /connectionCaller/, /connectionRunCredential/];
/** Checks and writers whose fact or rule moved to its one owner. */
const OLD_OWNERS = [/personTurns/, /waitedStates/, /waitAnchorIn/, /processedReturn/, /restoreReport/, /waitingIntent/,
  /WAITING_INTENT/, /report_restored/, /manual_correction/, /review_stopped/, /return_handlings/, /seatWake/, /boundaryOf/,
  /reviewBlocked/, /ownerless/, /\brunWait\b/, /runWaitState/, /runWaitInput/, /wait-state/, /answersPerson/,
  /currentWaitingIntent/, /ASKED_REMAINING/, /turnSchema/, /home-groups/, /\buseReview\b/, /useReportTask/,
  /useSubmitRequest/, /requireHuman/, /directActor/, /currentResponsibleRun/, /currentCommentRun/, /taskController/,
  /assertFileTaskRun/, /FileRunCredential/, /screenFor/, /actorFor/, /controllerOf/, /\bsubtreeDone\b/, /activeDescendants/,
  /pendingBySeat/, /unreturnedRequests/, /returnDestination/, /assertPersonHold/, /ownerDecision/, /restoreAnchor/,
  /\bwaitRun\b/, /isCurrentQuestionContext/, /reviewAvailability/, /\bturnOf\b/, /answeredBy/, /heldTurn/,
  /syntheticTurn/, /restoredReports/, /readBodyFile/, /updateCli/, /isDirectInstruction/, /asksSomething/, /currentAsks/,
  /hasUnfinishedRuns\(root/];
const LEGACY = new RegExp([...OLD_PROJECTS, ...OLD_CALLERS, ...OLD_OWNERS].map(name => name.source).join('|'));

/** TaskRepository's writer ports, which in the control code only TaskTransition and the repository itself call. */
const WRITER_PORTS = { pattern: /saveBatch\(|insertLogs\(|writer\.save\(task/, under: 'apps/backend/src/control/',
  owners: new Set(['apps/backend/src/control/task-transition.ts', 'apps/backend/src/control/task-store.ts']) };

test('the retired subtree owner is refused without confusing a duration with that owner', () => {
  for (const text of ['subtreeDone(task)', 'const subtreeDone = () => true', '"subtreeDone"'])
    assert.ok(LEGACY.test(text), text);
  assert.equal(LEGACY.test('let subtreeDoneMs = subtree.done.runMs'), false);
});

test('no removed project identifier, caller or old owner is named in apps, packages, skills or docs', () => {
  const deleted = new Set(execSync('git ls-files --deleted -z', { cwd: project, encoding: 'utf8' }).split('\0'));
  const files = execSync(`git ls-files --cached --others --exclude-standard -z -- ${SEARCHED.join(' ')}`,
    { cwd: project, encoding: 'utf8' }).split('\0').filter(file => file && !deleted.has(file));
  assert.ok(files.length > 300, `expected the tracked text to be searched, saw ${files.length} files`);
  const found: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(join(project, file));
    if (bytes.includes(0)) continue; // An image or another binary file holds no name.
    bytes.toString('utf8').split('\n').forEach((line, index) => {
      const name = LEGACY.exec(line)?.[0]
        ?? (file.startsWith(WRITER_PORTS.under) && !WRITER_PORTS.owners.has(file) ? WRITER_PORTS.pattern.exec(line)?.[0] : undefined);
      if (name !== undefined) found.push(`${file}:${index + 1}: ${name}`);
    });
  }
  assert.deepEqual(found, [], `Removed names are back:\n${found.join('\n')}`);
});
