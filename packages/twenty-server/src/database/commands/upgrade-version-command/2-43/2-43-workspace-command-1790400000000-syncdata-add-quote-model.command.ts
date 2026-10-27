// SyncData: brings workspaces that already exist up to the quoting model (article, quote, quoteLine,
// opportunity.activeQuote). New workspaces get it at creation (WorkspaceManagerService.init), so this
// command only covers existing ones. The model itself is declared in
// SyncdataQuoteModelProvisioningService; its steps are idempotent.
import { Command } from 'nest-commander';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { SyncdataWorkspaceProvisioningService } from 'src/engine/workspace-manager/syncdata/syncdata-workspace-provisioning.service';

@RegisteredWorkspaceCommand('2.43.0', 1790400000000)
@Command({
  name: 'upgrade:2-43:syncdata-add-quote-model',
  description:
    'SyncData: create the article, quote and quoteLine objects and the opportunity.activeQuote relation.',
})
export class SyncdataAddQuoteModelCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly provisioningService: SyncdataWorkspaceProvisioningService,
  ) {
    super(workspaceIteratorService);
  }

  override runOnWorkspace(args: RunOnWorkspaceArgs): Promise<void> {
    return this.up(args);
  }

  async down(_args: RunOnWorkspaceArgs): Promise<void> {
    // Dropping the objects would delete user data: the model is kept on rollback.
  }

  async up({ workspaceId, options }: RunOnWorkspaceArgs): Promise<void> {
    if (options.dryRun ?? false) {
      return;
    }

    await this.provisioningService.provision(workspaceId);
  }
}
