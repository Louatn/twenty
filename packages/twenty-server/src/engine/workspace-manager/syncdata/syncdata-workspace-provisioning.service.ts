// SyncData: the parts of our CRM data model that Twenty's standard application cannot declare.
//
// The standard definitions (twenty-shared/src/metadata/constants + twenty-standard-application/utils) hold
// task.priority, the OVERDUE status, the priority card fields and the Overdue kanban column. They have no
// notion of a view sort or a workflow, so those live here, in code, and are applied by:
//   - WorkspaceManagerService.init()                  (every new workspace)
//   - the 2-43 syncdata upgrade command               (workspaces that already exist)
// Every step is idempotent: it checks what exists before creating anything.
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import {
  FieldActorSource,
  ViewSortDirection,
  ViewType,
  type ActorMetadata,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type WorkflowAction, type WorkflowTrigger } from 'twenty-shared/workflow';
import { v4 } from 'uuid';

import { WorkflowVersionStatus } from 'src/engine/core-modules/workflow/entities/workflow-version.entity';
import { CoreWorkflowLifecycleWorkspaceService } from 'src/engine/core-modules/workflow/services/core-workflow-lifecycle.workspace-service';
import { CoreWorkflowMutationWorkspaceService } from 'src/engine/core-modules/workflow/services/core-workflow-mutation.workspace-service';
import { CoreWorkflowVersionListService } from 'src/engine/core-modules/workflow/services/core-workflow-version-list.service';
import { CoreWorkflowVersionMutationWorkspaceService } from 'src/engine/core-modules/workflow/services/core-workflow-version-mutation.workspace-service';
import { CoreWorkflowVersionWriteService } from 'src/engine/core-modules/workflow/services/core-workflow-version-write.service';
import { ViewSortService } from 'src/engine/metadata-modules/view-sort/services/view-sort.service';
import { ViewService } from 'src/engine/metadata-modules/view/services/view.service';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { type WorkflowWorkspaceEntity } from 'src/modules/workflow/common/standard-objects/workflow.workspace-entity';

const STATUS_VIEW_NAME = 'By Status';
const OVERDUE_WORKFLOW_NAME = 'Mark overdue tasks';
const OVERDUE_CRON = '0 0 * * *'; // the server runs in UTC
const OVERDUE_STATUS = 'OVERDUE';
const SYNCDATA_ACTOR: ActorMetadata = {
  source: FieldActorSource.MANUAL,
  workspaceMemberId: null,
  name: 'SyncData',
  context: {},
};

@Injectable()
export class SyncdataWorkspaceProvisioningService {
  private readonly logger = new Logger(SyncdataWorkspaceProvisioningService.name);

  constructor(
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly viewService: ViewService,
    private readonly viewSortService: ViewSortService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly moduleRef: ModuleRef,
  ) {}

  async provision(workspaceId: string): Promise<void> {
    await this.ensureTaskKanbanPrioritySort(workspaceId);
    await this.ensureOverdueWorkflow(workspaceId);
    await this.ensureRelancesWorkflows(workspaceId);
  }

  // The task kanban stays grouped by status and its cards are sorted by priority inside each column,
  // High first: a select sorts by option position and the options are declared High, Medium, Low.
  private async ensureTaskKanbanPrioritySort(workspaceId: string) {
    const { flatObjectMetadataMaps, flatFieldMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatObjectMetadataMaps',
        'flatFieldMetadataMaps',
      ]);

    const taskObjectId = flatObjectMetadataMaps.byUniversalIdentifier[
      STANDARD_OBJECTS.task.universalIdentifier
    ]?.id;
    const priorityFieldId = flatFieldMetadataMaps.byUniversalIdentifier[
      STANDARD_OBJECTS.task.fields.priority.universalIdentifier
    ]?.id;

    if (!isDefined(taskObjectId) || !isDefined(priorityFieldId)) {
      this.logger.log(`task.priority not found for workspace ${workspaceId}, skipping the kanban sort`);

      return;
    }

    const statusView = (
      await this.viewService.findByObjectMetadataId(workspaceId, taskObjectId)
    ).find((view) => view.name === STATUS_VIEW_NAME && view.type === ViewType.KANBAN);

    if (!isDefined(statusView)) {
      return;
    }

    const sorts = await this.viewSortService.findByViewId(workspaceId, statusView.id);

