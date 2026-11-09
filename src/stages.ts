import type { Changes } from './changes.js';
import type { Role, StageId } from './types.js';

export interface StageDef {
  id: StageId;
  n: string;
  title: string;
  role: Role;
  /**
   * Document the role delivers in <artifact> tags. `null` for Senior Dev stages: their final chat
   * message is the report (kept in run state), no files are written.
   */
  artifact: string | null;
}

export const STAGES: Record<StageId, StageDef> = {
  clarify: { id: 'clarify', n: '①', title: 'CLARIFY', role: 'techlead', artifact: 'requirements.md' },
  design: { id: 'design', n: '②', title: 'DESIGN', role: 'techlead', artifact: 'design.md' },
  implement: { id: 'implement', n: '③', title: 'IMPLEMENT', role: 'dev', artifact: null },
  test: { id: 'test', n: '④', title: 'TEST', role: 'dev', artifact: null },
  review: { id: 'review', n: '⑤', title: 'REVIEW', role: 'techlead', artifact: 'review.md' },
  fix: { id: 'fix', n: '⑥', title: 'FIX', role: 'dev', artifact: null },
};

/** `review.md` → `review-2.md` for later rounds. */
export function versionedName(name: string, round: number): string {
  if (round <= 1) return name;
  return name.replace(/(\.[^.]+)$/, `-${round}$1`);
}

export function extractArtifact(text: string, name: string): string | null {
  const re = /<artifact\s+name="([^"]+)"\s*>([\s\S]*?)<\/artifact>/g;
  let found: string | null = null;
  for (const m of text.matchAll(re)) if (m[1] === name) found = m[2]!.trim();
  return found;
}

