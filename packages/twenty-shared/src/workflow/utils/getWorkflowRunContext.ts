import { isDefined } from '@/utils';
import { type WorkflowRunStepInfos } from '@/workflow/types/WorkflowRunStateStepInfos';
import { DATE_CONTEXT_KEY } from '@/workflow/constants/DateContextKey';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// SyncData: relative dates for any step, e.g. a task due date of {{date.in3Days}}. Workflow variables
// have no date arithmetic and CODE steps are disabled in production builds, so the context carries them.
const buildDateContext = (now: Date): Record<string, string> => {
  const inDays = (days: number) =>
    new Date(now.getTime() + days * MILLISECONDS_PER_DAY).toISOString();

  return {
    now: now.toISOString(),
    in1Day: inDays(1),
    in2Days: inDays(2),
    in3Days: inDays(3),
    in7Days: inDays(7),
    in30Days: inDays(30),
  };
};

export const getWorkflowRunContext = (
  stepInfos: WorkflowRunStepInfos,
): Record<string, unknown> => {
  return {
    [DATE_CONTEXT_KEY]: buildDateContext(new Date()),
    ...Object.fromEntries(
      Object.entries(stepInfos)
        .filter(([, value]) => isDefined(value?.['result']))
        .map(([key, value]) => [key, value?.['result']]),
    ),
  };
};
