// SyncData: brings existing workspaces up to the computed opportunity amount.
//   1. opportunity.amount becomes read-only in the UI (isUIEditable false, now also declared in the
//      standard definition for new workspaces). Only that field is touched: a full re-synchronization
//      of the standard application fails on unrelated drift.
//   2. provision() is re-run (idempotent). The server-side sync itself is SyncdataQuoteAmountListener,
//      which needs no data migration.
import { Command } from 'nest-commander';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { SyncdataWorkspaceProvisioningService } from 'src/engine/workspace-manager/syncdata/syncdata-workspace-provisioning.service';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

@RegisteredWorkspaceCommand('2.43.0', 1790500000000)
@Command({
  name: 'upgrade:2-43:syncdata-opportunity-amount',
  description:
    'SyncData: make opportunity.amount read-only in the UI (it is computed from the active quote lines).',
})
export class SyncdataOpportunityAmountCommand extends ProvisionedWorkspaceCommandRunner {
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
    // Nothing to undo that would not lose data: the model is kept on rollback.
  }

  async up({ workspaceId, options }: RunOnWorkspaceArgs): Promise<void> {
    if (options.dryRun ?? false) {
      return;
    }

    const { flatFieldMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatFieldMetadataMaps',
      ]);
    const amountField =
      flatFieldMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.opportunity.fields.amount.universalIdentifier
      ];

    if (isDefined(amountField) && amountField.isUIEditable) {
      const { twentyStandardFlatApplication } =
        await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
          { workspaceId },
        );
      const result =
        await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration(
          {
            isSystemBuild: true,
            workspaceId,
            applicationUniversalIdentifier:
              twentyStandardFlatApplication.universalIdentifier,
            allFlatEntityOperationByMetadataName: {
              fieldMetadata: {
                flatEntityToCreate: [],
                flatEntityToDelete: [],
                flatEntityToUpdate: [{ ...amountField, isUIEditable: false }],
              },
            },
          },
        );

      if (result.status === 'fail') {
        throw new WorkspaceMigrationBuilderException(
          result,
          `Failed to make opportunity.amount read-only for workspace ${workspaceId}`,
        );
      }
    }

    await this.provisioningService.provision(workspaceId);
  }
}
