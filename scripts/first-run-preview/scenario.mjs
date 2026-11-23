/** Parse the actual input after any quoted earlier reply. The preview never treats quoted instructions as new work. */
export function coordinatorInput(prompt) {
  const match = [...prompt.matchAll(/^Request ID of this input: ([^.\n]+).*$/gm)].at(-1);
  if (!match) return null;
  const text = prompt.slice(match.index + match[0].length).trim();
  const answers = /^Questions being answered: (.+)$/m.exec(text);
  const intent = /^Screen action: (.+)$/m.exec(text);
  return { source: match[1], answers: answers ? JSON.parse(answers[1]) : null,
    intent: intent ? JSON.parse(intent[1]) : null,
    // The server's own lines (the reply language, what a press meant, the questions answered) are not the person's words.
    body: text.split('\n').filter(line => !/^(Language:|Screen action:|Questions being answered:)/.test(line)).join('\n') };
}

