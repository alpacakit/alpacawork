import assert from 'node:assert/strict';
/** Check semantic outcomes: uncertainty is provisional, and only a later taken can resolve it. */
export function assertInputOutcomes(events: { type: string; id?: string; evidence?: string }[], expected: Record<string, 'taken' | 'not_sent' | 'uncertain'>): void {
  for (const [id, result] of Object.entries(expected)) {
    const outcomes = events.filter(event => event.id === id && ['input.taken','input.not_sent','input.uncertain'].includes(event.type));
    assert.ok(outcomes.length, `${id} has a receipt`);
    assert.equal(outcomes.at(-1)!.type, `input.${result}`, id);
    let state = '';
    for (const event of outcomes) {
      assert.ok(state !== 'input.taken' || event.type === state, `${id}: taken never regresses`);
      assert.ok(state !== 'input.not_sent' || event.type === state, `${id}: not_sent cannot become taken`);
      if (event.type === 'input.not_sent') assert.equal(event.evidence, 'transfer_not_started');
      state = event.type;
    }
  }
}
