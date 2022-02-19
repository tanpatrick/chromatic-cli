/* eslint-disable no-param-reassign */
import { exitCodes, setExitCode } from '../lib/setExitCode';
import { createTask, transitionTo } from '../lib/tasks';
import { delay } from '../lib/utils';
import { Context, Task } from '../types';
import buildHasChanges from '../ui/messages/errors/buildHasChanges';
import buildHasErrors from '../ui/messages/errors/buildHasErrors';
import buildPassedMessage from '../ui/messages/info/buildPassed';
import speedUpCI from '../ui/messages/info/speedUpCI';
import {
  buildComplete,
  buildPassed,
  buildBroken,
  buildFailed,
  buildCanceled,
  initial,
  dryRun,
  skipped,
  pending,
} from '../ui/tasks/snapshot';

const BuildQuery = `
  query BuildQuery($buildNumber: Int!) {
    app {
      build(number: $buildNumber) {
        id
        status(legacy: false)
        autoAcceptChanges
        inProgressCount: testCount(statuses: [IN_PROGRESS])
        testCount
        changeCount
        errorCount: testCount(statuses: [BROKEN])
      }
    }
  }
`;
interface BuildQueryResult {
  app: {
    build: {
      id: string;
      status: string;
      autoAcceptChanges: boolean;
      inProgressCount: number;
      testCount: number;
      changeCount: number;
      errorCount: number;
    };
  };
}

export const takeSnapshots = async (ctx: Context, task: Task) => {
  const { client, log, options } = ctx;
  const { number: buildNumber, tests, testCount, actualTestCount } = ctx.build;

  if (ctx.build.app.repository && ctx.uploadedBytes && !options.junitReport) {
    log.info(speedUpCI(ctx.build.app.repository.provider));
  }

  const testLabels =
    options.interactive &&
    testCount === actualTestCount &&
    tests.map(({ spec, parameters }) => {
      const suffix = parameters.viewportIsDefault ? '' : ` [${parameters.viewport}px]`;
      return `${spec.component.displayName} › ${spec.name}${suffix}`;
    });

  const waitForBuild = async (): Promise<Context['build']> => {
    const { app } = await client.runQuery<BuildQueryResult>(BuildQuery, { buildNumber });
    ctx.build = { ...ctx.build, ...app.build };

    if (app.build.status !== 'IN_PROGRESS') {
      return ctx.build;
    }

    if (options.interactive) {
      const { inProgressCount } = ctx.build;
      const cursor = actualTestCount - inProgressCount + 1;
      const label = testLabels && testLabels[cursor - 1];
      task.output = pending(ctx, { cursor, label }).output;
    }

    await delay(ctx.env.CHROMATIC_POLL_INTERVAL);
    return waitForBuild();
  };

  const build = await waitForBuild();

  switch (build.status) {
    case 'PASSED':
      setExitCode(ctx, exitCodes.OK);
      ctx.log.info(buildPassedMessage(ctx));
      transitionTo(buildPassed, true)(ctx, task);
      break;

    // They may have sneakily looked at the build while we were waiting
    case 'ACCEPTED':
    case 'PENDING':
    case 'DENIED': {
      if (build.autoAcceptChanges || ctx.git.matchesBranch(options.exitZeroOnChanges)) {
        setExitCode(ctx, exitCodes.OK);
        ctx.log.info(buildPassedMessage(ctx));
      } else {
        setExitCode(ctx, exitCodes.BUILD_HAS_CHANGES, true);
        ctx.log.error(buildHasChanges(ctx));
      }
      transitionTo(buildComplete, true)(ctx, task);
      break;
    }

    case 'BROKEN':
      setExitCode(ctx, exitCodes.BUILD_HAS_ERRORS, true);
      ctx.log.error(buildHasErrors(ctx));
      transitionTo(buildBroken, true)(ctx, task);
      break;

    case 'FAILED':
      setExitCode(ctx, exitCodes.BUILD_FAILED, true);
      transitionTo(buildFailed, true)(ctx, task);
      break;

    case 'CANCELLED':
      setExitCode(ctx, exitCodes.BUILD_WAS_CANCELED, true);
      transitionTo(buildCanceled, true)(ctx, task);
      break;

    default:
      throw new Error(`Unexpected build status: ${build.status}`);
  }
};

export default createTask({
  title: initial.title,
  skip: (ctx: Context) => {
    if (ctx.skip) return true;
    if (ctx.skipSnapshots) return skipped(ctx).output;
    if (ctx.options.dryRun) return dryRun().output;
    return false;
  },
  steps: [transitionTo(pending), takeSnapshots],
});