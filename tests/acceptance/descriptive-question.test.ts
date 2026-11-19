import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { questionText, type FieldItem } from '@alpacawork/contract';
import { cli, coordinator, setup, until } from './harness.ts';
import { completionQuestion, descriptiveQuestion } from '../fixtures/descriptive-question.ts';

/** Each choice as the screen answers it: a choice's first-word answer, or the question's own Stop (`<n>-stop`), which stops the Task instead. */
for (const scenario of [
  { answer: '1-Include', values: descriptiveQuestion, stops: false },
  { answer: '1-Accept', values: completionQuestion, stops: false },
  { answer: '1-stop', values: completionQuestion, stops: true },
]) {
  test(`concrete answer ${scenario.answer} crosses real CLI/HTTP and ${scenario.stops ? 'stops the Task' : 'answers its question'}`, async t => {
    const h = await setup(t, 2, true, 'reporter');
    const check = (result: Awaited<ReturnType<typeof cli>>) => {
      assert.equal(result.code, 0, result.stderr || result.stdout); return result.body;
    };
    const task = h.task!.id;
    // Run completion is imported before its Task end is linked. Read the hash from the CLI snapshot that
    // includes that link, so a pending reconciliation cannot invalidate the user's stop or confirmation.
    const settledTask = (run: string) => until(async () => {
      const view = check(await cli(h.root, 'task get', { task, log: '1' }));
      const end = view.task.log[0];
      return end?.runId === run && end.stage?.boundary === 'settled_end' && view;
    }, `${run}'s end is linked to its Task`, 30_000);
    const valuesFile = h.gate('question.json'); writeFileSync(valuesFile, JSON.stringify(scenario.values));
    const updated = check(await cli(h.root, 'task update', { task, 'values-file': valuesFile, 'expected-task-hash': h.task!.hash }));
    const schema = check(await cli(h.root, 'field get'));
    assert.deepEqual([schema.from, schema.fields.includes('decide')], [null, true]);
    // The responsible asks its requester, the user (a person's Task is the user's request), the body's question.
    const asking = h.gate('ask.md'); writeFileSync(asking, 'ask');
    const first = check(await cli(h.root, 'task request', { task, 'instruction-file': asking,
      'expected-task-hash': updated.task.hash, 'expected-placement-revision': String(h.placement!.revision) }))
      .outcome.request.runId;
    await h.waitState(first, 'succeeded');
    const asked = await settledTask(first);
    assert.deepEqual(asked.task.values, scenario.values);
    assert.deepEqual(asked.questions.map((question: { destination: { kind: string } }) => question.destination.kind), ['user']);
    const question = asked.questions[0].id;
    const fixed = async () => check(await cli(h.root, 'task get', { task, question })).question;
    // The question reads as text by its ID, and the view carries what it fixed for the screen to draw.
    assert.equal((await fixed()).text, questionText(scenario.values.decide as FieldItem[]));
    assert.deepEqual(asked.questions[0].decide, scenario.values.decide);
    // The screen's choice reaches the coordinator as the user's words, which it quotes.
    const wire = `${asked.task.id}（${asked.task.title}） ${scenario.answer}`;

    if (scenario.stops) {
      const stopped = check(await cli(h.root, 'task report', { task, state: 'stopped',
        'expected-task-hash': asked.task.hash, quote: wire }, coordinator));
      assert.equal(stopped.task.state, 'stopped');
      assert.equal((await fixed()).state, 'expired');
    } else {
      const answerFile = h.gate('answer.md'); writeFileSync(answerFile, wire);
      const answered = check(await cli(h.root, 'task request', { task, answers: question,
        'instruction-file': answerFile, quote: wire }, coordinator));
      assert.equal(answered.outcome.kind, 'answered');
      // The answer wakes the responsible with its text; the question's full text stays readable by its ID.
      const woken = await until(() => h.records().find(run => run.task === task && run.id !== first),
        'the answer wakes the responsible');
      await h.waitState(woken.id, 'succeeded');
      const delivered = check(await cli(h.root, 'run get', { run: woken.id, kind: 'prompt' }));
      assert.equal(delivered.files[0].state, 'present');
      assert.ok(delivered.files[0].text.includes(`answer to question ${question}:\n${wire}`));
      const closed = await fixed();
      assert.deepEqual([closed.state, closed.answer], ['answered', wire]);
      // The woken responsible reported done: the user's request waits for the user's review of that Run, which the
      // coordinator confirms in the user's words.
      const review = await settledTask(woken.id);
      assert.deepEqual([review.task.state, review.reviewRun], ['waiting', woken.id]);
      const approval = 'Please mark this complete';

      const confirmed = check(await cli(h.root, 'task report', { task, state: 'done', 'about-run': review.reviewRun,
        'expected-task-hash': review.task.hash, 'expected-placement-revision': String(h.placement!.revision),
        quote: approval }, coordinator));
      assert.equal(confirmed.task.state, 'done');
    }
    h.integrity();
  });
}
