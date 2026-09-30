import { promptDefinition } from '@tanstack/ai-mcp/server';
import { z } from 'zod';
import type { Config } from '../config.js';

// Shared by every prompt: how to read a board this server does not interpret.
function groundRules(config: Config): string {
  const teamContext = config.teamContext
    ? `\nThe team described its board like this (treat it as the most reliable source):\n"""\n${config.teamContext}\n"""\n`
    : '';
  return `Work only with data from the KanbanFlow tools. Start with get_board.
The server does not interpret the board. Decide yourself what each column, swimlane, color and label means, from
their names, the color names/descriptions on the board and the team context.${teamContext}
Be transparent:
- Begin your answer with a short "Assumptions" list (for example which columns you treat as in progress or done,
  and what each color means), so the user can correct you.
- If a tool returns warnings or meta.complete = false, say what is missing and how it affects the answer.
- Link every task you mention with its url. Do not invent tasks, people or numbers.
- Answer in the language the user writes in.`;
}

const scope = (swimlane?: string) => (swimlane ? ` Limit it to the swimlane "${swimlane}".` : '');

const swimlaneArg = z.object({
  swimlane: z.string().optional().describe('Swimlane name or id to focus on (optional).'),
});

export function createPrompts(config: Config) {
  const rules = groundRules(config);

  const dailyStandup = promptDefinition({
    name: 'daily_standup',
    description:
      'Prepare a daily standup: what each person is working on, what is waiting for review and what is blocked.',
    argsSchema: swimlaneArg,
  }).render(({ swimlane }) => [
    {
      role: 'user',
      content: `Prepare today's daily standup from the KanbanFlow board.${scope(swimlane)}
Group work in progress by person, then list what is waiting (review, QA, validation…) and what is blocked or
depends on others. Use get_board_events for the last working day to mention what moved. Point out work in progress
that nobody owns and people with too much in progress.

${rules}`,
    },
  ]);

  const prioritizeTasks = promptDefinition({
    name: 'prioritize_tasks',
    description: 'Propose a priority order for pending tasks and explain the reasoning behind each position.',
    argsSchema: swimlaneArg.extend({
      criteria: z.string().optional().describe('Extra criteria for this run, e.g. "bugs first" (optional).'),
    }),
  }).render(({ swimlane, criteria }) => [
    {
      role: 'user',
      content: `Propose a priority order for the tasks that are not started yet.${scope(swimlane)}
${criteria ? `Apply these criteria from the user first: ${criteria}\n` : ''}Use the priority signals the board itself defines (color names and descriptions, labels, the team
context) and say which ones you used. For each task give one line of reasoning. Flag tasks that look blocked or
need a decision before they can be prioritized. This is a proposal: do not claim the board says something it
does not.

${rules}`,
    },
  ]);

  const sprintReview = promptDefinition({
    name: 'sprint_review',
    description: 'Summarize a period of work: what was finished, what moved, what is still open and where time went.',
    argsSchema: swimlaneArg.extend({
      from: z.string().optional().describe('Start of the period, ISO date (optional, default: 14 days ago).'),
      to: z.string().optional().describe('End of the period, ISO date (optional, default: now).'),
    }),
  }).render(({ swimlane, from, to }) => [
    {
      role: 'user',
      content: `Prepare a review of the work between ${from ?? '14 days ago'} and ${to ?? 'now'}.${scope(swimlane)}
Use get_board_events for that range to see what was created, moved and finished, and list_tasks for the current
state (load the done column completely if you need it). Report: finished work, work still in progress, what
stayed blocked, estimated vs spent time where tracked, and anything unusual.

${rules}`,
    },
  ]);

  const myTasks = promptDefinition({
    name: 'my_tasks',
    description: 'Show my tasks (the user configured as KANBANFLOW_USER) and suggest what to focus on next.',
    argsSchema: swimlaneArg,
  }).render(({ swimlane }) => [
    {
      role: 'user',
      content: `Show my tasks: list_tasks with people ["me"].${scope(swimlane)}
If "me" is not configured, ask me who I am and use get_users. Group them by where they are in the flow and
suggest what I should focus on next, explaining why.

${rules}`,
    },
  ]);

  return [dailyStandup, prioritizeTasks, sprintReview, myTasks];
}
