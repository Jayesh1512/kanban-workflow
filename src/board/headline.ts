import { actionTitle } from '../workflow/card-format.js';

const filler = /^(?:the|a|an|our|their|its|his|her|this|that|these|those|some|any)$/i, dangling = /^(?:to|of|for|with|in|on|at|by|and|or|from|about|into|as|than|that|which)$/i;
/** Brief card title: at most 5 words, no filler articles, never ending on a dangling preposition. */
export function shortAction(action: string): string {
  // "Kingsley asked AntSeed to have customers retry…" -> the requested task, not a verb picked from later words.
  const sentence = action.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z])/u)[0]!;
  const asked = sentence.match(/\b(?:asked|requested|wants?|needs?|promised|agreed)\s+(?:\S+\s+){0,3}?to\s+(.+)$/i)?.[1] ?? sentence.match(/^\S+\s+(?:proposed|suggested)\s+(.+)$/i)?.[1];
  const base = asked ? asked[0]!.toUpperCase() + asked.slice(1) : actionTitle(action);
  const words = base.split(/\s+/).filter((w, i) => i === 0 || !filler.test(w)).slice(0, 5);
  const clause = words.findIndex((w, i) => i >= 2 && /^(?:after|before|until|because|so|when|while|and|but|if)$/i.test(w));
  if (clause > 0) words.length = clause;
  while (words.length > 1 && dangling.test(words[words.length - 1]!)) words.pop();
  return words.join(' ').replace(/[,;:]$/, '');
}

const generic = /^(?:confirm|clarify) next step$/i;
/** Card/panel title: the owner's short action, else the stored plain-language headline, else a neutral prompt. */
export function workTitle(nextAction: string | null, headline: string | null): string {
  const action = nextAction?.trim() ? shortAction(nextAction) : '';
  if (action && !(generic.test(action) && headline?.trim())) return action;
  return headline?.trim() || action || 'Review conversation';
}