export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export function parseTasks(design: string): Task[] {
  const tasks: Task[] = [];
  for (const m of design.matchAll(/^###\s+(T\d+)\s*[—–:\-.]*\s*(.*)$/gm)) {
    tasks.push({ id: m[1]!, title: m[2]!.trim(), done: false });
  }
  return tasks;
}

export function parseVerdict(review: string): 'APPROVED' | 'CHANGES_REQUESTED' | null {
  const m = review.match(/^\s*VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/im);
  return m ? (m[1]!.toUpperCase() as 'APPROVED' | 'CHANGES_REQUESTED') : null;
}

export function parseTestResult(report: string): 'PASS' | 'FAIL' | null {
  const m = report.match(/^\s*RESULT:\s*(PASS|FAIL)/im);
  return m ? (m[1]!.toUpperCase() as 'PASS' | 'FAIL') : null;
}

export const isBlocked = (text: string): boolean => /^\s*BLOCKED:/m.test(text);

/** Key under which a Senior Dev stage's final message is stored in run state. */
export const noteKey = (stage: StageId, fixRound: number): string => (stage === 'fix' ? `fix-${fixRound}` : stage);

export interface PromptCtx {
  requirement: string;
  /** Tech Lead documents keyed by logical name (`requirements.md`, `design.md`, `review.md`). */
  artifacts: Record<string, string>;
  /** Senior Dev final messages, see `noteKey`. */
  notes: Record<string, string>;
  /** Earlier requirements in this project (clarify stage), see Engine.previousWork. */
  previousWork?: string[];
  /** Files changed by the Senior Dev (review stage only). */
  changes?: Changes;
  autoApprove: boolean;
  testCommand: string | null;
  maxFixIterations: number;
  /** User feedback when a gate was rejected. */
  feedback?: string;
  previous?: string;
  wontFix?: number[];
  round?: number;
}

const doc = (name: string, body: string | undefined) =>
  `<document name="${name}">\n${body ?? '(missing)'}\n</document>`;
const notes = (name: string, body: string | undefined) =>
  body ? `<notes from="Senior Dev" about="${name}">\n${body}\n</notes>\n\n` : '';

const ARTIFACT_RULE = (name: string) =>
  `Deliver the result as <artifact name="${name}">…</artifact> (the complete document, nothing else inside the tags).`;

const NO_FILES = 'Do NOT create report or summary files; your final message is the report.';

function changesBlock(c: PromptCtx['changes']): string {
  if (!c) return '';
  if (!c.isGit) {
    return '<changes source="none">The project is not a git repository, so there is no diff. ' +
      "Use the Senior Dev's notes to find the files that were changed and review only those.</changes>";
  }
  if (!c.files.length) return '<changes source="git" files="0">No changes were detected in the working tree.</changes>';
  return `<changes source="git diff HEAD + new files" files="${c.files.length}"${c.truncated ? ' truncated="true"' : ''}>\n${c.text}\n</changes>`;
}

export function buildStagePrompt(stage: StageId, c: PromptCtx): string {
  const head = `<stage>${stage}</stage>\nauto-approve: ${c.autoApprove ? 'ON' : 'OFF'}\n`;
  const def = STAGES[stage];

  if (c.feedback !== undefined) {
    if (!def.artifact) {
      return `${head}The user REJECTED the result of this stage with this feedback:\n\n${c.feedback}\n\n` +
        `Rework the code/tests accordingly, re-run the tests, and finish with an updated short summary. ${NO_FILES}` +
        (stage === 'test' ? ' Your final message must START with RESULT: PASS or RESULT: FAIL.' : '');
    }
    return `${head}The user REJECTED your previous ${def.artifact} with this feedback:\n\n${c.feedback}\n\n` +
      `${c.previous ? doc(`${def.artifact} (previous version, possibly edited by the user)`, c.previous) + '\n\n' : ''}` +
      `Revise it accordingly and output the COMPLETE updated document. ${ARTIFACT_RULE(def.artifact)}`;
  }

  switch (stage) {
    case 'clarify':
      return `${head}New requirement from the user:\n\n${c.requirement}\n\n` +
        (c.previousWork?.length
          ? `Earlier requirements in this project (newest first). If the new one builds on or touches any of them, read the relevant documents ` +
            `there (requirements.md / design.md / review.md) before asking questions or designing; otherwise ignore this list.\n` +
            `${c.previousWork.map((l) => `- ${l}`).join('\n')}\n\n`
          : '') +
        (c.autoApprove
          ? `Auto-approve is ON: do NOT ask questions. Make reasonable assumptions and record them under "Assumptions". ${ARTIFACT_RULE('requirements.md')}`
          : `Clarify the requirement. If something that would change the design is unclear, ask numbered questions and wait (no artifact yet). Once clear, ${ARTIFACT_RULE('requirements.md')}`);
    case 'design':
      return `${head}${doc('requirements.md', c.artifacts['requirements.md'])}\n\n` +
        `Explore the codebase, then design the solution. Use \`### T1 — title\` headings for tasks. ${ARTIFACT_RULE('design.md')}`;
    case 'implement':
      return `${head}${doc('design.md', c.artifacts['design.md'])}\n\n` +
        `Implement every task in order, with tests. Print TASK_START: <id> / TASK_DONE: <id> lines as you go. ` +
        `Finish with a short summary: files changed per task, deviations, concerns. ${NO_FILES}`;
    case 'test':
      return `${head}${doc('design.md', c.artifacts['design.md'])}\n\n${notes('implementation', c.notes.implement)}` +
        `Test command: ${c.testCommand ?? '(detect it from the project)'}\n` +
        `Max fix attempts: ${c.maxFixIterations}\n` +
        `Run the full test suite, fill gaps against the design's test strategy, fix failures. ${NO_FILES} ` +
        `Your final message must START with a line "RESULT: PASS" or "RESULT: FAIL", followed by the commands run, results and fixes made.`;
    case 'review': {
      const latestFix = (c.round ?? 1) > 1 ? c.notes[`fix-${(c.round ?? 1) - 1}`] : undefined;
      return `${head}Review round ${c.round ?? 1}.\n\n${doc('requirements.md', c.artifacts['requirements.md'])}\n\n` +
        `${doc('design.md', c.artifacts['design.md'])}\n\n` +
        notes('implementation', c.notes.implement) + notes('tests', c.notes.test) + notes('latest fixes', latestFix) +
        `${changesBlock(c.changes)}\n\n` +
        `Review ONLY these changes. Do not read or audit the rest of the source; open another file only when you need it to judge ` +
        `a specific change (a caller, a type, a convention). You must NOT change any file. ` +
        `${ARTIFACT_RULE('review.md')} First line must be VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED.`;
    }
    case 'fix':
      return `${head}Fix round ${c.round ?? 1}.\n\n${doc('review.md', c.artifacts['review.md'])}\n\n` +
        (c.wontFix?.length ? `The user marked these finding numbers as WON'T FIX — skip them: ${c.wontFix.join(', ')}.\n\n` : '') +
        `Test command: ${c.testCommand ?? '(detect it from the project)'}\nMax fix attempts: ${c.maxFixIterations}\n` +
        `Address the findings and re-run the tests. Finish with a short summary: for each finding number, how it was handled, plus the test result. ${NO_FILES}`;
  }
}

export const NUDGE =
  'You did not output the required artifact. Output it now, wrapped in the <artifact name="…"> tags. ' +
  'If you are blocked, reply with a first line "BLOCKED: <reason>" instead.';

export const NUDGE_RESULT =
  'Your final message must START with a line "RESULT: PASS" or "RESULT: FAIL". Reply with that line, then a short summary of the test run.';

export const wrapUserReply = (stage: StageId, text: string): string => `<stage>${stage}</stage>\nUser message:\n${text}`;

export const wrapSideChat = (text: string): string =>
  `<mode>side-chat</mode>\nThe user is talking to you outside the current workflow step. You are READ-ONLY: do not modify files or run state-changing commands. Do not produce artifacts. Answer concisely.\n\n${text}`;