    if (sorts.length === 0) {
      await this.viewSortService.createOne({
        workspaceId,
        createViewSortInput: {
          viewId: statusView.id,
          fieldMetadataId: priorityFieldId,
          direction: ViewSortDirection.ASC,
        },
      });
      this.logger.log(`Sorted "${STATUS_VIEW_NAME}" by priority on ${workspaceId}`);
    }
  }

  // Daily at midnight: TODO tasks whose dueAt is past become OVERDUE.
  private async ensureOverdueWorkflow(workspaceId: string) {
    const { flatFieldMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatFieldMetadataMaps',
      ]);

    const statusFieldId = flatFieldMetadataMaps.byUniversalIdentifier[
      STANDARD_OBJECTS.task.fields.status.universalIdentifier
    ]?.id;
    const dueAtFieldId = flatFieldMetadataMaps.byUniversalIdentifier[
      STANDARD_OBJECTS.task.fields.dueAt.universalIdentifier
    ]?.id;

    if (!isDefined(statusFieldId) || !isDefined(dueAtFieldId)) {
      return;
    }

    const findStepId = v4();
    const loopStepId = v4();
    const updateStepId = v4();
    const filterGroupId = v4();
    const common = {
      outputSchema: {},
      errorHandlingOptions: {
        retryOnFailure: { value: 0 },
        continueOnFailure: { value: false },
      },
    };

    const trigger = {
      name: 'Every day at midnight',
      type: 'CRON',
      settings: { type: 'CUSTOM', pattern: OVERDUE_CRON, outputSchema: {} },
    } as WorkflowTrigger;
    const steps = [
      {
        id: findStepId,
        name: 'Late to-do tasks',
        type: 'FIND_RECORDS',
        valid: true,
        settings: {
          ...common,
          input: {
            objectName: 'task',
            limit: 200, // Twenty caps a find at 200 records: a bigger backlog drains over several nights
            filter: {
              recordFilterGroups: [{ id: filterGroupId, logicalOperator: 'AND' }],
              recordFilters: [
                {
                  id: v4(),
                  fieldMetadataId: statusFieldId,
                  type: 'SELECT',
                  operand: 'IS',
                  value: '["TODO"]',
                  recordFilterGroupId: filterGroupId,
                },
                {
                  id: v4(),
                  fieldMetadataId: dueAtFieldId,
                  type: 'DATE_TIME',
                  operand: 'IS_IN_PAST',
                  value: '',
                  recordFilterGroupId: filterGroupId,
                },
              ],
            },
          },
        },
      },
      {
        id: loopStepId,
        name: 'For each task',
        type: 'ITERATOR',
        valid: true,
        settings: {
          ...common,
          input: {
            items: `{{${findStepId}.all}}`,
            initialLoopStepIds: [updateStepId],
          },
        },
      },
      {
        id: updateStepId,
        name: 'Set status to Overdue',
        type: 'UPDATE_RECORD',
        valid: true,
        settings: {
          ...common,
          input: {
            objectName: 'task',
            objectRecordId: `{{${loopStepId}.currentItem.id}}`,
            objectRecord: { status: OVERDUE_STATUS },
            fieldsToUpdate: ['status'],
          },
        },
      },
    ] as WorkflowAction[];
    const loopOptions = {
      connectedStepType: 'ITERATOR',
      settings: { isConnectedToLoop: true },
    } as const;
    const edges = [
      { source: 'trigger', target: findStepId },
      { source: findStepId, target: loopStepId },
      { source: loopStepId, target: updateStepId, options: loopOptions },
      // back edge: without it the loop would run a single iteration
      { source: updateStepId, target: loopStepId },
    ];

    await this.createAndActivateWorkflow({
      workspaceId,
      name: OVERDUE_WORKFLOW_NAME,
      trigger,
      steps,
      edges,
    });
  }

  // Creates a workflow, writes its trigger/steps/edges through Twenty's core workflow services (the ones
  // behind its AI workflow tool) and activates it. Skips when a workflow with that name already exists.
  private async createAndActivateWorkflow({
    workspaceId,
    name,
    trigger,
    steps,
    edges,
  }: {
    workspaceId: string;
    name: string;
    trigger: WorkflowTrigger;
    steps: WorkflowAction[];
    edges: { source: string; target: string; options?: unknown }[];
  }) {
    const alreadyExists = await this.workspaceOrmManager.executeInWorkspaceContext(
      async () =>
        isDefined(
          await this.workspaceOrmManager
            .getRepository<WorkflowWorkspaceEntity>('workflow', {
              shouldBypassPermissionChecks: true,
            })
            .findOne({ where: { name } }),
        ),
      buildSystemAuthContext(workspaceId),
    );

    if (alreadyExists) {
      return;
    }

    // resolved lazily: importing the workflow modules here closes an import cycle
    // (WorkspaceModule -> UpgradeModule -> this module -> workflow -> calendar -> WorkspaceModule)
    const resolve = <TService>(service: new (...args: never[]) => TService) =>
      this.moduleRef.get(service, { strict: false });
    const userWorkspaceId = undefined;

    const coreWorkflow = await resolve(
      CoreWorkflowMutationWorkspaceService,
    ).createWorkflow({
      workspaceId,
      createdBy: SYNCDATA_ACTOR,
      userWorkspaceId,
      name,
    });

    const draftVersion = (
      await resolve(CoreWorkflowVersionListService).findManyByCoreWorkflowId({
        workspaceId,
        userWorkspaceId,
        coreWorkflowId: coreWorkflow.id,
      })
    ).find((version) => version.status === WorkflowVersionStatus.DRAFT);

    if (!isDefined(draftVersion)) {
      throw new Error(`Workflow ${coreWorkflow.id} has no initial draft version`);
    }

    const versionWriteService = resolve(CoreWorkflowVersionWriteService);
    const { coreWorkflowVersion } =
      await versionWriteService.getValidatedDraftCoreWorkflowVersion({
        workspaceId,
        userWorkspaceId,
        coreWorkflowVersionId: draftVersion.id,
      });

    await versionWriteService.writeContentAndMirror({
      workspaceId,
      coreWorkflowVersionId: draftVersion.id,
      expectedVersion: coreWorkflowVersion,
      trigger,
      steps,
    });

    const versionMutationService = resolve(
      CoreWorkflowVersionMutationWorkspaceService,
    );

    for (const edge of edges) {
      await versionMutationService.createEdge({
        workspaceId,
        userWorkspaceId,
        coreWorkflowVersionId: draftVersion.id,
        source: edge.source,
        target: edge.target,
        sourceConnectionOptions: edge.options as never,
      });
    }

    await versionMutationService.autoLayoutCoreWorkflowVersion({
      workspaceId,
      userWorkspaceId,
      coreWorkflowVersionId: draftVersion.id,
    });

    // validates the definition and registers the cron
    await resolve(CoreWorkflowLifecycleWorkspaceService).activateCoreWorkflowVersion({
      workspaceId,
      userWorkspaceId,
      coreWorkflowVersionId: draftVersion.id,
    });
    this.logger.log(`Created and activated "${name}" on ${workspaceId}`);
  }

  // "Plan relances": a button on a person, company or opportunity record. It opens a form asking for the
  // relance title, then creates three follow-up tasks due in 1, 2 and 3 days, each linked to the record,
  // so they show up in the task dashboard. {{date.inNDays}} comes from getWorkflowRunContext.
  private async ensureRelancesWorkflows(workspaceId: string) {
    const targetFieldByObject = {
      person: 'targetPersonId',
      company: 'targetCompanyId',
      opportunity: 'targetOpportunityId',
    } as const;
    const relances = [
      { label: 'J+1', dueAt: '{{date.in1Day}}' },
      { label: 'J+2', dueAt: '{{date.in2Days}}' },
      { label: 'J+3', dueAt: '{{date.in3Days}}' },
    ];
    const common = {
      outputSchema: {},
      errorHandlingOptions: {
        retryOnFailure: { value: 0 },
        continueOnFailure: { value: false },
      },
    };

    for (const [objectName, targetField] of Object.entries(targetFieldByObject)) {
      const formStepId = v4();
      const steps: Record<string, unknown>[] = [
        {
          id: formStepId,
          name: 'Plan relances',
          type: 'FORM',
          valid: true,
          settings: {
            ...common,
            input: [
              {
                id: v4(),
                name: 'title',
                label: 'Relance title',
                type: 'TEXT',
                placeholder: 'Relance devis',
              },
            ],
          },
        },
      ];
      const edges: { source: string; target: string }[] = [
        { source: 'trigger', target: formStepId },
      ];
      let previousStepId = formStepId;

      for (const relance of relances) {
        const taskStepId = v4();
        const targetStepId = v4();

        steps.push(
          {
            id: taskStepId,
            name: `Task ${relance.label}`,
            type: 'CREATE_RECORD',
            valid: true,
            settings: {
              ...common,
              input: {
                objectName: 'task',
                objectRecord: {
                  title: `{{${formStepId}.title}} ${relance.label}`,
                  dueAt: relance.dueAt,
                  status: 'TODO',
                },
              },
            },
          },
          {
            id: targetStepId,
            name: `Link ${relance.label} to the record`,
            type: 'CREATE_RECORD',
            valid: true,
            settings: {
              ...common,
              input: {
                objectName: 'taskTarget',
                objectRecord: {
                  taskId: `{{${taskStepId}.id}}`,
                  [targetField]: '{{trigger.id}}',
                },
              },
            },
          },
        );
        edges.push(
          { source: previousStepId, target: taskStepId },
          { source: taskStepId, target: targetStepId },
        );
        previousStepId = targetStepId;
      }

      await this.createAndActivateWorkflow({
        workspaceId,
        name: `Plan relances (${objectName})`,
        trigger: {
          name: 'Plan relances',
          type: 'MANUAL',
          settings: {
            outputSchema: {},
            icon: 'IconCalendarPlus',
            isPinned: true,
            availability: {
              type: 'SINGLE_RECORD',
              objectNameSingular: objectName,
            },
          },
        } as WorkflowTrigger,
        steps: steps as WorkflowAction[],
        edges,
      });
    }
  }
}
