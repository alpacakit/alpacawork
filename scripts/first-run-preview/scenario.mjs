/** Parse the actual input after any quoted earlier reply. The preview never treats quoted instructions as new work. */
export function coordinatorInput(prompt) {
  const match = [...prompt.matchAll(/^Request ID of this input: ([^.\n]+).*$/gm)].at(-1);
  if (!match) return null;
  // The server puts its reply-language line right after this one (coordinator/conversation.ts launchText); it is not the person's.
  const text = prompt.slice(match.index + match[0].length).trim().replace(/^Language: [^\n]*Write your replies[^\n]*\n?/, '');
  const answers = /^Questions being answered: (.+)$/m.exec(text);
  const intent = /^Screen action: (.+)$/m.exec(text);
  return { source: match[1], answers: answers ? JSON.parse(answers[1]) : null,
    intent: intent ? JSON.parse(intent[1]) : null,
    body: text.split('\n').filter(line => !/^(Screen action:|Questions being answered:)/.test(line)).join('\n') };
}

