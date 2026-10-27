// SyncData: brings workspaces that already exist up to our CRM data model. New workspaces get it when
// they are created (WorkspaceManagerService.init), so this command only covers existing ones.
//
// 1. Creates, from the standard definitions, the entities we added to the twenty-standard application
//    (see twenty-shared standard-object(-fields).constant.ts and twenty-standard-application/utils):
//    task.priority, the priority card/column fields, the Overdue kanban columns, and the OVERDUE option
//    of task.status. Only these are touched: a full re-synchronization of the standard application
//    fails on unrelated drift in existing workspaces.
// 2. Applies what the standard application cannot declare (kanban sort, workflows), see
//    SyncdataWorkspaceProvisioningService.
//
// To change the model later: edit the standard definitions or the provisioning service, then add a new
// command like this one (a command runs once per instance).
import { Command } from 'nest-commander';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { getStandardFlatEntitiesToCreateOrThrow } from 'src/database/commands/upgrade-version-command/2-10/utils/get-standard-flat-entities-to-create-or-throw.util';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatViewField } from 'src/engine/metadata-modules/flat-view-field/types/flat-view-field.type';
import { type FlatViewGroup } from 'src/engine/metadata-modules/flat-view-group/types/flat-view-group.type';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { SyncdataWorkspaceProvisioningService } from 'src/engine/workspace-manager/syncdata/syncdata-workspace-provisioning.service';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

const TASK = STANDARD_OBJECTS.task;

const NEW_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = [
  TASK.views.allTasks.viewFields.priority.universalIdentifier,
  TASK.views.assignedToMe.viewFields.priority.universalIdentifier,
  TASK.views.byStatus.viewFields.priority.universalIdentifier,
  TASK.views.taskRecordPageFields.viewFields.priority.universalIdentifier,
];

const NEW_VIEW_GROUP_UNIVERSAL_IDENTIFIERS = [
  TASK.views.assignedToMe.viewGroups.overdue.universalIdentifier,
  TASK.views.byStatus.viewGroups.overdue.universalIdentifier,
];

@RegisteredWorkspaceCommand('2.43.0', 1790300000000)
@Command({
  name: 'upgrade:2-43:syncdata-sync-task-model',
  description:
    'SyncData: add task priority, the Overdue status and the priority card fields from the standard definitions, then provision the kanban sort and workflows.',
})
export class SyncdataSyncTaskModelCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly applicationService: ApplicationService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    private readonly provisioningService: SyncdataWorkspaceProvisioningService,
  ) {
    super(workspaceIteratorService);
  }

  override runOnWorkspace(args: RunOnWorkspaceArgs): Promise<void> {
    return this.up(args);
  }

  async down(_args: RunOnWorkspaceArgs): Promise<void> {
    // Removing the priority field would delete user data: the model is kept on rollback.
  }

  async up({ workspaceId, options }: RunOnWorkspaceArgs): Promise<void> {
    const isDryRun = options.dryRun ?? false;

    const { flatFieldMetadataMaps, flatViewFieldMaps, flatViewGroupMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatFieldMetadataMaps',
        'flatViewFieldMaps',
        'flatViewGroupMaps',
      ]);

    const existingStatusField =
      flatFieldMetadataMaps.byUniversalIdentifier[
        TASK.fields.status.universalIdentifier
      ];

    if (!isDefined(existingStatusField)) {
      this.logger.log(`task.status not found for workspace ${workspaceId}, skipping`);

      return;
    }

    const { twentyStandardFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );

    const { allFlatEntityMaps: standardAllFlatEntityMaps } =
      computeTwentyStandardApplicationAllFlatEntityMaps({
        now: new Date().toISOString(),
        workspaceId,
        twentyStandardApplicationId: twentyStandardFlatApplication.id,
      });

    const fieldsToCreate = getStandardFlatEntitiesToCreateOrThrow<FlatFieldMetadata>({
      standardFlatEntityMaps: standardAllFlatEntityMaps.flatFieldMetadataMaps,
      existingFlatEntityMaps: flatFieldMetadataMaps,
      universalIdentifiers: [TASK.fields.priority.universalIdentifier],
    });

    // the OVERDUE option: take the standard options, keep the rest of the workspace field
    const standardStatusField =
      standardAllFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
        TASK.fields.status.universalIdentifier
      ];
    const hasOverdueOption = (existingStatusField.options ?? []).some(
      (option) => option.value === 'OVERDUE',
    );
    const fieldsToUpdate =
      hasOverdueOption || !isDefined(standardStatusField)
        ? []
        : [{ ...existingStatusField, options: standardStatusField.options }];

    const viewFieldsToCreate = getStandardFlatEntitiesToCreateOrThrow<FlatViewField>({
      standardFlatEntityMaps: standardAllFlatEntityMaps.flatViewFieldMaps,
      existingFlatEntityMaps: flatViewFieldMaps,
      universalIdentifiers: NEW_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
    });
    const viewGroupsToCreate = getStandardFlatEntitiesToCreateOrThrow<FlatViewGroup>({
      standardFlatEntityMaps: standardAllFlatEntityMaps.flatViewGroupMaps,
      existingFlatEntityMaps: flatViewGroupMaps,
      universalIdentifiers: NEW_VIEW_GROUP_UNIVERSAL_IDENTIFIERS,
    });

    const operationCount =
      fieldsToCreate.length +
      fieldsToUpdate.length +
      viewFieldsToCreate.length +
      viewGroupsToCreate.length;

    this.logger.log(
      `${isDryRun ? '[DRY RUN] ' : ''}Workspace ${workspaceId}: ${fieldsToCreate.length} field(s) to create, ${fieldsToUpdate.length} to update, ${viewFieldsToCreate.length} view field(s), ${viewGroupsToCreate.length} view group(s)`,
    );

    if (operationCount > 0 && !isDryRun) {
      const result =
        await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration(
          {
            isSystemBuild: true,
            workspaceId,
            applicationUniversalIdentifier:
              twentyStandardFlatApplication.universalIdentifier,
            allFlatEntityOperationByMetadataName: {
              fieldMetadata: {
                flatEntityToCreate: fieldsToCreate,
                flatEntityToDelete: [],
                flatEntityToUpdate: fieldsToUpdate,
              },
              viewField: {
                flatEntityToCreate: viewFieldsToCreate,
                flatEntityToDelete: [],
                flatEntityToUpdate: [],
              },
              viewGroup: {
                flatEntityToCreate: viewGroupsToCreate,
                flatEntityToDelete: [],
                flatEntityToUpdate: [],
              },
            },
          },
        );

      if (result.status === 'fail') {
        throw new WorkspaceMigrationBuilderException(
          result,
          `Failed to sync the SyncData task model for workspace ${workspaceId}`,
        );
      }
    }

    if (!isDryRun) {
      await this.provisioningService.provision(workspaceId);
    }
  }
}
